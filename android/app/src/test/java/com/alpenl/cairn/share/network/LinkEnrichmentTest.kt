package com.alpenl.cairn.share.network

import com.alpenl.cairn.share.displayTitle
import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LinkEnrichmentTest {
    private fun base() = JSONObject("""{"id":1,"url":"https://x.com/example/status/1","note":"note","created_at":"2026-09-12T00:00:00Z","learned":false,"learned_at":null}""")

    @Test fun legacyLinksRemainReadable() {
        val link = LinkJson.decodeLink(base())
        assertNull(link.enrichment)
        assertEquals("x.com/example/status/1", link.displayTitle())
    }

    @Test fun nullableSummaryFieldsNeverDisplayTheLiteralNull() {
        val link = LinkJson.decodeLink(base().put("enrichment", JSONObject("""{"ai_title":null,"original_text":null,"summary":null,"classification":null,"content_loaded":false}""")))
        assertEquals("", link.enrichment?.aiTitle)
        assertEquals("", link.enrichment?.originalText)
        assertEquals("x.com/example/status/1", link.displayTitle())
        assertEquals(CurationStatus.Inbox, link.enrichment?.curationStatus)
    }

    @Test fun enhancedDetailsKeepBothLanguagesAndPreferTheAiTitle() {
        val link = LinkJson.decodeLink(base().put("enrichment", JSONObject("""{
            "status":"completed","ai_title":"中文收藏标题","original_language":"en",
            "original_text":"original","translated_text":"中文全文","summary":"摘要",
            "related_links":["https://example.com"],"images":[{"key":"enrichment/1/image.png"}],
            "content_loaded":true,"curation_status":"kept","classification_reviewed":true,
            "classification":{"topics":["eng"],"form":"method","use":"quote","uncertainty":false,"entities":["Cairn"]}
        }""")))
        assertEquals("中文收藏标题", link.displayTitle())
        val content = requireNotNull(link.enrichment)
        assertEquals("original", content.originalText)
        assertEquals("中文全文", content.translatedText)
        assertEquals(listOf("enrichment/1/image.png"), content.imageKeys)
        assertEquals(listOf("eng"), content.classification?.topics)
        assertTrue(content.contentLoaded)
        assertTrue(content.classificationReviewed)
    }

    @Test fun humanCurationWritesOnlyEditableFieldsAndSupportsReset() {
        val update = JSONObject(CurationUpdate("保存原因", CurationStatus.Kept, BookmarkClassification(
            topics = listOf("eng"), form = "method", use = "quote", whySuggestion = "AI advice",
        )).encode())
        val selection = update.getJSONObject("classification")
        assertEquals(setOf("topics", "form", "use"), selection.keys().asSequence().toSet())
        assertEquals("kept", update.getString("curation_status"))
        assertFalse(update.has("original_text"))
        val reset = JSONObject(CurationUpdate(resetClassification = true).encode())
        assertTrue(reset.has("classification"))
        assertTrue(reset.isNull("classification"))
        assertFalse(reset.has("why"))
    }

    @Test fun summaryRefreshRetainsLoadedBodiesOnlyForTheSameContentRevision() {
        val saved = LinkJson.decodeLink(base()).copy(enrichment = LinkEnrichment(status = "completed", originalText = "old", contentLoaded = true, updatedAt = "one"))
        val summary = saved.copy(enrichment = saved.enrichment!!.copy(originalText = "", contentLoaded = false, why = "new reason"))
        val merged = summary.retainLoadedContent(saved)
        assertEquals("old", merged.enrichment?.originalText)
        assertEquals("new reason", merged.enrichment?.why)
        assertTrue(merged.enrichment!!.contentLoaded)
        val changed = summary.copy(enrichment = summary.enrichment!!.copy(updatedAt = "two"))
        assertFalse(changed.retainLoadedContent(saved).enrichment!!.contentLoaded)
        assertFalse(summary.copy(url = "https://example.com/new").retainLoadedContent(saved).enrichment!!.contentLoaded)
    }

    @Test fun filtersUseHumanClassificationAndInclusiveDates() {
        val link = LinkJson.decodeLink(base()).copy(enrichment = LinkEnrichment(
            source = "x", curationStatus = CurationStatus.Kept,
            classification = BookmarkClassification(topics = listOf("eng"), form = "method", use = "quote", uncertainty = false), classificationReviewed = true,
        ))
        val now = Instant.parse("2026-09-19T00:00:00Z")
        val filter = BookmarkFilters(curationStatus = "kept", topic = "eng", source = "x", recentDays = 7)
        assertTrue(filter.matches(link, now))
        assertEquals("2026-09-12T00:00:00Z", filter.parameters(now)["since"])
        assertFalse(filter.copy(topic = "llm").matches(link, now))
        assertFalse(filter.copy(uncertain = true).matches(link, now))
        assertFalse(filter.matches(link, now.plusSeconds(1)))
    }

    @Test fun taxonomyKeepsInactiveTermsForPreviouslySavedLabels() {
        val terms = """[{"id":"eng","label":"工程","active":true},{"id":"old","label":"旧标签","active":false}]"""
        val taxonomy = decodeTaxonomy(JSONObject("""{"topics":$terms,"forms":[],"uses":[]}"""))
        assertEquals(listOf("eng", "old"), taxonomy.topics.map { it.id })
        assertFalse(taxonomy.topics.last().active)
    }
}
