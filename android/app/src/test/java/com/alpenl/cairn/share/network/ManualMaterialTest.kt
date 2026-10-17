package com.alpenl.cairn.share.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ManualMaterialTest {
    private val source = MaterialSource(3, 8, "a".repeat(64), 2)
    private val option = MaterialOption("image_text", "known-image", "legacy_unknown")
    private val intent = ManualMaterialIntent("same-intent", source, option, "Manual text 🙂\n ")
    private fun options() = JSONObject().put("version", 1).put("id", 4).put("source", JSONObject().put("content_revision", 3)
        .put("evidence_snapshot_id", 8).put("source_hash", source.hash).put("target_generation", 2)).put("can_submit", true)
        .put("blocked_reason", JSONObject.NULL).put("max_text_bytes", 100000).put("options", JSONArray().put(JSONObject()
            .put("kind", option.kind).put("source_ref", option.sourceRef).put("role", option.role)))
    private fun receipt() = JSONObject().put("version", 1).put("id", 4).put("operation_key", "same-intent").put("request_id", "receipt")
        .put("status", "material_saved").put("content_revision", 4).put("evidence_snapshot_id", 9).put("source_hash", "b".repeat(64))
        .put("changed", true).put("classification_queued", true).put("model_calls", 0).put("replayed", false)

    @Test fun observedOptionsAndStoredIntentsRetainIdentityAndUnknownAuthorship() {
        val loaded = (decodeMaterialOptions(options(), 4) as RunHistoryResult.Loaded).value
        assertEquals(source, loaded.source); assertEquals(listOf(option), loaded.options)
        assertEquals(intent, decodeMaterialIntent(intent.encode(), option.role))
        assertEquals("Manual text 🙂\n ", intent.encode().getString("text"))
        assertFalse(intent.encode().has("model")); assertFalse(intent.encode().has("role"))
        assertFalse(intent.copy(text = "中".repeat(33334)).valid())
        assertFalse(intent.copy(text = "bad\uD800").valid())
        assertTrue(intent.copy(text = "<>&".repeat(30000)).valid())
    }
    @Test fun absentOrFutureCapabilitiesNeverBecomePermissionToWrite() {
        assertEquals(RunHistoryResult.Unsupported, decodeMaterialOptions(options().put("version", 2), 4))
        for (json in listOf(options().put("id", 5), options().put("can_submit", "true"), options().put("source", JSONObject.NULL),
            options().apply { remove("blocked_reason") }, options().put("max_text_bytes", 999999),
            options().put("options", JSONArray().put(JSONObject().put("kind", "semantic_uncertainty").put("source_ref", "x").put("role", "primary"))))) {
            assertTrue(runCatching { decodeMaterialOptions(json, 4) }.isFailure)
        }
        val blocked = options().put("source", JSONObject.NULL).put("can_submit", false).put("blocked_reason", "v2_required")
        assertFalse((decodeMaterialOptions(blocked, 4) as RunHistoryResult.Loaded).value.canSubmit)
    }
    @Test fun receiptMustBindOwnerNonceNewSourceAndExplicitZeroCalls() {
        assertEquals(MaterialWriteResult.Saved(4, true, false), decodeMaterialReceipt(receipt(), 4, intent))
        assertEquals(MaterialWriteResult.Saved(4, true, true), decodeMaterialReceipt(receipt().put("replayed", true), 4, intent))
        val noop = receipt().put("content_revision", 3).put("evidence_snapshot_id", 8).put("source_hash", source.hash).put("changed", false).put("classification_queued", false)
        assertEquals(MaterialWriteResult.Saved(3, false, false), decodeMaterialReceipt(noop, 4, intent))
        for (json in listOf(receipt().put("id", 5), receipt().put("operation_key", "other"), receipt().put("content_revision", 3),
            receipt().put("evidence_snapshot_id", 8), receipt().put("source_hash", source.hash), receipt().put("classification_queued", false),
            receipt().put("model_calls", 1), receipt().apply { remove("model_calls") }, receipt().put("replayed", "false")))
            assertTrue(runCatching { decodeMaterialReceipt(json, 4, intent) }.isFailure)
    }
}
