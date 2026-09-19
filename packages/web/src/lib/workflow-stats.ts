import type { ApiRun } from '@open-mercato/cezar-api-client'

/**
 * Per-(workflow, runner, model) outcome stats, computed entirely from runs the cockpit already
 * has (`useRuns()`) — no server route, no persisted state (spec
 * `.ai/specs/2026-09-19-workflow-outcome-stats.md`).
 *
 * Deliberately never computes anything called a "success rate": `review`/`done` mean the engine
 * reached a terminal state, not that the user accepted the result — cezar has no signal for that
 * yet. `failedRate` is the one rate this module names, and only over `failed`.
 */
export interface WorkflowStatsGroup {
  workflow: string
  runner: string
  model: string
  counts: {
    queued: number
    running: number
    waiting: number
    review: number
    done: number
    failed: number
    cancelled: number
  }
  /** review + done + failed + cancelled — the runs that reached an end state. */
  terminalTotal: number
  /** failed / terminalTotal; undefined when there are no terminal runs yet. */
  failedRate: number | undefined
  /** Average finishedAt-startedAt over terminal runs that have both timestamps. */
  avgDurationMs: number | undefined
  /** Average tokensUsed over terminal runs. */
  avgTokens: number | undefined
  /** Average costUsd over terminal runs that carry a cost. */
  avgCostUsd: number | undefined
}

const TERMINAL_STATUSES = new Set<ApiRun['status']>(['review', 'done', 'failed', 'cancelled'])

function average(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, v) => sum + v, 0) / values.length
}

function groupKey(run: ApiRun): string {
  return `${run.workflow}\u0000${run.runner ?? 'unknown'}\u0000${run.modelIdentity ?? run.model ?? 'default'}`
}

export function computeWorkflowStats(runs: readonly ApiRun[]): WorkflowStatsGroup[] {
  const groups = new Map<string, ApiRun[]>()
  for (const run of runs) {
    if (run.dispatch?.parentRunId !== undefined) continue // dispatched child, not a user workflow choice
    const key = groupKey(run)
    const bucket = groups.get(key)
    if (bucket) bucket.push(run)
    else groups.set(key, [run])
  }

  return [...groups.values()].map((groupRuns) => {
    const first = groupRuns[0]!
    const counts = {
      queued: 0,
      running: 0,
      waiting: 0,
      review: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    }
    for (const run of groupRuns) counts[run.status] += 1

    const terminalRuns = groupRuns.filter((run) => TERMINAL_STATUSES.has(run.status))
    const terminalTotal = terminalRuns.length

    return {
      workflow: first.workflow,
      runner: first.runner ?? 'unknown',
      model: first.modelIdentity ?? first.model ?? 'default',
      counts,
      terminalTotal,
      failedRate: terminalTotal === 0 ? undefined : counts.failed / terminalTotal,
      avgDurationMs: average(
        terminalRuns
          .filter((run) => run.startedAt && run.finishedAt)
          .map((run) => new Date(run.finishedAt!).getTime() - new Date(run.startedAt!).getTime()),
      ),
      avgTokens: average(terminalRuns.map((run) => run.tokensUsed)),
      avgCostUsd: average(terminalRuns.filter((run) => run.costUsd !== undefined).map((run) => run.costUsd!)),
    }
  })
}
