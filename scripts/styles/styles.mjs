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
  layers: capLayersForDataMaxZoom(layers[selectedStyle]),
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

knownStyles.forEach((style) => {
  fs.writeFileSync(`${style}.json`, JSON.stringify(makeStyle(style)))
})
