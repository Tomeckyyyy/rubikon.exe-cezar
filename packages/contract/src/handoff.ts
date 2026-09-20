import { z } from 'zod';
import { runStatusSchema } from './runs.ts';

/**
 * The HANDOFF family of `/api/v1` — moving finished tasks between machines from the cockpit
 * (spec `.ai/specs/2026-09-19-cross-machine-task-handoff.md`, Phase 3).
 *
 * The CLI is the primary surface (`cez handoff export|import|push|list|unmark`); these routes are
 * what the cockpit's "Hand off" action, handed-off badge and import surface call. Every route is
 * project-scoped: a bundle is imported INTO one project, and the machine-level cache directory is
 * only the shelf bundles sit on.
 *
 * The record half of the feature (`RunRecord.handoff`) lives in `./runs.ts`, because it is served
 * by the existing run routes; this family owns the bundle choreography.
 */

/**
 * A bundle file name as the cache holds it. Deliberately a strict pattern rather than "any
 * string": the name reaches the filesystem as a path segment, so `/`, `..` and anything a shell
 * would treat specially are refused at the boundary. The server additionally resolves the name
 * inside the cache directory and refuses anything that escapes it.
 */
export const handoffBundleNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/, 'a bundle name looks like <name>.tgz');

/** One bundle waiting in the machine's handoff cache. Metadata only — the manifest is read by the
 *  explicit preview, so listing never gunzips every bundle. */
export const handoffBundleEntrySchema = z.object({
  name: handoffBundleNameSchema,
  sizeBytes: z.number(),
  modifiedAt: z.string(),
});
export type HandoffBundleEntry = z.infer<typeof handoffBundleEntrySchema>;

/** `GET /handoff/bundles` — the import surface's shelf. Never 404s; an empty cache is `[]`. */
export const handoffBundlesResponseSchema = z.object({
  bundles: z.array(handoffBundleEntrySchema),
});
export type HandoffBundlesResponse = z.infer<typeof handoffBundlesResponseSchema>;

/**
 * One task of a previewed import. This is what `--dry-run` prints, as data: the destination's own
 * worktree path, whether the id already exists here (replace), and everything that will warn.
 */
export const handoffPlanEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: runStatusSchema,
  action: z.enum(['create', 'replace']),
  branch: z.string().optional(),
  worktree: z.enum(['materialize', 'none']),
  /** The DESTINATION path a materialized worktree gets. Absent when none is materialized. */
  worktreePath: z.string().optional(),
  warnings: z.array(z.string()),
});
export type HandoffPlanEntry = z.infer<typeof handoffPlanEntrySchema>;

/** `GET /handoff/bundles/preview?name=…` and the `plan` of an import answer — one shape, because
 *  the preview IS the plan the import will apply. */
export const handoffImportPlanSchema = z.object({
  /** The bundle file name (never an absolute path — the client already knows the name it sent). */
  name: z.string(),
  formatVersion: z.number(),
  createdAt: z.string(),
  cezarVersion: z.string(),
  /** Informational: the project id the bundle was exported from. */
  sourceProjectId: z.string().optional(),
  runs: z.array(handoffPlanEntrySchema),
  /** Refs packed in the bundle. */
  branches: z.array(z.string()),
  /** Refs that will be fetched into this machine. */
  fetch: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type HandoffImportPlan = z.infer<typeof handoffImportPlanSchema>;

/** `POST /handoff/export` body. Explicit ids only — there is no `--all` spelling over HTTP, so a
 *  user action can never pack the whole project by accident. */
export const handoffExportRequestSchema = z.object({
  runs: z.array(z.string().min(1)).min(1).max(300),
});
export type HandoffExportRequest = z.infer<typeof handoffExportRequestSchema>;

export const handoffExportResponseSchema = z.object({
  bundle: handoffBundleEntrySchema,
  /** The tasks now marked handed-off (a live task is refused with a 409 naming it). */
  runs: z.array(z.string()),
  branches: z.array(z.string()),
  notes: z.array(z.string()),
});
export type HandoffExportResponse = z.infer<typeof handoffExportResponseSchema>;

export const handoffImportRequestSchema = z.object({
  name: handoffBundleNameSchema,
});
export type HandoffImportRequest = z.infer<typeof handoffImportRequestSchema>;

export const handoffImportResponseSchema = z.object({
  imported: z.array(z.string()),
  plan: handoffImportPlanSchema,
});
export type HandoffImportResponse = z.infer<typeof handoffImportResponseSchema>;

/** `POST /handoff/unmark` body — the cockpit's undo for an accidental hand-off. Explicit ids, the
 *  same reasoning as export. */
export const handoffUnmarkRequestSchema = z.object({
  runs: z.array(z.string().min(1)).min(1).max(300),
});
export type HandoffUnmarkRequest = z.infer<typeof handoffUnmarkRequestSchema>;

export const handoffUnmarkResponseSchema = z.object({
  unmarked: z.array(z.string()),
});
export type HandoffUnmarkResponse = z.infer<typeof handoffUnmarkResponseSchema>;

export const handoffPreviewQuerySchema = z.object({
  name: handoffBundleNameSchema,
});
export type HandoffPreviewQuery = z.infer<typeof handoffPreviewQuerySchema>;