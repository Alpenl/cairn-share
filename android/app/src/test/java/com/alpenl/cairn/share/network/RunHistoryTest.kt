package com.alpenl.cairn.share.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RunHistoryTest {
    private fun row(id: Long) = JSONObject().put("id", id).put("status", "partial")
        .put("resolved_model", JSONObject.NULL).put("requested_model", "recorded-request")
        .put("content_revision", 2).put("coverage", "partial").put("evidence_coverage", "partial")
    private fun page() = JSONObject().put("version", 1).put("bookmark_id", 4)
        .put("runs", JSONArray().put(row(9)).put(row(8))).put("next_after_id", 8)

    @Test fun summariesKeepPartialAndUnknownMetadataWithoutLoadingPayloads() {
        val value = (decodeRunHistoryPage(page(), 4, 14) as RunHistoryResult.Loaded).value
        assertEquals(listOf(9L, 8L), value.runs.map { it.id })
        assertEquals(8L, value.nextAfterId)
        assertEquals("partial", value.runs.first().status)
        assertNull(value.runs.first().resolvedModel)
        assertNull(value.runs.first().archived)
        val terminal = page().put("runs", JSONArray()).put("next_after_id", JSONObject.NULL)
        assertNull((decodeRunHistoryPage(terminal, 4, 8) as RunHistoryResult.Loaded).value.nextAfterId)
    }

    @Test fun fullRecordExportPreservesUnknownNullsSavedJudgmentsAndSourceMetadata() {
        val stored = row(9).put("answers", JSONObject().put("topic", false))
            .put("usage", JSONObject().put("input_tokens", 17)).put("policy", JSONObject().put("old", true))
            .put("raw_judgments", JSONObject().put("source", JSONObject().put("partial", true)))
        val envelope = JSONObject().put("version", 1).put("bookmark_id", 4).put("run", stored)
        val result = (decodeRunHistoryRecord(envelope, 4, 9) as RunHistoryResult.Loaded).value
        assertEquals("partial", result.summary.status)
        val exported = JSONObject(result.exportJson).getJSONObject("run")
        assertTrue(exported.has("resolved_model")); assertTrue(exported.isNull("resolved_model"))
        assertFalse(exported.getJSONObject("answers").getBoolean("topic"))
        assertEquals(17, exported.getJSONObject("usage").getInt("input_tokens"))
        assertTrue(exported.getJSONObject("raw_judgments").getJSONObject("source").getBoolean("partial"))
        assertTrue(exported.getJSONObject("policy").getBoolean("old"))
        assertFalse(exported.has("created_at"))
    }

    @Test fun malformedForeignAndUnboundedPagesCannotBecomeSuccessfulHistory() {
        val invalid = listOf(
            page().put("bookmark_id", 5), page().put("next_after_id", 9), page().apply { remove("next_after_id") },
            page().put("runs", JSONArray().put(row(8)).put(row(9))),
            page().put("runs", JSONArray().put(row(9).put("answers", JSONObject()))),
            page().put("runs", JSONArray().put(row(9).put("resolved_model", 3))),
            page().put("runs", JSONArray().put(row(9_007_199_254_740_992L))),
            page().put("runs", JSONArray().apply { repeat(51) { put(row((100 - it).toLong())) } }),
        )
        for (json in invalid) assertTrue(json.toString(), runCatching { decodeRunHistoryPage(json, 4, 14) }.isFailure)
        assertTrue(runCatching { decodeRunHistoryPage(page(), 4, 9) }.isFailure)
        assertEquals(RunHistoryResult.Unsupported, decodeRunHistoryPage(page().put("version", 2), 4, null))
        assertTrue(runCatching {
            decodeRunHistoryRecord(JSONObject().put("version", 1).put("bookmark_id", 4).put("run", row(10)), 4, 9)
        }.isFailure)
    }
}
