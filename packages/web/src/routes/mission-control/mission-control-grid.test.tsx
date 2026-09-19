import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { MissionControlGrid } from './mission-control-grid'

afterEach(() => cleanup())

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

function run(overrides: Partial<RunIndexEntry> & { id: string }): RunIndexEntry {
  return {
    projectId: 'api',
    title: overrides.id,
    status: 'running',
    createdAt: '2026-09-19T00:00:00.000Z',
    archived: false,
    workflow: 'quick-task',
    ...overrides,
  }
}

function renderGrid(runs: RunIndexEntry[]) {
  return render(
    <MemoryRouter>
      <MissionControlGrid runs={runs} projects={PROJECTS} />
    </MemoryRouter>,
  )
}

describe('MissionControlGrid', () => {
  it('shows the empty state when no run exists anywhere', () => {
    renderGrid([])
    expect(screen.queryByText('No agents in action')).not.toBeNull()
  })

  it('renders active runs immediately and keeps finished ones collapsed by default', () => {
    renderGrid([
      run({ id: 'run-active', status: 'running' }),
      run({ id: 'run-done', status: 'done' }),
    ])
    expect(screen.queryByText('run-active')).not.toBeNull()
    expect(screen.queryByText('run-done')).toBeNull()
    expect(screen.queryByText('Recently finished')).not.toBeNull()
  })

  it('reveals finished runs once the "Recently finished" section is expanded', () => {
    renderGrid([run({ id: 'run-done', status: 'done' })])
    fireEvent.click(screen.getByRole('button', { name: /recently finished/i }))
    expect(screen.queryByText('run-done')).not.toBeNull()
  })

  it('paints a subtask badge for a run that dispatched children', () => {
    renderGrid([
      run({ id: 'root', status: 'running' }),
      run({
        id: 'child',
        status: 'running',
        dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' },
      }),
    ])
    const tile = screen.getByRole('link', { name: /root/ })
    expect(tile.querySelector('[data-slot="agent-tile-subtasks"]')?.textContent).toBe('1')
  })

  it("marks each tile with its own status for color/animation mapping", () => {
    renderGrid([run({ id: 'run-a', status: 'queued' })])
    expect(screen.getByRole('link', { name: /run-a/ }).getAttribute('data-status')).toBe('queued')
  })

  it('puts a waiting/review run under its own "Needs you" heading, ahead of merely-running work', () => {
    const { container } = renderGrid([
      run({ id: 'run-running', status: 'running' }),
      run({ id: 'run-waiting', status: 'waiting' }),
    ])
    expect(screen.queryByText('Needs you')).not.toBeNull()
    const needsYouSection = container.querySelector('[data-slot="mission-control-needs-you"]')
    const workingSection = container.querySelector('[data-slot="mission-control-working"]')
    expect(needsYouSection?.textContent).toContain('run-waiting')
    expect(workingSection?.textContent).toContain('run-running')
    expect(workingSection?.textContent).not.toContain('run-waiting')
  })
})
