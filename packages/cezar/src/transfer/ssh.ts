import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { TransferError } from './manifest.ts';

/**
 * The SSH seam for `cez handoff push` (spec `.ai/specs/2026-09-19-cross-machine-task-handoff.md`).
 *
 * The ONE network-touching layer of the feature, injected exactly like `RunProviderCommand`
 * (`core/provider-auth.ts`) so tests drive a fake and no new `CEZ_*` variable exists. Two hard
 * rules:
 *
 *  - the `[user@]host` is validated against a strict pattern and handed to `spawn`/`execFile` as
 *    an argv element — never a shell string — so a metacharacter cannot become a command;
 *  - the host key policy is ssh's own. Nothing here ever adds
 *    `-o StrictHostKeyChecking=no`: an unknown host key must fail with SSH's message and let the
 *    user decide.
 *
 * Cezar opens no socket of its own — ssh and scp do the talking, and `push` only transfers a
 * file plus prints (never runs) the remote stop/import/start commands.
 */

export interface TransferCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
}

export type RunTransferCommand = (
  executable: string,
  args: readonly string[],
  /** Bytes piped to the child's stdin (the `ssh … cat >` fallback). */
  stdin?: Buffer,
) => Promise<TransferCommandResult>;

export const TRANSFER_TIMEOUT_MS = 10 * 60_000;

export function defaultTransferCommand(
  executable: string,
  args: readonly string[],
  stdin?: Buffer,
): Promise<TransferCommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      [...args],
      { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', timeout: TRANSFER_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: err ? (typeof code === 'number' ? code : 1) : 0,
          ...(typeof code === 'string' ? { errorCode: code } : {}),
        });
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

/** `[user@]host` with no shell metacharacters, no spaces, no IPv6 brackets, no options. */
const SSH_HOST_RE = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/;

/** The refusal text for an unusable host, or null when it is acceptable. */
export function validateSshHost(host: string): string | null {
  if (!host.trim()) return '--to needs a target, like user@host or host';
  if (!SSH_HOST_RE.test(host)) {
    return `"${host}" is not a valid ssh target — use [user@]host with letters, digits, dot, dash or underscore`;
  }
  return null;
}

/** A file name we minted, verified before it is spliced into a remote command. */
const SAFE_BUNDLE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Remote directory the bundle lands in, relative to the destination user's home. */
export const REMOTE_HANDOFF_DIR = '.cache/cez/handoff';

export interface PushRequest {
  host: string;
  localPath: string;
  /** Bundle file name; defaults to the local file name. */
  name?: string;
  run?: RunTransferCommand;
  log?: (line: string) => void;
}

export interface PushResult {
  remotePath: string;
  method: 'scp' | 'ssh';
}

function failed(executable: string, result: TransferCommandResult): never {
  const detail = result.errorCode === 'ENOENT'
    ? `${executable} is not installed or not on PATH`
    : result.stderr.trim() || result.stdout.trim() || `${executable} exited ${result.exitCode ?? '?'}`;
  throw new TransferError(`${executable} failed: ${detail}`, 'ssh-failed');
}

/**
 * Copy one bundle to `[user@]host:~/.cache/cez/handoff/`. `scp` first; the `ssh … cat >` stream
 * is the fallback for a host without scp (and is what the spec allows as "a tar | ssh stream").
 * Nothing here stops, starts or otherwise touches the remote service.
 */
export async function pushBundle(request: PushRequest): Promise<PushResult> {
  const hostProblem = validateSshHost(request.host);
  if (hostProblem) throw new TransferError(hostProblem, 'ssh-failed');
  const name = request.name ?? basename(request.localPath);
  if (!SAFE_BUNDLE_NAME_RE.test(name)) {
    throw new TransferError(`refusing to transfer an unexpected file name: ${name}`, 'ssh-failed');
  }
  const run = request.run ?? defaultTransferCommand;
  const log = request.log ?? (() => {});

  // Ensure the destination directory exists. The remote path is a FIXED cezar-owned string, and
  // the name passed the pattern above — no user input reaches the remote shell.
  const mkdir = await run('ssh', [request.host, 'mkdir', '-p', REMOTE_HANDOFF_DIR]);
  if (mkdir.exitCode !== 0) failed('ssh', mkdir);

  const remotePath = `${REMOTE_HANDOFF_DIR}/${name}`;
  const scp = await run('scp', ['-q', request.localPath, `${request.host}:${remotePath}`]);
  if (scp.exitCode === 0) return { remotePath, method: 'scp' };
  if (scp.errorCode !== 'ENOENT') failed('scp', scp);

  log('scp is not available — streaming over ssh instead');
  const streamed = await run('ssh', [request.host, `cat > ${remotePath}`], readFileSync(request.localPath));
  if (streamed.exitCode !== 0) failed('ssh', streamed);
  return { remotePath, method: 'ssh' };
}

/** The commands `push` prints for the human to run on the destination — never executed here. */
export function remoteImportInstructions(host: string, remotePath: string): string[] {
  // The remote path is relative to the destination user's home; `~` spells that out for a reader.
  const shown = remotePath.startsWith('.') ? `~/${remotePath}` : remotePath;
  return [
    `  ssh ${host}   # then, on that machine:`,
    '    sudo systemctl stop cezar.service          # or: systemctl --user stop cezar.service',
    `    cez handoff import ${shown}`,
    '    sudo systemctl start cezar.service         # or: systemctl --user start cezar.service',
    '',
    `  the cockpit on ${host} can now import it too (Tasks → Import a bundle), once its service is stopped.`,
  ];
}