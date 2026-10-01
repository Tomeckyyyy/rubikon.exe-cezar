import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The auth methods a user can have configured that work for Gemini CLI without a Google sign-in.
 * Google sign-in (`oauth-personal`) is deliberately absent here: for individuals it now fails every
 * session with `UNSUPPORTED_CLIENT` (`__fixtures__/gemini/unsupported-client.ndjson`), so a host
 * configured only for it is not evidence of working credentials — `hasLicensedGoogleLogin` below
 * decides when it is. Ids from `AuthType` in the 0.60.0 bundle.
 */
const WORKING_AUTH_TYPES: ReadonlySet<string> = new Set([
  'gemini-api-key',
  'vertex-ai',
  'gateway',
  'compute-default-credentials',
  'cloud-shell',
]);

/** Google sign-in, as `AuthType.LOGIN_WITH_GOOGLE` spells it. */
const GOOGLE_LOGIN_AUTH_TYPE = 'oauth-personal';

/** The names Gemini CLI reads the Code Assist project from (`setupUser` in the bundle). */
const PROJECT_NAMES = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID'] as const;

/**
 * Does this host visibly hold credentials Gemini CLI can use? Gemini CLI has no `auth status`
 * subcommand, so cezar reads the same places the CLI reads (spec 2026-09-19 § Phase 2 "Detection and
 * auth"), all verified in the 0.60.0 bundle:
 *
 * - `GEMINI_API_KEY` / `GOOGLE_API_KEY`, or a custom gateway (`GOOGLE_GEMINI_BASE_URL`);
 * - Vertex AI: `GOOGLE_GENAI_USE_VERTEXAI=true` with a project (`GOOGLE_CLOUD_PROJECT`);
 * - the `.env` the CLI loads on its own: `<gemini home>/.gemini/.env`, then `<gemini home>/.env`,
 *   where the gemini home is `GEMINI_CLI_HOME`, else the OS home (`homedir()` in the bundle);
 * - the auth method the user chose in the CLI (`security.auth.selectedType` in
 *   `<gemini home>/.gemini/settings.json`), when it is one that still works. This goes beyond the
 *   spec's environment-only rule on purpose: the CLI's own `/auth` dialog stores an API key in the OS
 *   keychain (`HybridTokenStorage`, service `gemini-cli-api-key`), which cezar cannot read — and the
 *   provider gate refuses every run for a provider that is not `connected`. A key that turns out to
 *   be bad still surfaces at run time as `provider-auth-required`;
 * - Google sign-in on an organization license (Workspace / Gemini Code Assist) — see
 *   `hasLicensedGoogleLogin`.
 *
 * `false` is NOT "logged out" — callers report `unknown` with the API-key hint, never
 * `disconnected`. Key VALUES are never read out: only whether a key line exists.
 */
export function geminiHasCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (present(env.GEMINI_API_KEY) || present(env.GOOGLE_API_KEY) || present(env.GOOGLE_GEMINI_BASE_URL)) return true;
  if (env.GOOGLE_GENAI_USE_VERTEXAI === 'true' && present(env.GOOGLE_CLOUD_PROJECT)) return true;
  const home = present(env.GEMINI_CLI_HOME) ? env.GEMINI_CLI_HOME! : homedir();
  const envFiles = [join(home, '.gemini', '.env'), join(home, '.env')];
  if (envFiles.some((path) => definesAny(path, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']))) return true;
  const selected = selectedAuthType(join(home, '.gemini', 'settings.json'));
  if (selected !== undefined && WORKING_AUTH_TYPES.has(selected)) return true;
  return hasLicensedGoogleLogin(env, home, envFiles, selected);
}

/**
 * Google sign-in still works for an account whose organization holds a license (Workspace / Gemini
 * Code Assist Standard or Enterprise); only the individual tier was retired. cezar cannot ask Google
 * which tier an account is on, so it counts a sign-in only when all of these hold — the shape of a
 * licensed setup, which an individual's leftover login does not have:
 *
 * - Google sign-in is the chosen method: `GOOGLE_GENAI_USE_GCA=true` (`getAuthTypeFromEnv`), or
 *   `oauth-personal` in settings.json;
 * - a Google Cloud project is named (`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID`, in the
 *   environment or the `.env` the CLI loads) — a licensed account needs one, the retired individual
 *   tier never did;
 * - a completed sign-in is on disk (`<gemini home>/.gemini/oauth_creds.json`), or the caller supplies
 *   the token itself (`GOOGLE_CLOUD_ACCESS_TOKEN`). With `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`
 *   the CLI keeps the token in the OS keychain, which cezar cannot read, so the first two stand alone.
 *
 * An account that turns out to be unlicensed still fails at run time as `provider-auth-required`.
 */
function hasLicensedGoogleLogin(
  env: NodeJS.ProcessEnv,
  home: string,
  envFiles: readonly string[],
  selected: string | undefined,
): boolean {
  const googleLoginChosen = env.GOOGLE_GENAI_USE_GCA === 'true' || selected === GOOGLE_LOGIN_AUTH_TYPE;
  if (!googleLoginChosen) return false;
  const projectNamed =
    PROJECT_NAMES.some((name) => present(env[name])) || envFiles.some((path) => definesAny(path, PROJECT_NAMES));
  if (!projectNamed) return false;
  return (
    present(env.GOOGLE_CLOUD_ACCESS_TOKEN) ||
    env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE === 'true' ||
    readText(join(home, '.gemini', 'oauth_creds.json')) !== undefined
  );
}

/** Does the `.env` at `path` set any of `names` to a non-empty value? The value is never read out. */
function definesAny(path: string, names: readonly string[]): boolean {
  const text = readText(path);
  return text !== undefined && new RegExp(`^\\s*(?:export\\s+)?(?:${names.join('|')})\\s*=\\s*\\S`, 'm').test(text);
}

function selectedAuthType(path: string): string | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    const settings = JSON.parse(text) as { security?: { auth?: { selectedType?: unknown } } };
    const selected = settings?.security?.auth?.selectedType;
    return typeof selected === 'string' ? selected : undefined;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
