// Navegação e tema (módulo sem dependências, para evitar importações circulares).

export function getTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('mr-theme', next);
  } catch {}
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#0f1014' : '#f6f5f2');
  window.dispatchEvent(new Event('themechange'));
}

export function go(path) {
  if (location.hash !== `#${path}`) location.hash = path;
  else window.dispatchEvent(new HashChangeEvent('hashchange'));
}
