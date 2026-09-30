package com.alpenl.cairn.share.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TagSystemIntegrationTest {
    @Test fun `resource filters match within dimension and combine with topics`() {
        val link = LinkJson.decodeLink(JSONObject("""{"id":1,"url":"https://example.com","note":"","created_at":"2026-09-30T00:00:00Z","learned":false,"enrichment":{"classification":{"topics":["ai_coding"],"resource_kinds":["skill"]}}}"""))
        val filters = BookmarkFilters(topics = listOf("ai_coding"), resourceKinds = listOf("prompt", "skill"))
        assertTrue(filters.matches(link))
        assertFalse(filters.copy(topics = listOf("finance_resources")).matches(link))
        assertFalse(filters.copy(resourceKinds = listOf("model")).matches(link))
        assertEquals("prompt,skill", filters.parameters()["resource_kinds"])
        assertTrue(filters.needsEffectiveFilterContract())
    }

    @Test fun `offline confirmation retains observed decision and source after process recreation`() {
        val action = QueuedCurationAction(7, "op-identity", "resource_kinds", "skill", "confirm", 4L, "account",
            expectedDecisionId = 81L, expectedContentRevision = 3L)
        assertEquals(action, QueuedCurationAction.decode(JSONObject(action.encode().toString())))
        val legacy = action.encode().apply { remove("expected_decision_id"); remove("expected_content_revision") }
        assertNull(QueuedCurationAction.decode(legacy).expectedDecisionId)
        assertNull(QueuedCurationAction.decode(legacy).expectedContentRevision)
    }

    @Test fun `resource provenance and export distinguish manual addition from confirmation`() {
        val payload = JSONObject(javaClass.classLoader!!.getResource("selection-state-v1.json")!!.readText())
        payload.getJSONObject("selection").put("resource_kinds", JSONArray().put("skill"))
        payload.getJSONObject("automatic").put("resource_kinds", JSONArray().put("skill"))
        payload.put("decision_id", 81).put("content_revision", 3)
        val resources = JSONObject("""{"status":"completed_nonempty","values":[{"term":"skill","origin":"human","confirmed":true,"revision":0,"human_action":"accept"}],"candidates":[]}""")
        payload.getJSONObject("state").getJSONObject("fields").put("resource_kinds", resources)
        val client = V2CurationClient("https://unused.invalid")
        val selected = (client.decodeSelection(payload) as V2Result.Loaded).value
        assertEquals(listOf("skill"), selected.resourceKinds)
        assertEquals(81L, selected.decisionId)
        assertEquals(3L, selected.contentRevision)
        assertEquals("你添加", selected.state!!.fields.getValue("resource_kinds").values.single().label)
        resources.getJSONArray("values").getJSONObject(0).put("human_action", "confirm")
        val confirmed = (client.decodeSelection(payload) as V2Result.Loaded).value
        assertEquals("你已确认", confirmed.state!!.fields.getValue("resource_kinds").values.single().label)
        val link = LinkJson.decodeLink(JSONObject("""{"id":1,"url":"https://example.com","note":"","created_at":"now","learned":false}"""))
        assertTrue(com.alpenl.cairn.share.v2ExportMarkdown(link, confirmed, null).contains("skill（你已确认）"))
    }
}
