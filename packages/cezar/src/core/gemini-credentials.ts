import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Does this host visibly hold credentials Gemini CLI can use? Gemini CLI has no `auth status`
 * subcommand, so cezar reads the same places the CLI reads (spec 2026-09-19 § Phase 2 "Detection and
 * auth"), all verified in the 0.60.0 bundle:
 *
 * - `GEMINI_API_KEY` / `GOOGLE_API_KEY`, or a custom gateway (`GOOGLE_GEMINI_BASE_URL`);
 * - Vertex AI: `GOOGLE_GENAI_USE_VERTEXAI=true` with a project (`GOOGLE_CLOUD_PROJECT`);
 * - the `.env` the CLI loads on its own: `<gemini home>/.gemini/.env`, then `<gemini home>/.env`,
 *   where the gemini home is `GEMINI_CLI_HOME`, else the OS home (`homedir()` in the bundle).
 *
 * `false` is NOT "logged out": the CLI can also hold a key in the OS keychain or a Workspace login,
 * which cezar cannot see — so callers report `unknown` with the API-key hint, never `disconnected`.
 * Key VALUES are never read out: only whether a key line exists.
 */
export function geminiHasCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (present(env.GEMINI_API_KEY) || present(env.GOOGLE_API_KEY) || present(env.GOOGLE_GEMINI_BASE_URL)) return true;
  if (env.GOOGLE_GENAI_USE_VERTEXAI === 'true' && present(env.GOOGLE_CLOUD_PROJECT)) return true;
  const home = present(env.GEMINI_CLI_HOME) ? env.GEMINI_CLI_HOME! : homedir();
  return [join(home, '.gemini', '.env'), join(home, '.env')].some(definesKey);
}

function definesKey(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  return /^\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*\S/m.test(text);
}

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
