package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.BookmarkClassification
import com.alpenl.cairn.share.network.BookmarkFilters
import com.alpenl.cairn.share.network.BookmarkTaxonomy
import com.alpenl.cairn.share.network.LinkEnrichment
import com.alpenl.cairn.share.network.SavedLink
import com.alpenl.cairn.share.network.TaxonomyTerm
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TagChipFilterTest {
    private val link = SavedLink(
        id = 1, url = "https://example.com/a", note = "", createdAt = "2026-10-01T00:00:00Z", learned = false, learnedAt = null,
        enrichment = LinkEnrichment(classification = BookmarkClassification(topics = listOf("ui_design"), resourceKinds = listOf("reference"), uncertainty = false)),
    )

    @Test fun serialisesUnifiedTagsAndOnlySendsModeForAll() {
        val any = BookmarkFilters(tags = listOf("system/topics/ui_design", "custom/default/abc"))
        assertEquals("system/topics/ui_design,custom/default/abc", any.parameters()["tags"])
        assertFalse(any.parameters().containsKey("tags_mode"))
        assertEquals("all", any.copy(tagsMode = "all").parameters()["tags_mode"])
        assertTrue(any.needsEffectiveFilterContract())
        assertTrue(any.needsTagFilterContract())
    }

    @Test fun localMatchFollowsAnyAndAll() {
        val refs = listOf("system/topics/ui_design", "system/resource_kinds/tool")
        assertTrue(BookmarkFilters(tags = refs).matches(link))
        assertFalse(BookmarkFilters(tags = refs, tagsMode = "all").matches(link))
        assertTrue(BookmarkFilters(tags = listOf("system/topics/ui_design", "system/resource_kinds/reference"), tagsMode = "all").matches(link))
        assertFalse(BookmarkFilters(tags = listOf("custom/default/x")).matches(link))
    }

    @Test fun toggleTagAddsAndRemoves() {
        val f = BookmarkFilters().toggleTag("system/topics/a")
        assertEquals(listOf("system/topics/a"), f.tags)
        assertEquals(emptyList<String>(), f.toggleTag("system/topics/a").tags)
    }

    @Test fun groupsFollowPrototypeOrderAndSearchAliases() {
        val taxonomy = BookmarkTaxonomy(
            topics = listOf(TaxonomyTerm("ui_specific", "界面细节", true, granularity = "specific"), TaxonomyTerm("ui_design", "界面设计", true, aliases = listOf("UI"))),
            forms = emptyList(), uses = emptyList(),
            resourceKinds = listOf(TaxonomyTerm("reference", "参考资料", true), TaxonomyTerm("old", "旧类型", false)),
        )
        val groups = tagFilterGroups(taxonomy, emptyList(), emptyList())
        assertEquals(listOf("主题", "资源类型"), groups.map { it.title })
        assertEquals("system/topics/ui_design", groups[0].chips.first().first) // broad first
        assertEquals(1, groups[1].chips.size) // inactive hidden unless selected
        assertEquals(listOf("system/topics/ui_design"), tagFilterGroups(taxonomy, emptyList(), emptyList(), "ui").flatMap { it.chips }.map { it.first })
    }
}
