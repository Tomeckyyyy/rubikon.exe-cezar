import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TransferError } from './manifest.ts';
import {
  REMOTE_HANDOFF_DIR,
  pushBundle,
  remoteImportInstructions,
  validateSshHost,
  type RunTransferCommand,
  type TransferCommandResult,
} from './ssh.ts';

/**
 * The SSH seam (spec `.ai/specs/2026-09-19-cross-machine-task-handoff.md`): strict `[user@]host`
 * validation, argv-not-shell invocation, no host-key override, and a `cat >` fallback for a host
 * without scp. Every test drives a fake runner — nothing here opens a socket.
 */
describe('validateSshHost', () => {
  it('accepts a bare host and a user@host', () => {
    for (const host of ['vps.example.com', 'user@vps.example.com', 'deploy@10.0.0.7', 'box', 'a_b-c.d@h1']) {
      expect(validateSshHost(host)).toBeNull();
    }
  });

  it('refuses shell metacharacters, options, spaces and empty targets', () => {
    for (const host of ['', '   ', 'vps; rm -rf /', 'user@host && curl evil', '-oProxyCommand=sh', 'a b', 'user@@host', '[::1]', 'host/path']) {
      expect(validateSshHost(host)).not.toBeNull();
    }
    expect(validateSshHost('vps; rm -rf /')).toContain('not a valid ssh target');
    expect(validateSshHost('')).toContain('--to needs a target');
  });
});

describe('pushBundle', () => {
  let dir: string;
  let bundlePath: string;
  const calls: Array<{ exe: string; args: readonly string[]; stdin?: Buffer }> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-ssh-'));
    bundlePath = join(dir, 'cez-20260919.tgz');
    writeFileSync(bundlePath, 'bundle-bytes');
    calls.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fake = (scp: 'ok' | 'missing' | 'fail'): RunTransferCommand =>
    async (exe, args, stdin): Promise<TransferCommandResult> => {
      calls.push({ exe, args, stdin });
      if (exe === 'scp') {
        if (scp === 'missing') return { stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' };
        if (scp === 'fail') return { stdout: '', stderr: 'scp: no route to host', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

  it('ensures the remote directory, then copies with scp — argv only, host passed verbatim', async () => {
    const result = await pushBundle({ host: 'deploy@vps.example.com', localPath: bundlePath, run: fake('ok') });
    expect(calls.map((call) => call.exe)).toEqual(['ssh', 'scp']);
    expect(calls[0]!.args).toEqual(['deploy@vps.example.com', 'mkdir', '-p', REMOTE_HANDOFF_DIR]);
    expect(calls[1]!.args).toEqual(['-q', bundlePath, `deploy@vps.example.com:${REMOTE_HANDOFF_DIR}/cez-20260919.tgz`]);
    // Never a host-key override, never a shell string.
    expect(calls.every((call) => call.args.every((arg) => !arg.includes('StrictHostKeyChecking')))).toBe(true);
    expect(result).toEqual({ remotePath: `${REMOTE_HANDOFF_DIR}/cez-20260919.tgz`, method: 'scp' });
  });

  it('streams over ssh when scp is not installed', async () => {
    const result = await pushBundle({ host: 'vps.example.com', localPath: bundlePath, run: fake('missing') });
    expect(calls.map((call) => call.exe)).toEqual(['ssh', 'scp', 'ssh']);
    expect(calls[2]!.args).toEqual(['vps.example.com', `cat > ${REMOTE_HANDOFF_DIR}/cez-20260919.tgz`]);
    expect(calls[2]!.stdin?.toString('utf8')).toBe('bundle-bytes');
    expect(result.method).toBe('ssh');
  });

  it('reports a real scp failure with the ssh message, and does not fall back', async () => {
    await expect(pushBundle({ host: 'vps.example.com', localPath: bundlePath, run: fake('fail') })).rejects.toThrow(
      /scp failed: scp: no route to host/,
    );
    expect(calls.map((call) => call.exe)).toEqual(['ssh', 'scp']);
  });

  it('refuses a bad host, a missing mkdir and an unexpected file name before copying', async () => {
    await expect(pushBundle({ host: 'a;b', localPath: bundlePath, run: fake('ok') })).rejects.toThrow(TransferError);
    expect(calls).toHaveLength(0);

    const failing: RunTransferCommand = async () => ({ stdout: '', stderr: 'mkdir: permission denied', exitCode: 1 });
    await expect(pushBundle({ host: 'vps.example.com', localPath: bundlePath, run: failing })).rejects.toThrow(
      /ssh failed: mkdir: permission denied/,
    );

    const weird = join(dir, 'weird name.tgz');
    writeFileSync(weird, 'x');
    await expect(pushBundle({ host: 'vps.example.com', localPath: weird, run: fake('ok') })).rejects.toThrow(
      /unexpected file name/,
    );
  });

  it('names the stop/import/start commands for the human, never running them', () => {
    const lines = remoteImportInstructions('deploy@vps.example.com', `${REMOTE_HANDOFF_DIR}/b.tgz`).join('\n');
    expect(lines).toContain('ssh deploy@vps.example.com');
    expect(lines).toContain('sudo systemctl stop cezar.service');
    expect(lines).toContain('systemctl --user stop cezar.service');
    expect(lines).toContain('cez handoff import ~/.cache/cez/handoff/b.tgz');
    expect(lines).toContain('sudo systemctl start cezar.service');
  });
});

describe('the bundle bytes never change on the way out', () => {
  it('reads the file it was given (no re-encoding)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-ssh-bytes-'));
    const path = join(dir, 'b.tgz');
    writeFileSync(path, Buffer.from([0, 1, 2, 255]));
    const seen: Buffer[] = [];
    const run: RunTransferCommand = async (exe, _args, stdin) => {
      if (exe === 'scp') return { stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' };
      if (stdin) seen.push(stdin);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    return pushBundle({ host: 'h', localPath: path, run }).then(() => {
      expect(seen[0] && Buffer.compare(seen[0], readFileSync(path))).toBe(0);
      rmSync(dir, { recursive: true, force: true });
    });
  });
});