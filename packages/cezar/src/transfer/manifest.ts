import { z } from 'zod';
import { runStatusSchema, runnerSchema } from '@open-mercato/cezar-contract';

/**
 * The cross-machine boundary of `cez handoff` (spec
 * `.ai/specs/2026-09-19-cross-machine-task-handoff.md`): the manifest every bundle carries, and
 * the error type the transfer modules refuse with.
 *
 * Deliberately its OWN module rather than a key in `handoff.ts` — that name is taken by the
 * per-task handoff JOURNAL (spec 007), which is a different feature with a different lifecycle.
 * A bundle is what moves a task between machines; the journal is what makes the destination's
 * continuation meaningful once it arrives.
 *
 * The manifest carries REFERENCES, never secrets: run ids, display fields, branch names. No
 * `.env`, no `~/.cezar/agent-accounts.json`, no vendor session files, no attachment bytes. Event
 * NDJSON is already redacted at persist time (`core/secret-redaction.ts`), and the whole bundle
 * is untrusted input on the receiving side — every field is validated through the schemas here
 * and in `import.ts` before anything is written.
 */

/** Bump only for an incompatible layout; a newer cezar importing an older bundle must still work. */
export const HANDOFF_FORMAT_VERSION = 1;

/**
 * The statuses export accepts, and the only ones import will take. Each of the others holds a
 * live or open session that cannot travel: `queued` has a live slot claim, `running` a live
 * agent process, `waiting` an open interactive session. Refusing them at the source removes the
 * whole "an imported live run starts itself" failure class instead of papering over it.
 */
export const TERMINAL_RUN_STATUSES = ['done', 'failed', 'cancelled', 'review'] as const;
export const terminalRunStatusSchema = z.enum(TERMINAL_RUN_STATUSES);
export type TerminalRunStatus = z.infer<typeof terminalRunStatusSchema>;

export function isTerminalRunStatus(status: string): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * One exported run, as the manifest names it. A REFERENCE, not the record: the full record
 * travels as `runs/<id>.json` inside the bundle and is validated against `runRecordSchema` on
 * arrival. `worktreePath` is the SOURCE path and informational only — the destination decides its
 * own path through `createWorktree` and never writes this value onto a record.
 */
export const handoffRunSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: runStatusSchema,
  runner: runnerSchema.optional(),
  model: z.string().optional(),
  modelIdentity: z.string().optional(),
  agentProfile: z.string().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  /** Source-machine path — informational; the destination resolves its own. */
  worktreePath: z.string().optional(),
});
export type HandoffRun = z.infer<typeof handoffRunSchema>;

export const handoffManifestSchema = z.object({
  formatVersion: z.literal(HANDOFF_FORMAT_VERSION),
  createdAt: z.string(),
  cezarVersion: z.string(),
  /** Informational: the destination re-registers by path, never by id. */
  sourceProjectId: z.string().optional(),
  runs: z.array(handoffRunSchema),
  /** Refs packed into `branches.bundle`, exactly as they were resolved at export time. */
  branches: z.array(z.string()),
});
export type HandoffManifest = z.infer<typeof handoffManifestSchema>;

/** The bundle's manifest entry for a run record (structurally typed — this module stays free of
 *  the store, so the manifest cannot accidentally grow persistence concerns). */
export function manifestRunEntry(run: {
  id: string;
  title: string;
  status: string;
  runner?: string;
  model?: string;
  modelIdentity?: string;
  agentProfile?: string;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string;
}): HandoffRun {
  return {
    id: run.id,
    title: run.title,
    status: run.status as HandoffRun['status'],
    ...(run.runner !== undefined ? { runner: run.runner as HandoffRun['runner'] } : {}),
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(run.modelIdentity !== undefined ? { modelIdentity: run.modelIdentity } : {}),
    ...(run.agentProfile !== undefined ? { agentProfile: run.agentProfile } : {}),
    ...(run.branch !== undefined ? { branch: run.branch } : {}),
    ...(run.baseBranch !== undefined ? { baseBranch: run.baseBranch } : {}),
    ...(run.worktreePath !== undefined ? { worktreePath: run.worktreePath } : {}),
  };
}

/**
 * Every refusal of the transfer family — the untrusted-bundle boundary, the selection rules, the
 * live-instance guard, git and ssh failures. The message is written for the CLI user (or the
 * cockpit's error toast); `code` exists so a caller can branch without parsing prose.
 */
export class TransferError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-a-bundle'
      | 'unsupported-format'
      | 'malformed-record'
      | 'not-terminal'
      | 'unknown-run'
      | 'nothing-to-export'
      | 'not-registered'
      | 'live-instance'
      | 'branch-conflict'
      | 'git-failed'
      | 'ssh-failed'
      | 'io-failed' = 'io-failed',
  ) {
    super(message);
    this.name = 'TransferError';
  }
}