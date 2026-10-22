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
 */
public final class ApkProvider extends ContentProvider {
    private static final String NAME = "CicaTavern.apk";

    static Uri uri(Context context) {
        return Uri.parse("content://" + context.getPackageName() + ".update/" + NAME);
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
        if (!NAME.equals(uri.getLastPathSegment()) || !"r".equals(mode)) throw new FileNotFoundException(String.valueOf(uri));
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
            cursor.addRow(new Object[] {NAME, file().length()});
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
