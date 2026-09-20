import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PackageOpenIcon } from 'lucide-react'
import { useState } from 'react'

import { importHandoffBundle, previewHandoffBundle } from '@/api/client'
import { queryKeys, useHandoffBundles } from '@/api/queries'
import type { HandoffBundleEntry, HandoffImportPlan } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { formatMem } from '@/lib/tasks-table'
import { cn } from '@/lib/utils'

/**
 * "Import a bundle" (spec `.ai/specs/2026-09-19-cross-machine-task-handoff.md`, Phase 3 step 10):
 * the cockpit's shelf of bundles waiting in `~/.cache/cez/handoff/` and the same preview
 * `cez handoff import --dry-run` prints — what each task will become, where its worktree lands,
 * and every warning — before anything is written.
 *
 * The dialog is mounted with `open` and gates BOTH queries on it (`useHandoffBundles(open)`, the
 * preview on `open && selected`): a closed dialog is an inert one, which matters because these
 * routes 409 in hosted mode and the component may sit mounted on a page whose button is hidden.
 *
 * Import is deliberately two-step — pick, read the plan, then commit — because it upserts records
 * and materializes worktrees in THIS repo; the CLI's `--dry-run` is the same courtesy, and a
 * destructive action without it would be a worse cockpit than the terminal it replaces.
 */
export function HandoffImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const bundles = useHandoffBundles(open)
  const preview = useQuery({
    queryKey: queryKeys.handoff.preview(selected ?? ''),
    queryFn: ({ signal }) => previewHandoffBundle(selected as string, { signal }),
    enabled: open && selected !== null,
    retry: false,
  })
  const importBundle = useMutation({
    mutationFn: (name: string) => importHandoffBundle(name),
    onSuccess: (result) => {
      // The list and every detail query under it — an import upserts records, so the shelf
      // itself is unchanged but the tasks around it are not.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      const count = result.imported.length
      toast(`Imported ${count} ${count === 1 ? 'task' : 'tasks'} from ${result.plan.name}`)
      setOpen(false)
    },
    // Inline AND toasted: the inline line stays next to the button that failed (the dialog does
    // not close), while the toast is what a user looking elsewhere still notices.
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  /** Close resets the selection and the last refusal, so a reopen is a fresh surface. */
  const setOpen = (next: boolean) => {
    if (!next) {
      setSelected(null)
      importBundle.reset()
    }
    onOpenChange(next)
  }

  const shelf = bundles.data?.bundles ?? []
  const importError = importBundle.error instanceof Error ? importBundle.error.message : undefined

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-import would hide a write that is already in flight.
        if (importBundle.isPending) return
        setOpen(next)
      }}
    >
      <DialogContent
        data-slot="handoff-import-dialog"
        className="min-w-0 max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>Import a bundle</DialogTitle>
          <DialogDescription>
            Recreate the tasks, branches and worktrees a bundle carries. Nothing starts on its own —
            imported tasks wait for Continue.
          </DialogDescription>
        </DialogHeader>

        {bundles.data === undefined ? (
          <p className="text-[13px] text-muted-foreground">
            {bundles.isError ? 'Could not read the handoff cache.' : 'Reading the handoff cache…'}
          </p>
        ) : shelf.length === 0 ? (
          <div
            data-slot="handoff-empty"
            className="rounded-lg border border-dashed border-border px-4 py-6 text-center"
          >
            <PackageOpenIcon className="mx-auto size-5 text-soft-foreground" aria-hidden="true" />
            <p className="mt-2 text-[13px] font-medium">No bundles on this machine yet</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Bundles land in <code className="font-mono">~/.cache/cez/handoff/</code> — export one
              with <code className="font-mono">cez handoff export</code>, or send one over SSH with{' '}
              <code className="font-mono">cez handoff push</code>.
            </p>
          </div>
        ) : (
          <ul data-slot="handoff-bundles" className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {shelf.map((bundle) => (
              <li key={bundle.name}>
                <BundleRow
                  bundle={bundle}
                  selected={selected === bundle.name}
                  onSelect={() => setSelected(bundle.name)}
                />
              </li>
            ))}
          </ul>
        )}

        {selected === null ? (
          <p className="text-[12.5px] text-muted-foreground">
            Pick a bundle to see what importing it would change.
          </p>
        ) : (
          <div
            data-slot="handoff-preview"
            className="min-w-0 rounded-lg border border-border bg-muted/40 p-3"
          >
            {preview.isPending ? (
              <p className="text-[13px] text-muted-foreground">Reading {selected}…</p>
            ) : preview.isError ? (
              <p data-slot="handoff-preview-error" className="min-w-0 break-words text-[13px] text-danger">
                {preview.error instanceof Error ? preview.error.message : 'could not read that bundle'}
              </p>
            ) : preview.data ? (
              <HandoffPlanView plan={preview.data} />
            ) : null}
          </div>
        )}

        {importError ? (
          <p data-slot="handoff-import-error" className="min-w-0 break-words text-[13px] text-danger">
            {importError}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={importBundle.isPending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            data-slot="handoff-import-confirm"
            disabled={selected === null || importBundle.isPending}
            onClick={() => {
              if (selected !== null) importBundle.mutate(selected)
            }}
          >
            {importBundle.isPending ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** `Sep 19` — the shelf's short date, the shape Settings → Projects already uses. The exact
 *  instant stays in the `title` and `dateTime`, so nothing is lost to the abbreviation. */
function bundleDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** One bundle on the shelf: name, human size, when it landed. A button rather than a radio so
 *  the whole row is the target and the keyboard reaches it the way it reaches every other row. */
function BundleRow({
  bundle,
  selected,
  onSelect,
}: {
  bundle: HandoffBundleEntry
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-slot="handoff-bundle"
      data-bundle={bundle.name}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full min-w-0 items-center gap-3 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        selected && 'border-border bg-card',
      )}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium">{bundle.name}</span>
      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground tabular-nums">
        {formatMem(bundle.sizeBytes) || '0 kB'}
      </span>
      <time
        dateTime={bundle.modifiedAt}
        title={bundle.modifiedAt}
        className="shrink-0 text-[11.5px] text-soft-foreground tabular-nums"
      >
        {bundleDate(bundle.modifiedAt)}
      </time>
    </button>
  )
}

/**
 * The dry-run, as markup: the bundle's own provenance, every plan-level warning, and one row per
 * task with its action (`create`/`replace`), status, branch and destination worktree — plus that
 * task's warnings. Nothing is summarized away: a warning the CLI would print but the dialog hid
 * is exactly the kind of surprise this preview exists to prevent.
 */
function HandoffPlanView({ plan }: { plan: HandoffImportPlan }) {
  return (
    <div data-slot="handoff-plan" className="flex min-w-0 flex-col gap-2.5">
      <p className="text-[11.5px] text-soft-foreground">
        {plan.runs.length} {plan.runs.length === 1 ? 'task' : 'tasks'} · cezar {plan.cezarVersion}
        {plan.sourceProjectId ? ` · from ${plan.sourceProjectId}` : ''}
      </p>
      {plan.warnings.length > 0 ? (
        <ul data-slot="handoff-plan-warnings" className="flex flex-col gap-1">
          {plan.warnings.map((warning) => (
            <li key={warning} className="min-w-0 break-words text-[12px] text-danger">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
      <ul data-slot="handoff-plan-runs" className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {plan.runs.map((entry) => (
          <li
            key={entry.id}
            data-slot="handoff-plan-entry"
            className="min-w-0 rounded-md border border-border bg-card px-2.5 py-2"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                data-slot="handoff-plan-action"
                data-action={entry.action}
                className={cn(
                  'shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-medium',
                  // `replace` overwrites a record that exists here — amber, the palette's
                  // "attention, not broken" ink (`--pending-strong`, never `text-pending`).
                  entry.action === 'replace' ? 'bg-pending/10 text-pending-strong' : 'bg-muted text-muted-foreground',
                )}
              >
                {entry.action}
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-soft-foreground">{entry.status}</span>
              <span className="min-w-0 truncate text-[13px] font-medium" title={entry.title}>
                {entry.title}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">{entry.branch ?? 'no branch'}</span>
              <span className="text-soft-foreground" aria-hidden="true">
                ·
              </span>
              <span className="min-w-0 break-all" title={entry.worktreePath}>
                {entry.worktree === 'materialize' ? (entry.worktreePath ?? 'worktree') : 'no worktree'}
              </span>
            </div>
            {entry.warnings.length > 0 ? (
              <ul data-slot="handoff-entry-warnings" className="mt-1 flex flex-col gap-0.5">
                {entry.warnings.map((warning) => (
                  <li key={warning} className="min-w-0 break-words text-[11.5px] text-danger">
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
