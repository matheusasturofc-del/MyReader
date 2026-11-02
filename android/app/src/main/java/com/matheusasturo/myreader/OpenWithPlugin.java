package com.matheusasturo.myreader;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Parcelable;
import android.provider.OpenableColumns;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Recebe arquivos abertos com "Abrir com MyReader" ou compartilhados para o app
 * (Intent VIEW / SEND), copia para o cache do app e avisa o JavaScript
 * com o evento "fileOpened" { path, name, mime }.
 */
@CapacitorPlugin(name = "OpenWith")
public class OpenWithPlugin extends Plugin {

    @Override
    public void load() {
        if (getActivity() != null) handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    /** Apaga uma cópia temporária depois que o app importou o arquivo. */
    @PluginMethod
    public void release(PluginCall call) {
        String path = call.getString("path");
        if (path != null) {
            File f = new File(path);
            File cache = new File(getContext().getCacheDir(), "opened");
            if (f.getAbsolutePath().startsWith(cache.getAbsolutePath())) f.delete();
        }
        call.resolve();
    }

    @SuppressWarnings("deprecation")
    private void handleIntent(Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        final List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Parcelable p = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (p instanceof Uri) uris.add((Uri) p);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Parcelable> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) for (Parcelable p : list) if (p instanceof Uri) uris.add((Uri) p);
        }
        if (uris.isEmpty()) return;
        // Evita abrir o mesmo arquivo de novo se a Activity for recriada.
        intent.setAction(Intent.ACTION_MAIN);
        intent.setData(null);
        final String typeHint = intent.getType();

        new Thread(() -> {
            for (Uri uri : uris) {
                try {
                    JSObject file = copyToCache(uri, typeHint);
                    if (file != null) notifyListeners("fileOpened", file, true);
                } catch (Exception e) {
                    JSObject err = new JSObject();
                    err.put("error", String.valueOf(e.getMessage()));
                    notifyListeners("fileOpened", err, true);
                }
            }
        }).start();
    }

    private JSObject copyToCache(Uri uri, String typeHint) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (i >= 0) name = c.getString(i);
                }
            } catch (Exception ignored) {}
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "arquivo";
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        String mime = cr.getType(uri);
        if (mime == null) mime = typeHint;

        File dir = new File(getContext().getCacheDir(), "opened");
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, System.currentTimeMillis() + "_" + name);
        try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) return null;
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        }
        JSObject o = new JSObject();
        o.put("path", out.getAbsolutePath());
        o.put("name", name);
        o.put("mime", mime == null ? "" : mime);
        o.put("size", out.length());
        return o;
    }
}
