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
}
