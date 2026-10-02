package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class TopicNavigationTest {
    private val catalog = decodeTaxonomy(JSONObject("""{"topics":[
      {"id":"image_creation","label":"图像生成","active":true,"granularity":"broad","navigation":true},
      {"id":"portrait","label":"写真","active":true,"granularity":"specific","navigation":false,"aliases":["个人写真"],"recall_terms":["AI写真"]},
      {"id":"avatar","label":"头像","active":true,"granularity":"specific","navigation":false}
    ],"resource_kinds":[{"id":"skill","label":"Skill","active":true}]}"""), topicGranularity = true)
    private fun link(topics: String) = LinkJson.decodeLink(JSONObject("""{"id":1,"url":"https://example.com","created_at":"now","learned":false,
      "enrichment":{"classification":{"topics":[$topics],"resource_kinds":["skill"]}}}"""))

    @Test fun `specific topics lead without removing manual tags or changing source identity`() {
        val item = link("\"image_creation\",\"portrait\",\"avatar\",\"manual1\",\"manual2\",\"manual3\"")
        val tags = readerTags(item, null, catalog)
        assertEquals(listOf("写真", "头像", "图像生成"), tags.take(3).map { it.label })
        assertEquals(7, tags.size)
        assertEquals("system/topics/portrait", tags.first().ref)
        assertEquals("image_creation", item.enrichment!!.classification!!.topics.first())
    }

    @Test fun `stable navigation contextual specifics aliases and fixed entry share one identity`() {
        val initial = topicSections(catalog.topics, emptySet(), emptySet(), emptyMap()).flatMap { it.terms }
        assertEquals(listOf("image_creation"), initial.map { it.id })
        val contextual = topicSections(catalog.topics, setOf("image_creation"), emptySet(), mapOf("portrait" to 2, "avatar" to 0))
        assertEquals(listOf("portrait"), contextual.single { it.id == "specific" }.terms.map { it.id })
        assertTrue(topicMatches(catalog.topics[1], "个人写真"))
        assertFalse(topicMatches(catalog.topics[1], "AI写真"))
        assertEquals("portrait", topicSections(catalog.topics, emptySet(), setOf("portrait"), emptyMap()).first().terms.single().id)
    }

    @Test fun `refinement means existing any group AND all specific topics and isolates cache entries`() {
        val original = BookmarkFilters(topics = listOf("image_creation", "design"))
        val refined = original.copy(topicRefinements = listOf("portrait", "avatar"))
        assertTrue(original.matches(link("\"image_creation\"")))
        assertFalse(refined.matches(link("\"image_creation\",\"portrait\"")))
        assertTrue(refined.matches(link("\"design\",\"portrait\",\"avatar\"")))
        assertFalse(refined.matches(link("\"portrait\",\"avatar\"")))
        assertEquals("any", refined.topicsMode)
        assertEquals("portrait,avatar", refined.parameters()["topic_refinements"])
        assertTrue(refined.needsTagFilterContract())
        val time = Instant.parse("2026-10-02T00:00:00Z")
        assertNotEquals(QueryPageKey.of("a", LinkFilter.All, "", null, original, time), QueryPageKey.of("a", LinkFilter.All, "", null, refined, time))
        assertNotEquals(QueryPageKey.of("a", LinkFilter.All, "", null, refined, time), QueryPageKey.of("b", LinkFilter.All, "", null, refined, time))
        assertEquals(refined.topicRefinements, refined.withTag(ReaderTag("system/resource_kinds/skill", "Skill")).topicRefinements)
    }

    @Test fun `unacknowledged taxonomy metadata falls back to original navigation`() {
        val json = JSONObject("""{"topics":[{"id":"portrait","label":"写真","active":true,"granularity":"specific","navigation":false}]}""")
        val old = decodeTaxonomy(json).topics.single()
        assertEquals("broad", old.granularity)
        assertTrue(old.navigation)
        assertEquals("specific", decodeTaxonomy(json, topicGranularity = true).topics.single().granularity)
    }
}
