package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.ManualMaterialIntent
import com.alpenl.cairn.share.network.MaterialOption
import com.alpenl.cairn.share.network.MaterialSource
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ManualMaterialDraftTest {
    private val value = StoredManualMaterial("v2:"+"a".repeat(64), 4, ManualMaterialIntent("fixed-nonce",
        MaterialSource(3, 8, "b".repeat(64), 2), MaterialOption("image_text", "known-image", "legacy_unknown"), "完整草稿 🙂\n"+"x".repeat(17000)))
    @Test fun unknownAndRejectedIntentsRoundTripWithoutTruncationOrCredentialStorage() {
        val second = value.copy(accountKey = "v2:"+"c".repeat(64), rejected = "source_conflict")
        assertEquals(listOf(value, second), decodeMaterialDrafts(encodeMaterialDrafts(listOf(value, second))))
        val encoded = encodeMaterialDrafts(listOf(value))
        assertTrue(JSONArray(encoded).getJSONObject(0).isNull("rejected"))
        assertFalse(encoded.contains("api_token")); assertFalse(encoded.contains("base_url"))
    }
    @Test fun damagedDuplicateOrUnscopedJournalFailsClosedInsteadOfLosingUnknownRequests() {
        val json = JSONArray(encodeMaterialDrafts(listOf(value))).getJSONObject(0)
        val invalid = listOf("{", JSONArray().put(json).put(json).toString(),
            JSONArray().put(JSONObject(json.toString()).put("account", "suffix-only")).toString(),
            JSONArray().put(JSONObject(json.toString()).put("id", 4.5)).toString(),
            JSONArray().put(JSONObject(json.toString()).apply { remove("rejected") }).toString(),
            JSONArray().put(JSONObject(json.toString()).apply { getJSONObject("intent").put("text", " ") }).toString())
        for (encoded in invalid) assertTrue(runCatching { decodeMaterialDrafts(encoded) }.exceptionOrNull() is java.io.IOException)
    }
}
