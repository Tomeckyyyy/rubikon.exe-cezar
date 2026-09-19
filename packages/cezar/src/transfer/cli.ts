import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getRepoInfo } from '../server/git.ts';
import { handoffBundleDir } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import type { RunRecord } from '../runs/store.ts';
import { defaultBundleName, exportRuns } from './export.ts';
import { importBundle, listBundles, planImport, resolveRegisteredProject } from './import.ts';
import { findLiveInstance, liveInstanceRefusal } from './live.ts';
import { TransferError } from './manifest.ts';
import { pushBundle, remoteImportInstructions, validateSshHost, type RunTransferCommand } from './ssh.ts';

/**
 * `cez handoff …` (spec `.ai/specs/2026-09-19-cross-machine-task-handoff.md`) — the CLI half of
 * the cross-machine task handoff. Routed before the cockpit's `parseArgs` in `index.ts` exactly
 * like `cez task` and `cez automation`, because it owns its flags (`--out`, `--to`, `--dry-run`).
 *
 * Everything here is a thin shell over `transfer/{export,import,ssh,live}.ts`; the store is
 * opened read-mostly and flushed after a write, and a live cockpit for the target project is a
 * refusal, never a race (see `live.ts`).
 */

const USAGE = `cez handoff — move finished tasks between machines

Usage:
  cez handoff export [<runId> | --all] [--out <file>] [--repo <dir>]
      pack finished tasks — records, transcripts, handoff journals and cez/* branches —
      into one portable bundle. Default: ~/.cache/cez/handoff/<project>-<stamp>.tgz;
      --out - streams the bundle to stdout (logs then go to stderr)
  cez handoff import <bundle> [--repo <dir>] [--dry-run] [--peer <label>]
      validate and import a bundle into THIS (registered) project. <bundle> may be a
      file path or a name from ~/.cache/cez/handoff/. --dry-run prints what would happen
  cez handoff push --to <[user@]host> [<runId> | --all] [--repo <dir>]
      export, copy the bundle to that host over ssh, then PRINT (never run) the
      stop → import → start commands for it
  cez handoff list
      bundles waiting in ~/.cache/cez/handoff/
  cez handoff unmark <runId> | --all [--repo <dir>]
      clear the handed-off mark so this machine can continue the task again

Only terminal tasks travel: done, failed, cancelled, review. Vendor session files and
credentials never do — the destination's Continue starts a fresh session seeded by the
task's handoff journal.`;

export interface HandoffCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** This cezar's version, stamped into the manifest. */
  version: string;
  cwd: string;
  now: () => string;
  /** SSH command runner; tests inject a fake. */
  runCommand?: RunTransferCommand;
  /** Asked before `push` opens the network (TTY only by default). */
  confirm?: (question: string) => Promise<boolean>;
  /** Where bundles live — injectable for tests; defaults to `~/.cache/cez/handoff`. */
  bundleDir: string;
}

async function ttyConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function ioWithDefaults(io: Partial<HandoffCliIo>): HandoffCliIo {
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    version: '0.0.0',
    cwd: process.cwd(),
    now: () => new Date().toISOString(),
    bundleDir: handoffBundleDir(),
    ...io,
  };
}

/** Resolve the target repo the way the top-level CLI does (a subdirectory still works). */
async function resolveRepo(dir: string): Promise<string> {
  const resolved = resolve(dir);
  const info = await getRepoInfo(resolved);
  return info?.root ?? resolved;
}

function dataDirOf(repoRoot: string): string {
  return join(repoRoot, '.ai', 'cezar');
}

/** Open the project's store for a mutating command. Export and unmark require existing state —
 *  an empty repo has nothing to hand off, and opening a store would silently create
 *  `.ai/cezar/runs/`. Import is the exception: a fresh destination has no `runs.json` yet, and
 *  the file it writes is the point. */
function openStore(repoRoot: string, opts: { allowCreate?: boolean } = {}): RunStore {
  const dataDir = dataDirOf(repoRoot);
  if (!opts.allowCreate && !existsSync(join(dataDir, 'runs.json'))) {
    throw new TransferError(`this project has no cezar tasks yet (${join(dataDir, 'runs.json')} is missing)`, 'nothing-to-export');
  }
  return RunStore.open(dataDir, { keepLive: true });
}

/** The shared "a live cockpit owns this project" gate for every mutating command. */
function assertNoLiveInstance(repoRoot: string): void {
  const live = findLiveInstance(repoRoot);
  if (live) throw new TransferError(liveInstanceRefusal(live), 'live-instance');
}

/** Resolve one run by exact id or unique prefix — `unmark` does not care about status. */
function resolveRun(runs: readonly RunRecord[], input: string): RunRecord {
  const matches = runs.filter((run) => run.id === input || run.id.startsWith(input));
  if (matches.length === 0) throw new TransferError(`no task in this project matches "${input}"`, 'unknown-run');
  if (matches.length > 1) {
    throw new TransferError(`"${input}" matches ${matches.length} tasks — use the full task id`, 'unknown-run');
  }
  return matches[0]!;
}

function printPlan(
  io: HandoffCliIo,
  plan: Awaited<ReturnType<typeof planImport>>,
  dryRun: boolean,
): void {
  const m = plan.manifest;
  io.log(`bundle:  ${plan.bundlePath}`);
  io.log(
    `from:    ${m.cezarVersion}${m.sourceProjectId ? ` · project "${m.sourceProjectId}"` : ''} · created ${m.createdAt}`,
  );
  io.log('');
  io.log('tasks:');
  for (const entry of plan.entries) {
    const id = entry.id.slice(0, 8);
    const worktree =
      entry.worktree === 'materialize' ? `worktree ${entry.worktreePath}` : 'no worktree (branch not in the bundle)';
    io.log(`  ${entry.action.padEnd(8)} ${entry.status.padEnd(9)} ${id}  ${JSON.stringify(entry.title)}`);
    io.log(`           ${worktree}`);
  }
  if (plan.fetch.length > 0) io.log(`branches to fetch: ${plan.fetch.join(', ')}`);
  const warnings = [...plan.warnings, ...plan.entries.flatMap((entry) => entry.warnings)];
  if (warnings.length > 0) {
    io.log('');
    io.log('warnings:');
    for (const warning of warnings) io.log(`  - ${warning}`);
  }
  io.log('');
  io.log(dryRun ? 'dry run — nothing was written.' : `imported ${plan.entries.length} task(s).`);
}

// ---- export ------------------------------------------------------------------

async function exportCommand(io: HandoffCliIo, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      out: { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  const runIds = positionals.slice(1);
  if (values.all && runIds.length > 0) {
    throw new TransferError('pass either a task id or --all, not both', 'nothing-to-export');
  }
  const repoRoot = await resolveRepo(values.repo ?? io.cwd);
  assertNoLiveInstance(repoRoot);
  const toStdout = values.out === '-';
  const log = toStdout ? io.error : io.log;
  const store = openStore(repoRoot);
  try {
    const project = await resolveRegisteredProject(repoRoot);
    const result = await exportRuns({
      repoRoot,
      dataDir: dataDirOf(repoRoot),
      store,
      runIds,
      all: values.all,
      cezarVersion: io.version,
      ...(project ? { sourceProjectId: project.id } : {}),
      now: io.now,
      ...(toStdout
        ? { sink: (bytes: Buffer) => new Promise<void>((res, rej) => process.stdout.write(bytes, (err) => (err ? rej(err) : res()))) }
        : { outPath: values.out ? resolve(values.out) : join(io.bundleDir, defaultBundleName(project?.id ?? basename(repoRoot), io.now)) }),
    });
    for (const note of result.notes) log(`  ! ${note}`);
    log(`exported ${result.runs.length} task(s) to ${result.bundlePath ?? 'stdout'}`);
    if (result.branches.length > 0) log(`  branches: ${result.branches.join(', ')}`);
    log('  each task is now marked handed-off — this machine will not continue it until `cez handoff unmark`');
    return 0;
  } finally {
    store.flush();
  }
}

// ---- import ------------------------------------------------------------------

async function importCommand(io: HandoffCliIo, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      peer: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  const input = positionals[1];
  if (!input) throw new TransferError('import needs a bundle: cez handoff import <bundle> [--repo <dir>]', 'not-a-bundle');
  const bundlePath = resolveBundleRef(input, io.cwd, io.bundleDir);
  const repoRoot = await resolveRepo(values.repo ?? io.cwd);
  const project = await resolveRegisteredProject(repoRoot);
  if (!project) {
    throw new TransferError(
      `this project is not registered — add it first with: cez projects add ${repoRoot}`,
      'not-registered',
    );
  }
  const store = openStore(repoRoot, { allowCreate: true });
  try {
    if (values['dry-run']) {
      const plan = await planImport({ repoRoot, dataDir: dataDirOf(repoRoot), store, bundlePath, now: io.now });
      printPlan(io, plan, true);
      return 0;
    }
    assertNoLiveInstance(repoRoot);
    const result = await importBundle({
      repoRoot,
      dataDir: dataDirOf(repoRoot),
      store,
      bundlePath,
      now: io.now,
      ...(values.peer ? { peer: values.peer } : {}),
    });
    printPlan(io, result.plan, false);
    io.log('Continue on an imported task starts a fresh session seeded by its handoff journal.');
    return 0;
  } finally {
    store.flush();
  }
}

/** A bundle argument may be a path or a name from the handoff cache. */
function resolveBundleRef(input: string, cwd: string, bundleDir: string): string {
  if (existsSync(input)) return resolve(input);
  const fromCache = join(bundleDir, input);
  if (existsSync(fromCache)) return fromCache;
  if (isAbsolute(input) || input.includes('/')) {
    throw new TransferError(`cannot read bundle ${resolve(cwd, input)}`, 'not-a-bundle');
  }
  throw new TransferError(
    `no bundle named "${input}" in ${bundleDir} — pass a path, or run \`cez handoff list\``,
    'not-a-bundle',
  );
}

// ---- list --------------------------------------------------------------------

function listCommand(io: HandoffCliIo): number {
  const bundles = listBundles(io.bundleDir);
  if (bundles.length === 0) {
    io.log(`no bundles in ${io.bundleDir}`);
    return 0;
  }
  for (const bundle of bundles) {
    const mb = (bundle.sizeBytes / 1024 / 1024).toFixed(1);
    io.log(`  ${bundle.name}  ${mb} MB  ${bundle.modifiedAt}`);
  }
  io.log('');
  io.log(`import one with: cez handoff import <name> --repo <project>`);
  return 0;
}

// ---- push --------------------------------------------------------------------

async function pushCommand(io: HandoffCliIo, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      repo: { type: 'string' },
      all: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  const host = values.to?.trim();
  if (!host) throw new TransferError('push needs a target: cez handoff push --to <[user@]host>', 'ssh-failed');
  // Validate BEFORE exporting: an unusable host must not leave a bundle — or a handed-off mark —
  // on this machine.
  const hostProblem = validateSshHost(host);
  if (hostProblem) throw new TransferError(hostProblem, 'ssh-failed');
  const runIds = positionals.slice(1);
  if (values.all && runIds.length > 0) {
    throw new TransferError('pass either a task id or --all, not both', 'nothing-to-export');
  }
  const repoRoot = await resolveRepo(values.repo ?? io.cwd);
  assertNoLiveInstance(repoRoot);

  // Ask BEFORE exporting: a declined transfer must not leave the tasks marked handed-off.
  if (!values.yes) {
    const ask = io.confirm ?? (process.stdin.isTTY && process.stderr.isTTY ? ttyConfirm : undefined);
    if (ask) {
      const ok = await ask(`Export and copy the bundle to ${host} over ssh?`);
      if (!ok) {
        io.log('cancelled — nothing was exported.');
        return 0;
      }
    }
  }

  const store = openStore(repoRoot);
  try {
    const bundlePath = join(
      io.bundleDir,
      defaultBundleName((await resolveRegisteredProject(repoRoot))?.id ?? basename(repoRoot), io.now),
    );
    const result = await exportRuns({
      repoRoot,
      dataDir: dataDirOf(repoRoot),
      store,
      runIds,
      all: values.all,
      outPath: bundlePath,
      cezarVersion: io.version,
      peer: host,
      now: io.now,
    });
    for (const note of result.notes) io.log(`  ! ${note}`);
    io.log(`exported ${result.runs.length} task(s) — copying ${basename(bundlePath)} to ${host} …`);
    try {
      const pushed = await pushBundle({
        host,
        localPath: bundlePath,
        run: io.runCommand,
        log: io.log,
      });
      io.log('');
      io.log(`transferred → ${host}:${pushed.remotePath}`);
      io.log('');
      io.log('Next, on that machine (cezar never stops or starts the remote service for you):');
      for (const line of remoteImportInstructions(host, pushed.remotePath)) io.log(line);
      return 0;
    } catch (err) {
      // The bundle never left this machine, so the handed-off mark must not stick. Revert ONLY
      // the marks this command wrote — a task already handed off before keeps its state.
      for (const id of result.marked) store.updateRun(id, { handoff: undefined });
      throw err;
    }
  } finally {
    store.flush();
  }
}

// ---- unmark ------------------------------------------------------------------

async function unmarkCommand(io: HandoffCliIo, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  const input = positionals[1];
  if (!values.all && !input) {
    throw new TransferError('unmark needs a task id or --all', 'unknown-run');
  }
  if (values.all && input) throw new TransferError('pass either a task id or --all, not both', 'unknown-run');
  const repoRoot = await resolveRepo(values.repo ?? io.cwd);
  assertNoLiveInstance(repoRoot);
  const store = openStore(repoRoot);
  try {
    const runs = store.listRuns();
    const targets = values.all ? runs.filter((run) => run.handoff !== undefined) : [resolveRun(runs, input!)];
    let count = 0;
    for (const run of targets) {
      if (run.handoff === undefined) continue;
      store.updateRun(run.id, { handoff: undefined });
      count++;
    }
    io.log(
      count === 0
        ? 'no handed-off task to unmark'
        : `unmarked ${count} task(s) — this machine can continue them again`,
    );
    return 0;
  } finally {
    store.flush();
  }
}

// ---- dispatch ----------------------------------------------------------------

export async function runHandoffCommand(args: string[], partial: Partial<HandoffCliIo> = {}): Promise<number> {
  const io = ioWithDefaults(partial);
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    io.log(USAGE);
    return sub ? 0 : 1;
  }
  try {
    switch (sub) {
      case 'export':
        return await exportCommand(io, args);
      case 'import':
        return await importCommand(io, args);
      case 'list':
      case 'ls':
        return listCommand(io);
      case 'push':
        return await pushCommand(io, args);
      case 'unmark':
        return await unmarkCommand(io, args);
      default:
        io.error(`unknown handoff command: ${sub}\n`);
        io.log(USAGE);
        return 1;
    }
  } catch (err) {
    if (err instanceof TransferError) {
      io.error(err.message);
      return 1;
    }
    throw err;
  }
}