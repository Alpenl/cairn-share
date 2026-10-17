package com.alpenl.cairn.share

import okhttp3.mockwebserver.MockResponse
import org.json.JSONArray
import org.json.JSONObject

/** Synthetic HTTP contract; actual Worker/D1 phases separately verify storage. */
internal object ProcessingFixture {
    fun status(revision: Long = 3, fence: String = "a".repeat(64), missing: Boolean = true): JSONObject = JSONObject()
        .put("version", 1).put("id", 4).put("fence", fence).put("content_revision", revision).put("target_generation", 0)
        .put("model_calls", 0).put("max_text_bytes", 100000).put("stages", JSONObject()
            .put("source", JSONObject().put("state", if (missing) "missing_primary" else "available"))
            .put("reading", JSONObject().put("state", "completed").put("output_state", "unversioned").put("supported", true))
            .put("classification", JSONObject().put("state", "completed").put("output_state", "partial"))
            .put("human", JSONObject().put("state", "recorded").put("revision", 2).put("events", 3).put("overrides", 4)))
        .put("actions", JSONObject().also { actions ->
            for (action in listOf("save_primary", "retry_reading", "retry_classification")) {
                val allowed = if (action == "save_primary") missing else !missing
                actions.put(action, JSONObject().put("allowed", allowed).put("blocked_reason", if (allowed) JSONObject.NULL
                    else if (missing) "primary_source_required" else "primary_already_present")
                    .put("model_calls_now", 0).put("may_call_model_later", true).put("queues", JSONArray(when (action) {
                        "save_primary" -> listOf("reading", "classification")
                        "retry_reading" -> listOf("reading")
                        else -> listOf("classification")
                    })))
            }
        })
    fun receipt(body: JSONObject, replayed: Boolean = false): JSONObject {
        val action = body.getString("action")
        return JSONObject().put("version", 1).put("id", 4).put("operation_key", body.getString("operation_key"))
            .put("action", action).put("status", if (action == "save_primary") "source_saved" else "queued")
            .put("content_revision", body.getLong("expected_content_revision") + if (action == "save_primary") 1 else 0)
            .put("target_generation", body.getLong("target_generation")).put("source_hash", "b".repeat(64))
            .put("reading_queued", action != "retry_classification").put("classification_queued", action != "retry_reading")
            .put("model_calls", 0).put("replayed", replayed)
    }
    fun response(body: JSONObject, status: Int = 200): MockResponse = MockResponse().setResponseCode(status)
        .setHeader("Content-Type", "application/json").setHeader("X-Cairn-App-Processing", "1").setBody(body.toString())
}
