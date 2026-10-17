package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProcessingDraftTest {
    private val account = accountKeyFor("https://example.com", "account-A-token")
    private val intent = ProcessingIntent("kept-operation", ProcessingIdentity("a".repeat(64), 3, 0), ProcessingAction.SavePrimary, "Original 🙂\n ")
    @Test fun unknownAndRefusedActionsRoundTripWithoutCredentialOrSourceRebasing() {
        val unknown = StoredProcessingIntent(account, 4, intent)
        val rejected = unknown.copy(rejected = "state_conflict")
        for (value in listOf(unknown, rejected)) {
            val encoded = encodeProcessingDrafts(listOf(value))
            assertEquals(listOf(value), decodeProcessingDrafts(encoded))
            assertFalse(encoded.contains("account-A-token"))
            assertEquals(intent, decodeProcessingDrafts(encoded).single().intent)
        }
        assertNotEquals(account, accountKeyFor("https://example.com", "different-A-token"))
        assertNotEquals(account, accountKeyFor("https://other.example.com", "account-A-token"))
    }
    @Test fun malformedMissingOrDuplicateRecordsFailInsteadOfLookingLikeAnEmptyQueue() {
        val original = encodeProcessingDrafts(listOf(StoredProcessingIntent(account, 4, intent)))
        val bad = listOf("not-json", JSONArray(original).put(JSONArray(original).getJSONObject(0)).toString(),
            JSONArray(original).apply { getJSONObject(0).remove("rejected") }.toString(),
            JSONArray(original).apply { getJSONObject(0).getJSONObject("intent").remove("target_generation") }.toString(),
            JSONArray(original).apply { getJSONObject(0).put("account", "legacy-suffix") }.toString(),
            JSONArray(original).apply { getJSONObject(0).put("rejected", JSONObject()) }.toString())
        bad.forEach { assertTrue(runCatching { decodeProcessingDrafts(it) }.exceptionOrNull() is java.io.IOException) }
    }
}
