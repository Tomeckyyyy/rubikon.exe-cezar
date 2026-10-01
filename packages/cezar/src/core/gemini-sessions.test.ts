import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { geminiResumeWaitMs, pruneGeminiResumeShells } from './gemini-sessions.ts';

/**
 * The same-minute resume guard (#581). The file name is Gemini CLI 0.60's own
 * (`session-<ISO minute, UTC>-<id8>.jsonl`); reproduced against the real CLI on 2026-09-19: a
 * `session/load` in the creation minute destroyed the session permanently, one a minute later
 * worked.
 */
const SESSION = 'a9a3ac1b-e340-4286-8c10-fc98a83dca58';
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-gemini-sessions-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function recording(project: string, minute: string, id = SESSION): void {
  const chats = join(home, '.gemini', 'tmp', project, 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(chats, `session-${minute}-${id.slice(0, 8)}.jsonl`), '{}\n');
}

describe('geminiResumeWaitMs', () => {
  it('waits for the next minute (plus a margin) when the session was created in the current one', () => {
    recording('repo', '2026-09-19T16-59');
    const now = new Date('2026-09-19T16:59:07.250Z');
    expect(geminiResumeWaitMs(SESSION, { GEMINI_CLI_HOME: home }, now)).toBe(60_000 - 7_250 + 1_500);
  });

  it('does not wait once the minute has passed, or for another session', () => {
    recording('repo', '2026-09-19T16-58');
    recording('repo', '2026-09-19T16-59', 'ffffffff-0000-4000-8000-000000000000');
    expect(geminiResumeWaitMs(SESSION, { GEMINI_CLI_HOME: home }, new Date('2026-09-19T16:59:07Z'))).toBe(0);
  });

  it('finds the recording whatever project folder Gemini filed it under', () => {
    recording('cez-gemini-smoke-hbz4y4', '2026-09-19T16-59');
    expect(geminiResumeWaitMs(SESSION, { GEMINI_CLI_HOME: home }, new Date('2026-09-19T16:59:59.000Z'))).toBe(2_500);
  });

  it('degrades to no wait when Gemini has no tmp dir or the id is not id-shaped', () => {
    expect(geminiResumeWaitMs(SESSION, { GEMINI_CLI_HOME: home })).toBe(0);
    expect(geminiResumeWaitMs('../../x', { GEMINI_CLI_HOME: home })).toBe(0);
  });
});

/**
 * The second-resume guard. Shapes copied from Gemini CLI 0.60.0's own files after a live
 * run → Continue on 2026-10-01: the original recording holds the turns as top-level records, and
 * the load left a second file with the header and the startup context only (written twice).
 */
describe('pruneGeminiResumeShells', () => {
  const header = (id = SESSION): string =>
    JSON.stringify({ sessionId: id, projectHash: 'd4e7', startTime: '2026-10-01T20:06:01.521Z', lastUpdated: '2026-10-01T20:06:01.521Z', kind: 'main' });
  const context = JSON.stringify({ $set: { messages: [{ id: 'd049', type: 'user', content: [{ text: '<session_context>' }] }] } });
  const SHELL = [header(), context, header(), context, ''].join('\n');
  const HISTORY = [
    header(),
    context,
    JSON.stringify({ id: 'f21a', timestamp: '2026-10-01T20:05:10.000Z', type: 'user', content: [{ text: 'create g2.txt' }] }),
    JSON.stringify({ $set: { lastUpdated: '2026-10-01T20:05:10.000Z' } }),
    JSON.stringify({ id: 'd72b', timestamp: '2026-10-01T20:05:12.000Z', type: 'gemini', content: 'done' }),
    '',
  ].join('\n');

  function file(minute: string, content: string, id = SESSION, project = 'repo'): string {
    const chats = join(home, '.gemini', 'tmp', project, 'chats');
    mkdirSync(chats, { recursive: true });
    const path = join(chats, `session-${minute}-${id.slice(0, 8)}.jsonl`);
    writeFileSync(path, content);
    return path;
  }

  it('removes the shell an earlier load left and keeps the recording that holds the turns', () => {
    const history = file('2026-10-01T20-05', HISTORY);
    const shell = file('2026-10-01T20-06', SHELL);
    expect(pruneGeminiResumeShells(SESSION, { GEMINI_CLI_HOME: home })).toBe(1);
    expect(existsSync(history)).toBe(true);
    expect(existsSync(shell)).toBe(false);
    // Nothing left to remove; the history is never a candidate.
    expect(pruneGeminiResumeShells(SESSION, { GEMINI_CLI_HOME: home })).toBe(0);
    expect(existsSync(history)).toBe(true);
  });

  it('never removes a session\'s only recording, even when nothing has been said in it yet', () => {
    const only = file('2026-10-01T20-06', SHELL);
    expect(pruneGeminiResumeShells(SESSION, { GEMINI_CLI_HOME: home })).toBe(0);
    expect(existsSync(only)).toBe(true);
  });

  it('keeps shells when no recording of the session holds turns — there is nothing to protect', () => {
    const first = file('2026-10-01T20-06', SHELL);
    const second = file('2026-10-01T20-07', SHELL);
    expect(pruneGeminiResumeShells(SESSION, { GEMINI_CLI_HOME: home })).toBe(0);
    expect(existsSync(first) && existsSync(second)).toBe(true);
  });

  it('leaves alone what it cannot vouch for: another session behind the same short id, a rewritten history, junk', () => {
    const history = file('2026-10-01T20-05', HISTORY);
    const sibling = file('2026-10-01T20-06', [header(`${SESSION.slice(0, 8)}-0000-4000-8000-000000000000`), context, ''].join('\n'));
    const rewritten = file(
      '2026-10-01T20-07',
      [header(), JSON.stringify({ $set: { messages: [{ type: 'user' }, { type: 'gemini' }] } }), ''].join('\n'),
    );
    const junk = file('2026-10-01T20-08', 'not json\n');
    const empty = file('2026-10-01T20-09', '');
    expect(pruneGeminiResumeShells(SESSION, { GEMINI_CLI_HOME: home })).toBe(0);
    for (const path of [history, sibling, rewritten, junk, empty]) expect(existsSync(path)).toBe(true);
  });

  it('degrades to a no-op when Gemini has no tmp dir or the id is not id-shaped', () => {
    expect(pruneGeminiResumeShells(SESSION, { GEMINI_CLI_HOME: home })).toBe(0);
    expect(pruneGeminiResumeShells('../../x', { GEMINI_CLI_HOME: home })).toBe(0);
  });
});
