import { z } from 'zod';

/** User-selectable runners, in display order. All complete runner sets derive from this tuple. */
export const RUNNER_IDS = ['claude', 'codex', 'opencode', 'cursor', 'pi', 'junie', 'copilot', 'gemini', 'omp'] as const;
export const runnerSchema = z.enum(RUNNER_IDS);
export type Runner = z.infer<typeof runnerSchema>;

/** Build a typed per-runner object while preserving each caller's field and object policies. */
export function perRunner<S extends z.ZodTypeAny>(schema: S): z.ZodObject<{ [K in Runner]: S }> {
  const shape = Object.fromEntries(RUNNER_IDS.map((id) => [id, schema])) as { [K in Runner]: S };
  return z.object(shape);
}
