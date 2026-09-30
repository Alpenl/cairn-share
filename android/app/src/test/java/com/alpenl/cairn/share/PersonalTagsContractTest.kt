package com.alpenl.cairn.share

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PersonalTagsContractTest {
    private fun snapshotJson(): JSONObject = JSONObject("""{
      "revision":12,"decision_id":17,"content_revision":3,
      "custom_tags":[{"id":"abc","owner_id":"default","tag_ref":"custom/default/abc","label":"周末试试","revision":2,"status":"active"}]
    }""")

    @Test
    fun `personal labels preserve identity when display name changes`() {
        val original = parsePersonalTagSnapshot(snapshotJson())!!
        val renamed = snapshotJson().apply { getJSONArray("custom_tags").getJSONObject(0).put("label", "已经试过") }
        val current = parsePersonalTagSnapshot(renamed)!!
        assertEquals(original.customTags.single().tagRef, current.customTags.single().tagRef)
        assertEquals("已经试过", current.customTags.single().label)
    }

    @Test
    fun `missing evidence binding and foreign owner are not treated as a valid empty result`() {
        val noBinding = snapshotJson().apply { remove("content_revision") }
        assertNull(parsePersonalTagSnapshot(noBinding))
        val foreign = snapshotJson().apply { getJSONArray("custom_tags").getJSONObject(0).put("tag_ref", "custom/another/abc") }
        assertNull(parsePersonalTagSnapshot(foreign))
        val badRevision = snapshotJson().apply { put("revision", 12.5) }
        assertNull(parsePersonalTagSnapshot(badRevision))
        assertTrue(parsePersonalTagSnapshot(snapshotJson().apply { put("custom_tags", org.json.JSONArray()) })!!.customTags.isEmpty())
    }

    @Test
    fun `incremental action binds personal and AI versions and uses stable ref`() {
        val snapshot = parsePersonalTagSnapshot(snapshotJson())!!
        val action = JSONObject().put("action", "detach").put("tag_ref", snapshot.customTags.single().tagRef)
        val payload = personalTagActionPayload(snapshot, action, "same-operation")
        assertEquals("same-operation", payload.getString("operation_key"))
        assertEquals(12L, payload.getLong("expected_revision"))
        assertEquals(17L, payload.getLong("expected_decision_id"))
        assertEquals(3L, payload.getLong("expected_content_revision"))
        assertEquals(1, payload.getJSONArray("actions").length())
        assertFalse(payload.has("selection"))
        assertEquals("custom/default/abc", payload.getJSONArray("actions").getJSONObject(0).getString("tag_ref"))
    }

    @Test
    fun `undo only targets latest acknowledged operation and never overwrites newer edits`() {
        val current = parsePersonalTagSnapshot(snapshotJson())!!
        val latest = PersonalTagHistoryEvent("original", 12, "移除", "now", true)
        val payload = personalTagUndoPayload(current, latest, "undo-once")!!
        assertEquals("original", payload.getJSONArray("actions").getJSONObject(0).getString("operation_id"))
        assertEquals("undo-once", payload.getString("operation_key"))
        assertNull(personalTagUndoPayload(current, latest.copy(revision = 11)))
        assertNull(personalTagUndoPayload(current, latest.copy(reversible = false)))
    }

    @Test
    fun `historical display uses recorded labels and old unknown events remain non reversible`() {
        val history = JSONObject("""{"events":[
          {"operation_id":"replace","revision":12,"created_at":"today","before":{},"after":{},
            "context":{"tag_definitions":[{"field":"topics","term":"ai_coding","label":"AI编程"},{"field":"topics","term":"image_creation","label":"图像生成"}]},
            "actions":[{"action":"replace","from_tag_ref":"system/topics/ai_coding","to_tag_ref":"system/topics/image_creation"}]},
          {"operation_id":"legacy","revision":4,"created_at":"old","before":null,"after":null,"context":{},
            "actions":[{"action":"reject","field":"topics","term":"llm"}]},
          {"operation_id":"undo","revision":13,"created_at":"today","before":{},"after":{},"context":{},
            "actions":[{"action":"undo","operation_id":"replace"}]}
        ]}""")
        val parsed = parsePersonalTagHistory(history.getJSONArray("events"))
        assertEquals("AI编程 → 图像生成", parsed[0].summary)
        assertTrue(parsed[0].reversible)
        assertFalse(parsed[1].reversible)
        assertFalse(parsed[2].reversible)
    }
}
