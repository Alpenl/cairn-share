package com.alpenl.cairn.share.network

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SelectionStateTest {
    private val client = V2CurationClient("https://unused.invalid")
    private fun fixture() = JSONObject(javaClass.classLoader!!.getResource("selection-state-v1.json")!!.readText())
    private fun decode(json: JSONObject): MultidimensionalSelection =
        (client.decodeSelection(json) as V2Result.Loaded).value

    @Test fun `shared Worker fixture retains abstention zero probability independent entities and automatic origins`() {
        val selection = decode(fixture())
        assertEquals(listOf("llm"), selection.topics)
        val state = selection.state!!
        assertEquals("abstained", state.fields.getValue("form").status)
        assertEquals("method", state.fields.getValue("form").candidates.single().term)
        assertEquals("completed_empty", state.fields.getValue("use").status)
        assertEquals("not_run", state.entities!!.status)
        assertEquals(0.0, state.fields.getValue("topics").candidates.last().probability)
        assertFalse(state.fields.getValue("topics").values.single().confirmed)
        assertEquals("自动建议", state.fields.getValue("topics").values.single().label)
    }

    @Test fun `old or unknown state never becomes confirmed and invalid selections fail`() {
        val old = fixture().apply { remove("state") }
        assertNull(decode(old).state)
        for (state in listOf(
            fixture().getJSONObject("state").put("version", 2),
            fixture().getJSONObject("state").put("personal_revision", 4),
        )) assertNull(decode(fixture().put("state", state)).state)
        for (bad in listOf(JSONObject(), fixture().put("revision", -1), fixture().put("revision", 0.5),
            fixture().put("revision", "0"), fixture().put("selection", JSONObject()))) {
            assertEquals(V2Result.Failed(FailureKind.Server), client.decodeSelection(bad))
        }
        val humanWithoutRevision = fixture()
        humanWithoutRevision.getJSONObject("state").getJSONObject("fields").getJSONObject("topics")
            .getJSONArray("values").getJSONObject(0).put("origin", "human").put("confirmed", true)
        assertFalse(decode(humanWithoutRevision).state!!.fields.getValue("topics").values.single().confirmed)
        val mismatched = fixture()
        mismatched.getJSONObject("state").getJSONObject("fields").getJSONObject("topics")
            .getJSONArray("values").getJSONObject(0).put("term", "wrong")
        assertNull(decode(mismatched).state)
    }

    @Test fun `export preserves full selection provenance partial evidence and independent entity unknown`() {
        val json = fixture()
        json.getJSONObject("state").put("evidence", JSONObject("""{"truncated":0,"completeness":"empty"}"""))
        val selection = decode(json).copy(topics = listOf("llm", "eng", "eval", "design"))
        val link = LinkJson.decodeLink(JSONObject("""{"id":1,"url":"https://example.com","note":"","created_at":"now","learned":false,
            "enrichment":{"status":"completed","why":"我的原因","classification":{"entities":["stale-classification-entity"]}}}"""))
        val exported = com.alpenl.cairn.share.v2ExportMarkdown(link, selection, null)
        assertTrue(exported.contains("design（来源未知）"))
        assertTrue(exported.contains("llm（自动建议）"))
        assertTrue(exported.contains("来源证据：不完整"))
        assertTrue(exported.contains("收藏原因：我的原因"))
        assertTrue(exported.contains("实体状态：尚未运行"))
        assertFalse(exported.contains("stale-classification-entity"))
        val draft = selection.copy(topics = emptyList(), pendingFields = setOf("topics"))
        assertTrue(com.alpenl.cairn.share.v2ExportMarkdown(link, draft, null).contains("主题：本地留空，待同步"))
    }

    @Test fun `local edits cannot reuse server human confirmation in export or UI`() {
        val selection = decode(fixture())
        val repo = V2CurationRepository(object : V2Transport {
            override fun loadSelection(id: Int, apiToken: String) = V2Result.Unsupported
            override fun loadTaxonomy(apiToken: String) = V2Result.Unsupported
            override fun applyOverride(id: Int, override: FieldOverride, apiToken: String) = V2Result.Unsupported
        })
        val pending = repo.applyLocal(selection, selection.automatic, "topics", "eng", "accept")
        assertEquals(setOf("topics"), pending.pendingFields)
        assertEquals(listOf("llm", "eng"), pending.topics)
        assertEquals("automatic", pending.state!!.fields.getValue("topics").values.single().origin)
    }
}
