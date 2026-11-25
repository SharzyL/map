import { describe, expect, it } from 'vitest'
import { withoutHoverState } from './styles.mjs'

const HOVER_TEST = ['boolean', ['feature-state', 'hover'], false]

describe('withoutHoverState', () => {
  it('drops the hover branches of case expressions, keeping the rest', () => {
    expect(withoutHoverState(['case', HOVER_TEST, 'red', 'blue'])).toBe('blue')
    expect(withoutHoverState(['case', HOVER_TEST, 'red', ['get', 'x'], 'green', 'blue'])).toEqual([
      'case',
      ['get', 'x'],
      'green',
      'blue',
    ])
    expect(
      withoutHoverState({
        paint: { 'line-color': ['interpolate', ['linear'], ['zoom'], 5, ['case', HOVER_TEST, 'a', 'b']] },
      }),
    ).toEqual({ paint: { 'line-color': ['interpolate', ['linear'], ['zoom'], 5, 'b'] } })
  })
})
