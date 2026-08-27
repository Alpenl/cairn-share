package com.alpenl.cairn.share.network

import com.alpenl.cairn.share.BuildConfig

internal object AppUserAgent {
    fun value(versionName: String = BuildConfig.VERSION_NAME): String =
        "CairnShareAndroid/$versionName (Android)"
}
