/// <reference types="vite/client" />

declare global {
  const __STYLE_HASH__: string;
  const __SCREENSHOT_FIXTURES__: boolean;

  interface Window {
    _mlmap?: import('maplibre-gl').Map | null;
  }

  interface Document {
    webkitFullscreenElement?: Element | null;
  }

  namespace Cloudflare {
    interface Env {
      ASSETS: Fetcher;
      ORM_BUCKET: R2Bucket;
    }
  }
}

export {};
