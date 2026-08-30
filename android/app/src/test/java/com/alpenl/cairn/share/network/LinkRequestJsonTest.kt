package com.alpenl.cairn.share.network

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class LinkRequestJsonTest {
    @Test
    fun requestJsonPreservesQuotesNewlinesAndUnicode() {
        val url = "https://example.com/a?x=1#fragment"
        val note = "quote \" newline\nunicode \u7a0d\u540e\u9605\u8bfb"

        val json = JSONObject(LinkRequestJson.encode(url, note))

        assertEquals(url, json.getString("url"))
        assertEquals(note, json.getString("note"))
        assertEquals(2, json.length())
    }

    @Test
    fun queuedRequestIncludesStableClientId() {
        val clientId = "3f55e9e8-4d52-4f45-a33d-89be8ef7ab45"

        val json = JSONObject(LinkRequestJson.encode("https://example.com", "", clientId))

        assertEquals(clientId, json.getString("client_id"))
        assertEquals(3, json.length())
    }
}
