package com.jishnuinfotech.supportlauncher;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final String PORTAL_URL = "https://jitsupport.jishnuinfotech.com";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(PORTAL_URL));
            browserIntent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(browserIntent);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "No browser is available to open the support portal.", Toast.LENGTH_LONG).show();
        } finally {
            finish();
        }
    }
}
