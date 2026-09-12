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
) {
    fun parameters(now: Instant = Instant.now()): Map<String, String> = buildMap {
        put("curation_status", curationStatus)
        put("topic", topic)
        put("form", form)
        put("use", use)
        put("source", source)
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
            (!uncertain || (data?.classificationReviewed != true && labels?.uncertainty != false)) &&
            (recentDays <= 0 || runCatching { !Instant.parse(link.createdAt).isBefore(now.minus(recentDays.toLong(), ChronoUnit.DAYS)) }.getOrDefault(false))
    }
}
