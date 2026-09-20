import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useFleetCostHistory } from './use-fleet-cost-history'

afterEach(() => cleanup())

describe('useFleetCostHistory', () => {
  it('starts with a single sample: the current value', () => {
    const { result } = renderHook(() => useFleetCostHistory(1.5))
    expect(result.current).toEqual([1.5])
  })

  it('appends a sample only when the value actually changes', () => {
    const { result, rerender } = renderHook(({ cost }) => useFleetCostHistory(cost), {
      initialProps: { cost: 1 },
    })
    rerender({ cost: 1 })
    rerender({ cost: 1 })
    expect(result.current).toEqual([1])

    rerender({ cost: 2 })
    expect(result.current).toEqual([1, 2])
  })

  it('caps the history, dropping the oldest samples first', () => {
    const { result, rerender } = renderHook(({ cost }) => useFleetCostHistory(cost), {
      initialProps: { cost: 0 },
    })
    for (let i = 1; i <= 50; i += 1) rerender({ cost: i })
    expect(result.current.length).toBe(40)
    expect(result.current[0]).toBe(11)
    expect(result.current[result.current.length - 1]).toBe(50)
  })
})
