package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.BookmarkTaxonomy
import com.alpenl.cairn.share.network.MultidimensionalSelection
import com.alpenl.cairn.share.network.SavedLink

internal data class ReaderTag(val ref: String, val label: String)

internal fun orderedTopics(ids: List<String>, taxonomy: BookmarkTaxonomy?): List<String> {
    val specific = taxonomy?.topics.orEmpty().filter { it.granularity == "specific" }.map { it.id }.toSet()
    return ids.distinct().sortedBy { if (it in specific) 0 else 1 }
}

/** Same effective three dimensions on list and reader; human additions are not capped. */
internal fun readerTags(link: SavedLink, selection: MultidimensionalSelection?, taxonomy: BookmarkTaxonomy?): List<ReaderTag> {
    val c = link.enrichment?.classification
    val dimensions = listOf(
        Triple("topics", orderedTopics(selection?.topics ?: c?.topics.orEmpty(), taxonomy), taxonomy?.topics.orEmpty()),
        Triple("resource_kinds", selection?.resourceKinds ?: c?.resourceKinds.orEmpty(), taxonomy?.resourceKinds.orEmpty()),
        Triple("content_functions", selection?.contentFunctions ?: c?.contentFunctions.orEmpty(), taxonomy?.contentFunctions.orEmpty()),
    )
    return dimensions.flatMap { (field, ids, terms) -> ids.map { id ->
        ReaderTag("system/$field/$id", terms.firstOrNull { it.id == id }?.label ?: id)
    } } + link.customTags.filter { it.active }.map { ReaderTag(it.tagRef, it.label) }
}
