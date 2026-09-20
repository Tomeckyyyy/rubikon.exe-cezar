import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchFor } from '../git-worktree.ts';
import { unpackBundle, parseManifest } from './bundle.ts';
import { runHandoffCommand, type HandoffCliIo } from './cli.ts';
import { listBundles } from './import.ts';
import { writeInstanceLock, releaseInstanceLock } from './live.ts';
import type { TransferCommandResult } from './ssh.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

async function fixtureRepo(prefix: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

/** The task branch with one commit, so export has a branch to pack. */
async function seedBranch(repo: string, runId: string): Promise<string> {
  const branch = branchFor(runId);
  await run('git', ['checkout', '-q', '-b', branch], { cwd: repo });
  writeFileSync(join(repo, 'work.txt'), 'work\n');
  await run('git', ['add', '-A'], { cwd: repo });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'work'], { cwd: repo });
  await run('git', ['checkout', '-q', 'main'], { cwd: repo });
  return branch;
}

interface TestIo extends HandoffCliIo {
  lines: string[];
  errors: string[];
}

function makeIo(cwd: string, bundleDir: string, overrides: Partial<HandoffCliIo> = {}): TestIo {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
    version: '0.0.0-test',
    cwd,
    now: () => '2026-09-19T10:00:00.000Z',
    bundleDir,
    ...overrides,
  };
}

describe('cez handoff (CLI)', () => {
  let source: string;
  let bundleDir: string;
  let bundleName: string;
  let io: TestIo;
  let doneId: string;
  let liveId: string;

  beforeEach(async () => {
    source = await fixtureRepo('cez-handoff-cli-src-');
    bundleDir = mkdtempSync(join(tmpdir(), 'cez-handoff-cli-out-'));
    roots.push(bundleDir);
    io = makeIo(source, bundleDir);
    bundleName = `${basename(source)}-20260919-100000.tgz`;
    const { RunStore } = await import('../runs/store.ts');
    const store = RunStore.open(join(source, '.ai/cezar'));
    const done = store.createRun({
      title: 'ship it',
      workflow: 'quick-task',
      task: 'ship it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    doneId = done.id;
    const branch = await seedBranch(source, doneId);
    store.updateRun(doneId, { status: 'done', finishedAt: '2026-09-19T09:00:00.000Z', branch, baseBranch: 'main' });
    store.updateStep(doneId, 'work', { status: 'done', sessionId: 'sess-1', backend: 'claude' });
    store.flush();

    const live = store.createRun({
      title: 'still running',
      workflow: 'quick-task',
      task: 'still running',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    liveId = live.id;
    store.updateRun(live.id, { status: 'running', startedAt: '2026-09-19T09:30:00.000Z' });
    store.flush();
  });

  afterEach(() => {
    releaseInstanceLock(source);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('exports to the default cache path and marks the task handed-off', async () => {
    expect(await runHandoffCommand(['export', '--all', '--repo', source], io)).toBe(0);
    expect(io.errors).toEqual([]);
    const bundlePath = join(bundleDir, bundleName);
    const manifest = parseManifest(unpackBundle(readFileSync(bundlePath)));
    expect(manifest.runs.map((entry) => entry.id)).toEqual([doneId]);
    expect(manifest.createdAt).toBe('2026-09-19T10:00:00.000Z');
    expect(io.lines.join('\n')).toContain('exported 1 task(s)');
    expect(io.lines.join('\n')).toContain(`branches: ${branchFor(doneId)}`);

    const { RunStore } = await import('../runs/store.ts');
    const reopened = RunStore.open(join(source, '.ai/cezar'));
    expect(reopened.getRun(doneId)?.handoff?.direction).toBe('out');
  });

  it('refuses a live task by name and exits 1', async () => {
    expect(await runHandoffCommand(['export', liveId, '--repo', source], io)).toBe(1);
    expect(io.errors.join('\n')).toContain('is running');
    expect(listBundles(bundleDir)).toHaveLength(0);
  });

  it('refuses while a live cockpit holds the project, naming the stop commands', async () => {
    writeInstanceLock(source, { port: 4321 });
    expect(await runHandoffCommand(['export', '--all', '--repo', source], io)).toBe(1);
    const refusal = io.errors.join('\n');
    expect(refusal).toContain('a cezar cockpit is running for this project');
    expect(refusal).toContain('sudo systemctl stop cezar.service');
    expect(listBundles(bundleDir)).toHaveLength(0);
    releaseInstanceLock(source);
  });

  it('imports a bundle by name from the handoff cache, dry-run first', async () => {
    await runHandoffCommand(['export', '--all', '--repo', source], io);
    const name = listBundles(bundleDir)[0]!.name;

    const destination = await fixtureRepo('cez-handoff-cli-dst-');
    const { RunStore } = await import('../runs/store.ts');
    const { mergeWriteWorkspaceConfig } = await import('../workspace/config.ts');
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push({
        id: 'dest-cli',
        root: destination,
        name: 'dest',
        addedAt: '2026-09-19T00:00:00.000Z',
        lastOpenedAt: '2026-09-19T00:00:00.000Z',
        source: 'local',
      });
    });
    const destIo = makeIo(destination, bundleDir);

    expect(await runHandoffCommand(['import', name, '--repo', destination, '--dry-run'], destIo)).toBe(0);
    expect(destIo.lines.join('\n')).toContain('dry run — nothing was written.');
    const destStore = RunStore.open(join(destination, '.ai/cezar'));
    expect(destStore.getRun(doneId)).toBeUndefined();
    destStore.flush();

    const applyIo = makeIo(destination, bundleDir);
    expect(await runHandoffCommand(['import', name, '--repo', destination], applyIo)).toBe(0);
    const applied = RunStore.open(join(destination, '.ai/cezar'));
    expect(applied.getRun(doneId)?.handoff?.direction).toBe('in');
    expect(applied.getRun(doneId)?.worktreePath).toBe(join(destination, '.ai/cezar/worktrees', doneId));
    expect(applyIo.lines.join('\n')).toContain('imported 1 task(s)');
    applied.flush();
  });

  it('refuses to import into an unregistered project, naming the fix', async () => {
    await runHandoffCommand(['export', '--all', '--repo', source], io);
    const name = listBundles(bundleDir)[0]!.name;
    const destination = await fixtureRepo('cez-handoff-cli-unreg-');
    const destIo = makeIo(destination, bundleDir);
    expect(await runHandoffCommand(['import', name, '--repo', destination], destIo)).toBe(1);
    expect(destIo.errors.join('\n')).toContain('not registered');
    expect(destIo.errors.join('\n')).toContain(`cez projects add ${destination}`);
  });

  it('unmarks one task or all of them', async () => {
    await runHandoffCommand(['export', '--all', '--repo', source], io);
    const { RunStore } = await import('../runs/store.ts');
    const store = RunStore.open(join(source, '.ai/cezar'));
    expect(store.getRun(doneId)?.handoff?.direction).toBe('out');
    store.flush();

    const unmarkIo = makeIo(source, bundleDir);
    expect(await runHandoffCommand(['unmark', doneId.slice(0, 8), '--repo', source], unmarkIo)).toBe(0);
    expect(unmarkIo.lines.join('\n')).toContain('unmarked 1 task(s)');
    const after = RunStore.open(join(source, '.ai/cezar'));
    expect(after.getRun(doneId)?.handoff).toBeUndefined();
    after.flush();

    // --all on a project with nothing marked is a no-op, not an error.
    const allIo = makeIo(source, bundleDir);
    expect(await runHandoffCommand(['unmark', '--all', '--repo', source], allIo)).toBe(0);
    expect(allIo.lines.join('\n')).toContain('no handed-off task to unmark');
  });

  it('lists bundles waiting in the cache', async () => {
    await runHandoffCommand(['export', '--all', '--repo', source], io);
    const listIo = makeIo(source, bundleDir);
    expect(await runHandoffCommand(['list'], listIo)).toBe(0);
    expect(listIo.lines.join('\n')).toContain(bundleName);
    expect(listIo.lines.join('\n')).toContain('cez handoff import');
  });

  it('refuses an import while a live cockpit holds the destination project', async () => {
    await runHandoffCommand(['export', '--all', '--repo', source], io);
    const name = listBundles(bundleDir)[0]!.name;
    // Runs LAST in this file on purpose: registering the source changes the default bundle name
    // for any test that runs after it.
    const { mergeWriteWorkspaceConfig } = await import('../workspace/config.ts');
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push({
        id: 'live-src',
        root: source,
        name: 'src',
        addedAt: '2026-09-19T00:00:00.000Z',
        lastOpenedAt: '2026-09-19T00:00:00.000Z',
        source: 'local',
      });
    });
    writeInstanceLock(source, { port: 4321 });
    const importIo = makeIo(source, bundleDir);
    expect(await runHandoffCommand(['import', name, '--repo', source], importIo)).toBe(1);
    expect(importIo.errors.join('\n')).toContain('a cezar cockpit is running for this project');
    releaseInstanceLock(source);
  });

  describe('push', () => {
    const calls: Array<{ exe: string; args: readonly string[]; stdin?: Buffer }> = [];

    const fakeRun = (failScp = false) =>
      async (exe: string, args: readonly string[], stdin?: Buffer): Promise<TransferCommandResult> => {
        calls.push({ exe, args, stdin });
        if (exe === 'scp' && failScp) return { stdout: '', stderr: 'scp: no route to host', exitCode: 1 };
        return { stdout: '', stderr: '', exitCode: 0 };
      };

    beforeEach(() => {
      calls.length = 0;
    });

    it('exports, copies over ssh and prints (never runs) the service commands', async () => {
      io.runCommand = fakeRun();
      expect(await runHandoffCommand(['push', '--to', 'deploy@vps.example.com', '--all', '--repo', source, '--yes'], io)).toBe(0);
      // mkdir then scp, argv arrays, host passed through untouched.
      expect(calls.map((call) => call.exe)).toEqual(['ssh', 'scp']);
      expect(calls[1]!.args).toEqual([
        '-q',
        join(bundleDir, bundleName),
        `deploy@vps.example.com:.cache/cez/handoff/${bundleName}`,
      ]);
      const out = io.lines.join('\n');
      expect(out).toContain('transferred → deploy@vps.example.com:.cache/cez/handoff/');
      expect(out).toContain('sudo systemctl stop cezar.service');
      expect(out).toContain('sudo systemctl start cezar.service');
      expect(out).toContain('cez handoff import ~/.cache/cez/handoff/');
      // The remote service is never touched by cezar itself.
      expect(calls.some((call) => call.args.join(' ').includes('systemctl'))).toBe(false);

      const { RunStore } = await import('../runs/store.ts');
      const reopened = RunStore.open(join(source, '.ai/cezar'));
      expect(reopened.getRun(doneId)?.handoff?.direction).toBe('out');
      reopened.flush();
    });

    it('leaves the handed-off mark off when the transfer fails', async () => {
      io.runCommand = fakeRun(true);
      expect(await runHandoffCommand(['push', '--to', 'vps.example.com', '--all', '--repo', source, '--yes'], io)).toBe(1);
      expect(io.errors.join('\n')).toContain('scp failed');
      const { RunStore } = await import('../runs/store.ts');
      const reopened = RunStore.open(join(source, '.ai/cezar'));
      expect(reopened.getRun(doneId)?.handoff).toBeUndefined();
      reopened.flush();
    });

    it('refuses an unsafe host before exporting anything', async () => {
      io.runCommand = fakeRun();
      expect(await runHandoffCommand(['push', '--to', 'vps; rm -rf /', '--all', '--repo', source, '--yes'], io)).toBe(1);
      expect(io.errors.join('\n')).toContain('is not a valid ssh target');
      expect(calls).toHaveLength(0);
      expect(listBundles(bundleDir)).toHaveLength(0);
    });

    it('asks before the network and does nothing on a no', async () => {
      io.runCommand = fakeRun();
      io.confirm = async () => false;
      expect(await runHandoffCommand(['push', '--to', 'vps.example.com', '--all', '--repo', source], io)).toBe(0);
      expect(io.lines.join('\n')).toContain('cancelled');
      expect(calls).toHaveLength(0);
      expect(listBundles(bundleDir)).toHaveLength(0);
    });
  });
});