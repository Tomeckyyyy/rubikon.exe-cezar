import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { branchFor, createWorktree, removeWorktree } from '../git-worktree.ts';
import { seedHandoffFile } from '../handoff.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from '../workflows/run.ts';
import { MANIFEST_FILE, parseManifest, unpackBundle } from './bundle.ts';
import { exportRuns, selectExportableRuns } from './export.ts';
import { importBundle, normalizeImportedRun, planImport, resolveRegisteredProject } from './import.ts';
import { TransferError } from './manifest.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) runner would receive — the "nothing launches on import" assertion. */
const captured = vi.hoisted(() => ({ specs: [] as unknown[] }));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: unknown) => {
      captured.specs.push(spec);
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

const roots: string[] = [];
const opened: RunStore[] = [];

/** Every store the test opens is flushed before its temp tree goes away — a debounced save
 *  landing after teardown is the one way this suite produces noise. */
function openStore(dataDir: string): RunStore {
  const store = RunStore.open(dataDir);
  opened.push(store);
  return store;
}

async function fixtureRepo(prefix: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

const frozen = () => new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

describe('export → import round trip', () => {
  let source: string;
  let sourceData: string;
  let store: RunStore;
  let bundlePath: string;
  let doneId: string;
  let failedId: string;
  let runningId: string;

  beforeEach(async () => {
    captured.specs.length = 0;
    source = await fixtureRepo('cez-transfer-src-');
    sourceData = join(source, '.ai/cezar');
    store = openStore(sourceData);
    const outDir = mkdtempSync(join(tmpdir(), 'cez-transfer-out-'));
    roots.push(outDir);
    bundlePath = join(outDir, 'bundle.tgz');

    // A finished task with a real branch, worktree, transcript and journal.
    const done = store.createRun({
      title: 'add the widget',
      workflow: 'quick-task',
      task: 'add the widget',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    doneId = done.id;
    const worktree = await createWorktree(source, doneId, 'main');
    writeFileSync(join(worktree.path, 'widget.txt'), 'widget\n');
    await run('git', ['add', '-A'], { cwd: worktree.path });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'widget'], { cwd: worktree.path });
    store.updateRun(doneId, {
      status: 'done',
      finishedAt: '2026-09-19T09:00:00.000Z',
      branch: branchFor(doneId),
      baseBranch: 'main',
      worktreePath: worktree.path,
    });
    store.updateStep(doneId, 'work', { status: 'done', sessionId: 'sess-src-1', backend: 'claude' });
    store.appendEvent(doneId, { type: 'user-message', text: 'add the widget' });
    store.appendEvent(doneId, { type: 'text', text: 'widget added' });
    seedHandoffFile(sourceData, {
      id: doneId,
      title: 'add the widget',
      workflow: 'quick-task',
      task: 'add the widget',
      branch: branchFor(doneId),
      worktreePath: worktree.path,
    });

    // A failed task with a pending usage-limit resume and a recorded session — both dead ends
    // on the destination, and the source must stop waiting on them too.
    const failed = store.createRun({
      title: 'fix the flaky test',
      workflow: 'quick-task',
      task: 'fix the flaky test',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      agentProfile: 'work',
    });
    failedId = failed.id;
    store.updateRun(failedId, {
      status: 'failed',
      finishedAt: '2026-09-19T09:30:00.000Z',
      error: 'Claude AI usage limit reached|1756166400',
      autoResumeAt: '2026-09-20T00:00:00.000Z',
      autoResumeAttempts: 2,
    });
    store.updateStep(failedId, 'work', { status: 'failed', sessionId: 'sess-src-2', backend: 'claude' });

    // A live task: never exportable.
    const running = store.createRun({
      title: 'still working',
      workflow: 'quick-task',
      task: 'still working',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    runningId = running.id;
    store.updateRun(runningId, { status: 'running', startedAt: '2026-09-19T09:45:00.000Z' });
  });

  afterEach(() => {
    store.flush();
    for (const openedStore of opened.splice(0)) openedStore.flush();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('exports only terminal tasks and marks them handed-off after the durable write', async () => {
    const result = await exportRuns({
      repoRoot: source,
      dataDir: sourceData,
      store,
      all: true,
      outPath: bundlePath,
      cezarVersion: '0.0.0-test',
      sourceProjectId: 'src',
      now: () => '2026-09-19T10:00:00.000Z',
    });

    expect(result.runs.map((r) => r.id).sort()).toEqual([doneId, failedId].sort());
    expect(result.branches).toEqual([branchFor(doneId)]);
    expect(result.marked.sort()).toEqual([doneId, failedId].sort());
    expect(existsSync(bundlePath)).toBe(true);

    expect(store.getRun(doneId)?.handoff).toEqual({ direction: 'out', at: '2026-09-19T10:00:00.000Z' });
    // The source stops waiting for a usage-limit reset the destination now owns.
    expect(store.getRun(failedId)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(failedId)?.autoResumeAttempts).toBeUndefined();
    // A live task is untouched by an --all export.
    expect(store.getRun(runningId)?.handoff).toBeUndefined();

    // Bundle contents: manifest, records, transcript and journal.
    const files = unpackBundle(readFileSync(bundlePath));
    const manifest = parseManifest(files);
    expect(manifest.runs.map((entry) => entry.id).sort()).toEqual([doneId, failedId].sort());
    expect(manifest.runs.find((entry) => entry.id === doneId)?.branch).toBe(branchFor(doneId));
    expect(files.has(`runs/${doneId}.json`)).toBe(true);
    expect(files.get(`runs/${doneId}.ndjson`)?.toString('utf8')).toContain('widget added');
    expect(files.get(`runs/${doneId}.handoff.md`)?.toString('utf8')).toContain('## Progress log');
    expect(files.has('branches.bundle')).toBe(true);
    expect(files.has(MANIFEST_FILE)).toBe(true);
  });

  it('refuses a live task by name, exporting nothing', async () => {
    await expect(
      exportRuns({
        repoRoot: source,
        dataDir: sourceData,
        store,
        runIds: [runningId],
        outPath: bundlePath,
        cezarVersion: '0.0.0-test',
      }),
    ).rejects.toThrow(/is running/);
    expect(existsSync(bundlePath)).toBe(false);
    expect(store.getRun(runningId)?.handoff).toBeUndefined();
  });

  it('marks nothing when the bundle cannot be written', async () => {
    store.flush(); // make runs.json a real file, so the child path below cannot be created
    // The destination's parent is an existing FILE, so the durable write must fail.
    const blocked = join(sourceData, 'runs.json', 'bundle.tgz');
    await expect(
      exportRuns({
        repoRoot: source,
        dataDir: sourceData,
        store,
        all: true,
        outPath: blocked,
        cezarVersion: '0.0.0-test',
        now: () => '2026-09-19T10:00:00.000Z',
      }),
    ).rejects.toThrow(/could not write the bundle/);
    expect(existsSync(blocked)).toBe(false);
    expect(store.getRun(doneId)?.handoff).toBeUndefined();
    // Not even the source-side auto-resume cleanup happened: the write is the commit point.
    expect(store.getRun(failedId)?.autoResumeAt).toBe('2026-09-20T00:00:00.000Z');
  });

  it('imports into a second repo: records, worktrees, statuses, no launch', async () => {
    await exportRuns({
      repoRoot: source,
      dataDir: sourceData,
      store,
      all: true,
      outPath: bundlePath,
      cezarVersion: '0.0.0-test',
      sourceProjectId: 'src',
      now: () => '2026-09-19T10:00:00.000Z',
    });

    const destination = await fixtureRepo('cez-transfer-dst-');
    const destData = join(destination, '.ai/cezar');
    const destStore = openStore(destData);

    // Plan first: read-only, and it names the destination worktree path.
    const plan = await planImport({
      repoRoot: destination,
      store: destStore,
      dataDir: destData,
      bundlePath,
      knownProfiles: async () => new Set(['default']),
    });
    expect(plan.entries.map((entry) => entry.id).sort()).toEqual([doneId, failedId].sort());
    expect(plan.entries.every((entry) => entry.action === 'create')).toBe(true);
    expect(plan.fetch).toEqual([branchFor(doneId)]);
    expect(destStore.getRun(doneId)).toBeUndefined();
    expect(plan.entries.find((entry) => entry.id === failedId)?.warnings).toContain(
      'agent account "work" does not exist on this machine — add it before continuing this task',
    );

    const result = await importBundle({
      repoRoot: destination,
      store: destStore,
      dataDir: join(destination, '.ai/cezar'),
      bundlePath,
      knownProfiles: async () => new Set(['default']),
      now: () => '2026-09-19T11:00:00.000Z',
    });
    expect(result.imported.sort()).toEqual([doneId, failedId].sort());
    destStore.flush();

    const importedDone = destStore.getRun(doneId)!;
    expect(importedDone.status).toBe('done');
    expect(importedDone.handoff).toEqual({ direction: 'in', at: '2026-09-19T11:00:00.000Z' });
    expect(importedDone.worktreePath).toBe(join(destination, '.ai/cezar/worktrees', doneId));
    expect(existsSync(importedDone.worktreePath!)).toBe(true);
    expect(importedDone.steps.find((step) => step.id === 'work')?.sessionId).toBeUndefined();
    // The transcript and journal travelled.
    expect(destStore.readEvents(doneId).some((event) => event.text === 'widget added')).toBe(true);
    expect(readFileSync(join(destData, 'runs', `${doneId}.handoff.md`), 'utf8')).toContain('## Progress log');

    const importedFailed = destStore.getRun(failedId)!;
    expect(importedFailed.status).toBe('failed');
    expect(importedFailed.handoff).toEqual({ direction: 'in', at: '2026-09-19T11:00:00.000Z' });
    expect(importedFailed.autoResumeAt).toBeUndefined();
    expect(importedFailed.autoResumeAttempts).toBeUndefined();
    expect(importedFailed.worktreePath).toBeUndefined(); // no branch travelled for it
    expect(importedFailed.steps.find((step) => step.id === 'work')?.sessionId).toBeUndefined();

    // The branch exists at the source commit, checked out in the task's own worktree.
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: importedDone.worktreePath! })).stdout.trim();
    const sourceHead = (await run('git', ['rev-parse', branchFor(doneId)], { cwd: source })).stdout.trim();
    expect(head).toBe(sourceHead);

    // Booting the destination constructs no runner: nothing is live, nothing has a session.
    expect(captured.specs).toHaveLength(0);
    const manager = new RunManager(destStore, destination, { semaphore: frozen() });
    await manager.recover();
    manager.dispose();
    expect(captured.specs).toHaveLength(0);
    expect(destStore.listRuns().every((r) => ['done', 'failed', 'cancelled', 'review'].includes(r.status))).toBe(true);

    // Idempotent: a second import (an interrupted transfer re-run) changes nothing.
    const again = await importBundle({
      repoRoot: destination,
      store: destStore,
      dataDir: join(destination, '.ai/cezar'),
      bundlePath,
      knownProfiles: async () => new Set(['default']),
    });
    expect(again.imported.sort()).toEqual([doneId, failedId].sort());
    expect(destStore.getRun(doneId)?.worktreePath).toBe(importedDone.worktreePath);
  });

  it('refuses when the same branch exists locally at a different commit', async () => {
    await exportRuns({
      repoRoot: source,
      dataDir: sourceData,
      store,
      all: true,
      outPath: bundlePath,
      cezarVersion: '0.0.0-test',
    });
    const destination = await fixtureRepo('cez-transfer-conflict-');
    const destStore = openStore(join(destination, '.ai/cezar'));
    // A local branch with the same name but unrelated work.
    await run('git', ['checkout', '-q', '-b', branchFor(doneId)], { cwd: destination });
    writeFileSync(join(destination, 'local.txt'), 'local\n');
    await run('git', ['add', '-A'], { cwd: destination });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'local work'], { cwd: destination });

    await expect(
      importBundle({
        repoRoot: destination,
        store: destStore,
        dataDir: join(destination, '.ai/cezar'),
        bundlePath,
        knownProfiles: async () => new Set(['default']),
      }),
    ).rejects.toThrow(TransferError);
    await expect(
      importBundle({
        repoRoot: destination,
        store: destStore,
        dataDir: join(destination, '.ai/cezar'),
        bundlePath,
        knownProfiles: async () => new Set(['default']),
      }),
    ).rejects.toThrow(/already exists locally/);
    expect(destStore.getRun(doneId)).toBeUndefined();
  });

  it('imports a task whose branch never travelled, without a worktree', async () => {
    // Remove the branch before exporting: the record still travels, the diff does not.
    const worktreePath = store.getRun(doneId)!.worktreePath!;
    await removeWorktree(source, worktreePath); // directory only — the branch is kept
    await run('git', ['branch', '-D', branchFor(doneId)], { cwd: source });
    const result = await exportRuns({
      repoRoot: source,
      dataDir: sourceData,
      store,
      runIds: [doneId],
      outPath: bundlePath,
      cezarVersion: '0.0.0-test',
    });
    expect(result.branches).toEqual([]);
    expect(result.notes.join('\n')).toContain('imports without a worktree');

    const destination = await fixtureRepo('cez-transfer-nobranch-');
    const destStore = openStore(join(destination, '.ai/cezar'));
    const imported = await importBundle({
      repoRoot: destination,
      store: destStore,
      dataDir: join(destination, '.ai/cezar'),
      bundlePath,
      knownProfiles: async () => new Set(['default']),
    });
    expect(imported.imported).toEqual([doneId]);
    expect(destStore.getRun(doneId)?.worktreePath).toBeUndefined();
  });

  it('finds the destination project in the registry, and only when it is registered', async () => {
    const destination = await fixtureRepo('cez-transfer-registry-');
    expect(await resolveRegisteredProject(destination)).toBeNull();
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push({
        id: 'dest-proj',
        root: destination,
        name: 'dest',
        addedAt: '2026-09-19T00:00:00.000Z',
        lastOpenedAt: '2026-09-19T00:00:00.000Z',
        source: 'local',
      });
    });
    expect(await resolveRegisteredProject(destination)).toEqual({ id: 'dest-proj', root: destination });
  });
});

describe('normalizeImportedRun', () => {
  const base: RunRecord = {
    id: 'r1',
    title: 't',
    workflow: 'quick-task',
    task: 't',
    status: 'failed' as const,
    createdAt: '2026-09-19T00:00:00.000Z',
    finishedAt: '2026-09-19T01:00:00.000Z',
    tokensUsed: 5,
    archived: false,
    autoResumeAt: '2026-09-20T00:00:00.000Z',
    autoResumeAttempts: 3,
    monitoringWakeAt: '2026-09-20T00:00:00.000Z',
    monitoringWakeCapReached: true,
    activity: 'monitoring' as const,
    askParked: true,
    error: 'usage limit',
    branch: 'cez/1234abcd',
    worktreePath: '/laptop/.ai/cezar/worktrees/r1',
    worktreeReclaimedAt: '2026-09-19T02:00:00.000Z',
    steps: [
      { id: 'work', name: 'Work', kind: 'agent' as const, status: 'failed' as const, iterations: 1, tokensUsed: 5, sessionId: 'sess-1', backend: 'claude' as const, profileId: 'work' },
    ],
  };

  it('clears every launch field, every session id and the source worktree path', () => {
    const next = normalizeImportedRun(base, { at: '2026-09-19T11:00:00.000Z', peer: 'vps.example.com' });
    expect(next.handoff).toEqual({ direction: 'in', at: '2026-09-19T11:00:00.000Z', peer: 'vps.example.com' });
    expect(next.autoResumeAt).toBeUndefined();
    expect(next.autoResumeAttempts).toBeUndefined();
    expect(next.monitoringWakeAt).toBeUndefined();
    expect(next.monitoringWakeCapReached).toBeUndefined();
    expect(next.activity).toBeUndefined();
    expect(next.askParked).toBeUndefined();
    expect(next.worktreePath).toBeUndefined();
    expect(next.worktreeReclaimedAt).toBeUndefined();
    expect(next.steps[0]?.sessionId).toBeUndefined();
    expect(next.error).toBe('usage limit'); // history stays
    // The input is never mutated.
    expect(base.worktreePath).toBe('/laptop/.ai/cezar/worktrees/r1');
    expect(base.steps[0]?.sessionId).toBe('sess-1');
  });

  it('takes the destination worktree path when one was materialized', () => {
    const next = normalizeImportedRun(base, { at: 'x', worktreePath: '/server/.ai/cezar/worktrees/r1' });
    expect(next.worktreePath).toBe('/server/.ai/cezar/worktrees/r1');
    expect(next.worktreeReclaimedAt).toBeUndefined();
  });

  it('keeps an in-place run in place', () => {
    const inPlace: RunRecord = { ...base, worktree: false, worktreePath: undefined, branch: undefined };
    const next = normalizeImportedRun(inPlace, { at: 'x' });
    expect(next.worktree).toBe(false);
    expect(next.worktreePath).toBeUndefined();
  });
});
/** The pure half of export selection: which terminal tasks travel, and the exact refusals. */
describe('selectExportableRuns', () => {
  const runAt = (id: string, status: RunRecord['status']): RunRecord => ({
    id,
    title: id,
    workflow: 'quick-task',
    task: id,
    status,
    createdAt: '2026-09-19T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
  });

  const RUNS = [
    runAt('aaaaaaaa-1', 'done'),
    runAt('bbbbbbbb-1', 'failed'),
    runAt('cccccccc-1', 'cancelled'),
    runAt('dddddddd-1', 'review'),
    runAt('eeeeeeee-1', 'queued'),
    runAt('ffffffff-1', 'running'),
    runAt('99999999-1', 'waiting'),
  ];

  it('takes every terminal status under --all and leaves the live ones out silently', () => {
    const result = selectExportableRuns(RUNS, { all: true });
    expect(result.selected.map((run) => run.id)).toEqual(['aaaaaaaa-1', 'bbbbbbbb-1', 'cccccccc-1', 'dddddddd-1']);
    expect(result.problems).toEqual([]);
  });

  it('names each live status in its own refusal when one is asked for', () => {
    const expectations: Array<[string, string]> = [
      ['eeeeeeee-1', 'is queued'],
      ['ffffffff-1', 'is running'],
      ['99999999-1', 'is waiting'],
    ];
    for (const [id, phrasing] of expectations) {
      const result = selectExportableRuns(RUNS, { runIds: [id] });
      expect(result.selected).toEqual([]);
      expect(result.problems[0]?.code).toBe('not-terminal');
      expect(result.problems[0]?.message).toContain(phrasing);
      expect(result.problems[0]?.message).toContain('export accepts done, failed, cancelled and review');
    }
  });

  it('takes a unique prefix, and refuses unknown or ambiguous ids', () => {
    const result = selectExportableRuns(RUNS, { runIds: ['aaaaaaaa'] });
    expect(result.selected.map((run) => run.id)).toEqual(['aaaaaaaa-1']);

    const duplicate = [...RUNS, runAt('aaaaaaaa-2', 'review')];
    const ambiguous = selectExportableRuns(duplicate, { runIds: ['aaaaaaaa'] });
    expect(ambiguous.selected).toEqual([]);
    expect(ambiguous.problems[0]?.code).toBe('unknown-run');
    expect(ambiguous.problems[0]?.message).toContain('matches 2 tasks');
  });

  it('requires a selection, and reports an empty project as nothing to export', () => {
    const nothing = selectExportableRuns(RUNS, {});
    expect(nothing.selected).toEqual([]);
    expect(nothing.problems[0]?.code).toBe('nothing-to-export');
    expect(nothing.problems[0]?.message).toContain('name a task id or pass --all');

    const empty = selectExportableRuns([runAt('live-1', 'running')], { all: true });
    expect(empty.selected).toEqual([]);
    expect(empty.problems[0]?.code).toBe('nothing-to-export');
    expect(empty.problems[0]?.message).toContain('no finished task');
  });
});
