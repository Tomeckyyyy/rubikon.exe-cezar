import { agentTime, usd } from '@/lib/automation-format'
import { compactTokens } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { UsageMetricVisibility } from '@/lib/token-metrics'
import type { WorkflowStatsGroup } from '@/lib/workflow-stats'

/**
 * A workflow's run history (`.ai/specs/2026-09-19-workflow-outcome-stats.md`): raw terminal-
 * status counts, never a "success rate" — `review`/`done` mean the engine reached an end state,
 * not that the user accepted the result. `failed` is only styled as a warning once the sample is
 * big enough (`DANGER_MIN_TERMINAL`) that one bad run cannot paint a workflow red.
 */
const DANGER_MIN_TERMINAL = 3

export function WorkflowStatsRow({
  groups,
  usage,
}: {
  groups: readonly WorkflowStatsGroup[]
  usage: UsageMetricVisibility
}) {
  if (groups.length === 0) return null
  return (
    <div data-testid="workflow-stats-row" data-slot="workflow-stats-row" className="flex flex-col gap-1">
      {groups.map((group) => {
        const doneOrReview = group.counts.done + group.counts.review
        const danger = group.terminalTotal >= DANGER_MIN_TERMINAL && group.counts.failed > 0
        return (
          <div
            key={`${group.runner}/${group.model}`}
            data-slot="workflow-stats-group"
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground"
          >
            <span className="font-mono text-soft-foreground">
              {group.runner}/{group.model}
            </span>
            <Stat slot="stat-runs" label="runs" value={String(group.terminalTotal)} />
            <Stat slot="stat-done" label="done/review" value={String(doneOrReview)} />
            <Stat slot="stat-failed" label="failed" value={String(group.counts.failed)} danger={danger} />
            <Stat slot="stat-cancelled" label="cancelled" value={String(group.counts.cancelled)} />
            {group.avgDurationMs !== undefined ? (
              <Stat slot="stat-duration" label="avg" value={agentTime(group.avgDurationMs / 1000)} />
            ) : null}
            {usage.tokens && group.avgTokens !== undefined ? (
              <Stat slot="stat-tokens" label="avg tok" value={compactTokens(group.avgTokens)} />
            ) : null}
            {usage.cost && group.avgCostUsd !== undefined ? (
              <Stat slot="stat-cost" label="avg" value={usd(group.avgCostUsd)} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function Stat({ slot, label, value, danger = false }: { slot: string; label: string; value: string; danger?: boolean }) {
  return (
    <span data-slot={slot} data-danger={danger} className="inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap">
      <b className={cn('font-mono font-semibold tabular-nums', danger ? 'text-danger' : 'text-foreground')}>{value}</b>
      {label}
    </span>
  )
}
