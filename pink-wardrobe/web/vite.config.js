import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // GitHub project Pages serve from /<repo>/, while the APK loads from the
  // WebView root. VITE_BASE lets the Pages build set the subpath without
  // affecting the APK, which must stay at '/'.
  base: process.env.VITE_BASE || '/',

  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'logo.svg'],
      manifest: {
        name: 'Pink Wardrobe',
        short_name: 'Wardrobe',
        description: 'Your closet, on you, before you get dressed.',
        theme_color: '#ED93B1',
        background_color: '#FBEAF0',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The MediaPipe models and WASM runtime are tens of megabytes. Raise
        // the cap so they are genuinely precached — without this they are
        // silently skipped and the app has no offline segmentation at all.
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,tflite,task}'],
        runtimeCaching: [
          {
            // Signed Storage URLs. The path is stable and the bytes behind a
            // layer never change once written, so caching on path is safe and
            // is what makes repeat outfit builds feel instant.
            urlPattern: ({ url }) =>
              url.hostname.endsWith('.supabase.co') &&
              url.pathname.includes('/storage/v1/object/sign/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'wardrobe-layers',
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: { target: 'es2020', sourcemap: true },
});
