import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchFor } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { exportRuns } from '../transfer/export.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

/**
 * The cross-machine handoff routes (spec `.ai/specs/2026-09-19-cross-machine-task-handoff.md`):
 * the cockpit's "Hand off" action, bundle listing/preview, import and unmark. `handoffDir` is
 * injected so the suite never touches `~/.cache/cez/handoff/`.
 */
describe('handoff API', () => {
  let repoRoot: string;
  let handoffDir: string;
  let store: RunStore;
  let app: Hono;
  let doneId: string;
  let runningId: string;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-handoff-api-'));
    handoffDir = mkdtempSync(join(tmpdir(), 'cez-handoff-api-cache-'));
    roots.push(repoRoot, handoffDir);
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });

    store = RunStore.open(join(repoRoot, '.ai/cezar'));

    const done = store.createRun({
      title: 'ship it',
      workflow: 'quick-task',
      task: 'ship it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    doneId = done.id;
    const branch = branchFor(doneId);
    await run('git', ['checkout', '-q', '-b', branch], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'work.txt'), 'work\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'work'], { cwd: repoRoot });
    await run('git', ['checkout', '-q', 'main'], { cwd: repoRoot });
    store.updateRun(doneId, { status: 'done', finishedAt: '2026-09-19T09:00:00.000Z', branch, baseBranch: 'main' });
    store.updateStep(doneId, 'work', { status: 'done' });

    const running = store.createRun({
      title: 'still going',
      workflow: 'quick-task',
      task: 'still going',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    runningId = running.id;
    store.updateRun(runningId, { status: 'running', startedAt: '2026-09-19T09:30:00.000Z' });

    app = createApp({
      repoRoot,
      store,
      manager: {} as unknown as RunManager,
      version: '0.0.0-test',
      handoffDir,
    });
  });

  afterEach(() => {
    store.flush();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const post = (path: string, body: unknown) =>
    apiRequest(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('starts with an empty shelf, exports every finished task on request, and lists it', async () => {
    const empty = await apiRequest(app, '/api/v1/handoff/bundles');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ bundles: [] });

    const exported = await post('/api/v1/handoff/export', { runs: [doneId] });
    expect(exported.status).toBe(200);
    const body = (await exported.json()) as {
      bundle: { name: string; sizeBytes: number; modifiedAt: string };
      runs: string[];
      branches: string[];
    };
    expect(body.bundle.name).toMatch(/\.tgz$/);
    expect(body.bundle.sizeBytes).toBeGreaterThan(0);
    expect(body.runs).toEqual([doneId]);
    expect(body.branches).toEqual([branchFor(doneId)]);
    // The mark rides the existing run record (and its SSE), so it is visible immediately.
    expect(store.getRun(doneId)?.handoff?.direction).toBe('out');

    const listed = (await (await apiRequest(app, '/api/v1/handoff/bundles')).json()) as { bundles: Array<{ name: string }> };
    expect(listed.bundles.map((bundle) => bundle.name)).toEqual([body.bundle.name]);
  });

  it('refuses a live task with 409 and the reason, exporting nothing', async () => {
    const res = await post('/api/v1/handoff/export', { runs: [runningId] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('is running');
    const listed = (await (await apiRequest(app, '/api/v1/handoff/bundles')).json()) as { bundles: unknown[] };
    expect(listed.bundles).toHaveLength(0);
  });

  it('answers 404 for a task this project does not have', async () => {
    const res = await post('/api/v1/handoff/export', { runs: ['no-such-run'] });
    expect(res.status).toBe(404);
  });

  it('previews a bundle as the plan an import would apply', async () => {
    await post('/api/v1/handoff/export', { runs: [doneId] });
    const name = (
      ((await (await apiRequest(app, '/api/v1/handoff/bundles')).json()) as { bundles: Array<{ name: string }> }).bundles[0]!
    ).name;

    const res = await apiRequest(app, `/api/v1/handoff/bundles/preview?name=${encodeURIComponent(name)}`);
    expect(res.status).toBe(200);
    const plan = (await res.json()) as {
      name: string;
      runs: Array<{ id: string; action: string; worktree: string; worktreePath?: string }>;
      fetch: string[];
      warnings: string[];
    };
    expect(plan.name).toBe(name);
    // The same project already holds the task and its branch: this is an upsert, no fetch.
    expect(plan.runs[0]).toMatchObject({ id: doneId, action: 'replace', worktree: 'materialize' });
    expect(plan.runs[0]?.worktreePath).toBe(join(repoRoot, '.ai/cezar/worktrees', doneId));
    expect(plan.fetch).toEqual([]);
  });

  it('imports a bundle: record, branch, worktree and the in-mark', async () => {
    await post('/api/v1/handoff/export', { runs: [doneId] });
    const name = (
      ((await (await apiRequest(app, '/api/v1/handoff/bundles')).json()) as { bundles: Array<{ name: string }> }).bundles[0]!
    ).name;
    // Drop the local record (the branch stays) so the import recreates it from the bundle.
    store.deleteRun(doneId);
    expect(store.getRun(doneId)).toBeUndefined();

    const res = await post('/api/v1/handoff/import', { name });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: string[]; plan: { runs: Array<{ action: string }> } };
    expect(body.imported).toEqual([doneId]);
    expect(body.plan.runs[0]?.action).toBe('create');

    const imported = store.getRun(doneId)!;
    expect(imported.handoff?.direction).toBe('in');
    expect(imported.status).toBe('done');
    expect(imported.worktreePath).toBe(join(repoRoot, '.ai/cezar/worktrees', doneId));
  });

  it('refuses a bundle name that tries to escape the cache, and one that is not there', async () => {
    const traversal = await apiRequest(app, '/api/v1/handoff/bundles/preview?name=..%2F..%2Fetc%2Fpasswd');
    expect(traversal.status).toBe(400);

    await post('/api/v1/handoff/export', { runs: [doneId] });
    const missing = await apiRequest(app, '/api/v1/handoff/bundles/preview?name=absent-000.tgz');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain('cannot read bundle');
  });

  it('unmarks a handed-off task, so this machine can continue it again', async () => {
    await post('/api/v1/handoff/export', { runs: [doneId] });
    expect(store.getRun(doneId)?.handoff?.direction).toBe('out');

    const res = await post('/api/v1/handoff/unmark', { runs: [doneId, 'no-such-run'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unmarked: [doneId] });
    expect(store.getRun(doneId)?.handoff).toBeUndefined();
  });

  it('is a local-machine capability: hosted mode answers 409 on every route', async () => {
    process.env.CEZ_REMOTE = '1';
    const paths = [
      await apiRequest(app, '/api/v1/handoff/bundles'),
      await apiRequest(app, '/api/v1/handoff/bundles/preview?name=x.tgz'),
      await post('/api/v1/handoff/export', { runs: [doneId] }),
      await post('/api/v1/handoff/import', { name: 'x.tgz' }),
      await post('/api/v1/handoff/unmark', { runs: [doneId] }),
    ];
    for (const res of paths) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('local machine');
    }
  });

  it('never writes a bundle for a rejected export', async () => {
    await exportRuns({
      repoRoot,
      dataDir: join(repoRoot, '.ai/cezar'),
      store,
      runIds: ['nope'],
      outPath: join(handoffDir, 'never.tgz'),
      cezarVersion: '0.0.0-test',
    }).catch(() => undefined);
    const listed = (await (await apiRequest(app, '/api/v1/handoff/bundles')).json()) as { bundles: unknown[] };
    expect(listed.bundles).toHaveLength(0);
  });
});