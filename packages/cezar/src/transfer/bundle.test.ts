import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_FILE,
  bundleHeads,
  createBranchBundle,
  fetchBundleRefs,
  localRefExists,
  localRefSha,
  packBundle,
  parseManifest,
  readBundleBytes,
  recordFilePath,
  unpackBundle,
  writeDurable,
} from './bundle.ts';
import { HANDOFF_FORMAT_VERSION, TransferError } from './manifest.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const tmpRoots: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

async function fixtureRepo(prefix: string): Promise<string> {
  const root = tmp(prefix);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const MANIFEST = {
  formatVersion: HANDOFF_FORMAT_VERSION,
  createdAt: '2026-09-19T10:00:00.000Z',
  cezarVersion: '0.11.1',
  sourceProjectId: 'cezar',
  runs: [
    {
      id: '1a2b3c4d-0000-4000-8000-000000000000',
      title: 'move me',
      status: 'done' as const,
      runner: 'claude' as const,
      branch: 'cez/1a2b3c4d',
      baseBranch: 'main',
      worktreePath: '/laptop/repo/.ai/cezar/worktrees/1a2b3c4d-0000-4000-8000-000000000000',
    },
  ],
  branches: ['cez/1a2b3c4d'],
};

describe('bundle codec (tar + gzip)', () => {
  it('round-trips text, binary and nested entries', () => {
    const files = new Map<string, Buffer | string>([
      [MANIFEST_FILE, JSON.stringify(MANIFEST)],
      [recordFilePath('run-1'), '{"id":"run-1"}'],
      ['runs/run-1.ndjson', Buffer.from([0, 1, 2, 255, 0])],
      ['runs/run-1.handoff.md', '# Handoff\n\n## Progress log\n'],
      ['branches.bundle', Buffer.alloc(4096, 7)],
    ]);
    const packed = packBundle(files);
    // A tar block is 512 bytes; gzip output starts with 1f 8b.
    expect(packed[0]).toBe(0x1f);
    expect(packed[1]).toBe(0x8b);
    const back = unpackBundle(packed);
    expect([...back.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [name, data] of files) {
      const expected = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      expect(Buffer.compare(back.get(name)!, expected)).toBe(0);
    }
    const manifest = parseManifest(back);
    expect(manifest).toEqual(MANIFEST);
  });

  it('round-trips an empty file and a file whose size is an exact block multiple', () => {
    const files = new Map<string, Buffer>([
      [MANIFEST_FILE, Buffer.from(JSON.stringify(MANIFEST))],
      ['runs/empty.ndjson', Buffer.alloc(0)],
      ['runs/block.ndjson', Buffer.alloc(1024, 3)],
    ]);
    const back = unpackBundle(packBundle(files));
    expect(back.get('runs/empty.ndjson')!.length).toBe(0);
    expect(back.get('runs/block.ndjson')!.length).toBe(1024);
  });

  it('refuses a tar entry that climbs out of the archive', () => {
    const packed = packBundle(new Map([['../evil.sh', 'rm -rf /']]));
    expect(() => unpackBundle(packed)).toThrow(TransferError);
    expect(() => unpackBundle(packed)).toThrow(/unsafe path/);
  });

  it('refuses bytes that are not gzip at all', () => {
    expect(() => unpackBundle(Buffer.from('definitely not a bundle'))).toThrow(/not gzip-compressed/);
  });

  it('refuses a tar whose header checksum does not match', () => {
    const tar = gunzipSync(packBundle(new Map([[MANIFEST_FILE, '{}']])));
    tar[100] = 0x39; // mode field: corrupt the header, which the checksum covers
    expect(() => unpackBundle(gzipSync(tar))).toThrow(/checksum mismatch/);
  });

  it('names a missing manifest and an unsupported format version', () => {
    expect(() => parseManifest(unpackBundle(packBundle(new Map([['other.txt', 'x']]))))).toThrow(/no manifest/);
    const newer = { ...MANIFEST, formatVersion: 99 };
    expect(() => parseManifest(unpackBundle(packBundle(new Map([[MANIFEST_FILE, JSON.stringify(newer)]]))))).toThrow(
      /different cezar \(format 99/,
    );
    expect(() => parseManifest(unpackBundle(packBundle(new Map([[MANIFEST_FILE, '{"formatVersion": 1}']]))))).toThrow(
      /malformed/,
    );
  });

  it('writes durably and reads the bytes back', () => {
    const dir = tmp('cez-bundle-');
    const path = join(dir, 'nested', 'x.tgz');
    const bytes = packBundle(new Map([[MANIFEST_FILE, JSON.stringify(MANIFEST)]]));
    writeDurable(path, bytes);
    expect(Buffer.compare(readBundleBytes(path), bytes)).toBe(0);
    expect(() => readBundleBytes(join(dir, 'missing.tgz'))).toThrow(/cannot read bundle/);
  });
});

describe('git bundle helpers', () => {
  it('creates a bundle of the given branches and fetches them into another repo', async () => {
    const source = await fixtureRepo('cez-gitbundle-src-');
    await run('git', ['checkout', '-q', '-b', 'cez/1a2b3c4d'], { cwd: source });
    writeFileSync(join(source, 'work.txt'), 'the task work\n');
    await run('git', ['add', '-A'], { cwd: source });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'task work'], { cwd: source });
    await run('git', ['checkout', '-q', 'main'], { cwd: source });
    const sha = (await run('git', ['rev-parse', 'cez/1a2b3c4d'], { cwd: source })).stdout.trim();

    const bundlePath = join(tmp('cez-gitbundle-out-'), 'branches.bundle');
    await createBranchBundle(source, ['cez/1a2b3c4d'], bundlePath);
    expect((await bundleHeads(bundlePath, source)).get('refs/heads/cez/1a2b3c4d')).toBe(sha);

    const destination = await fixtureRepo('cez-gitbundle-dst-');
    expect(await localRefExists(destination, 'cez/1a2b3c4d')).toBe(false);
    await fetchBundleRefs(destination, bundlePath, ['cez/1a2b3c4d']);
    expect(await localRefSha(destination, 'cez/1a2b3c4d')).toBe(sha);

    // Idempotent: fetching an identical ref again is a no-op, not an error.
    await fetchBundleRefs(destination, bundlePath, ['cez/1a2b3c4d']);
    expect(await localRefSha(destination, 'cez/1a2b3c4d')).toBe(sha);
  });

  it('refuses an option-like branch name without touching git', async () => {
    const repo = await fixtureRepo('cez-gitbundle-bad-');
    const bundlePath = join(tmp('cez-gitbundle-bad-out-'), 'x.bundle');
    expect(await localRefSha(repo, '--upload-pack=/bin/sh')).toBeUndefined();
    expect(await localRefExists(repo, '-x')).toBe(false);
    expect((await bundleHeads(bundlePath, repo)).size).toBe(0);
  });

  it('reports a git failure rather than writing a bundle of nothing', async () => {
    const repo = await fixtureRepo('cez-gitbundle-fail-');
    await expect(createBranchBundle(repo, ['cez/nope'], join(tmp('cez-gitbundle-fail-out-'), 'x.bundle'))).rejects.toThrow(
      /git bundle create failed/,
    );
  });
});

describe('bundle bytes on disk', () => {
  it('a written bundle is readable from its path', () => {
    const dir = tmp('cez-bundle-read-');
    const path = join(dir, 'b.tgz');
    writeDurable(path, packBundle(new Map([[MANIFEST_FILE, JSON.stringify(MANIFEST)]])));
    expect(parseManifest(unpackBundle(readFileSync(path))).runs[0]!.id).toBe(MANIFEST.runs[0]!.id);
  });
});