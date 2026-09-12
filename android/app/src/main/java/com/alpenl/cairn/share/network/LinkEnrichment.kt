package com.alpenl.cairn.share.network

import org.json.JSONArray
import org.json.JSONObject

internal enum class CurationStatus(val apiValue: String, val label: String) {
    Inbox("inbox", "收件箱"),
    Kept("kept", "精选"),
    Compiled("compiled", "已编入笔记"),
    Drop("drop", "搁置"),
}

internal data class BookmarkClassification(
    val topics: List<String> = emptyList(),
    val form: String = "",
    val use: String = "",
    val whySuggestion: String = "",
    val entities: List<String> = emptyList(),
    val uncertainty: Boolean = true,
)

internal data class LinkEnrichment(
    val status: String = "pending",
    val source: String = "other",
    val aiTitle: String = "",
    val summary: String = "",
    val originalLanguage: String = "",
    val originalText: String = "",
    val translatedText: String = "",
    val relatedLinks: List<String> = emptyList(),
    val imageKeys: List<String> = emptyList(),
    val classification: BookmarkClassification? = null,
    val classificationReviewed: Boolean = false,
    val why: String = "",
    val curationStatus: CurationStatus = CurationStatus.Inbox,
    val contentLoaded: Boolean = false,
    val updatedAt: String = "",
)

internal data class TaxonomyTerm(val id: String, val label: String, val active: Boolean)

internal data class BookmarkTaxonomy(
    val topics: List<TaxonomyTerm>,
    val forms: List<TaxonomyTerm>,
    val uses: List<TaxonomyTerm>,
)

internal sealed interface TaxonomyResult {
    data class Loaded(val taxonomy: BookmarkTaxonomy) : TaxonomyResult
    data class Failed(val kind: FailureKind) : TaxonomyResult
}

internal data class CurationUpdate(
    val why: String? = null,
    val status: CurationStatus? = null,
    val classification: BookmarkClassification? = null,
    val resetClassification: Boolean = false,
) {
    fun encode(): String = JSONObject().apply {
        why?.let { put("why", it) }
        status?.let { put("curation_status", it.apiValue) }
        if (resetClassification) put("classification", JSONObject.NULL)
        else classification?.let {
            put("classification", JSONObject().apply {
                put("topics", JSONArray(it.topics))
                put("form", it.form)
                put("use", it.use)
            })
        }
    }.toString()
}

internal fun decodeEnrichment(json: JSONObject): LinkEnrichment = LinkEnrichment(
    status = json.text("status").ifBlank { "pending" },
    source = json.text("source").ifBlank { "other" },
    aiTitle = json.text("ai_title"),
    summary = json.text("summary"),
    originalLanguage = json.text("original_language"),
    originalText = json.text("original_text"),
    translatedText = json.text("translated_text"),
    relatedLinks = json.optJSONArray("related_links").strings(),
    imageKeys = json.optJSONArray("images")?.let { images ->
        List(images.length()) { images.optJSONObject(it)?.text("key").orEmpty() }.filter { it.isNotBlank() }
    }.orEmpty(),
    classification = json.optJSONObject("classification")?.let {
        BookmarkClassification(
            topics = it.optJSONArray("topics").strings(), form = it.text("form"), use = it.text("use"),
            whySuggestion = it.text("why_suggestion"), entities = it.optJSONArray("entities").strings(),
            uncertainty = it.optBoolean("uncertainty", true),
        )
    },
    classificationReviewed = json.optBoolean("classification_reviewed", false),
    why = json.text("why"),
    curationStatus = CurationStatus.entries.firstOrNull { it.apiValue == json.text("curation_status") } ?: CurationStatus.Inbox,
    contentLoaded = json.optBoolean("content_loaded", false),
    updatedAt = json.text("updated_at"),
)

internal fun SavedLink.retainLoadedContent(previous: SavedLink?): SavedLink {
    val fresh = enrichment ?: return this
    val loaded = previous?.enrichment ?: return this
    if (fresh.contentLoaded || !loaded.contentLoaded || url != previous.url || note != previous.note ||
        fresh.updatedAt != loaded.updatedAt || fresh.status != loaded.status) return this
    return copy(enrichment = fresh.copy(
        originalText = loaded.originalText, translatedText = loaded.translatedText,
        relatedLinks = loaded.relatedLinks, imageKeys = loaded.imageKeys, contentLoaded = true,
    ))
}

internal fun decodeTaxonomy(json: JSONObject): BookmarkTaxonomy {
    fun terms(key: String): List<TaxonomyTerm> = json.getJSONArray(key).let { items ->
        List(items.length()) { index -> items.getJSONObject(index).let {
            TaxonomyTerm(it.getString("id"), it.getString("label"), it.optBoolean("active", false))
        } }
    }
    return BookmarkTaxonomy(terms("topics"), terms("forms"), terms("uses"))
}

private fun JSONObject.text(key: String): String = if (isNull(key)) "" else optString(key)
private fun JSONArray?.strings(): List<String> = this?.let { array ->
    List(array.length()) { index -> array.optString(index).takeUnless { it == "null" }.orEmpty() }
        .filter { it.isNotBlank() }
}.orEmpty()
