import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findLiveInstance,
  instanceLockPath,
  liveInstanceRefusal,
  readInstanceLock,
  releaseInstanceLock,
  writeInstanceLock,
} from './live.ts';

/**
 * The live-instance heartbeat (spec `.ai/specs/2026-09-19-cross-machine-task-handoff.md` edge case
 * "Destination service running"): `RunStore` keeps records in memory and rewrites `runs.json` on
 * its next save, so a handoff mutation behind a running cockpit would be silently overwritten.
 * The lock is a file per project root under the (disposable, `CEZ_HOME`-aware) cezar home; the
 * tests below pin its lifecycle and its self-healing, not its path spelling.
 *
 * `CEZ_HOME` is pinned to a per-worker sandbox by `vitest.setup.ts`, so nothing here can touch a
 * developer's real home — `writeInstanceLock` refuses that outright (`assertCezarHomeWriteIsSandboxed`).
 */
describe('live instance lock', () => {
  let repo: string;
  let other: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-live-a-'));
    other = mkdtempSync(join(tmpdir(), 'cez-live-b-'));
  });

  afterEach(() => {
    releaseInstanceLock(repo);
    releaseInstanceLock(other);
    rmSync(repo, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it('reports nothing before a heartbeat is armed', () => {
    expect(readInstanceLock(repo)).toBeNull();
    expect(findLiveInstance(repo)).toBeNull();
  });

  it('arms a heartbeat for this process and finds it live', () => {
    writeInstanceLock(repo, { port: 4321, now: () => '2026-09-19T10:00:00.000Z' });
    expect(readInstanceLock(repo)).toEqual({
      pid: process.pid,
      repoRoot: repo,
      startedAt: '2026-09-19T10:00:00.000Z',
      port: 4321,
    });
    expect(findLiveInstance(repo)?.pid).toBe(process.pid);
  });

  it('treats a heartbeat whose process is gone as stale and removes it', () => {
    writeInstanceLock(repo);
    expect(findLiveInstance(repo, { alive: () => false })).toBeNull();
    // Self-healing: the stale file is gone, so the next reader starts clean.
    expect(readInstanceLock(repo)).toBeNull();
  });

  it('treats a corrupt heartbeat as absent', () => {
    writeInstanceLock(repo);
    const path = instanceLockPath(repo);
    writeFileSync(path, '{not json');
    expect(readInstanceLock(repo)).toBeNull();
    expect(findLiveInstance(repo)).toBeNull();
  });

  it('keys by project root — one project never blocks another', () => {
    writeInstanceLock(repo, { port: 4321 });
    expect(findLiveInstance(repo)).not.toBeNull();
    expect(findLiveInstance(other)).toBeNull();
    expect(instanceLockPath(repo)).not.toBe(instanceLockPath(other));
  });

  it('releases on demand', () => {
    writeInstanceLock(repo);
    releaseInstanceLock(repo);
    expect(readInstanceLock(repo)).toBeNull();
    // Releasing twice is legal (shutdown paths can overlap).
    releaseInstanceLock(repo);
  });

  it('names both service managers, the pid and the port in the refusal', () => {
    const linux = liveInstanceRefusal(
      {
        pid: 4242,
        repoRoot: repo,
        startedAt: '2026-09-19T10:11:12.345Z',
        port: 4321,
      },
      'linux',
    );
    expect(linux).toContain('pid 4242');
    expect(linux).toContain('port 4321');
    expect(linux).toContain('started 2026-09-19 10:11:12');
    expect(linux).toContain('sudo systemctl stop cezar.service');
    expect(linux).toContain('systemctl --user stop cezar.service');
    expect(linux).toContain('Ctrl+C');
    expect(linux).not.toContain('launchctl');

    // macOS installs run as a launchd agent (`ai.cezar.cockpit`), so the systemd spelling would
    // send a Mac user looking for a unit that does not exist.
    const mac = liveInstanceRefusal(
      { pid: 7, repoRoot: repo, startedAt: '2026-09-19T10:11:12.345Z' },
      'darwin',
    );
    expect(mac).toContain('launchctl bootout gui/$(id -u)/ai.cezar.cockpit');
    expect(mac).toContain('launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.cezar.cockpit.plist');
    expect(mac).not.toContain('systemctl');
    expect(mac).toContain('Ctrl+C');
  });
});