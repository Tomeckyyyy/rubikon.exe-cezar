import * as React from 'react'

import type { RunIndexEntry } from '@open-mercato/cezar-api-client'

import { useRunEvents } from '@/api/run-events'
import { lastToolCallTitle } from '@/lib/mission-control'

/**
 * The live tool-call thumbnail's subscription policy (spec 2026-09-18-mission-control, Phase 2):
 * open a per-run event stream ONLY for a tile that is both on screen AND `running` — never one
 * socket per row in a fifty-row grid, and never a socket for a tile the user has scrolled past.
 *
 * This is the one genuinely new mechanism in this feature (the repo has no existing
 * `IntersectionObserver` usage — spec, "Risks"), so it is isolated to its own hook rather than
 * folded into `AgentTile` or the Grid: a badly written cleanup here would leak a socket per
 * fast-scrolled tile, and that is exactly the failure mode worth testing in isolation.
 *
 * Returns a ref CALLBACK (not a `RefObject`) because the element it observes is decided by the
 * caller's own JSX — `AgentTile`'s root node — and a callback ref is what lets that be wired
 * with a plain `ref={setNode}` without a second `useEffect` to attach/detach it.
 */
export function useVisibleRunEvents(
  run: Pick<RunIndexEntry, 'id' | 'projectId' | 'status'>,
): { setNode: (node: Element | null) => void; toolCall: string | undefined } {
  const [visible, setVisible] = React.useState(false)
  const observerRef = React.useRef<IntersectionObserver | null>(null)

  const setNode = React.useCallback((node: Element | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null) {
      setVisible(false)
      return
    }
    // No IntersectionObserver (an old browser, or a test environment that never stubs one) —
    // degrade to "always visible" rather than never subscribing at all: per-capability
    // degradation, the same rule `useRunEvents` itself applies when `EventSource` is absent.
    if (typeof IntersectionObserver !== 'function') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[entries.length - 1]?.isIntersecting ?? false),
      { threshold: 0.1 },
    )
    observer.observe(node)
    observerRef.current = observer
  }, [])

  // The observer must not outlive the component even if `setNode(null)` is never called (a
  // consumer that unmounts without clearing its own ref, e.g. via React's automatic cleanup on
  // an unmounted host node) — this is the unmount half `useRunEvents` cannot provide on its own.
  React.useEffect(() => () => observerRef.current?.disconnect(), [])

  const running = run.status === 'running'
  const subscribed = visible && running
  // Passing `undefined` when not subscribed is what actually unsubscribes: `useRunEvents` tears
  // its socket down and resets to `[]` the moment `runId` goes away, so visibility loss AND a
  // status change away from `running` both end the socket through the SAME path, with no second
  // teardown to keep in sync.
  const events = useRunEvents(subscribed ? run.id : undefined, { projectId: run.projectId })
  const toolCall = React.useMemo(() => lastToolCallTitle(events), [events])

  return { setNode, toolCall: subscribed ? toolCall : undefined }
}
