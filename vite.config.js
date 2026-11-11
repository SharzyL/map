import { defineConfig } from 'vite';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

import { cloudflare } from '@cloudflare/vite-plugin';

function fileHash(path) {
  try {
    return createHash('md5').update(readFileSync(path)).digest('hex').slice(0, 8);
  } catch {
    return Date.now().toString(36);
  }
}

const STYLE_HASH = fileHash('public/orm/style/standard.json');

// Starts the first map requests while the app's JavaScript is still loading:
// connections to the tile hosts, and the two styles main.ts fetches before it
// can create the map. The style URL must match main.ts's STYLE_URL exactly,
// including the hash, and the crossorigin mode must match fetch()'s default,
// or the browser downloads it twice.
function mapResourceHints() {
  return {
    name: 'map-resource-hints',
    transformIndexHtml() {
      const link = (attrs) => ({ tag: 'link', attrs, injectTo: 'head-prepend' });
      return [
        link({ rel: 'preconnect', href: 'https://tiles.openfreemap.org', crossorigin: '' }),
        link({ rel: 'preconnect', href: 'https://tiles.mapterhorn.com', crossorigin: '' }),
        link({ rel: 'preload', href: `/orm/style/standard.json?v=${STYLE_HASH}`, as: 'fetch', crossorigin: '' }),
        link({ rel: 'preload', href: 'https://tiles.openfreemap.org/styles/liberty', as: 'fetch', crossorigin: '' }),
      ];
    },
  };
}

export default defineConfig({
  plugins: [
    mapResourceHints(),
    cloudflare({
      remoteBindings: process.env.CLOUDFLARE_VITE_REMOTE_BINDINGS !== '0',
    }),
  ],
  define: {
    __STYLE_HASH__: JSON.stringify(STYLE_HASH),
    __SCREENSHOT_FIXTURES__: JSON.stringify(process.env.SCREENSHOT_FIXTURES === '1'),
  },
  server: {
    host: true,
  },
});
