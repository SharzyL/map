import fs from 'fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { expressionStrings, spriteIconsFor, styleIconNames } from './sprite-subset.mjs'

const UNKNOWN = '\u0000'
const read = (file) => JSON.parse(fs.readFileSync(`public/orm/${file}`, 'utf8'))

describe('expressionStrings', () => {
  it('collects the outputs of match, case, step and coalesce', () => {
    expect(expressionStrings(['match', ['get', 'a'], 'x', 'one', ['y', 'z'], 'two', 'other'])).toEqual(
      new Set(['one', 'two', 'other']),
    )
    expect(expressionStrings(['case', ['has', 'a'], 'one', ['has', 'b'], 'two', 'other'])).toEqual(
      new Set(['one', 'two', 'other']),
    )
    expect(expressionStrings(['step', ['zoom'], 'low', 10, 'high'])).toEqual(new Set(['low', 'high']))
    expect(expressionStrings(['coalesce', ['image', 'a'], ['image', 'b']])).toEqual(new Set(['a', 'b']))
  })

  it('marks parts read from feature data', () => {
    expect(expressionStrings(['image', ['concat', 'sdf:general/station-', ['get', 'size']]])).toEqual(
      new Set([`sdf:general/station-${UNKNOWN}`]),
    )
    expect(
      expressionStrings(['concat', ['match', ['get', 'side'], 'left', 'l-', 'r-'], ['case', ['has', 'x'], 'a', 'b']]),
    ).toEqual(new Set(['l-a', 'l-b', 'r-a', 'r-b']))
  })
})

describe('spriteIconsFor', () => {
  const index = { 'general/a': {}, 'general/b': {}, 'other/c': {}, 'station-small': {}, 'station-large': {} }

  it('resolves names to the sprite they belong to', () => {
    const names = new Set(['general/a', 'sdf:general/b', `station-${UNKNOWN}`, UNKNOWN])
    expect(spriteIconsFor(names, 'default', index)).toEqual([
      'general/a',
      'general/b',
      'station-large',
      'station-small',
    ])
    expect(spriteIconsFor(names, 'sdf', index)).toEqual(['general/b'])
  })
})

describe('standard style sprites', () => {
  const style = read('style/standard.json')
  const sprites = [
    { id: 'sdf', dir: 'sdf_sprite' },
    { id: 'default', dir: 'sprite' },
  ]

  it('loads the subset sprites', () => {
    expect(style.sprite).toEqual(sprites.map(({ id, dir }) => ({ id, url: `/${dir}/standard` })))
  })

  // Fails when the style changed without `pnpm generate:style`.
  it.each(sprites)('holds every $dir icon the style can draw', ({ id, dir }) => {
    const full = read(`${dir}/symbols@2x.json`)
    const expected = spriteIconsFor(styleIconNames(style), id, full)
    expect(expected.length).toBeGreaterThan(0)
    for (const suffix of ['', '@2x']) {
      const subset = read(`${dir}/standard${suffix}.json`)
      const fullIndex = read(`${dir}/symbols${suffix}.json`)
      expect(Object.keys(subset).sort()).toEqual(expected)
      for (const name of expected) {
        const { width, height, pixelRatio } = fullIndex[name]
        expect(subset[name]).toMatchObject({ width, height, pixelRatio })
      }
    }
  })

  it('copies icons pixel for pixel', async () => {
    for (const { dir } of sprites) {
      const subset = read(`${dir}/standard@2x.json`)
      const full = read(`${dir}/symbols@2x.json`)
      for (const name of ['general/station-small', 'general/level-crossing', 'general/water_tower']) {
        const pixels = async (file, icon) =>
          sharp(`public/orm/${dir}/${file}@2x.png`)
            .extract({ left: icon.x, top: icon.y, width: icon.width, height: icon.height })
            .raw()
            .toBuffer()
        expect((await pixels('standard', subset[name])).equals(await pixels('symbols', full[name]))).toBe(true)
      }
    }
  })
})
