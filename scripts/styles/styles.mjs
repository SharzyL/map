import fs from 'fs'
import { knownStyles, defaultDate } from './shared.mjs'
import { sources } from './fragments/sources.mjs'
import { standardLayers } from './fragments/standard.layers.mjs'

// Only upstream's standard style: the map draws its other views (speed,
// electrification, gauge, ...) by recoloring this one (src/railway-colors.ts).
const layers = {
  standard: standardLayers,
}

const DATA_MAX_ZOOM = 15

const capSourcesForDataMaxZoom = (originalSources) =>
  Object.fromEntries(
    Object.entries(originalSources).map(([name, source]) => {
      if (source?.type === 'vector' && source.url) {
        return [
          name,
          {
            ...source,
            maxzoom: DATA_MAX_ZOOM,
          },
        ]
      }
      return [name, source]
    }),
  )

const capLayersForDataMaxZoom = (originalLayers) =>
  originalLayers.map((layer) => {
    const next = { ...layer }

    if (typeof next.minzoom === 'number' && next.minzoom > DATA_MAX_ZOOM) {
      next.minzoom = DATA_MAX_ZOOM
    }

    if (typeof next.maxzoom === 'number' && next.maxzoom > DATA_MAX_ZOOM) {
      delete next.maxzoom
    }

    return next
  })

// Upstream's fragments light a hovered feature through its `hover` feature
// state: `['case', ['boolean', ['feature-state', 'hover'], false], hover, ...]`.
// The map draws hovered features from a small overlay source instead
// (src/railway-hover.ts), so those branches go: MapLibre keeps the state of
// every feature it ever held state for and replays all of it into every tile
// it loads, for each of the ~200 layers reading it, which froze the map for
// hundreds of milliseconds at a time while zooming and panning.
const isHoverTest = (expression) =>
  JSON.stringify(expression) === JSON.stringify(['boolean', ['feature-state', 'hover'], false])

export const withoutHoverState = (value) => {
  if (Array.isArray(value)) {
    const items = value.map(withoutHoverState)
    if (items[0] !== 'case') return items
    const branches = []
    for (let i = 1; i + 1 < items.length; i += 2) {
      if (!isHoverTest(items[i])) branches.push(items[i], items[i + 1])
    }
    const fallback = items[items.length - 1]
    return branches.length === 0 ? fallback : ['case', ...branches, fallback]
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutHoverState(item)]))
  }
  return value
}

const makeStyle = (selectedStyle) => ({
  center: [12.55, 51.14], // default
  zoom: 3.75, // default
  glyphs: '/font/{fontstack}/{range}',
  metadata: {
    dataMaxZoom: DATA_MAX_ZOOM,
    z15Capped: true,
  },
  name: `OpenRailwayMap ${selectedStyle}`,
  sources: capSourcesForDataMaxZoom(sources),
  sprite: [
    {
      id: 'sdf',
      url: '/sdf_sprite/symbols',
    },
    {
      id: 'default',
      url: '/sprite/symbols',
    },
  ],
  version: 8,
  layers: capLayersForDataMaxZoom(layers[selectedStyle]).map(withoutHoverState),
  state: {
    date: {
      default: defaultDate,
    },
    theme: {
      default: 'light',
    },
    stationLowZoomLabel: {
      default: 'label',
    },
    showConstructionInfrastructure: {
      default: true,
    },
    showProposedInfrastructure: {
      default: true,
    },
    showAbandonedInfrastructure: {
      default: false,
    },
    showRazedInfrastructure: {
      default: false,
    },
    hillshade: {
      default: false,
    },
    electrificationRailwayLine: {
      default: 'voltageFrequency',
    },
    trackRailwayLine: {
      default: 'gauge',
    },
  },
})

if (import.meta.url === `file://${process.argv[1]}`)
  knownStyles.forEach((style) => {
    fs.writeFileSync(`${style}.json`, JSON.stringify(makeStyle(style)))
  })
