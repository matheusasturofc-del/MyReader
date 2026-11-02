package com.matheusasturo.myreader;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OpenWithPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
