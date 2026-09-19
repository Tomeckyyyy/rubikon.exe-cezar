import * as React from 'react'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { fleetTotals, type FleetStatusCounts } from '@/lib/mission-control'
import { cn } from '@/lib/utils'

/**
 * The fleet-level readout above the Grid/Graph toggle — three small panels answering the
 * questions a per-tile board can't: what SHAPE is the fleet in right now (a distribution, not
 * eighteen individual dots to count), what is it costing me right now, and which project is
 * actually burning the money. "Mission Control" names a management job, not just a triage list —
 * this is the part of the page that is actually about managing the fleet rather than reading it
 * one run at a time.
 *
 * Renders for BOTH Grid and Graph (owned by `mission-control-route.tsx`, not either view) because
 * the fleet's shape and spend do not change depending on which presentation of the same runs is
 * currently on screen.
 */
export function MissionControlFleet({
  runs,
  projects,
  costHistory,
  showCost,
}: {
  runs: readonly RunIndexEntry[]
  projects: readonly ProjectListEntry[]
  /** `use-fleet-cost-history.ts`'s rolling, session-local sample list — never fetched, never
   *  persisted; see that hook's own header for why. */
  costHistory: readonly number[]
  /** `usageMetricVisibility(useHealth().data).cost` — the same host gate `global-tasks.tsx`'s
   *  table already honors (`CEZ_HIDE_COST` and friends). A board that ignored it would be the
   *  one surface in the cockpit where a disabled cost metric still shows up. */
  showCost: boolean
}) {
  const totals = React.useMemo(() => fleetTotals(runs), [runs])
  const byId = React.useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const topProjects = React.useMemo(
    () => [...totals.costByProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    [totals.costByProject],
  )

  if (runs.length === 0) return null

  return (
    <div data-slot="mission-control-fleet" className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <FleetPanel label="Fleet status">
        <DistributionBar counts={totals.statusCounts} total={runs.length} />
      </FleetPanel>

      {showCost ? (
        <FleetPanel label="Spend, active agents">
          <p data-slot="fleet-active-cost" className="font-mono text-lg leading-none font-semibold tabular-nums">
            ${totals.activeCostUsd.toFixed(2)}
          </p>
          <Sparkline values={costHistory} />
        </FleetPanel>
      ) : null}

      {showCost && topProjects.length > 1 ? (
        <FleetPanel label="Cost by project">
          <div className="flex flex-col gap-1.5">
            {topProjects.map(([projectId, cost]) => (
              <ProjectCostRow
                key={projectId}
                name={byId.get(projectId)?.name ?? projectId}
                cost={cost}
                maxCost={topProjects[0]![1]}
              />
            ))}
          </div>
        </FleetPanel>
      ) : null}
    </div>
  )
}

function FleetPanel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <p className="text-[11px] text-soft-foreground">{label}</p>
      {children}
    </div>
  )
}

/** One segment per non-empty bucket, ordered exactly the way `deriveAttention` ranks urgency
 *  (needs-you first) so the bar reads left-to-right the same way the Grid's own sections stack
 *  top-to-bottom — the two never disagree about what "first" means. */
const DISTRIBUTION_SEGMENTS: ReadonlyArray<{
  key: keyof FleetStatusCounts
  label: string
  dotClassName: string
}> = [
  { key: 'needsYou', label: 'needs you', dotClassName: 'bg-pending' },
  { key: 'working', label: 'working', dotClassName: 'bg-violet' },
  { key: 'failed', label: 'failed', dotClassName: 'bg-danger' },
  { key: 'done', label: 'done', dotClassName: 'bg-success' },
  { key: 'cancelled', label: 'cancelled', dotClassName: 'bg-soft-foreground' },
]

function DistributionBar({ counts, total }: { counts: FleetStatusCounts; total: number }) {
  const segments = DISTRIBUTION_SEGMENTS.filter((segment) => counts[segment.key] > 0)
  return (
    <div className="flex flex-col gap-2">
      <div
        data-slot="fleet-distribution-bar"
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={segments.map((segment) => `${counts[segment.key]} ${segment.label}`).join(', ')}
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={cn(segment.dotClassName)}
            style={{ width: `${(counts[segment.key] / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {segments.map((segment) => (
          <span key={segment.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-[6px] shrink-0 rounded-full', segment.dotClassName)} />
            <span className="font-mono tabular-nums">{counts[segment.key]}</span> {segment.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function ProjectCostRow({ name, cost, maxCost }: { name: string; cost: number; maxCost: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-20 shrink-0 truncate text-muted-foreground">{name}</span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-violet" style={{ width: `${(cost / maxCost) * 100}%` }} />
      </div>
      <span className="w-11 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
        ${cost.toFixed(2)}
      </span>
    </div>
  )
}

/**
 * A hand-rolled polyline rather than a charting dependency — this is one line with a handful of
 * points, the same "isolated new dependency only when the math is nontrivial" call this spec
 * already made for `@xyflow/react` + `dagre` (Swarm Graph), and here the math is not nontrivial.
 *
 * `viewBox` fakes a fixed coordinate space (`0 0 100 20`) so the SVG scales to any container width
 * via `preserveAspectRatio="none"` without recomputing points on resize, and `vector-effect`
 * keeps the stroke a constant 1.5px regardless of that scaling.
 */
function Sparkline({ values }: { values: readonly number[] }) {
  // Reserves the same footprint before enough samples exist, so the panel does not visibly grow
  // once the second sample lands a tick later.
  if (values.length < 2) return <div className="mt-1 h-8" aria-hidden="true" />

  const max = Math.max(...values, 0.01)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100
      const y = 20 - ((value - min) / range) * 18 - 1
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      className="mt-1 h-8 w-full"
      role="img"
      aria-label={`Spend over this session, from $${values[0]!.toFixed(2)} to $${values[values.length - 1]!.toFixed(2)}`}
    >
      <polyline points={points} fill="none" stroke="var(--violet)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
