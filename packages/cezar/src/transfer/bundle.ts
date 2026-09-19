import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isSafeGitRef } from '../git-refs.ts';
import {
  HANDOFF_FORMAT_VERSION,
  TransferError,
  handoffManifestSchema,
  type HandoffManifest,
} from './manifest.ts';

/**
 * The bundle codec: a gzipped tar holding `manifest.json`, one `runs/<id>.json` record per task,
 * its `runs/<id>.ndjson` event log and its `runs/<id>.handoff.md` journal, plus a plain
 * `git bundle` of every referenced `cez/*` branch.
 *
 * Dependency-free on purpose (the server stack is deliberately small): a minimal ustar writer and
 * reader, so the format is ours end to end and a round-trip test can pin it. The reader is the
 * untrusted side — it validates the checksum, rejects traversal-shaped names, and caps the
 * unpacked size — because a bundle arrives from another machine.
 *
 * Git never crosses a shell here either: `git bundle create`/`fetch` run through `execFile` with
 * argv arrays, and refs pass `isSafeGitRef` first (the `--upload-pack` injection guard from #431).
 */

export const MANIFEST_FILE = 'manifest.json';
export const RUNS_DIR = 'runs';
export const BRANCHES_FILE = 'branches.bundle';
/** Human name of the archive format, for refusals. */
export const BUNDLE_EXTENSION = '.tgz';

export function recordFilePath(runId: string): string {
  return `${RUNS_DIR}/${runId}.json`;
}
export function eventsFilePath(runId: string): string {
  return `${RUNS_DIR}/${runId}.ndjson`;
}
export function journalFilePath(runId: string): string {
  return `${RUNS_DIR}/${runId}.handoff.md`;
}

/** Unpacked ceiling — a bundle from another machine must not be able to exhaust this one. */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
/** Per-entry ceiling, so one absurd record cannot dominate. */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

// ---- tar (ustar) ------------------------------------------------------------

function tarOctal(value: number, length: number): string {
  // length - 1 octal digits + NUL, the classic encoding every tar reads.
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function writeTar(files: ReadonlyMap<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, data] of files) {
    const slash = name.lastIndexOf('/');
    // ustar splits names at a '/' boundary into name (100) + prefix (155).
    let short = name;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      if (slash > 0 && Buffer.byteLength(name.slice(slash + 1)) <= 100 && Buffer.byteLength(name.slice(0, slash)) <= 155) {
        short = name.slice(slash + 1);
        prefix = name.slice(0, slash);
      } else {
        throw new TransferError(`bundle entry name is too long for tar: ${name}`, 'io-failed');
      }
    }
    const header = Buffer.alloc(512);
    header.write(short, 0, 100, 'utf8');
    header.write(tarOctal(0o644, 8), 100, 8, 'ascii');
    header.write(tarOctal(0, 8), 108, 8, 'ascii');
    header.write(tarOctal(0, 8), 116, 8, 'ascii');
    header.write(tarOctal(data.length, 12), 124, 12, 'ascii');
    header.write(tarOctal(Math.floor(Date.now() / 1000), 12), 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii'); // checksum placeholder: 8 spaces
    header.write('0', 156, 1, 'ascii'); // regular file
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    if (prefix) header.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks: end of archive
  return Buffer.concat(blocks);
}

function parseTarNumber(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  const first = field[0];
  if (first === undefined || first === 0 || first === 0x20) return 0;
  // GNU base-256 encoding for large values (high bit set).
  if (first & 0x80) {
    let value = 0;
    for (const byte of field) value = value * 256 + byte;
    return value;
  }
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readTarString(block: Buffer, offset: number, length: number): string {
  return block.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '');
}

/** A tar entry name must be relative and must not climb out of the archive (defence in depth —
 *  this reader only ever builds an in-memory map, but a future extractor must not inherit a hole). */
function assertSafeEntryName(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\')) {
    throw new TransferError(`bundle contains an unsafe path: ${name}`, 'not-a-bundle');
  }
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new TransferError(`bundle contains an unsafe path: ${name}`, 'not-a-bundle');
  }
}

function readTar(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  let pendingLongName: string | undefined;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (!header.some((byte) => byte !== 0)) break; // end-of-archive marker
    const size = parseTarNumber(header, 124, 12);
    if (size < 0 || size > MAX_ENTRY_BYTES || total + size > MAX_UNPACKED_BYTES) {
      throw new TransferError('bundle is larger than this cezar will unpack', 'not-a-bundle');
    }
    const type = String.fromCharCode(header[156] || 0x30);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    // Verify the checksum before trusting any field.
    const stored = parseTarNumber(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < header.length; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    if (stored !== sum) {
      throw new TransferError('bundle is corrupt (tar checksum mismatch)', 'not-a-bundle');
    }
    offset += 512;
    const dataStart = offset;
    offset += Math.ceil(size / 512) * 512;
    if (type === 'L') {
      pendingLongName = buffer.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0+$/, '');
      continue;
    }
    // Directories, PAX headers and global headers carry no file this reader needs.
    if (type === '5' || type === 'x' || type === 'g') continue;
    if (type !== '0' && type !== '\0') continue;
    const fullName = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
    pendingLongName = undefined;
    assertSafeEntryName(fullName);
    if (files.size >= MAX_ENTRIES) {
      throw new TransferError('bundle contains more files than this cezar will unpack', 'not-a-bundle');
    }
    files.set(fullName, Buffer.from(buffer.subarray(dataStart, dataStart + size)));
    total += size;
  }
  return files;
}

/** Pack a file map into the `.tgz` bytes a bundle is. */
export function packBundle(files: ReadonlyMap<string, Buffer | string>): Buffer {
  const blobs = new Map<string, Buffer>();
  for (const [name, data] of files) blobs.set(name, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return gzipSync(writeTar(blobs), { level: 6 });
}

/** Unpack `.tgz` bytes into the file map. Throws `TransferError('not-a-bundle')` on anything
 *  that is not one of ours — gzip garbage, a corrupt tar, an unsafe path. */
export function unpackBundle(bytes: Buffer): Map<string, Buffer> {
  let tarBytes: Buffer;
  try {
    tarBytes = gunzipSync(bytes);
  } catch {
    throw new TransferError('not a cezar handoff bundle (not gzip-compressed)', 'not-a-bundle');
  }
  return readTar(tarBytes);
}

/** Write bytes durably: temp file in the destination directory, then rename over the target. */
export function writeDurable(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

export function readBundleBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new TransferError(`cannot read bundle ${path}: ${err instanceof Error ? err.message : String(err)}`, 'not-a-bundle');
  }
}

export function parseManifest(files: ReadonlyMap<string, Buffer>): HandoffManifest {
  const raw = files.get(MANIFEST_FILE);
  if (!raw) throw new TransferError('not a cezar handoff bundle (no manifest.json)', 'not-a-bundle');
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new TransferError('bundle manifest is not valid JSON', 'not-a-bundle');
  }
  const formatVersion = (json as { formatVersion?: unknown })?.formatVersion;
  if (typeof formatVersion === 'number' && formatVersion !== HANDOFF_FORMAT_VERSION) {
    throw new TransferError(
      `this bundle was written by a different cezar (format ${formatVersion}, this cezar reads ${HANDOFF_FORMAT_VERSION})`,
      'unsupported-format',
    );
  }
  const parsed = handoffManifestSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues[0] ? `${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}` : 'invalid shape';
    throw new TransferError(`bundle manifest is malformed (${detail})`, 'not-a-bundle');
  }
  return parsed.data;
}

// ---- git bundle -------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

/** Run git, never throw — degradation is the caller's policy (the `git-worktree.ts` discipline). */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const errorCode = (err as NodeJS.ErrnoException | null)?.code;
        resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', errorCode });
      },
    );
  });
}

export function gitAvailableError(result: GitResult): string {
  if (result.errorCode === 'ENOENT') return 'git is not installed or not on PATH';
  return result.stderr.trim() || result.stdout.trim() || 'git failed';
}

/** `git bundle list-heads` → `refs/heads/…` → commit sha. Best-effort: '' on any failure. */
export async function bundleHeads(bundlePath: string, cwd?: string): Promise<Map<string, string>> {
  const res = await git(cwd ?? process.cwd(), ['bundle', 'list-heads', bundlePath]);
  const heads = new Map<string, string>();
  if (!res.ok) return heads;
  for (const line of res.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) heads.set(ref, sha);
  }
  return heads;
}

/** Pack the given branch refs into a git bundle at `outPath`. Throws on any failure so the
 *  caller never marks a run handed off over a bundle that was not written. */
export async function createBranchBundle(
  repoRoot: string,
  branches: readonly string[],
  outPath: string,
): Promise<void> {
  const refs = branches.map((branch) => `refs/heads/${branch}`);
  const res = await git(repoRoot, ['bundle', 'create', outPath, ...refs]);
  if (!res.ok) throw new TransferError(`git bundle create failed: ${gitAvailableError(res)}`, 'git-failed');
}

/** Fetch the listed refs from a bundle into local heads. The caller has already refused a
 *  diverging local ref, so `+` is only a belt-and-braces force — identical refs are a no-op. */
export async function fetchBundleRefs(
  repoRoot: string,
  bundlePath: string,
  branches: readonly string[],
): Promise<void> {
  if (branches.length === 0) return;
  const specs = branches.map((branch) => `+refs/heads/${branch}:refs/heads/${branch}`);
  const res = await git(repoRoot, ['fetch', '--no-tags', bundlePath, ...specs]);
  if (!res.ok) throw new TransferError(`git fetch from the bundle failed: ${gitAvailableError(res)}`, 'git-failed');
}

/** The local commit a branch points at, or undefined when the ref does not exist. */
export async function localRefSha(repoRoot: string, branch: string): Promise<string | undefined> {
  if (!isSafeGitRef(branch)) return undefined;
  const res = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return res.ok && res.stdout.trim() ? res.stdout.trim() : undefined;
}

/** `true` when the branch exists as a local head. */
export async function localRefExists(repoRoot: string, branch: string): Promise<boolean> {
  return (await localRefSha(repoRoot, branch)) !== undefined;
}

/** `git bundle verify` summary; `null` when the bundle is verifiable. Prerequisites are always
 *  satisfied by our own bundles (full history, never `^`-limited), so a failure here means the
 *  file is not a usable git bundle. */
export async function verifyBundle(repoRoot: string, bundlePath: string): Promise<string | null> {
  const res = await git(repoRoot, ['bundle', 'verify', bundlePath]);
  if (res.ok) return null;
  return gitAvailableError(res);
}

/** Where the git bundle lives inside a temp working directory. */
export function tempBundlePath(dir: string): string {
  return join(dir, BRANCHES_FILE);
}