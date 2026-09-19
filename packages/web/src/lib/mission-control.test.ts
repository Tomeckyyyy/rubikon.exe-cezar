import { describe, expect, it } from 'vitest'

import type { RunEvent, RunIndexEntry } from '@open-mercato/cezar-api-client'

import {
  isActiveRun,
  lastToolCallTitle,
  splitActiveRuns,
  subtaskCounts,
  tileStatusPaint,
} from './mission-control'

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

function toolEvent(seq: number, type: RunEvent['type'], title: string): RunEvent {
  return {
    seq,
    ts: '2026-09-19T00:00:00.000Z',
    type,
    item: { kind: 'tool', title },
  } as RunEvent
}

describe('lastToolCallTitle', () => {
  it('returns undefined for an empty or tool-less stream', () => {
    expect(lastToolCallTitle([])).toBeUndefined()
    expect(
      lastToolCallTitle([
        { seq: 1, ts: '2026-09-19T00:00:00.000Z', type: 'session.started' } as RunEvent,
      ]),
    ).toBeUndefined()
  })

  it('reads the title off the most recent item snapshot', () => {
    const events = [
      toolEvent(1, 'item.started', 'Read src/foo.ts'),
      toolEvent(2, 'item.completed', 'Read src/foo.ts'),
      toolEvent(3, 'item.started', 'Ran npm test'),
    ]
    expect(lastToolCallTitle(events)).toBe('Ran npm test')
  })

  it('ignores item.delta frames, which never carry a full item', () => {
    const events = [
      toolEvent(1, 'item.started', 'Read src/foo.ts'),
      { seq: 2, ts: '2026-09-19T00:00:00.000Z', type: 'item.delta', itemId: 'x', field: 'text', delta: 'hi' } as RunEvent,
    ]
    expect(lastToolCallTitle(events)).toBe('Read src/foo.ts')
  })

  it('ignores non-tool items (messages/reasoning)', () => {
    const events: RunEvent[] = [
      { seq: 1, ts: '2026-09-19T00:00:00.000Z', type: 'item.started', item: { kind: 'message', text: 'hi' } } as RunEvent,
    ]
    expect(lastToolCallTitle(events)).toBeUndefined()
  })
})
