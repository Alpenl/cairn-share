package com.alpenl.cairn.share.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProcessingTest {
    private val identity = ProcessingIdentity("a".repeat(64), 3, 0)
    private val intent = ProcessingIntent("durable-action", identity, ProcessingAction.SavePrimary, "Original 🙂\n ")
    private fun status() = JSONObject().put("version", 1).put("id", 4).put("fence", identity.fence).put("content_revision", 3).put("target_generation", 0)
        .put("model_calls", 0).put("max_text_bytes", 100000).put("stages", JSONObject()
            .put("source", JSONObject().put("state", "missing_primary"))
            .put("reading", JSONObject().put("state", "failed").put("output_state", "unversioned").put("supported", true))
            .put("classification", JSONObject().put("state", "result_unknown").put("output_state", "partial"))
            .put("human", JSONObject().put("state", "recorded").put("revision", 2).put("events", 3).put("overrides", 4)))
        .put("actions", JSONObject().also { actions -> ProcessingAction.entries.forEach { action ->
            actions.put(action.wire, JSONObject().put("allowed", action == ProcessingAction.SavePrimary)
                .put("blocked_reason", if (action == ProcessingAction.SavePrimary) JSONObject.NULL else "provider_result_unknown")
                .put("model_calls_now", 0).put("may_call_model_later", true).put("queues", JSONArray(when (action) {
                    ProcessingAction.SavePrimary -> listOf("reading", "classification")
                    ProcessingAction.RetryReading -> listOf("reading")
                    ProcessingAction.RetryClassification -> listOf("classification")
                })))
        } })
    private fun receipt() = JSONObject().put("version", 1).put("id", 4).put("operation_key", intent.operationKey).put("action", "save_primary")
        .put("status", "source_saved").put("content_revision", 4).put("target_generation", 0).put("source_hash", "b".repeat(64))
        .put("reading_queued", true).put("classification_queued", true).put("model_calls", 0).put("replayed", false)

    @Test fun independentStatusesNeverPromotePartialOrUnversionedOutputToConfirmedCurrent() {
        val decoded = (decodeProcessingStatus(status(), 4) as RunHistoryResult.Loaded).value
        assertEquals(identity, decoded.identity)
        assertEquals(listOf("source", "reading", "classification", "human"), decoded.stages.map { it.key })
        assertEquals("unversioned", decoded.stages[1].outputState)
        assertEquals("partial", decoded.stages[2].outputState)
        assertEquals(4, decoded.stages[3].overrides)
        assertTrue(decoded.actions.getValue(ProcessingAction.SavePrimary).allowed)
        assertFalse(decoded.actions.getValue(ProcessingAction.RetryClassification).allowed)
    }
    @Test fun absentUnsafeOrForeignCapabilitiesAreNeverPermissionToSpend() {
        assertEquals(RunHistoryResult.Unsupported, decodeProcessingStatus(status().put("version", 2), 4))
        val bad = listOf(status().put("id", 5), status().put("model_calls", 1), status().apply { remove("target_generation") },
            status().put("target_generation", JSONObject.NULL), status().put("target_generation", "0"),
            status().apply { getJSONObject("stages").remove("human") },
            status().apply { getJSONObject("actions").getJSONObject("save_primary").put("blocked_reason", "busy") },
            status().apply { getJSONObject("actions").getJSONObject("retry_reading").put("queues", JSONArray(listOf("classification"))) },
            status().apply { getJSONObject("actions").getJSONObject("save_primary").put("may_call_model_later", false) })
        bad.forEach { assertTrue(runCatching { decodeProcessingStatus(it, 4) }.isFailure) }
    }
    @Test fun persistentIntentsKeepClosedActionsExplicitGenerationAndExactUnicodeWithinWireBudget() {
        assertEquals(intent, decodeProcessingIntent(intent.encode()))
        assertEquals(intent.text, intent.encode().getString("text"))
        assertTrue(intent.copy(text = "<>&".repeat(30000)).valid())
        assertFalse(intent.copy(text = "界".repeat(33334)).valid())
        assertFalse(intent.copy(text = "bad\uD800").valid())
        assertFalse(intent.copy(text = "\u0000".repeat(100000)).valid())
        assertFalse(intent.copy(action = ProcessingAction.RetryReading).valid())
        for (bad in listOf(intent.encode().put("model", "arbitrary"), intent.encode().apply { remove("target_generation") },
            intent.encode().put("action", "manage_target"), intent.encode().put("target_generation", JSONObject.NULL)))
            assertTrue(runCatching { decodeProcessingIntent(bad) }.isFailure)
    }
    @Test fun successRequiresExactOwnerOperationSourceActionQueueAndZeroImmediateCalls() {
        assertEquals(ProcessingWriteResult.Confirmed(4, true, true, false), decodeProcessingReceipt(receipt(), 4, intent))
        assertEquals(ProcessingWriteResult.Confirmed(4, true, true, true), decodeProcessingReceipt(receipt().put("replayed", true), 4, intent))
        for (bad in listOf(receipt().put("id", 5), receipt().put("operation_key", "other"), receipt().put("action", "retry_reading"),
            receipt().put("content_revision", 3), receipt().put("target_generation", 1), receipt().apply { remove("target_generation") },
            receipt().put("classification_queued", false), receipt().put("replayed", "true"), receipt().put("model_calls", 1)))
            assertTrue(runCatching { decodeProcessingReceipt(bad, 4, intent) }.isFailure)
    }
}
