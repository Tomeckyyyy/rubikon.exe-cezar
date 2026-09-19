import { LayersIcon, LoaderCircleIcon } from 'lucide-react'
import * as React from 'react'

import { useProjects, useRunsIndex } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { truncatedProjectNames } from '@/lib/global-tasks'
import { needsYouRun } from '@/lib/mission-control'
import { useMissionControlView, type MissionControlView } from '@/lib/use-mission-control-view'
import { cn } from '@/lib/utils'

import { MissionControlGrid } from './mission-control-grid'

/** Lazy ON PURPOSE, split from the route's own chunk (spec 2026-09-18-mission-control,
 *  Architecture): `@xyflow/react` + `dagre` are a dependency this ONE view needs, and Grid-only
 *  visitors — the common case per the spec's own Phase 1/2 framing — must not pay for it. */
const MissionControlGraph = React.lazy(() =>
  import('./mission-control-graph').then((m) => ({ default: m.MissionControlGraph })),
)

/** Same backstop interval `GlobalTasksRoute` polls the index on (see that file's own comment) —
 *  this page reads the identical query, so it inherits the same freshness story: the workspace
 *  SSE stream is the mechanism, this is the cover for a dropped socket or a frozen tab. */
const RUNS_INDEX_POLL_MS = 15_000

/**
 * `/mission-control` — a global (cross-project), purely front-end view of every run in flight,
 * as tiles or a graph (spec 2026-09-18-mission-control). Outside every `/p/:projectId`, exactly
 * like `/tasks`: reads the same workspace-level index (`useRunsIndex`) so it is never a second
 * fetch or a second cache for data `GlobalTasksRoute` already holds.
 *
 * `highlightedRunId` lives HERE, not in either view, which is the whole reason it "survives" a
 * Grid⇄Graph switch (Phase 3, plan step 12): switching views only swaps which component reads
 * this route's own state, it never remounts the route itself.
 */
export function MissionControlRoute() {
  const projects = useProjects()
  const index = useRunsIndex(true, RUNS_INDEX_POLL_MS)
  const { view, setView } = useMissionControlView()
  const [highlightedRunId, setHighlightedRunId] = React.useState<string | undefined>(undefined)
  const registry = React.useMemo(() => projects.data?.projects ?? [], [projects.data])
  const truncated = React.useMemo(
    () => truncatedProjectNames(index.data?.truncated ?? [], registry),
    [index.data, registry],
  )
  const needsYouCount = React.useMemo(
    () => (index.data?.runs ?? []).filter(needsYouRun).length,
    [index.data],
  )

  if (index.isError || projects.isError) {
    return (
      <div data-route="mission-control" className="flex min-h-full flex-col">
        <CenteredState
          icon={<LayersIcon />}
          tone="danger"
          title="Mission Control did not load"
          subtitle={(index.error ?? projects.error)?.message}
        />
      </div>
    )
  }

  return (
    <div data-route="mission-control" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Mission Control</h1>
        <ViewToggle view={view} onChange={setView} />
        {needsYouCount > 0 ? (
          // The one number a person opening this page actually wants first: not "how many
          // agents exist" but "how many of them are stuck on ME right now" — the run count to
          // its right already answers the first question.
          <span
            data-slot="mission-control-needs-you-count"
            className="rounded-full bg-pending/15 px-2 py-0.5 text-[12px] font-medium text-pending-strong tabular-nums"
          >
            {needsYouCount} need{needsYouCount === 1 ? 's' : ''} you
          </span>
        ) : null}
        <div className="flex-1" />
        <span data-slot="mission-control-count" className="text-[12.5px] text-soft-foreground tabular-nums">
          {index.data?.runs.length ?? 0} runs
        </span>
      </header>

      <div className="flex flex-1 flex-col gap-3 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        <div className="md:hidden">
          <ViewToggle view={view} onChange={setView} />
        </div>

        {truncated.length > 0 ? (
          <p data-slot="mission-control-truncated" className="text-[11.5px] text-soft-foreground">
            Showing the newest {index.data?.perProjectLimit} tasks per project — older ones in{' '}
            {truncated.join(', ')} are only in that project&rsquo;s own Tasks page.
          </p>
        ) : null}

        {index.data === undefined ? null : view === 'graph' ? (
          <React.Suspense fallback={<GraphLoading />}>
            <MissionControlGraph
              runs={index.data.runs}
              projects={registry}
              highlightedRunId={highlightedRunId}
              onHighlightRun={setHighlightedRunId}
            />
          </React.Suspense>
        ) : (
          <MissionControlGrid
            runs={index.data.runs}
            projects={registry}
            highlightedRunId={highlightedRunId}
            onHighlightRun={setHighlightedRunId}
          />
        )}
      </div>
    </div>
  )
}

/** Grid/Graph, two mutually exclusive tabs — the same shape as `GlobalTasksRoute`'s
 *  Active/Archived `ViewTab`, deliberately: one filters/reshapes one list, so it is a tab pair,
 *  not a checkbox pair. */
function ViewToggle({
  view,
  onChange,
}: {
  view: MissionControlView
  onChange: (view: MissionControlView) => void
}) {
  return (
    <div data-slot="mission-control-view-toggle" className="inline-flex gap-0.5 rounded-md bg-muted p-[3px]">
      <ViewTab view="grid" current={view} onSelect={onChange}>
        Grid
      </ViewTab>
      <ViewTab view="graph" current={view} onSelect={onChange}>
        Swarm Graph
      </ViewTab>
    </div>
  )
}

function ViewTab({
  view,
  current,
  onSelect,
  children,
}: {
  view: MissionControlView
  current: MissionControlView
  onSelect: (view: MissionControlView) => void
  children: React.ReactNode
}) {
  const isActive = view === current
  return (
    <button
      type="button"
      data-slot="mission-control-view-tab"
      data-view={view}
      aria-pressed={isActive}
      onClick={() => onSelect(view)}
      className={cn(
        'flex h-7 items-center justify-center rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground',
        isActive && 'bg-card font-semibold text-foreground shadow-xs',
      )}
    >
      {children}
    </button>
  )
}

function GraphLoading() {
  return (
    <CenteredState
      heading="h2"
      icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
      tone="neutral"
      title="Loading Swarm Graph…"
    />
  )
}
