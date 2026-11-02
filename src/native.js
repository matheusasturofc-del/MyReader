// Integração com o app Android (Capacitor). No navegador nada disso é usado.
import { toast } from './ui.js';

export const isNative = () => !!window.Capacitor?.isNativePlatform?.();

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

/** Salva o arquivo em Documentos e abre o menu "Compartilhar" (Drive, WhatsApp, Arquivos...). */
export async function saveNative(blob, filename) {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  const name = filename.replace(/[\\/:*?"<>|]/g, '_');
  const data = await blobToBase64(blob);
  let uri;
  let savedDocs = false;
  try {
    const r = await Filesystem.writeFile({ path: `MyReader/${name}`, data, directory: Directory.Documents, recursive: true });
    uri = r.uri;
    savedDocs = true;
  } catch {
    const r = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache, recursive: true });
    uri = r.uri;
  }
  if (savedDocs) toast(`Salvo em Documentos/MyReader/${name}`, { timeout: 4000 });
  try {
    await Share.share({ title: name, files: [uri], dialogTitle: 'Salvar ou enviar' });
  } catch (e) {
    if (!savedDocs && !/cancel/i.test(String(e?.message || e))) throw e;
  }
}

/**
 * "Abrir com MyReader" / "Compartilhar → MyReader" no Android.
 * onFile(file: File) é chamado para cada arquivo recebido.
 */
export async function initOpenWith(onFile) {
  if (!isNative()) return;
  const { registerPlugin, Capacitor } = await import('@capacitor/core');
  const OpenWith = registerPlugin('OpenWith');
  await OpenWith.addListener('fileOpened', async (f) => {
    if (f?.error) {
      toast(`Não foi possível abrir o arquivo: ${f.error}`, { type: 'error', timeout: 5000 });
      return;
    }
    if (!f?.path) return;
    try {
      const res = await fetch(Capacitor.convertFileSrc(f.path));
      const blob = await res.blob();
      await onFile(new File([blob], f.name || 'arquivo', { type: f.mime || blob.type || '' }));
    } catch (e) {
      toast(`Não foi possível abrir o arquivo: ${e?.message || e}`, { type: 'error', timeout: 5000 });
    } finally {
      OpenWith.release({ path: f.path }).catch(() => {});
    }
  });
}
