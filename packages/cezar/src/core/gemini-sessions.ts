import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for an upstream Gemini CLI 0.60 bug found by the real-CLI smoke (#581): a session resumed
 * with ACP `session/load` in the SAME wall-clock minute (UTC) it was created is destroyed.
 *
 * Gemini records each session to `<gemini home>/.gemini/tmp/<project>/chats/` in a file named
 * `session-${new Date().toISOString().slice(0, 16).replace(/:/g, '-')}-${id.slice(0, 8)}.jsonl`
 * (`ChatRecordingService` in the 0.60.0 bundle). `session/load` starts a NEW recording for the
 * loaded id before it reads the history; inside the creation minute that new recording has the
 * original's file name, so it appends a fresh header and a `messages` reset to the original file.
 * The load then fails ("No previous sessions found for this project."), and so does every later
 * load: the history is gone for good. A task that finishes in under a minute and is continued
 * right away — the ordinary "send back" flow — hits it.
 *
 * So before loading, cezar looks for a recording of this session stamped with the current minute
 * and, when there is one, waits for the minute to roll over. It only reads directory names; it
 * never opens or edits Gemini's files.
 */
export function geminiResumeWaitMs(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): number {
  const shortId = sessionId.slice(0, 8);
  if (!/^[A-Za-z0-9-]{8}$/.test(shortId)) return 0;
  const minute = now.toISOString().slice(0, 16).replace(/:/g, '-');
  const name = `session-${minute}-${shortId}.jsonl`;
  const home = env.GEMINI_CLI_HOME?.trim() || homedir();
  const tmp = join(home, '.gemini', 'tmp');
  let projects: string[];
  try {
    projects = readdirSync(tmp);
  } catch {
    return 0;
  }
  if (!projects.some((project) => existsSync(join(tmp, project, 'chats', name)))) return 0;
  // To the next minute, plus a margin for clock skew between cezar and the child.
  return 60_000 - (now.getUTCSeconds() * 1000 + now.getUTCMilliseconds()) + 1_500;
}

/** A resume shell is a header and a context line — a few KB. Anything bigger is read as history. */
const SHELL_MAX_BYTES = 1024 * 1024;

/**
 * Guard for a second upstream Gemini CLI 0.60 bug, found by a live Continue → Continue: every
 * `session/load` leaves a SHELL recording behind — a new `session-<minute>-<id8>.jsonl` holding
 * only the session header and the startup context, written before the CLI reads the history,
 * while the turns themselves keep going to the original file. The next Gemini process started in
 * that project sweeps "abandoned" recordings at startup, by short id — and takes the history with
 * the shell, before any `session/load` is sent. The load then fails ("Invalid session identifier"
 * / "No previous sessions found for this project.") and the history is gone for good: the first
 * Continue works, the second starts from nothing. Reproduced on 2026-10-01 (both files gone
 * within a second of the spawn); with the shell removed first, the second load resumes.
 *
 * So cezar removes the shells of THIS session — before it spawns the CLI for a resume, and again
 * when a session's process has exited — and only those: a file is removed when its header names
 * this session id, it holds no conversation record, and another recording of the same session
 * does. A session's only recording is never touched, and neither is anything unreadable,
 * oversized or shaped differently from what 0.60 writes. Returns how many it removed.
 */
export function pruneGeminiResumeShells(sessionId: string, env: NodeJS.ProcessEnv = process.env): number {
  const shortId = sessionId.slice(0, 8);
  if (!/^[A-Za-z0-9-]{8}$/.test(shortId)) return 0;
  const home = env.GEMINI_CLI_HOME?.trim() || homedir();
  const tmp = join(home, '.gemini', 'tmp');
  let projects: string[];
  try {
    projects = readdirSync(tmp);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const project of projects) {
    const chats = join(tmp, project, 'chats');
    let names: string[];
    try {
      names = readdirSync(chats).filter((name) => name.startsWith('session-') && name.endsWith(`-${shortId}.jsonl`));
    } catch {
      continue;
    }
    if (names.length < 2) continue;
    const kinds = names.map((name) => recordingKind(join(chats, name), sessionId));
    if (!kinds.includes('history')) continue;
    names.forEach((name, index) => {
      if (kinds[index] !== 'shell') return;
      try {
        rmSync(join(chats, name));
        removed += 1;
      } catch {
        // Left in place: the load then fails the way it did before this guard, with a note.
      }
    });
  }
  return removed;
}

/** `shell`: this session's header and nothing said yet. `history`: it holds conversation records.
 *  `other`: anything cezar cannot vouch for — another session, unreadable, not 0.60's shape. */
function recordingKind(path: string, sessionId: string): 'shell' | 'history' | 'other' {
  let text: string;
  try {
    if (statSync(path).size > SHELL_MAX_BYTES) return 'history';
    text = readFileSync(path, 'utf8');
  } catch {
    return 'other';
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return 'other';
  let named = false;
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return 'other';
    }
    if (typeof record !== 'object' || record === null) return 'other';
    const fields = record as Record<string, unknown>;
    // A conversation record: a user prompt, a model answer, a tool round-trip.
    if (typeof fields.type === 'string') return 'history';
    if ('sessionId' in fields) {
      if (fields.sessionId !== sessionId) return 'other';
      named = true;
      continue;
    }
    const set = fields.$set;
    if (typeof set !== 'object' || set === null) return 'other';
    // A rewritten recording keeps its turns under `$set.messages`; the shell's holds one entry,
    // the startup context.
    const messages = (set as Record<string, unknown>).messages;
    if (Array.isArray(messages) && messages.length > 1) return 'history';
  }
  return named ? 'shell' : 'other';
}
