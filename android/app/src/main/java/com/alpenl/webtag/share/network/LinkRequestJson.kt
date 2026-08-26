package com.alpenl.webtag.share.network

import org.json.JSONObject

internal object LinkRequestJson {
    fun encode(url: String, note: String): String =
        JSONObject()
            .put("url", url)
            .put("note", note)
            .toString()
}
