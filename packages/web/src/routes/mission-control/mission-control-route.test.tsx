import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry, RunIndexEntry, WorkspaceUiState } from '@open-mercato/cezar-api-client'

import { MissionControlRoute } from './mission-control-route'

/**
 * The route wired end to end (spec 2026-09-18-mission-control, Phase 3, plan step 13): the
 * behavior worth a DOM test rather than a unit one is that a run HIGHLIGHTED in one view stays
 * highlighted after Grid→Graph→Grid — which only holds if `highlightedRunId` lives on the route,
 * not on either view, and no test at the `MissionControlGrid`/`MissionControlGraph` level alone
 * could catch a regression that moved it back into one of them.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const PROJECTS: ProjectListEntry[] = [
  {
    id: 'api',
    name: 'API',
    root: '/repos/api',
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
  },
]

const RUNS: RunIndexEntry[] = [
  {
    projectId: 'api',
    id: 'root',
    title: 'Root task',
    status: 'running',
    createdAt: '2026-09-19T00:00:00.000Z',
    archived: false,
    workflow: 'quick-task',
  },
  {
    projectId: 'api',
    id: 'child',
    title: 'Dispatched review',
    status: 'running',
    createdAt: '2026-09-19T00:01:00.000Z',
    archived: false,
    workflow: 'quick-task',
    dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'review' },
  },
]

let uiState: WorkspaceUiState = {}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      if (path === '/api/v1/health') {
        return jsonResponse({ capabilities: { costMetrics: true, tokenUsageMetrics: true } })
      }
      if (path === '/api/v1/projects') {
        return jsonResponse({ projects: PROJECTS, bootProject: 'api', projectsDir: '/repos' })
      }
      if (path === '/api/v1/workspace/runs-index') {
        return jsonResponse({ runs: RUNS, perProjectLimit: 200, truncated: [], referenceStatuses: {} })
      }
      if (path === '/api/v1/workspace/ui-state' && method === 'GET') {
        return jsonResponse(uiState)
      }
      if (path === '/api/v1/workspace/ui-state' && method === 'PUT') {
        uiState = { ...uiState, ...(JSON.parse(String(init.body)) as WorkspaceUiState) }
        return jsonResponse(uiState)
      }
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    }),
  )
}

beforeEach(() => {
  uiState = {}
  // react-flow (Swarm Graph) measures its viewport with a ResizeObserver — jsdom has none and
  // never lays anything out, same doctrine as every other ResizeObserver-consuming test here.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  stubFetch()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderRoute() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/mission-control']}>
        <MissionControlRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The toggle renders twice (a desktop header copy, hidden under `md:hidden` on the mobile one) —
 *  jsdom applies no media query, so both are always in the DOM. Either is a legitimate click. */
const clickView = (name: 'Grid' | 'Swarm Graph') => fireEvent.click(screen.getAllByRole('button', { name })[0]!)

describe('MissionControlRoute', () => {
  it('defaults to the Grid and renders every run', async () => {
    renderRoute()
    await waitFor(() => expect(screen.queryByText('Root task')).not.toBeNull())
    expect(screen.getAllByRole('button', { name: 'Grid' })[0]!.getAttribute('aria-pressed')).toBe('true')
  })

  it('a run highlighted in the Grid stays highlighted through Grid→Graph→Grid', async () => {
    renderRoute()
    await waitFor(() => expect(screen.queryByText('Root task')).not.toBeNull())

    fireEvent.mouseEnter(screen.getByRole('link', { name: /Root task/ }))
    expect(screen.getByRole('link', { name: /Root task/ }).getAttribute('data-highlighted')).toBe('true')

    clickView('Swarm Graph')
    await waitFor(() => expect(document.querySelector('[data-slot="mission-control-graph"]')).not.toBeNull())
    await waitFor(() =>
      expect(screen.getByText('Root task').closest('a')?.getAttribute('data-highlighted')).toBe('true'),
    )

    clickView('Grid')
    await waitFor(() => expect(screen.queryByText('Root task')).not.toBeNull())
    expect(screen.getByRole('link', { name: /Root task/ }).getAttribute('data-highlighted')).toBe('true')
  })

  it('persists the chosen view via workspace ui-state', async () => {
    renderRoute()
    await waitFor(() => expect(screen.queryByText('Root task')).not.toBeNull())
    clickView('Swarm Graph')
    await act(async () => {})
    await waitFor(() => expect(uiState.missionControlView).toBe('graph'))
  })
})
