import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import './styles.css';

import { renderLibrary, importFiles } from './library.js';
import { openReader, closeReader } from './reader.js';
import { toast } from './ui.js';

const app = document.getElementById('app');

import { go } from './nav.js';

// ---------------------------------------------------------------- rotas
let routing = Promise.resolve();
function route() {
  routing = routing.then(async () => {
    const m = /^#\/doc\/(.+)$/.exec(location.hash);
    await closeReader();
    if (m) {
      try {
        await openReader(app, decodeURIComponent(m[1]));
      } catch (err) {
        console.error(err);
        toast('Não foi possível abrir este arquivo.', { type: 'error' });
        go('/');
      }
    } else {
      try {
        await renderLibrary(app, /^#\/biblioteca/.test(location.hash) ? 'library' : 'home');
      } catch (err) {
        console.error(err);
        app.innerHTML = `<div class="error-box"><strong>Não foi possível abrir a biblioteca</strong><p>${String(err?.message || err)}</p><p>Se estiver numa aba anônima, o navegador pode bloquear o armazenamento local.</p></div>`;
      }
    }
  });
}
window.addEventListener('hashchange', route);
route();

// ---------------------------------------------------------------- arrastar e soltar em qualquer lugar
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  const recs = await importFiles(files);
  if (recs.length === 1) go(`/doc/${recs[0].id}`);
  else if (recs.length) {
    toast(`${recs.length} arquivos adicionados à biblioteca`);
    if (!location.hash.startsWith('#/doc/')) route();
  }
});

// ---------------------------------------------------------------- "Abrir com" (PWA instalado)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((f) => f.getFile()));
    const recs = await importFiles(files);
    if (recs[0]) go(`/doc/${recs[0].id}`);
  });
}

// Service worker (offline / instalar como app)
if (import.meta.env.PROD && !window.Capacitor?.isNativePlatform?.() && location.protocol === 'https:') {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
}
