package com.alpenl.cairn.share

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
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
internal fun ReaderTagChips(tags: List<ReaderTag>, onFilter: (ReaderTag) -> Unit, modifier: Modifier = Modifier, compact: Boolean = false) {
    var expanded by remember(tags) { mutableStateOf(false) }
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (tag in if (expanded) tags else tags.take(5)) ReaderTagPill(
            label = tag.label, description = "按“${tag.label}”筛选收藏", compact = compact,
            modifier = Modifier.testTag("tag_filter_${tag.ref}"), onClick = { onFilter(tag) },
        )
        if (tags.size > 5) ReaderTagPill(
            label = if (expanded) "收起" else "+${tags.size - 5}",
            description = if (expanded) "收起更多标签" else "展开其余 ${tags.size - 5} 个标签", compact = compact,
            onClick = { expanded = !expanded },
        )
    }
}

@Composable
private fun ReaderTagPill(label: String, description: String, compact: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    // The visual pill stays quiet; its entire 48 dp cell remains touchable.
    Box(modifier.heightIn(min = 48.dp).widthIn(min = 48.dp)
        .clickable(role = Role.Button, onClickLabel = description, onClick = onClick)
        .semantics(mergeDescendants = true) { contentDescription = description }, contentAlignment = Alignment.Center) {
        Surface(shape = RoundedCornerShape(5.dp), color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
            contentColor = MaterialTheme.colorScheme.onSurfaceVariant) {
            Text(label, style = if (compact) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(horizontal = if (compact) 7.dp else 9.dp, vertical = 3.dp))
        }
    }
}

@Composable
internal fun QuietFilterTag(label: String, selected: Boolean, onClick: () -> Unit,
    modifier: Modifier = Modifier, enabled: Boolean = true) {
    val foreground = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
    Box(modifier.heightIn(min = 48.dp).widthIn(min = 48.dp)
        .selectable(selected = selected, enabled = enabled, role = Role.Checkbox, onClick = onClick),
        contentAlignment = Alignment.CenterStart) {
        Surface(shape = RoundedCornerShape(5.dp),
            color = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.08f)
                else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
            contentColor = foreground.copy(alpha = if (enabled) 1f else 0.5f)) {
            Row(Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                if (selected) Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(13.dp))
                Text(label, style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TopicNavigation(filters: BookmarkFilters, terms: List<TaxonomyTerm>, baseUrl: String, apiToken: String,
    query: String, learned: String, onChange: (BookmarkFilters) -> Unit) {
    val account = accountKeyFor(baseUrl, apiToken)
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val preferences = remember(context) { context.getSharedPreferences("topic-navigation", Context.MODE_PRIVATE) }
    var pinned by remember(account) { mutableStateOf(preferences.getStringSet("pins:$account", emptySet()).orEmpty().toSet()) }
    var search by rememberSaveable(account) { mutableStateOf("") }
    var searchFocused by remember(account) { mutableStateOf(false) }
    var all by rememberSaveable(account) { mutableStateOf(false) }
    var managingPins by rememberSaveable(account) { mutableStateOf(false) }
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
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("主题", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = { managingPins = !managingPins }, modifier = Modifier.testTag("manage_topic_pins")
                .semantics { stateDescription = if (managingPins) "正在管理常用主题" else "管理已关闭" }) {
                Text(if (managingPins) "完成管理" else "管理常用")
            }
        }
        if (managingPins) Text("固定常用入口，不改变筛选条件", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        BasicTextField(search, { search = it }, singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }, onDone = { focus.clearFocus() }),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("topic_search")
                .onFocusChanged { searchFocused = it.isFocused }
                .semantics { contentDescription = "查找全部主题" },
            decorationBox = { input ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp))
                    Box(Modifier.weight(1f)) {
                        if (search.isEmpty()) Text("查找全部主题", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        input()
                    }
                }
            })
        HorizontalDivider(thickness = 1.dp,
            color = if (searchFocused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant)
        val sections = topicSections(terms, current, pinned, counts, search, all || managingPins)
        for (section in sections) {
            if (sections.size > 1 || section.id !in setOf("navigation", "all")) Text(section.label,
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (term in section.terms) {
                    val refine = term.id in refinements || current.isNotEmpty() && term.granularity == "specific" && term.id !in selected
                    if (managingPins) {
                        QuietFilterTag(label = term.label, selected = term.id in pinned, onClick = {
                            focus.clearFocus(); keyboard?.hide()
                            pinned = if (term.id in pinned) pinned - term.id else pinned + term.id
                            preferences.edit().putStringSet("pins:$account", pinned).apply()
                        }, enabled = term.active && !term.deprecated || term.id in pinned,
                            modifier = Modifier.testTag("pin_topic_${term.id}").semantics {
                                contentDescription = (if (term.id in pinned) "取消固定" else "固定") + term.label
                            })
                    } else {
                        QuietFilterTag(label = term.label + (if (!term.active || term.deprecated) "（已停用）" else "") + (counts[term.id]?.let { " $it" } ?: ""),
                            selected = term.id in current, onClick = {
                            focus.clearFocus(); keyboard?.hide()
                            if (refine) onChange(filters.copy(topicRefinements = if (term.id in refinements) filters.topicRefinements - term.id else filters.topicRefinements + term.id))
                            else onChange(filters.copy(topic = "", topics = if (term.id in selected) selected.toList() - term.id else selected.toList() + term.id))
                        },
                            modifier = Modifier.testTag("filter_${if (refine) "topic_refinements" else "topics"}_${term.id}"))
                    }
                }
            }
        }
        for (id in current.filter { id -> terms.none { it.id == id } }) QuietFilterTag("$id（词表不可用）", true, onClick = {
            focus.clearFocus(); keyboard?.hide()
            if (id in refinements) onChange(filters.copy(topicRefinements = filters.topicRefinements - id))
            else onChange(filters.copy(topic = "", topics = selected.toList() - id))
        })
        if (sections.all { it.terms.isEmpty() }) Text("没有匹配的主题", style = MaterialTheme.typography.bodySmall)
        if (countsError) Text("具体主题暂时无法读取，仍可查找全部主题。", style = MaterialTheme.typography.bodySmall)
        if (!managingPins) TextButton(onClick = { all = !all }) { Text(if (all) "收起全部主题" else "浏览全部主题") }
    }
}
