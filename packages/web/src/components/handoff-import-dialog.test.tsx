import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, importHandoffBundle, listHandoffBundles, previewHandoffBundle } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { HandoffBundleEntry, HandoffImportPlan } from '@open-mercato/cezar-api-client'
import { HandoffImportDialog } from '@/components/handoff-import-dialog'
import { Toaster, resetToasts } from '@/components/ui/toaster'

/**
 * The import surface (spec 2026-09-19-cross-machine-task-handoff, Phase 3 step 10).
 *
 * The API functions are mocked — not `fetch` — because this component's contract is the SHAPES
 * it consumes (`HandoffBundlesResponse`, `HandoffImportPlan`) and the calls it makes with them;
 * the wire spelling is the client's own tested contract, not this dialog's.
 */
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    listHandoffBundles: vi.fn(),
    previewHandoffBundle: vi.fn(),
    importHandoffBundle: vi.fn(),
  }
})

const mockList = vi.mocked(listHandoffBundles)
const mockPreview = vi.mocked(previewHandoffBundle)
const mockImport = vi.mocked(importHandoffBundle)

const bundle = (name: string, extra: Partial<HandoffBundleEntry> = {}): HandoffBundleEntry => ({
  name,
  sizeBytes: 5 * 1024 * 1024,
  modifiedAt: '2026-09-19T12:00:00.000Z',
  ...extra,
})

const plan: HandoffImportPlan = {
  name: 'laptop-work.tgz',
  formatVersion: 1,
  createdAt: '2026-09-19T12:00:00.000Z',
  cezarVersion: '0.10.0',
  sourceProjectId: 'laptop-project',
  runs: [
    {
      id: 'r1',
      title: 'Fix the parser',
      status: 'done',
      action: 'replace',
      branch: 'cez/abc12345',
      worktree: 'materialize',
      worktreePath: '/home/me/proj/.ai/cezar/worktrees/r1',
      warnings: ['agent account "work" is missing on this machine'],
    },
    {
      id: 'r2',
      title: 'Draft the release notes',
      status: 'review',
      action: 'create',
      worktree: 'none',
      warnings: [],
    },
  ],
  branches: ['cez/abc12345'],
  fetch: ['cez/abc12345'],
  warnings: ['the source project id is informational — the destination re-registers by path'],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue({ bundles: [] })
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
})

function renderDialog(open = true) {
  const client = createQueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const onOpenChange = vi.fn()
  const utils = render(
    <QueryClientProvider client={client}>
      <HandoffImportDialog open={open} onOpenChange={onOpenChange} />
      <Toaster />
    </QueryClientProvider>,
  )
  return { ...utils, onOpenChange, invalidate }
}

describe('HandoffImportDialog', () => {
  it('names the CLI and the cache directory when the shelf is empty', async () => {
    renderDialog()
    expect(await screen.findByText('No bundles on this machine yet')).not.toBeNull()
    expect(screen.getByText('~/.cache/cez/handoff/')).not.toBeNull()
    expect(screen.getByText('cez handoff export')).not.toBeNull()
    expect(screen.getByText('cez handoff push')).not.toBeNull()
    // Nothing to preview or import without a selection.
    expect(mockPreview).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists bundles, previews the selected one, and imports it', async () => {
    mockList.mockResolvedValue({ bundles: [bundle('laptop-work.tgz'), bundle('vps-night.tgz', { sizeBytes: 900 })] })
    mockPreview.mockResolvedValue(plan)
    mockImport.mockResolvedValue({ imported: ['r1', 'r2'], plan })
    const { onOpenChange, invalidate } = renderDialog()

    // The shelf: name, human size, date.
    const row = await screen.findByRole('button', { name: /laptop-work\.tgz/ })
    expect(row.textContent).toContain('5 MB')
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-19T12:00:00.000Z')
    expect(row.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-pressed')).toBe('true')

    // The preview, task by task: action, status, title, branch, worktree destination.
    await waitFor(() => expect(mockPreview).toHaveBeenCalledWith('laptop-work.tgz', expect.anything()))
    expect(await screen.findByText('Fix the parser')).not.toBeNull()
    expect(screen.getByText('replace')).not.toBeNull()
    expect(screen.getByText('cez/abc12345')).not.toBeNull()
    expect(screen.getByText('/home/me/proj/.ai/cezar/worktrees/r1')).not.toBeNull()
    expect(screen.getByText('create')).not.toBeNull()
    expect(screen.getByText('Draft the release notes')).not.toBeNull()
    expect(screen.getByText('no worktree')).not.toBeNull()
    expect(screen.getByText('no branch')).not.toBeNull()
    // Every warning — plan-level and per-task.
    expect(screen.getByText('the source project id is informational — the destination re-registers by path')).not.toBeNull()
    expect(screen.getByText('agent account "work" is missing on this machine')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(mockImport).toHaveBeenCalledWith('laptop-work.tgz'))
    expect(await screen.findByText('Imported 2 tasks from laptop-work.tgz')).not.toBeNull()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.all })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders the server\'s refusal inline and keeps the dialog open', async () => {
    mockList.mockResolvedValue({ bundles: [bundle('laptop-work.tgz')] })
    mockPreview.mockResolvedValue(plan)
    mockImport.mockRejectedValue(
      new ApiError(409, 'bundle laptop-work.tgz was exported on a machine running cezar 0.10.0'),
    )
    const { onOpenChange } = renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: /laptop-work\.tgz/ }))
    await waitFor(() => expect(mockPreview).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    // The message is on screen twice by design (inline + toast); the inline line is the one
    // that must exist next to the button, so this queries the slot rather than the text.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="handoff-import-error"]')?.textContent).toBe(
        'bundle laptop-work.tgz was exported on a machine running cezar 0.10.0',
      ),
    )
    expect(screen.getAllByText('bundle laptop-work.tgz was exported on a machine running cezar 0.10.0')).toHaveLength(2)
    // Inline, not only a toast — and the dialog stays put so the refusal can be read.
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('fires no request while closed, and reads the shelf once opened', async () => {
    mockList.mockResolvedValue({ bundles: [bundle('laptop-work.tgz')] })
    const onOpenChange = vi.fn()
    const client = createQueryClient()
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <HandoffImportDialog open={false} onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    )
    await act(async () => {})
    expect(mockList).not.toHaveBeenCalled()
    expect(mockPreview).not.toHaveBeenCalled()

    rerender(
      <QueryClientProvider client={client}>
        <HandoffImportDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1))
  })
})
