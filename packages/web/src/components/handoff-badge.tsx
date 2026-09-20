import { DownloadIcon, UploadIcon } from 'lucide-react'
import type { RunHandoff } from '@open-mercato/cezar-api-client'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * The badge a run wears once it has crossed machines (spec
 * `.ai/specs/2026-09-19-cross-machine-task-handoff.md`, § UI/UX).
 *
 * `handoff` is the prop rather than `run`, because two different record shapes carry the same
 * optional field: the fat `RunRecord` on the task page and the slim `RunIndexEntry` on the
 * global Tasks page. Both satisfy this shape structurally, so neither surface needs an adapter
 * or a second badge that could drift.
 *
 * The tooltip is the only place the direction's CONSEQUENCE is spelled out — "handed off" is a
 * state, not an instruction, and a user who has never run `cez handoff` cannot be expected to
 * know that Continue is refused until the mark is cleared. The same sentence is the accessible
 * name, because `TooltipContent` is portalled and mounted only while open: without it a screen
 * reader (or a keyboard user who cannot hover) would get the two-word label alone, which names
 * the state but not what it means.
 */
export function HandoffBadge({
  handoff,
  now = Date.now(),
  className,
}: {
  handoff?: RunHandoff
  /** Injected so the tooltip's age is not racing the clock in tests. */
  now?: number
  className?: string
}) {
  if (!handoff) return null
  const out = handoff.direction === 'out'
  const age = shortAge(handoff.at, now)
  const when = age ? `${age} ago` : handoff.at
  const peer = handoff.peer ? ` ${out ? 'to' : 'from'} ${handoff.peer}` : ''
  const details = out
    ? `Handed off${peer} ${when} — Continue refuses until it is unmarked, because the other machine owns this task now.`
    : `Imported${peer} ${when} — Continue starts a fresh session from its handoff journal.`
  const Icon = out ? UploadIcon : DownloadIcon

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-slot="handoff-badge"
            data-direction={handoff.direction}
            // Focusable so the explanation is reachable without a pointer (Radix opens the
            // tooltip on focus); `aria-label` carries it for assistive tech even while closed.
            tabIndex={0}
            aria-label={details}
            className={cn(
              'inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[10.5px] leading-[1.4] font-medium whitespace-nowrap text-muted-foreground',
              className,
            )}
          >
            <Icon className="size-3 shrink-0" aria-hidden="true" />
            {out ? 'handed off' : 'imported'}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px]">
          {details}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
