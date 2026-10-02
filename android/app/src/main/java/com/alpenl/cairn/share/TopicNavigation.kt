package com.alpenl.cairn.share

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.FilterChip
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.BookmarkFilters
import com.alpenl.cairn.share.network.TaxonomyTerm
import com.alpenl.cairn.share.network.V2CurationClient
import com.alpenl.cairn.share.network.V2Result
import com.alpenl.cairn.share.network.cancellableRead
import java.net.URLEncoder
import java.text.Normalizer
import java.util.Locale
import kotlinx.coroutines.delay

internal fun topicMatches(term: TaxonomyTerm, query: String): Boolean {
    fun normalized(value: String) = Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase(Locale.ROOT)
    val needle = normalized(query.trim())
    return needle.isBlank() || (listOf(term.id, term.label) + term.aliases).any { normalized(it).contains(needle) }
}

internal data class TopicSection(val id: String, val label: String, val terms: List<TaxonomyTerm>)

internal fun topicSections(terms: List<TaxonomyTerm>, selected: Set<String>, pinned: Set<String>, counts: Map<String, Int>,
    query: String = "", all: Boolean = false): List<TopicSection> {
    val choices = terms.filter { it.active && !it.deprecated || it.id in selected }
    if (all || query.isNotBlank()) return listOf(TopicSection("all", "全部主题", choices.filter { topicMatches(it, query) }))
    val fixed = choices.filter { it.id in pinned }
    val navigation = choices.filter { it.navigation && it.id !in pinned }
    val used = (fixed + navigation).map { it.id }.toSet()
    val specific = choices.filter { it.id !in used && it.granularity == "specific" &&
        (it.id in selected || selected.isNotEmpty() && (counts[it.id] ?: 0) > 0) }
    val chosen = choices.filter { it.id in selected && it.id !in used && it !in specific }
    return listOf(TopicSection("pinned", "常用主题", fixed), TopicSection("navigation", "浏览主题", navigation),
        TopicSection("specific", "进一步筛选", specific), TopicSection("selected", "已选主题", chosen)).filter { it.terms.isNotEmpty() }
}

internal fun BookmarkFilters.withTag(tag: ReaderTag): BookmarkFilters {
    val parts = tag.ref.split('/')
    val id = parts.lastOrNull().orEmpty()
    fun List<String>.toggle() = if (id in this) this - id else this + id
    return when {
        parts.size == 3 && parts[0] == "custom" -> copy(customTags = customTags.toggle())
        parts.size != 3 || parts[0] != "system" -> this
        parts[1] == "topics" -> copy(topic = "", topics = (topics + listOf(topic).filter { it.isNotBlank() }).distinct().toggle())
        parts[1] == "resource_kinds" -> copy(resourceKinds = resourceKinds.toggle())
        parts[1] == "content_functions" -> copy(contentFunctions = contentFunctions.toggle())
        else -> this
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ReaderTagChips(tags: List<ReaderTag>, onFilter: (ReaderTag) -> Unit, modifier: Modifier = Modifier) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        for (tag in tags.take(5)) AssistChip(onClick = { onFilter(tag) }, label = { Text(tag.label, style = MaterialTheme.typography.labelSmall) },
            modifier = Modifier.testTag("tag_filter_${tag.ref}"))
        if (tags.size > 5) Text("+${tags.size - 5}", style = MaterialTheme.typography.labelSmall)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TopicNavigation(filters: BookmarkFilters, terms: List<TaxonomyTerm>, baseUrl: String, apiToken: String,
    query: String, learned: String, onChange: (BookmarkFilters) -> Unit) {
    val account = accountKeyFor(baseUrl, apiToken)
    val context = LocalContext.current
    val preferences = remember(context) { context.getSharedPreferences("topic-navigation", Context.MODE_PRIVATE) }
    var pinned by remember(account) { mutableStateOf(preferences.getStringSet("pins:$account", emptySet()).orEmpty().toSet()) }
    var search by rememberSaveable(account) { mutableStateOf("") }
    var all by rememberSaveable(account) { mutableStateOf(false) }
    var counts by remember(account, filters, query, learned) { mutableStateOf(emptyMap<String, Int>()) }
    var countsError by remember(account, filters, query, learned) { mutableStateOf(false) }
    val cache = remember(account) { linkedMapOf<String, Pair<Long, Map<String, Int>>>() }
    val selected = (filters.topics + listOf(filters.topic).filter { it.isNotBlank() }).toSet()
    val refinements = filters.topicRefinements.toSet()
    val current = selected + refinements
    LaunchedEffect(account, filters, query, learned) {
        if (current.isEmpty() || apiToken.isBlank() || baseUrl.isBlank()) return@LaunchedEffect
        val params = filters.parameters().toMutableMap().apply {
            if (query.isNotBlank()) put("q", query)
            if (learned.isNotBlank() && learned != "all") put("learned", learned)
            if (filters.needsEffectiveFilterContract()) put("filter_contract_version", "1")
        }
        val path = "/api/tag-counts?" + params.toSortedMap().map { (key, value) -> "$key=${URLEncoder.encode(value, "UTF-8")}" }.joinToString("&")
        val now = android.os.SystemClock.elapsedRealtime()
        cache[path]?.takeIf { now - it.first < 10_000 }?.let { counts = it.second; return@LaunchedEffect }
        delay(160)
        when (val result = cancellableRead { V2CurationClient(baseUrl).tagRequest(path, "GET", apiToken, cancellation = it) }) {
            is V2Result.Loaded -> {
                val values = result.value.optJSONArray("topics")
                counts = (0 until (values?.length() ?: 0)).associate { index ->
                    val value = values!!.getJSONObject(index); value.getString("id") to value.optInt("count", 0)
                }
                cache[path] = android.os.SystemClock.elapsedRealtime() to counts
                while (cache.size > 12) cache.remove(cache.keys.first())
            }
            else -> countsError = true
        }
    }
    Column(Modifier.fillMaxWidth().testTag("topic_navigation")) {
        OutlinedTextField(search, { search = it }, label = { Text("查找全部主题") }, singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("topic_search"))
        val sections = topicSections(terms, current, pinned, counts, search, all)
        for (section in sections) {
            Text(section.label, style = MaterialTheme.typography.labelMedium)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (term in section.terms) {
                    val refine = term.id in refinements || current.isNotEmpty() && term.granularity == "specific" && term.id !in selected
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        FilterChip(selected = term.id in current, onClick = {
                            if (refine) onChange(filters.copy(topicRefinements = if (term.id in refinements) filters.topicRefinements - term.id else filters.topicRefinements + term.id))
                            else onChange(filters.copy(topic = "", topics = if (term.id in selected) selected.toList() - term.id else selected.toList() + term.id))
                        }, label = { Text(term.label + (counts[term.id]?.let { " $it" } ?: "")) },
                            modifier = Modifier.testTag("filter_${if (refine) "topic_refinements" else "topics"}_${term.id}"))
                        TextButton(onClick = {
                            pinned = if (term.id in pinned) pinned - term.id else pinned + term.id
                            preferences.edit().putStringSet("pins:$account", pinned).apply()
                        }, modifier = Modifier.size(36.dp).testTag("pin_topic_${term.id}").semantics {
                            contentDescription = (if (term.id in pinned) "取消固定" else "固定") + term.label
                        }) { Text(if (term.id in pinned) "★" else "☆") }
                    }
                }
            }
        }
        for (id in current.filter { id -> terms.none { it.id == id } }) FilterChip(true, onClick = {
            if (id in refinements) onChange(filters.copy(topicRefinements = filters.topicRefinements - id))
            else onChange(filters.copy(topic = "", topics = selected.toList() - id))
        }, label = { Text("$id（词表不可用）") })
        if (sections.all { it.terms.isEmpty() }) Text("没有匹配的主题", style = MaterialTheme.typography.bodySmall)
        if (countsError) Text("具体主题暂时无法读取，仍可查找全部主题。", style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { all = !all }) { Text(if (all) "收起全部主题" else "浏览全部主题") }
    }
}
