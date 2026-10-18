package com.northbot.app;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/** Writes a file into the phone's Downloads folder (or the app's own one on Android 9 and older). */
final class Downloads {

    private Downloads() {}

    static void save(Context context, String name, String mime, byte[] bytes) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("MediaStore refused the file");
            try (OutputStream out = context.getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new IOException("No output stream");
                out.write(bytes);
            }
            return;
        }
        File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new IOException("No storage");
        try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
            out.write(bytes);
        }
    }
}
