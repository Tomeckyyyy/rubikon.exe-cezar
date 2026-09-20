import * as React from 'react'

/**
 * A rolling client-side history of one number — the fleet's active-run spend — sampled every
 * time it actually changes (`runs-index` ticking, on the workspace SSE stream or the poll
 * backstop `mission-control-route.tsx` already has).
 *
 * Deliberately NOT persisted and NOT server-sourced: cezar keeps no time series for cost (spec
 * `.ai/specs/2026-09-18-mission-control.md`'s whole premise is a pure overlay on data the server
 * already holds, and a real history would mean a new store to add, migrate and prune). This is a
 * sparkline of "since I opened this page," which is an honest, useful thing on its own — the
 * shape of the last few minutes' spend — and never claims to be more. It resets on navigation
 * away and reload, which is the correct behavior for state nothing persists.
 */
const MAX_SAMPLES = 40

export function useFleetCostHistory(activeCostUsd: number): readonly number[] {
  const [samples, setSamples] = React.useState<number[]>([activeCostUsd])

  React.useEffect(() => {
    setSamples((previous) => {
      const last = previous[previous.length - 1]
      // A tick that changed nothing (the common case between real cost movement) is not a new
      // sample — it would just stretch the sparkline's flat sections without adding information,
      // and would keep pushing genuinely old samples out of the MAX_SAMPLES window for no reason.
      if (last === activeCostUsd) return previous
      const next = [...previous, activeCostUsd]
      return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next
    })
  }, [activeCostUsd])

  return samples
}
