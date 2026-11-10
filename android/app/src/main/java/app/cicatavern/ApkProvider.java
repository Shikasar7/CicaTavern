package app.cicatavern;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Serves the downloaded update (ApkUpdate.file) to the system installer, read
 * only, to whoever the install intent grants it; nothing else. A small stand-in
 * for androidx FileProvider, which the offline build does not have.
 *
 * Each version is offered at its own address and name (…/20403/CicaTavern-2.4.3.apk):
 * some phones' installers keep their own copy of what they were handed and, given
 * the same address and name again, install that earlier version instead.
 */
public final class ApkProvider extends ContentProvider {
    private static final String NAME = "CicaTavern.apk";

    /** versionName and versionCode: the downloaded APK's (ApkUpdate.check). */
    static Uri uri(Context context, String versionName, long versionCode) {
        String version = versionName == null ? "" : versionName.replaceAll("[^0-9A-Za-z._-]", "");
        String name = version.isEmpty() ? NAME : "CicaTavern-" + version + ".apk";
        return Uri.parse("content://" + context.getPackageName() + ".update/" + versionCode + "/" + name);
    }

    /** Only the names uri() gives; whichever it is, the one downloaded file. */
    private static boolean ours(Uri uri) {
        String name = uri.getLastPathSegment();
        return name != null && name.matches("CicaTavern(-[0-9A-Za-z._-]+)?\\.apk");
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private File file() throws FileNotFoundException {
        Context context = getContext();
        if (context == null) throw new FileNotFoundException(NAME);
        File file = ApkUpdate.file(context);
        if (!file.isFile()) throw new FileNotFoundException(NAME);
        return file;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!ours(uri) || !"r".equals(mode)) throw new FileNotFoundException(String.valueOf(uri));
        return ParcelFileDescriptor.open(file(), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        MatrixCursor cursor = new MatrixCursor(new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        try {
            if (ours(uri)) cursor.addRow(new Object[] {uri.getLastPathSegment(), file().length()});
        } catch (FileNotFoundException ignored) {
            // No download: an empty answer.
        }
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
