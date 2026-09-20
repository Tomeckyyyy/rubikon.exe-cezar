import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';

/**
 * Is a live cezar instance serving this project? (spec
 * `.ai/specs/2026-09-19-cross-machine-task-handoff.md`, edge case "Destination service running".)
 *
 * `RunStore` holds its records in memory and rewrites `runs.json` on the next debounced save, so
 * a handoff mutation performed behind a running cockpit would be silently overwritten — the
 * export mark would vanish, or an import would lose every record it just wrote. Both commands
 * therefore refuse while an instance holds this project, and the refusal names the stop command.
 *
 * The heartbeat is a small file per project root under `~/.cezar/instances/`, deliberately NOT a
 * new `.ai/cezar/` file: it lives in the (already-`CEZ_HOME`-aware, already disposable) cezar
 * home, so `ensureDataGitignore` is untouched and deleting `~/.cezar` just drops the lock. A
 * stale file (the process was killed) is detected by pid liveness and removed on the next read —
 * no user repair, ever. Best-effort writes: a read-only home degrades to "cannot detect", which
 * is exactly the pre-lock behaviour rather than a boot failure.
 *
 * The spec allows either a lock file or a loopback health probe; the lock file wins because it is
 * deterministic for any `--port` (a probe cannot find a cockpit started on a custom port).
 */

export interface InstanceLock {
  pid: number;
  /** Canonical (realpath) root of the project this instance holds. */
  repoRoot: string;
  startedAt: string;
  port?: number;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function instanceLockPath(repoRoot: string): string {
  const key = createHash('sha1').update(canonical(repoRoot)).digest('hex').slice(0, 16);
  return join(cezarHomeDir(), 'instances', `${key}.json`);
}

/** Record that this process serves `repoRoot`. Never throws. */
export function writeInstanceLock(repoRoot: string, opts: { port?: number; now?: () => string } = {}): void {
  const path = instanceLockPath(repoRoot);
  try {
    assertCezarHomeWriteIsSandboxed(dirname(path));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const payload: InstanceLock = {
      pid: process.pid,
      repoRoot: canonical(repoRoot),
      startedAt: (opts.now ?? (() => new Date().toISOString()))(),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
    };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // best effort — the lock only protects transfers
  }
}

/** Drop this process's heartbeat for `repoRoot`. Never throws; a stale file is harmless. */
export function releaseInstanceLock(repoRoot: string): void {
  try {
    rmSync(instanceLockPath(repoRoot), { force: true });
  } catch {
    // best effort
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The raw heartbeat, without a liveness opinion. Null when absent or unreadable. */
export function readInstanceLock(repoRoot: string): InstanceLock | null {
  try {
    const raw = JSON.parse(readFileSync(instanceLockPath(repoRoot), 'utf8')) as Partial<InstanceLock>;
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    if (typeof raw.repoRoot !== 'string' || typeof raw.startedAt !== 'string') return null;
    return {
      pid: raw.pid,
      repoRoot: raw.repoRoot,
      startedAt: raw.startedAt,
      ...(typeof raw.port === 'number' ? { port: raw.port } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The live instance serving `repoRoot`, or null. A heartbeat whose pid is gone is stale: it is
 * deleted here so the next caller starts clean.
 */
export function findLiveInstance(
  repoRoot: string,
  opts: { alive?: (pid: number) => boolean } = {},
): InstanceLock | null {
  const lock = readInstanceLock(repoRoot);
  if (!lock) return null;
  const alive = opts.alive ?? pidAlive;
  if (alive(lock.pid)) return lock;
  releaseInstanceLock(repoRoot);
  return null;
}

/**
 * The refusal both `export` and `import` share, with the stop/start guidance AGENTS.md requires
 * ("prints the exact systemctl commands and asks") — the commands are printed, never run.
 *
 * The guidance is per-platform because the service is: `server-install` writes a systemd unit on
 * Linux and a launchd agent (`ai.cezar.cockpit`) on macOS. `platform` is injectable so tests can
 * pin both, and defaults to the machine the CLI is running on — which is the machine holding the
 * lock, so the right commands are always the ones printed.
 */
export function liveInstanceRefusal(
  instance: InstanceLock,
  platform: NodeJS.Platform = process.platform,
): string {
  const started = instance.startedAt.slice(0, 19).replace('T', ' ');
  const where = instance.port !== undefined ? ` on port ${instance.port}` : '';
  const serviceLines =
    platform === 'darwin'
      ? [
          '  launchd (cezar server-install):  launchctl bootout gui/$(id -u)/ai.cezar.cockpit',
          '                                    # start again: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.cezar.cockpit.plist',
        ]
      : [
          '  systemd (cezar server-install):   sudo systemctl stop cezar.service',
          '  a user unit:                      systemctl --user stop cezar.service',
        ];
  return [
    `a cezar cockpit is running for this project (pid ${instance.pid}${where}, started ${started}) —`,
    'stop it first, so its in-memory run records cannot overwrite what this command writes.',
    '',
    ...serviceLines,
    '  a manual `cez serve`:             press Ctrl+C in its terminal',
    '',
    'start it again the same way once the command finishes.',
  ].join('\n');
}