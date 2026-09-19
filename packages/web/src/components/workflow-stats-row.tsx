import { agentTime, usd } from '@/lib/automation-format'
import { compactTokens } from '@/lib/format'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { cn } from '@/lib/utils'
import type { UsageMetricVisibility } from '@/lib/token-metrics'
import type { WorkflowStatsGroup } from '@/lib/workflow-stats'

/**
 * A workflow's run history (`.ai/specs/2026-09-19-workflow-outcome-stats.md`): raw terminal-
 * status counts, never a "success rate" — `review`/`done` mean the engine reached an end state,
 * not that the user accepted the result. Shares the card chrome of this page's other auxiliary
 * panel (`wb-auto-panel` in `workflows.tsx`) rather than inventing a new container.
 *
 * The dot carries the status color, the text stays neutral — this design system's rule
 * (`status-dot.tsx`, `pill.tsx`). `cancelled` gets its own neutral dot rather than the danger
 * tone the task list uses for it: here the question is "did the engine break", and a run the
 * user stopped on purpose isn't that, even though it is elsewhere lumped in with failures.
 *
 * `failed`'s dot is always red — that's just what the bucket is. Its NUMBER only turns bold/red
 * once the sample is big enough (`DANGER_MIN_TERMINAL`) to mean anything, so a single unlucky run
 * can't paint a workflow's whole history red.
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
    <div
      data-testid="workflow-stats-row"
      data-slot="workflow-stats-row"
      className="rounded-lg border border-border bg-card p-3 shadow-xs"
    >
      <div className="text-[11px] font-medium tracking-wide text-soft-foreground uppercase">Run history</div>
      <div className="mt-2 divide-y divide-border/60">
        {groups.map((group) => {
          const danger = group.terminalTotal >= DANGER_MIN_TERMINAL && group.counts.failed > 0
          return (
            <div key={`${group.runner}/${group.model}`} data-slot="workflow-stats-group" className="py-2 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-[11.5px] text-soft-foreground">
                  {group.runner}/{group.model}
                </span>
                <Stat slot="stat-runs" label="runs" value={String(group.terminalTotal)} />
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <DotStat slot="stat-done" tone="success" label="done" value={group.counts.done} />
                <DotStat slot="stat-review" tone="violet" label="review" value={group.counts.review} />
                <DotStat slot="stat-failed" tone="danger" label="failed" value={group.counts.failed} danger={danger} />
                <DotStat slot="stat-cancelled" tone="neutral" label="cancelled" value={group.counts.cancelled} />
                <span className="ml-auto flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-soft-foreground">
                  {group.avgDurationMs !== undefined ? (
                    <span data-slot="stat-duration">avg {agentTime(group.avgDurationMs / 1000)}</span>
                  ) : null}
                  {usage.cost && group.avgCostUsd !== undefined ? (
                    <span data-slot="stat-cost">{usd(group.avgCostUsd)} avg</span>
                  ) : null}
                  {usage.tokens && group.avgTokens !== undefined ? (
                    <span data-slot="stat-tokens">{compactTokens(group.avgTokens)} tok avg</span>
                  ) : null}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Stat({ slot, label, value }: { slot: string; label: string; value: string }) {
  return (
    <span data-slot={slot} className="inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap text-[11px] text-soft-foreground">
      <b className="font-mono text-[12.5px] font-semibold tabular-nums text-foreground">{value}</b>
      {label}
    </span>
  )
}

function DotStat({
  slot,
  tone,
  label,
  value,
  danger = false,
}: {
  slot: string
  tone: StatusDotTone
  label: string
  value: number
  danger?: boolean
}) {
  return (
    <span
      data-slot={slot}
      data-danger={danger}
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-soft-foreground"
    >
      <StatusDot tone={tone} />
      <b className={cn('font-mono font-semibold tabular-nums', danger ? 'text-danger' : 'text-foreground')}>{value}</b>
      {label}
    </span>
  )
}
