import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createWorktree, worktreePathFor } from '../git-worktree.ts';
import { isSafeGitRef } from '../git-refs.ts';
import type { RunRecord, RunStatus } from '../runs/store.ts';
import { runRecordSchema } from '../runs/store.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, loadAgentAccounts } from '../workspace/agent-accounts.ts';
import { listAgentProfiles } from '../workspace/agent-profiles.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { RUNNER_IDS } from '@open-mercato/cezar-contract';
import type { ProviderId } from '../core/provider-auth.ts';
import {
  BRANCHES_FILE,
  bundleHeads,
  eventsFilePath,
  fetchBundleRefs,
  journalFilePath,
  localRefSha,
  parseManifest,
  readBundleBytes,
  recordFilePath,
  unpackBundle,
  verifyBundle,
} from './bundle.ts';
import { TransferError, isTerminalRunStatus, type HandoffManifest } from './manifest.ts';

/**
 * `cez handoff import` (spec `.ai/specs/2026-09-19-cross-machine-task-handoff.md`): validate a
 * bundle end to end, fetch its branches, reattach each worktree through the idempotent
 * `createWorktree`, and upsert the records with THIS machine's own `worktreePath`.
 *
 * All-or-nothing by design: every record is parsed, every branch is checked for a local
 * conflict, and the plan is complete before the first write. A re-run after an interrupted
 * import is idempotent — records upsert by id and an identical existing branch is a no-op.
 *
 * Nothing here launches anything. Terminal statuses only, every auto-resume/monitoring field
 * cleared, every step `sessionId` cleared: `recover()` on the destination has nothing to re-arm
 * and no session to resume, so an imported task waits for a human Continue.
 */

export interface ImportStore {
  getRun(id: string): RunRecord | undefined;
  importRun(record: unknown): { ok: true; run: RunRecord } | { ok: false; error: string };
}

export interface ImportPlanEntry {
  id: string;
  title: string;
  status: RunStatus;
  /** `replace` when the id already exists on this machine (upsert). */
  action: 'create' | 'replace';
  branch?: string;
  /** `materialize` = the branch is in the bundle and a worktree will be created here. */
  worktree: 'materialize' | 'none';
  /** The destination path a materialized worktree gets. */
  worktreePath?: string;
  warnings: string[];
}

export interface ImportPlan {
  manifest: HandoffManifest;
  bundlePath: string;
  entries: ImportPlanEntry[];
  warnings: string[];
  /** Branches to fetch, and branches already identical locally (no-ops). */
  fetch: string[];
  /** Parsed and validated records, keyed by run id — apply() uses these; never mutated. */
  records: ReadonlyMap<string, RunRecord>;
  /** The unpacked bundle. Kept so `importBundle` can re-extract the git bundle for the fetch
   *  without a second gunzip — not for consumers to read. */
  readonly files: ReadonlyMap<string, Buffer>;
}

export interface ImportOptions {
  repoRoot: string;
  /** `.ai/cezar` — where the record's NDJSON transcript and handoff journal are written. */
  dataDir: string;
  store: ImportStore;
  bundlePath: string;
  peer?: string;
  now?: () => string;
  /** Agent-account ids known on THIS machine; defaults to `~/.cezar/agent-accounts.json`.
   *  Injectable so tests never depend on the host's accounts. */
  knownProfiles?: () => Promise<ReadonlySet<string>>;
}

export interface ImportResult {
  plan: ImportPlan;
  imported: string[];
}

/** Canonical path for registry comparison (git canonicalizes symlinked prefixes). */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The registered project whose root is `repoRoot`, or null. Import requires this — "no implicit
 * clone" — so a destination that was never registered refuses with one named command instead of
 * importing tasks into a project the cockpit does not serve.
 */
export async function resolveRegisteredProject(
  repoRoot: string,
): Promise<{ id: string; root: string } | null> {
  const config = await loadWorkspaceConfig().catch(() => null);
  if (!config) return null;
  const target = canonicalPath(repoRoot);
  const match = config.projects.find((project) => canonicalPath(project.root) === target);
  return match ? { id: match.id, root: match.root } : null;
}

/** One bundle file in the handoff cache. Deliberately metadata-only: listing must not gunzip
 *  every bundle, so a full manifest read belongs to the explicit preview/import. */
export interface LocalBundle {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export function listBundles(dir: string): LocalBundle[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const bundles: LocalBundle[] = [];
  for (const name of names) {
    if (!name.endsWith('.tgz') || name.endsWith('.tmp')) continue;
    const path = resolve(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      bundles.push({ name, path, sizeBytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() });
    } catch {
      // unreadable entry — skip it
    }
  }
  return bundles.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
}

async function knownProfileIds(): Promise<ReadonlySet<string>> {
  try {
    const store = await loadAgentAccounts();
    const profiles = listAgentProfiles(store, RUNNER_IDS as readonly ProviderId[]);
    return new Set(profiles.map((profile) => profile.id));
  } catch {
    return new Set([DEFAULT_AGENT_ACCOUNT_ID]);
  }
}

/**
 * The git bundle inside the tgz is a FILE for git, so the caller extracts it to a scratch path,
 * runs git against it, and the scratch dir is gone on the way out. `undefined` when the bundle
 * carries no branches.
 */
async function withGitBundle<T>(
  files: ReadonlyMap<string, Buffer>,
  fn: (bundleFile: string) => Promise<T>,
): Promise<T | undefined> {
  const bytes = files.get(BRANCHES_FILE);
  if (!bytes) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'cez-handoff-git-'));
  const file = join(dir, BRANCHES_FILE);
  try {
    writeFileSync(file, bytes);
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Validate the bundle and everything that would be written, changing nothing. The CLI's
 * `--dry-run` and the cockpit's import preview both print exactly this.
 */
export async function planImport(opts: ImportOptions): Promise<ImportPlan> {
  const now = opts.now ?? (() => new Date().toISOString());
  let files: Map<string, Buffer>;
  try {
    files = unpackBundle(readBundleBytes(opts.bundlePath));
  } catch (err) {
    if (err instanceof TransferError) throw err;
    throw new TransferError(`cannot read bundle ${opts.bundlePath}: ${err instanceof Error ? err.message : String(err)}`, 'not-a-bundle');
  }
  const manifest = parseManifest(files);

  const warnings: string[] = [];
  const records = new Map<string, RunRecord>();
  for (const entry of manifest.runs) {
    const raw = files.get(recordFilePath(entry.id));
    if (!raw) {
      throw new TransferError(`bundle is incomplete: runs/${entry.id}.json is missing`, 'malformed-record');
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new TransferError(`runs/${entry.id}.json is not valid JSON`, 'malformed-record');
    }
    const parsed = runRecordSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TransferError(
        `runs/${entry.id}.json is not a valid run record${issue ? ` (${issue.path.join('.')}: ${issue.message})` : ''}`,
        'malformed-record',
      );
    }
    if (parsed.data.id !== entry.id) {
      throw new TransferError(`runs/${entry.id}.json holds a different task (${parsed.data.id})`, 'malformed-record');
    }
    if (!isTerminalRunStatus(parsed.data.status)) {
      throw new TransferError(
        `task ${entry.id.slice(0, 8)} is ${parsed.data.status} — a live or open task cannot be imported; finish or stop it on the source machine first`,
        'not-terminal',
      );
    }
    records.set(entry.id, parsed.data);
  }

  // The git bundle: present iff branches were exported. A missing declared ref means the record
  // imports WITHOUT a worktree (diff unavailable) rather than failing the import. The bundle
  // lives INSIDE the tgz, so git needs it extracted to a scratch file first.
  const gitHeads = files.has(BRANCHES_FILE)
    ? await withGitBundle(files, async (bundleFile) => {
        const problem = await verifyBundle(opts.repoRoot, bundleFile);
        if (problem) throw new TransferError(`the bundle's git bundle is unusable: ${problem}`, 'git-failed');
        return bundleHeads(bundleFile, opts.repoRoot);
      })
    : undefined;
  const heads = gitHeads ?? new Map<string, string>();

  const fetch: string[] = [];
  for (const branch of manifest.branches) {
    if (!isSafeGitRef(branch)) {
      throw new TransferError(`bundle declares an unsafe branch name: ${branch}`, 'malformed-record');
    }
    const bundled = heads.get(`refs/heads/${branch}`);
    if (bundled === undefined) {
      warnings.push(`branch ${branch} is declared but not packed in the bundle — its task imports without a worktree`);
      continue;
    }
    const local = await localRefSha(opts.repoRoot, branch);
    if (local === undefined) {
      fetch.push(branch);
      continue;
    }
    if (local !== bundled) {
      throw new TransferError(
        `branch ${branch} already exists locally at ${local.slice(0, 10)} but the bundle has ${bundled.slice(0, 10)} — ` +
          'delete or reconcile the local branch before importing (nothing was written)',
        'branch-conflict',
      );
    }
  }

  const known = await (opts.knownProfiles ?? knownProfileIds)();
  const entries: ImportPlanEntry[] = [];
  for (const run of manifest.runs) {
    const record = records.get(run.id)!;
    const entryWarnings: string[] = [];
    const profileIds = new Set<string>();
    if (record.agentProfile) profileIds.add(record.agentProfile);
    for (const step of record.steps) if (step.profileId) profileIds.add(step.profileId);
    for (const id of profileIds) {
      if (id !== DEFAULT_AGENT_ACCOUNT_ID && !known.has(id)) {
        entryWarnings.push(
          `agent account "${id}" does not exist on this machine — add it before continuing this task`,
        );
      }
    }
    const branch = record.branch;
    const bundled = Boolean(branch && heads.has(`refs/heads/${branch}`));
    entries.push({
      id: record.id,
      title: record.title,
      status: record.status,
      action: opts.store.getRun(record.id) ? 'replace' : 'create',
      ...(branch ? { branch } : {}),
      worktree: bundled ? 'materialize' : 'none',
      ...(bundled ? { worktreePath: worktreePathFor(opts.repoRoot, record.id) } : {}),
      warnings: entryWarnings,
    });
  }
  if (manifest.branches.length === 0 && manifest.runs.some((run) => run.branch)) {
    warnings.push('this bundle carries no branches — imported tasks have no worktree and no diff');
  }
  return {
    manifest,
    bundlePath: opts.bundlePath,
    entries,
    warnings,
    fetch,
    records,
    files,
  };
}

/**
 * Normalize one imported record for THIS machine. Pure, so the rules are pinned by unit tests
 * rather than by observing a store.
 *
 *  - `handoff.direction = 'in'` — Continue will open a fresh session seeded by the journal.
 *  - every step `sessionId` cleared: a session id only means something inside the config dir
 *    that created it, and this machine has neither that dir nor the session.
 *  - `autoResumeAt`/`autoResumeAttempts`/`monitoringWakeAt`/`monitoringWakeCapReached`/
 *    `activity`/`askParked` cleared: without this `recover()` re-arms a usage-limit resume from
 *    the source's stale deadline and launches an agent at boot.
 *  - `worktreePath` becomes the destination's own path, or is dropped when no worktree was
 *    materialized (a branch that did not travel; the diff is simply unavailable).
 */
export function normalizeImportedRun(
  record: RunRecord,
  opts: { at: string; peer?: string; worktreePath?: string },
): RunRecord {
  const next = JSON.parse(JSON.stringify(record)) as RunRecord;
  next.handoff = { direction: 'in', at: opts.at, ...(opts.peer ? { peer: opts.peer } : {}) };
  delete next.autoResumeAt;
  delete next.autoResumeAttempts;
  delete next.monitoringWakeAt;
  delete next.monitoringWakeCapReached;
  delete next.activity;
  delete next.askParked;
  for (const step of next.steps) delete step.sessionId;
  if (opts.worktreePath) {
    next.worktreePath = opts.worktreePath;
    delete next.worktreeReclaimedAt;
  } else if (next.worktree !== false) {
    delete next.worktreePath;
    delete next.worktreeReclaimedAt;
  }
  return next;
}

/**
 * Write one bundle file beside the destination's records. Skipped when the bundle does not carry
 * it; best-effort per file so a read-only path cannot half-import a record set — the store's
 * `importRun` still runs, and a missing transcript degrades to an empty thread.
 */
function copyRunFile(bytes: Buffer | undefined, destination: string): void {
  if (!bytes) return;
  try {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  } catch {
    // best effort — the record itself is the authoritative half
  }
}

/**
 * Apply a plan: fetch branches, reattach worktrees, upsert records. A worktree that cannot be
 * created degrades (the record imports without one, with a warning) — the file migration must
 * not fail wholesale because one directory is in the way.
 */
export async function importBundle(opts: ImportOptions): Promise<ImportResult> {
  const plan = await planImport(opts);
  const at = (opts.now ?? (() => new Date().toISOString()))();
  await withGitBundle(plan.files, (bundleFile) => fetchBundleRefs(opts.repoRoot, bundleFile, plan.fetch));
  const imported: string[] = [];
  for (const entry of plan.entries) {
    const record = plan.records.get(entry.id)!;
    let worktreePath: string | undefined;
    if (entry.worktree === 'materialize') {
      const base = record.baseBranch && isSafeGitRef(record.baseBranch) ? record.baseBranch : 'HEAD';
      try {
        worktreePath = (await createWorktree(opts.repoRoot, record.id, base)).path;
      } catch (err) {
        plan.warnings.push(
          `could not reattach the worktree for ${entry.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)} — its diff will be unavailable`,
        );
      }
    }
    // The transcript and the journal are plain files beside the record and travel as-is. Writing
    // them BEFORE `importRun` means a record never appears in the index without the files a
    // reader (the cockpit's thread, Continue's CEZ_HANDOFF_FILE) will look for next.
    copyRunFile(plan.files.get(eventsFilePath(entry.id)), join(opts.dataDir, 'runs', `${entry.id}.ndjson`));
    copyRunFile(plan.files.get(journalFilePath(entry.id)), join(opts.dataDir, 'runs', `${entry.id}.handoff.md`));
    const normalized = normalizeImportedRun(record, {
      at,
      ...(opts.peer ? { peer: opts.peer } : {}),
      ...(worktreePath ? { worktreePath } : {}),
    });
    const result = opts.store.importRun(normalized);
    if (!result.ok) {
      // The plan already validated every record, so this can only be a store-level surprise;
      // surfacing it beats writing a half-imported set silently.
      throw new TransferError(`could not import task ${entry.id.slice(0, 8)}: ${result.error}`, 'malformed-record');
    }
    imported.push(entry.id);
  }
  return { plan, imported };
}