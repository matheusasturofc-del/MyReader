import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'MyReader — Leitor universal',
        short_name: 'MyReader',
        description: 'Leia, edite, escreva e destaque PDF, Word, PowerPoint, partituras, EPUB, planilhas e imagens.',
        theme_color: '#6d5dfc',
        background_color: '#f6f5f2',
        display: 'standalone',
        start_url: './',
        scope: './',
        lang: 'pt-BR',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
        file_handlers: [
          {
            action: './',
            accept: {
              'application/pdf': ['.pdf'],
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
              'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
              'application/epub+zip': ['.epub'],
              'application/vnd.recordare.musicxml+xml': ['.musicxml', '.xml'],
              'application/vnd.recordare.musicxml': ['.mxl'],
              'text/vnd.abc': ['.abc'],
              'text/plain': ['.txt', '.md'],
              'text/csv': ['.csv'],
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
              'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
            },
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
      },
    }),
  ],
});
