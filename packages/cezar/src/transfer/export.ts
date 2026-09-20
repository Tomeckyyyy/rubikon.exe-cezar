import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeGitRef } from '../git-refs.ts';
import { handoffPath } from '../handoff.ts';
import type { RunRecord } from '../runs/store.ts';
import {
  BRANCHES_FILE,
  MANIFEST_FILE,
  createBranchBundle,
  eventsFilePath,
  journalFilePath,
  localRefExists,
  packBundle,
  recordFilePath,
  tempBundlePath,
  writeDurable,
} from './bundle.ts';
import {
  HANDOFF_FORMAT_VERSION,
  TransferError,
  isTerminalRunStatus,
  manifestRunEntry,
  type HandoffManifest,
} from './manifest.ts';
import { handoffBundleDir } from '../paths.ts';

/**
 * `cez handoff export` (spec `.ai/specs/2026-09-19-cross-machine-task-handoff.md`): select the
 * finished tasks of one project, pack their records, event logs, journals and `cez/*` branches
 * into a portable bundle, and only after the durable write mark each run
 * `handoff.direction = 'out'`.
 *
 * The store arrives from the caller rather than being opened here, because the same code serves
 * the CLI (no cockpit running) and the cockpit's export route (where the store is already open
 * and authoritative). Selection is a pure function so both callers, and the tests, share exactly
 * one rule.
 */

/** The slice of `RunStore` export needs — structural, so tests need no store. */
export interface ExportStore {
  listRuns(): RunRecord[];
  updateRun(
    id: string,
    patch: {
      handoff?: RunRecord['handoff'];
      autoResumeAt?: undefined;
      autoResumeAttempts?: undefined;
    },
  ): unknown;
}

export interface ExportSelectionProblem {
  message: string;
  code: 'unknown-run' | 'not-terminal' | 'nothing-to-export';
}

export interface ExportSelection {
  selected: RunRecord[];
  /** Human-readable refusals (unknown/ambiguous ids, live statuses, nothing selected). */
  problems: ExportSelectionProblem[];
}

/**
 * Why a live run cannot be exported, in one line each. Refusing at the source removes the whole
 * "an imported live run starts itself on another machine" failure class instead of guarding it
 * on arrival: each of these holds a live slot claim, a live agent process, or an open session.
 */
export function liveExportRefusal(run: RunRecord): string {
  const label = run.id.slice(0, 8);
  const why =
    run.status === 'queued'
      ? 'it is still queued for a slot'
      : run.status === 'running'
        ? 'an agent is working on it right now'
        : 'its session is open waiting for your reply';
  return `task ${label} is ${run.status} — ${why}; export accepts done, failed, cancelled and review tasks (finish or stop it first)`;
}

/** Resolve `[<runId> | --all]` against the project's runs. Exact id, else a unique prefix. */
export function selectExportableRuns(
  runs: readonly RunRecord[],
  opts: { runIds?: readonly string[]; all?: boolean },
): ExportSelection {
  const problems: ExportSelectionProblem[] = [];
  const selected: RunRecord[] = [];
  const taken = new Set<string>();
  const push = (run: RunRecord) => {
    if (!taken.has(run.id)) {
      taken.add(run.id);
      selected.push(run);
    }
  };
  const ids = (opts.runIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (ids.length > 0) {
    for (const input of ids) {
      const matches = runs.filter((run) => run.id === input || run.id.startsWith(input));
      if (matches.length === 0) {
        problems.push({ message: `no task in this project matches "${input}"`, code: 'unknown-run' });
        continue;
      }
      if (matches.length > 1) {
        problems.push({ message: `"${input}" matches ${matches.length} tasks — use the full task id`, code: 'unknown-run' });
        continue;
      }
      const run = matches[0]!;
      if (!isTerminalRunStatus(run.status)) {
        problems.push({ message: liveExportRefusal(run), code: 'not-terminal' });
        continue;
      }
      push(run);
    }
    return { selected, problems };
  }
  if (!opts.all) {
    problems.push({
      message: 'nothing selected — name a task id or pass --all to export every finished task',
      code: 'nothing-to-export',
    });
    return { selected, problems };
  }
  for (const run of runs) {
    if (isTerminalRunStatus(run.status)) push(run);
  }
  if (selected.length === 0) {
    problems.push({
      message: 'nothing to export — this project has no finished task (done, failed, cancelled, review)',
      code: 'nothing-to-export',
    });
  }
  return { selected, problems };
}

/** Candidates for the git bundle: the selected runs' own `cez/*` branches. */
export function exportBranches(runs: readonly RunRecord[]): string[] {
  const seen = new Set<string>();
  for (const run of runs) {
    const branch = run.branch;
    if (!branch || !isSafeGitRef(branch) || !branch.startsWith('cez/')) continue;
    seen.add(branch);
  }
  return [...seen];
}

export interface ExportOptions {
  repoRoot: string;
  /** `.ai/cezar` — where the NDJSON logs and journals live. */
  dataDir: string;
  store: ExportStore;
  runIds?: readonly string[];
  all?: boolean;
  /** Durable destination file. Defaults to `~/.cache/cez/handoff/<project>-<stamp>.tgz`. */
  outPath?: string;
  /** Stream sink (`--out -`): takes precedence over `outPath`. The mark follows this write too. */
  sink?: (bytes: Buffer) => void | Promise<void>;
  cezarVersion: string;
  sourceProjectId?: string;
  /** Host label recorded on the mark; `push` passes the SSH host. Never a credential. */
  peer?: string;
  now?: () => string;
}

export interface ExportResult {
  bundle: Buffer;
  bundlePath?: string;
  runs: RunRecord[];
  branches: string[];
  /** Notes about degradation (a missing branch, an in-place run) for the CLI/cockpit to print. */
  notes: string[];
  /** Ids whose `handoff` mark was newly written (not already `out`) — what `push` may revert. */
  marked: string[];
}

/** `<project>-<UTC stamp>.tgz` — sortable, and no character a shell or scp would mangle. */
export function defaultBundleName(projectId: string | undefined, now: () => string): string {
  const stamp = now().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const slug = (projectId ?? 'cez').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'cez';
  return `${slug}-${stamp}.tgz`;
}

export function defaultBundlePath(projectId: string | undefined, now: () => string): string {
  return join(handoffBundleDir(), defaultBundleName(projectId, now));
}

export async function exportRuns(opts: ExportOptions): Promise<ExportResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const selection = selectExportableRuns(opts.store.listRuns(), { runIds: opts.runIds, all: opts.all });
  if (selection.problems.length > 0) {
    throw new TransferError(
      selection.problems.map((problem) => problem.message).join('\n'),
      selection.problems[0]!.code,
    );
  }
  const at = now();
  const notes: string[] = [];
  const branches: string[] = [];
  for (const branch of exportBranches(selection.selected)) {
    if (await localRefExists(opts.repoRoot, branch)) branches.push(branch);
    else notes.push(`branch ${branch} is not in this repository — the task imports without a worktree`);
  }

  // The git bundle is created first, in a scratch directory, so a git failure aborts before any
  // file (or mark) is written. The scratch dir never outlives this function.
  let branchBundle: Buffer | undefined;
  if (branches.length > 0) {
    const scratch = mkdtempSync(join(tmpdir(), 'cez-handoff-'));
    try {
      const file = tempBundlePath(scratch);
      await createBranchBundle(opts.repoRoot, branches, file);
      branchBundle = readFileSync(file);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  const files = new Map<string, Buffer | string>();
  const manifest: HandoffManifest = {
    formatVersion: HANDOFF_FORMAT_VERSION,
    createdAt: at,
    cezarVersion: opts.cezarVersion,
    ...(opts.sourceProjectId !== undefined ? { sourceProjectId: opts.sourceProjectId } : {}),
    runs: selection.selected.map(manifestRunEntry),
    branches,
  };
  files.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const run of selection.selected) {
    files.set(recordFilePath(run.id), `${JSON.stringify(run, null, 2)}\n`);
    const events = join(opts.dataDir, 'runs', `${run.id}.ndjson`);
    if (existsSync(events)) files.set(eventsFilePath(run.id), readFileSync(events));
    const journal = handoffPath(opts.dataDir, run.id);
    if (existsSync(journal)) files.set(journalFilePath(run.id), readFileSync(journal));
    if (!run.branch) notes.push(`task ${run.id.slice(0, 8)} ran in place — no branch or diff travels`);
  }
  if (branchBundle) files.set(BRANCHES_FILE, branchBundle);

  const bundle = packBundle(files);
  let bundlePath: string | undefined;
  if (opts.sink) {
    await opts.sink(bundle);
  } else {
    bundlePath = opts.outPath ?? defaultBundlePath(opts.sourceProjectId, () => at);
    writeDurable(bundlePath, bundle);
  }

  // Only now — a durable bundle exists. Clearing a pending usage-limit resume here is the source
  // half of "nothing auto-launches on the destination": the work belongs to the other machine, so
  // this one must not pick it back up on its own either.
  const marked: string[] = [];
  for (const run of selection.selected) {
    const alreadyOut = run.handoff?.direction === 'out';
    opts.store.updateRun(run.id, {
      handoff: { direction: 'out', at, ...(opts.peer ? { peer: opts.peer } : {}) },
      autoResumeAt: undefined,
      autoResumeAttempts: undefined,
    });
    if (!alreadyOut) marked.push(run.id);
  }
  return { bundle, bundlePath, runs: selection.selected, branches, notes, marked };
}