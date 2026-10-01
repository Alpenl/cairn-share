package com.alpenl.cairn.share

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PersonalTagOutboxTest {
    private val snapshot = PersonalTagSnapshot(12, 17, 3, emptyList())
    private fun created() = PendingPersonalTag(accountKeyFor("https://test.invalid", "secret-a"), 28,
        PersonalTagRequest("/api/custom-tags", "POST", JSONObject().put("operation_key", "create-once").put("label", "待实践").toString(), true, true, snapshot))
    private fun receipt(replayed: Boolean) = JSONObject().put("replayed", replayed).put("tag", JSONObject()
        .put("id", "tag-id").put("tag_ref", "custom/default/tag-id").put("label", "待实践").put("revision", 1).put("status", "active"))

    @Test fun `recreation preserves ownership exact payload operation and conflict`() {
        val row = created().copy(conflictRevision = 31, failure = "Network")
        val stored = PersonalTagOutboxJson.encode(listOf(row))
        assertEquals(row, PersonalTagOutboxJson.decode(stored).single())
        assertFalse(stored.contains("secret-a"))
        assertFalse(stored.contains("https://test.invalid"))
        assertNotEquals(row.account, accountKeyFor("https://test.invalid", "secret-b"))
    }
    @Test fun `lost create receipt replays to one deterministic attach with original CAS`() {
        val fresh = PersonalTagOutboxJson.acknowledged(created(), receipt(false))!!
        val replay = PersonalTagOutboxJson.acknowledged(created(), receipt(true))!!
        assertEquals(fresh, replay)
        val body = JSONObject(replay.request.body)
        assertEquals(12L, body.getLong("expected_revision"))
        assertEquals(17L, body.getLong("expected_decision_id"))
        assertEquals(3L, body.getLong("expected_content_revision"))
        assertEquals("attach", body.getJSONArray("actions").getJSONObject(0).getString("action"))
        assertEquals("custom/default/tag-id", body.getJSONArray("actions").getJSONObject(0).getString("tag_ref"))
        assertEquals(replay, PersonalTagOutboxJson.decode(PersonalTagOutboxJson.encode(listOf(replay))).single())
        assertNull(PersonalTagOutboxJson.acknowledged(replay, JSONObject().put("id", 28).put("operation_id", replay.request.operationKey).put("operation_revision", 13).put("replayed", true)))
    }
    @Test fun `a mismatched receipt never acknowledges or loses an intent`() {
        val row = PersonalTagOutboxJson.acknowledged(created(), receipt(false))!!
        for (bad in listOf(
            JSONObject().put("id", 27).put("operation_id", row.request.operationKey).put("operation_revision", 13).put("replayed", false),
            JSONObject().put("id", 28).put("operation_id", "other-operation").put("operation_revision", 13).put("replayed", false),
            JSONObject().put("id", 28).put("operation_id", row.request.operationKey).put("operation_revision", 0).put("replayed", false),
        )) assertTrue(runCatching { PersonalTagOutboxJson.acknowledged(row, bad) }.isFailure)
    }
    @Test fun `corrupt journal and foreign paths fail closed rather than becoming empty`() {
        assertTrue(runCatching { PersonalTagOutboxJson.decode("broken") }.isFailure)
        val escaped = JSONArray(PersonalTagOutboxJson.encode(listOf(created()))).apply { getJSONObject(0).put("path", "https://external.invalid") }
        assertTrue(runCatching { PersonalTagOutboxJson.decode(escaped.toString()) }.isFailure)
    }
}
