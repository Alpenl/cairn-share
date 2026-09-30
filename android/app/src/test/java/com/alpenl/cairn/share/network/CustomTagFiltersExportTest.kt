package com.alpenl.cairn.share.network

import com.alpenl.cairn.share.v2ExportMarkdown
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CustomTagFiltersExportTest {
    private fun fixture() = JSONObject("""{
      "id":1,"url":"https://example.com","note":"","created_at":"2026-09-30T00:00:00Z","learned":false,
      "custom_tags":[{"id":"uuid-one","owner_id":"default","tag_ref":"custom/default/uuid-one","label":"周末试试","revision":2,"status":"active"}],
      "enrichment":{"status":"completed","classification":{"topics":["ai_coding","automation"],"resource_kinds":["skill","prompt"]}}
    }""")

    @Test fun `custom identity and display revision survive JSON decode and summary body merge`() {
        val loaded = LinkJson.decodeLink(fixture()).let { link -> link.copy(enrichment = link.enrichment!!.copy(
            originalText = "previous body", contentLoaded = true, updatedAt = "same")) }
        val changed = fixture().apply { getJSONArray("custom_tags").getJSONObject(0).put("label", "已经试过").put("revision", 3) }
        val summary = LinkJson.decodeLink(changed).let { link -> link.copy(enrichment = link.enrichment!!.copy(updatedAt = "same")) }
        val merged = summary.retainLoadedContent(loaded)
        assertEquals("previous body", merged.enrichment!!.originalText)
        assertEquals("uuid-one", merged.customTags.single().id)
        assertEquals("custom/default/uuid-one", merged.customTags.single().tagRef)
        assertEquals("已经试过", merged.customTags.single().label)
        assertEquals(3L, merged.customTags.single().revision)
        assertTrue(merged.customTags.single().active)
        assertTrue(LinkJson.decodeLink(fixture().apply { remove("custom_tags") }).customTags.isEmpty())
        assertTrue(LinkJson.decodeLink(fixture().put("custom_tags", JSONArray())).customTags.isEmpty())
    }

    @Test fun `invalid custom tag identity cannot silently become another label`() {
        for (change in listOf<(JSONObject) -> Unit>(
            { it.put("tag_ref", "system/topics/ai_coding") },
            { it.put("revision", 1.5) },
            { it.put("status", "unknown") },
        )) {
            val json = fixture()
            change(json.getJSONArray("custom_tags").getJSONObject(0))
            assertThrows(JSONException::class.java) { LinkJson.decodeLink(json) }
        }
    }

    @Test fun `custom and resources filter by stable ids with dimension any or all`() {
        val link = LinkJson.decodeLink(fixture())
        val filters = BookmarkFilters(topics = listOf("ai_coding", "automation"), resourceKinds = listOf("skill", "prompt"),
            customTags = listOf("uuid-one", "uuid-two"))
        assertTrue(filters.matches(link))
        assertFalse(filters.copy(customMode = "all").matches(link))
        assertTrue(filters.copy(topicsMode = "all", resourceMode = "all").matches(link))
        assertFalse(filters.copy(resourceKinds = listOf("skill", "model"), resourceMode = "all").matches(link))
        assertFalse(filters.copy(topics = listOf("ai_coding", "finance_resources"), topicsMode = "all").matches(link))
        assertFalse(filters.copy(customTags = listOf("周末试试")).matches(link))
        assertTrue(filters.needsTagFilterContract())
        assertEquals("uuid-one,uuid-two", filters.parameters()["custom_tags"])
        assertNull(filters.parameters()["custom_mode"])
        val allParameters = filters.copy(topicsMode = "all", resourceMode = "all", customMode = "all").parameters()
        assertEquals("all", allParameters["topics_mode"])
        assertEquals("all", allParameters["resource_mode"])
        assertEquals("all", allParameters["custom_mode"])
        assertTrue(BookmarkFilters(topics = listOf("ai_coding"), topicsMode = "all").needsTagFilterContract())
        assertFalse(BookmarkFilters(topics = listOf("ai_coding")).needsTagFilterContract())
    }

    @Test fun `native export preserves resource state and custom identity without requiring a source body`() {
        val payload = JSONObject(javaClass.classLoader!!.getResource("selection-state-v1.json")!!.readText())
        payload.getJSONObject("selection").put("resource_kinds", JSONArray().put("skill"))
        payload.getJSONObject("automatic").put("resource_kinds", JSONArray().put("skill"))
        payload.getJSONObject("state").getJSONObject("fields").put("resource_kinds", JSONObject("""{
          "status":"completed_nonempty","values":[{"term":"skill","origin":"automatic","confirmed":false}],"candidates":[]
        }"""))
        val selection = (V2CurationClient("https://unused.invalid").decodeSelection(payload) as V2Result.Loaded).value
        val exported = v2ExportMarkdown(LinkJson.decodeLink(fixture()), selection, null)
        assertTrue(exported.contains("资源类型：skill（自动建议）"))
        assertTrue(exported.contains("资源类型 自动判断："))
        assertTrue(exported.contains("自定义标记：周末试试（你添加）"))
        assertTrue(exported.contains("自定义标记身份：custom/default/uuid-one · 显示版本 2"))
        val empty = v2ExportMarkdown(LinkJson.decodeLink(fixture().put("custom_tags", JSONArray())), selection, null)
        assertFalse(empty.contains("自定义标记"))
    }
}
