package com.alpenl.cairn.share.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SavedRecordTest {
    private val sources = SavedRecordScope(SavedRecordKind.Sources)
    private fun envelope(scope: SavedRecordScope = sources) = JSONObject().put("version", 1).put("bookmark_id", 4)
        .put("kind", scope.kind.path).put("source_revision", scope.sourceRevision ?: JSONObject.NULL)
    private fun page() = envelope().put("records", JSONArray().put(JSONObject().put("key", "12")).put(JSONObject().put("key", "9")))
        .put("next_after", "9")

    @Test fun pagesRetainUnknownLegacyProvenanceAndUseNumericNotLexicalOrdering() {
        val value = (decodeSavedRecordPage(page(), 4, sources, null) as RunHistoryResult.Loaded).value
        assertEquals(listOf("12", "9"), value.rows.map { it.key })
        assertEquals("9", value.nextAfter)
        val scope = SavedRecordScope(SavedRecordKind.Overrides)
        val record = JSONObject().put("key", "1").put("source", "legacy_unknown").put("confirmed", 0).put("term", "旧标签")
        val result = (decodeSavedRecord(envelope(scope).put("record", record), 4, scope, "1") as RunHistoryResult.Loaded).value
        assertTrue(result.summary.fields.contains("source" to "legacy_unknown"))
        assertTrue(result.summary.fields.contains("confirmed" to "0"))
        assertFalse(JSONObject(result.exportJson).getJSONObject("record").has("payload"))
    }

    @Test fun fullSourceAndEntityExportKeepsMissingNullAndOriginalState() {
        val payload = JSONObject().put("text", "x".repeat(17_000)).put("unknown", JSONObject.NULL).put("truncated", false)
        val source = JSONObject().put("key", "2").put("payload", payload)
        val value = (decodeSavedRecord(envelope().put("record", source), 4, sources, "2") as RunHistoryResult.Loaded).value
        assertEquals(17_000, JSONObject(value.exportJson).getJSONObject("record").getJSONObject("payload").getString("text").length)
        val scope = SavedRecordScope(SavedRecordKind.Entities, 2)
        val entity = JSONObject().put("key", "opaque/结果 + ?").put("state", "failed").put("outcome", "ignored_stale").put("payload", payload)
        val stored = (decodeSavedRecord(envelope(scope).put("record", entity), 4, scope, "opaque/结果 + ?") as RunHistoryResult.Loaded).value
        val exported = JSONObject(stored.exportJson).getJSONObject("record")
        assertEquals("failed", exported.getString("state")); assertFalse(exported.has("model"))
        assertTrue(exported.getJSONObject("payload").isNull("unknown"))
    }

    @Test fun entityPagingMatchesSqliteUtf8BinaryOrderingIncludingSupplementaryCharacters() {
        val scope = SavedRecordScope(SavedRecordKind.Entities, 2)
        val json = envelope(scope).put("records", JSONArray().put(JSONObject().put("key", "\uD800\uDC00")).put(JSONObject().put("key", "\uE000")))
            .put("next_after", JSONObject.NULL)
        val rows = (decodeSavedRecordPage(json, 4, scope, null) as RunHistoryResult.Loaded).value.rows
        assertEquals(listOf("\uD800\uDC00", "\uE000"), rows.map { it.key })
        assertTrue(runCatching { decodeSavedRecordPage(json, 4, scope, "\uE000") }.isFailure)
    }

    @Test fun malformedForeignOrPayloadBearingPagesAreRejected() {
        val invalid = listOf(page().put("bookmark_id", 5), page().put("kind", "events"), page().put("source_revision", 2),
            page().put("source_revision", "invalid"), page().put("source_revision", 0),
            page().put("next_after", "12"), page().apply { remove("next_after") },
            page().put("records", JSONArray().put(JSONObject().put("key", "01"))),
            page().put("records", JSONArray().put(JSONObject().put("key", "1").put("payload", JSONObject()))),
            page().put("records", JSONArray().apply { repeat(51) { put(JSONObject().put("key", "${100-it}")) } }))
        for (json in invalid) assertTrue(runCatching { decodeSavedRecordPage(json, 4, sources, null) }.isFailure)
        assertEquals(RunHistoryResult.Unsupported, decodeSavedRecordPage(page().put("version", 2), 4, sources, null))
        assertTrue(runCatching { decodeSavedRecord(envelope().put("record", JSONObject().put("key", "2")), 4, sources, "3") }.isFailure)
    }
}
