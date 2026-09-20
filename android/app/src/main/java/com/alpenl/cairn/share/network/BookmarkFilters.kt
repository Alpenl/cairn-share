package com.alpenl.cairn.share.network

import java.time.Instant
import java.time.temporal.ChronoUnit

internal data class BookmarkFilters(
    val curationStatus: String = "",
    val topic: String = "",
    val form: String = "",
    val use: String = "",
    val source: String = "",
    val uncertain: Boolean = false,
    val recentDays: Int = 0,
    // v2 dimensions. Same-dimension values are OR-ed, cross-dimension AND-ed,
    // matching the Worker's frozen query contract.
    val contentFunctions: List<String> = emptyList(),
    val carriers: List<String> = emptyList(),
    val affordances: List<String> = emptyList(),
    val entityState: String = "",
) {
    fun parameters(now: Instant = Instant.now()): Map<String, String> = buildMap {
        put("curation_status", curationStatus)
        put("topic", topic)
        put("form", form)
        put("use", use)
        put("source", source)
        if (contentFunctions.isNotEmpty()) put("content_functions", contentFunctions.joinToString(","))
        if (carriers.isNotEmpty()) put("carriers", carriers.joinToString(","))
        if (affordances.isNotEmpty()) put("affordances", affordances.joinToString(","))
        if (entityState.isNotEmpty()) put("entity_state", entityState)
        if (uncertain) put("uncertain", "true")
        if (recentDays > 0) put("since", now.minus(recentDays.toLong(), ChronoUnit.DAYS).toString())
    }.filterValues { it.isNotEmpty() }

    fun matches(link: SavedLink, now: Instant = Instant.now()): Boolean {
        val data = link.enrichment
        val labels = data?.classification
        return (curationStatus.isBlank() || (data?.curationStatus?.apiValue ?: "inbox") == curationStatus) &&
            (topic.isBlank() || topic in labels?.topics.orEmpty()) &&
            (form.isBlank() || labels?.form == form) && (use.isBlank() || labels?.use == use) &&
            (source.isBlank() || data?.source == source) &&
            (contentFunctions.isEmpty() || contentFunctions.any { it in labels?.contentFunctions.orEmpty() }) &&
            (carriers.isEmpty() || carriers.any { it in labels?.carriers.orEmpty() }) &&
            (affordances.isEmpty() || affordances.any { it in labels?.affordances.orEmpty() }) &&
            (entityState.isBlank() || data?.entityState == entityState) &&
            (!uncertain || (data?.classificationReviewed != true && labels?.uncertainty != false)) &&
            (recentDays <= 0 || runCatching { !Instant.parse(link.createdAt).isBefore(now.minus(recentDays.toLong(), ChronoUnit.DAYS)) }.getOrDefault(false))
    }
}
