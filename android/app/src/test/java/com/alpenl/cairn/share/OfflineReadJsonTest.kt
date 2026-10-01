package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OfflineReadJsonTest {
    private fun link() = LinkJson.decodeLink(JSONObject("""{"id":28,"url":"https://example.com/a","note":"mine","created_at":"2026-10-01T00:00:00Z","learned":false,
      "enrichment":{"status":"completed","content_loaded":true,"original_text":"private local archive","translated_text":"译文","classification":{"topics":["ai_coding"],"resource_kinds":["software"],"content_functions":["method","tool"]},
      "cache_identity":{"schema_version":1,"representation":"enrichment_detail","content_revision":3,"personal_revision":7,"body_revision":11,"latest_decision_id":9,"latest_entity_revision":0}}}"""))
    @Test fun `private snapshot round trips body and revision bound metadata`() {
        val row = OfflineReadEntry(accountKeyFor("https://test.invalid", "token"), link(), 1, 2, true)
        assertEquals(row, OfflineReadJson.decode(OfflineReadJson.encode(listOf(row))).single())
    }
    @Test fun `known new content revision cannot borrow the cached old body`() {
        val old = link()
        val changed = old.copy(enrichment = old.enrichment!!.copy(contentLoaded = false, originalText = "", translatedText = "",
            cacheIdentity = old.enrichment.cacheIdentity!!.copy(representation = "enrichment_summary", contentRevision = 4)))
        assertFalse(changed.retainLoadedContent(old).enrichment!!.contentLoaded)
        assertEquals("", changed.retainLoadedContent(old).enrichment!!.originalText)
    }
    @Test fun `unversioned or truncated snapshots are never restored as authoritative content`() {
        val row = OfflineReadEntry("v2:a", link().copy(enrichment = link().enrichment!!.copy(cacheIdentity = null)), 1, 2, false)
        assertTrue(runCatching { OfflineReadJson.decode(OfflineReadJson.encode(listOf(row))) }.isFailure)
        assertTrue(runCatching { OfflineReadJson.decode("invalid") }.isFailure)
    }
    @Test fun `stale cache is visibly expired after seven days`() {
        val info = OfflineReadInfo(100, true)
        assertFalse(info.expired(100 + 7 * 24 * 60 * 60 * 1000L - 1))
        assertTrue(info.expired(100 + 7 * 24 * 60 * 60 * 1000L))
    }
    @Test fun `reader overview includes functions and preserves more than five human labels`() {
        val selected = MultidimensionalSelection(topics = listOf("a", "b", "c"), resourceKinds = listOf("one", "two"), contentFunctions = listOf("method", "tool", "opinion"))
        val tags = readerTags(link(), selected, null)
        assertEquals(8, tags.size)
        assertTrue(tags.any { it.ref == "system/content_functions/method" })
    }
}
