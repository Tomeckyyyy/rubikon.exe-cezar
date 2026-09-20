import { LoaderCircleIcon } from 'lucide-react'

import { CenteredState } from '@/components/centered-state'

/**
 * Mission Control's loading state — like `compare-loading.tsx`, in its own module ON PURPOSE:
 * it doubles as the `Suspense` fallback for the lazily-loaded route chunk (routes.tsx), and the
 * fallback must not import anything from that chunk or the split (`@xyflow/react` + `dagre`,
 * Phase 3) quietly disappears back into the main bundle.
 */
export function MissionControlLoading() {
  return (
    <div data-route="mission-control" className="flex min-h-full flex-col">
      <CenteredState
        icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
        tone="neutral"
        title="Loading Mission Control…"
        subtitle="Fetching every project's runs."
      />
    </div>
  )
}
