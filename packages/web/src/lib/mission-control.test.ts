import { describe, expect, it } from 'vitest'

import type { RunIndexEntry } from '@open-mercato/cezar-api-client'

import { isActiveRun, splitActiveRuns, subtaskCounts, tileStatusPaint } from './mission-control'

function run(overrides: Partial<RunIndexEntry> & { id: string }): RunIndexEntry {
  return {
    projectId: 'proj-1',
    title: overrides.id,
    status: 'running',
    createdAt: '2026-09-19T00:00:00.000Z',
    archived: false,
    workflow: 'quick-task',
    ...overrides,
  }
}

describe('tileStatusPaint', () => {
  it('paints running as a fast, non-slow pulse', () => {
    expect(tileStatusPaint({ status: 'running' })).toEqual({
      tone: 'success',
      pulse: true,
      slow: false,
      label: 'running',
    })
  })

  it('paints queued as a slower pulse than running', () => {
    const paint = tileStatusPaint({ status: 'queued' })
    expect(paint.pulse).toBe(true)
    expect(paint.slow).toBe(true)
  })

  it.each(['waiting', 'review'] as const)('paints %s with an amber (pending) accent', (status) => {
    expect(tileStatusPaint({ status }).tone).toBe('pending')
  })

  it.each(['done', 'failed', 'cancelled'] as const)('paints terminal status %s as static', (status) => {
    expect(tileStatusPaint({ status }).pulse).toBe(false)
  })
})

describe('isActiveRun / splitActiveRuns', () => {
  it('treats queued/running/waiting/review as active and the rest as finished', () => {
    expect(isActiveRun(run({ id: 'a', status: 'queued' }))).toBe(true)
    expect(isActiveRun(run({ id: 'b', status: 'done' }))).toBe(false)
  })

  it('preserves the caller-provided order within each partition', () => {
    const runs = [
      run({ id: 'r1', status: 'done' }),
      run({ id: 'r2', status: 'running' }),
      run({ id: 'r3', status: 'failed' }),
      run({ id: 'r4', status: 'queued' }),
    ]
    const { active, finished } = splitActiveRuns(runs)
    expect(active.map((r) => r.id)).toEqual(['r2', 'r4'])
    expect(finished.map((r) => r.id)).toEqual(['r1', 'r3'])
  })
})

describe('subtaskCounts', () => {
  it('counts direct children only, via the dispatch tree', () => {
    const runs = [
      run({ id: 'root' }),
      run({ id: 'child-1', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } }),
      run({ id: 'child-2', dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'review' } }),
      run({
        id: 'grandchild',
        dispatch: { rootRunId: 'root', parentRunId: 'child-1', kind: 'implement' },
      }),
      run({ id: 'standalone' }),
    ]
    const counts = subtaskCounts(runs)
    expect(counts.get('root')).toBe(2)
    expect(counts.get('child-1')).toBe(1)
    expect(counts.get('child-2')).toBe(0)
    expect(counts.get('standalone')).toBe(0)
  })
})
