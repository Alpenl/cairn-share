package com.alpenl.cairn.share.network

import org.json.JSONObject

internal object LinkRequestJson {
    fun encode(url: String, note: String, clientId: String? = null): String =
        JSONObject()
            .put("url", url)
            .put("note", note)
            .apply { clientId?.let { put("client_id", it) } }
            .toString()
}
