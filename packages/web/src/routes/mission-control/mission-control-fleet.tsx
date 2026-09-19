import * as React from 'react'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { fleetTotals, type FleetStatusCounts, type MissionControlFilter } from '@/lib/mission-control'
import { cn } from '@/lib/utils'

/**
 * The fleet-level readout above the Grid/Graph toggle — three small panels answering the
 * questions a per-tile board can't: what SHAPE is the fleet in right now (a distribution, not
 * eighteen individual dots to count), what is it costing me right now, and which project is
 * actually burning the money. "Mission Control" names a management job, not just a triage list —
 * this is the part of the page that is actually about managing the fleet rather than reading it
 * one run at a time.
 *
 * Every number here DOUBLES as a control: clicking a status segment or a project row narrows the
 * Grid/Graph below to that slice (`mission-control-route.tsx`'s `filter` state) — otherwise this
 * panel is just a prettier version of numbers a person still has to act on somewhere else. This
 * component always reads the FULL, unfiltered `runs` (never `applyMissionControlFilter`'s output)
 * on purpose: if selecting "needs you" shrank the very bar you clicked, the other segments would
 * vanish out from under your next click.
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
  filter,
  onFilterChange,
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
  filter: MissionControlFilter
  /** Clicking the segment/row that is ALREADY the active filter clears it — the same toggle a
   *  pressed filter chip usually gets, so there is always a way back to "everything" without a
   *  separate clear control living somewhere else on the page. */
  onFilterChange: (filter: MissionControlFilter) => void
}) {
  const totals = React.useMemo(() => fleetTotals(runs), [runs])
  const byId = React.useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const topProjects = React.useMemo(
    () => [...totals.costByProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    [totals.costByProject],
  )

  if (runs.length === 0) return null

  const toggleStatus = (bucket: keyof FleetStatusCounts) =>
    onFilterChange(filter?.kind === 'status' && filter.bucket === bucket ? undefined : { kind: 'status', bucket })
  const toggleProject = (projectId: string) =>
    onFilterChange(filter?.kind === 'project' && filter.projectId === projectId ? undefined : { kind: 'project', projectId })

  return (
    <div data-slot="mission-control-fleet" className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <FleetPanel label="Fleet status">
        <DistributionBar counts={totals.statusCounts} total={runs.length} filter={filter} onToggle={toggleStatus} />
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
                active={filter?.kind === 'project' && filter.projectId === projectId}
                onClick={() => toggleProject(projectId)}
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

function DistributionBar({
  counts,
  total,
  filter,
  onToggle,
}: {
  counts: FleetStatusCounts
  total: number
  filter: MissionControlFilter
  onToggle: (bucket: keyof FleetStatusCounts) => void
}) {
  const segments = DISTRIBUTION_SEGMENTS.filter((segment) => counts[segment.key] > 0)
  const activeBucket = filter?.kind === 'status' ? filter.bucket : undefined
  return (
    <div className="flex flex-col gap-2">
      {/* A row of adjacent buttons, not one bar with click-detection math on it — the segment
       *  boundaries ARE the button boundaries, so there is no pixel-picking to get this right,
       *  and each segment keeps its own real, keyboard-reachable, screen-reader-announced control
       *  instead of one `role="img"` bar faking five of them. */}
      <div data-slot="fleet-distribution-bar" className="flex h-2.5 gap-px overflow-hidden rounded-full">
        {segments.map((segment) => {
          const count = counts[segment.key]
          const isActive = activeBucket === segment.key
          return (
            <button
              key={segment.key}
              type="button"
              data-slot="fleet-distribution-segment"
              data-bucket={segment.key}
              aria-pressed={isActive}
              title={`${count} ${segment.label} — click to filter`}
              onClick={() => onToggle(segment.key)}
              className={cn(
                segment.dotClassName,
                'transition-[filter,opacity] hover:brightness-110',
                activeBucket !== undefined && !isActive && 'opacity-40',
              )}
              style={{ width: `${(count / total) * 100}%` }}
            />
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {segments.map((segment) => {
          const isActive = activeBucket === segment.key
          return (
            <button
              key={segment.key}
              type="button"
              onClick={() => onToggle(segment.key)}
              aria-pressed={isActive}
              className={cn(
                'flex items-center gap-1.5 rounded-sm transition-colors hover:text-foreground',
                isActive && 'text-foreground font-medium',
              )}
            >
              <span aria-hidden="true" className={cn('size-[6px] shrink-0 rounded-full', segment.dotClassName)} />
              <span className="font-mono tabular-nums">{counts[segment.key]}</span> {segment.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ProjectCostRow({
  name,
  cost,
  maxCost,
  active,
  onClick,
}: {
  name: string
  cost: number
  maxCost: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-slot="fleet-project-row"
      aria-pressed={active}
      onClick={onClick}
      title={`${name} — click to filter`}
      className={cn(
        'group -mx-1 flex items-center gap-2 rounded-md px-1 py-0.5 text-[11px] transition-colors hover:bg-muted',
        active && 'bg-muted',
      )}
    >
      <span className={cn('w-20 shrink-0 truncate text-left text-muted-foreground', active && 'font-medium text-foreground')}>
        {name}
      </span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full bg-violet transition-opacity', !active && 'opacity-70 group-hover:opacity-100')}
          style={{ width: `${(cost / maxCost) * 100}%` }}
        />
      </div>
      <span className="w-11 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
        ${cost.toFixed(2)}
      </span>
    </button>
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
