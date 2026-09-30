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
    // Values within a dimension default to any; dimensions always combine with
    // AND, matching the Worker's effective-selection query contract.
    val contentFunctions: List<String> = emptyList(),
    val carriers: List<String> = emptyList(),
    val affordances: List<String> = emptyList(),
    val entityState: String = "",
    val topics: List<String> = emptyList(),
    val resourceKinds: List<String> = emptyList(),
    val customTags: List<String> = emptyList(),
    val topicsMode: String = "any",
    val resourceMode: String = "any",
    val customMode: String = "any",
) {
    init {
        require(listOf(topicsMode, resourceMode, customMode).all { it in setOf("any", "all") })
    }

    fun needsEffectiveFilterContract(): Boolean = topic.isNotEmpty() || topics.isNotEmpty() ||
        form.isNotEmpty() || use.isNotEmpty() || contentFunctions.isNotEmpty() ||
        carriers.isNotEmpty() || affordances.isNotEmpty() || entityState.isNotEmpty() ||
        resourceKinds.isNotEmpty() || customTags.isNotEmpty()

    fun needsTagFilterContract(): Boolean = resourceKinds.isNotEmpty() || customTags.isNotEmpty() ||
        (topicsMode == "all" && (topics.isNotEmpty() || topic.isNotBlank()))

    fun parameters(now: Instant = Instant.now()): Map<String, String> = buildMap {
        put("curation_status", curationStatus)
        put("topic", topic)
        if (topics.isNotEmpty()) put("topics", topics.joinToString(","))
        if (resourceKinds.isNotEmpty()) put("resource_kinds", resourceKinds.joinToString(","))
        if (customTags.isNotEmpty()) put("custom_tags", customTags.joinToString(","))
        if (topicsMode == "all" && (topics.isNotEmpty() || topic.isNotBlank())) put("topics_mode", topicsMode)
        if (resourceMode == "all" && resourceKinds.isNotEmpty()) put("resource_mode", resourceMode)
        if (customMode == "all" && customTags.isNotEmpty()) put("custom_mode", customMode)
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
            matchesValues(topics + listOf(topic).filter { it.isNotBlank() }, labels?.topics.orEmpty(), topicsMode) &&
            (form.isBlank() || labels?.form == form) && (use.isBlank() || labels?.use == use) &&
            (source.isBlank() || data?.source == source) &&
            matchesValues(resourceKinds, labels?.resourceKinds.orEmpty(), resourceMode) &&
            matchesValues(customTags, link.customTags.map { it.id }, customMode) &&
            (contentFunctions.isEmpty() || contentFunctions.any { it in labels?.contentFunctions.orEmpty() }) &&
            (carriers.isEmpty() || carriers.any { it in labels?.carriers.orEmpty() }) &&
            (affordances.isEmpty() || affordances.any { it in labels?.affordances.orEmpty() }) &&
            (entityState.isBlank() || data?.entityState in entityState.split(',')) &&
            (!uncertain || (data?.classificationReviewed != true && labels?.uncertainty != false)) &&
            (recentDays <= 0 || runCatching { !Instant.parse(link.createdAt).isBefore(now.minus(recentDays.toLong(), ChronoUnit.DAYS)) }.getOrDefault(false))
    }

    private fun matchesValues(requested: List<String>, actual: List<String>, mode: String): Boolean =
        requested.isEmpty() || if (mode == "all") requested.all { it in actual } else requested.any { it in actual }
}
