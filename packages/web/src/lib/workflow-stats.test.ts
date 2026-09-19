import { describe, expect, it } from 'vitest'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import { computeWorkflowStats } from './workflow-stats'

/**
 * `computeWorkflowStats` as a table: technical-only outcome stats per
 * (workflow, runner, model), grouped from data the cockpit already fetches — no server, no I/O.
 * See `.ai/specs/2026-09-19-workflow-outcome-stats.md` for why this deliberately never computes
 * anything called a "success rate".
 */

let seq = 0

function run(overrides: Partial<ApiRun> & { workflow: string; status: ApiRun['status'] }): ApiRun {
  seq += 1
  return {
    id: `run-${seq}`,
    title: `task ${seq}`,
    task: 'do the thing',
    createdAt: '2026-09-01T10:00:00Z',
    tokensUsed: 0,
    steps: [],
    archived: false,
    ...overrides,
  } as ApiRun
}

describe('computeWorkflowStats', () => {
  it('groups runs by workflow, runner and model', () => {
    const runs = [
      run({ workflow: 'quick-task', runner: 'claude', model: 'sonnet', status: 'done' }),
      run({ workflow: 'quick-task', runner: 'claude', model: 'sonnet', status: 'failed' }),
      run({ workflow: 'quick-task', runner: 'codex', model: 'gpt-5', status: 'done' }),
    ]

    const groups = computeWorkflowStats(runs)

    expect(groups).toHaveLength(2)
    const claudeSonnet = groups.find((g) => g.runner === 'claude')!
    expect(claudeSonnet.workflow).toBe('quick-task')
    expect(claudeSonnet.model).toBe('sonnet')
    expect(claudeSonnet.counts.done).toBe(1)
    expect(claudeSonnet.counts.failed).toBe(1)
  })

  it('excludes dispatched children but keeps dispatch roots', () => {
    const runs = [
      run({ workflow: 'quick-task', runner: 'claude', status: 'done', dispatch: { rootRunId: 'root-1' } }),
      run({
        workflow: 'quick-task',
        runner: 'claude',
        status: 'done',
        dispatch: { rootRunId: 'root-1', parentRunId: 'root-1' },
      }),
    ]

    const groups = computeWorkflowStats(runs)

    expect(groups).toHaveLength(1)
    expect(groups[0]!.terminalTotal).toBe(1)
  })

  it('falls back to "unknown" runner and "default" model when absent', () => {
    const groups = computeWorkflowStats([run({ workflow: 'quick-task', status: 'done' })])

    expect(groups[0]!.runner).toBe('unknown')
    expect(groups[0]!.model).toBe('default')
  })

  it('prefers modelIdentity over the free-text model field', () => {
    const groups = computeWorkflowStats([
      run({ workflow: 'quick-task', status: 'done', model: 'Sonnet 5', modelIdentity: 'anthropic/claude-sonnet-5' }),
    ])

    expect(groups[0]!.model).toBe('anthropic/claude-sonnet-5')
  })

  it('counts every status, and sums only terminal ones into terminalTotal', () => {
    const runs = [
      run({ workflow: 'w', status: 'queued' }),
      run({ workflow: 'w', status: 'running' }),
      run({ workflow: 'w', status: 'waiting' }),
      run({ workflow: 'w', status: 'review' }),
      run({ workflow: 'w', status: 'done' }),
      run({ workflow: 'w', status: 'failed' }),
      run({ workflow: 'w', status: 'cancelled' }),
    ]

    const group = computeWorkflowStats(runs)[0]!

    expect(group.counts).toEqual({
      queued: 1,
      running: 1,
      waiting: 1,
      review: 1,
      done: 1,
      failed: 1,
      cancelled: 1,
    })
    expect(group.terminalTotal).toBe(4) // review + done + failed + cancelled
  })

  it('reports failedRate as undefined when there are no terminal runs yet', () => {
    const groups = computeWorkflowStats([run({ workflow: 'w', status: 'running' })])

    expect(groups[0]!.failedRate).toBeUndefined()
  })

  it('computes failedRate over terminal runs only', () => {
    const runs = [
      run({ workflow: 'w', status: 'running' }), // not terminal, excluded from the rate
      run({ workflow: 'w', status: 'done' }),
      run({ workflow: 'w', status: 'done' }),
      run({ workflow: 'w', status: 'failed' }),
    ]

    const group = computeWorkflowStats(runs)[0]!

    expect(group.terminalTotal).toBe(3)
    expect(group.failedRate).toBeCloseTo(1 / 3)
  })

  it('averages duration only over terminal runs with both startedAt and finishedAt', () => {
    const runs = [
      run({
        workflow: 'w',
        status: 'done',
        startedAt: '2026-09-01T10:00:00.000Z',
        finishedAt: '2026-09-01T10:01:00.000Z',
      }),
      run({
        workflow: 'w',
        status: 'done',
        startedAt: '2026-09-01T10:00:00.000Z',
        finishedAt: '2026-09-01T10:03:00.000Z',
      }),
      run({ workflow: 'w', status: 'done', startedAt: '2026-09-01T10:00:00.000Z' }), // never finished timestamp
    ]

    const group = computeWorkflowStats(runs)[0]!

    expect(group.avgDurationMs).toBe(2 * 60_000) // (60s + 180s) / 2
  })

  it('reports avgDurationMs as undefined when no terminal run has both timestamps', () => {
    const groups = computeWorkflowStats([run({ workflow: 'w', status: 'done' })])

    expect(groups[0]!.avgDurationMs).toBeUndefined()
  })

  it('averages tokens and cost only over terminal runs that carry them', () => {
    const runs = [
      run({ workflow: 'w', status: 'done', tokensUsed: 100, costUsd: 0.1 }),
      run({ workflow: 'w', status: 'done', tokensUsed: 300, costUsd: 0.3 }),
      run({ workflow: 'w', status: 'running', tokensUsed: 9999, costUsd: 99 }), // not terminal
    ]

    const group = computeWorkflowStats(runs)[0]!

    expect(group.avgTokens).toBe(200)
    expect(group.avgCostUsd).toBeCloseTo(0.2)
  })
})
