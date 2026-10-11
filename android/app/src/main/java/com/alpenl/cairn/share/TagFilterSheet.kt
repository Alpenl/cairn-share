package com.alpenl.cairn.share

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background
import androidx.compose.material.icons.filled.Search
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.BookmarkFilters
import com.alpenl.cairn.share.network.BookmarkTaxonomy
import com.alpenl.cairn.share.network.TaxonomyTerm
import com.alpenl.cairn.share.ui.components.SegmentedToggle
import com.alpenl.cairn.share.ui.components.TagChip
import com.alpenl.cairn.share.ui.components.TagState
import com.alpenl.cairn.share.ui.components.TagTone
import com.alpenl.cairn.share.ui.theme.CairnTheme

/** One chip group of the tag filter: its tone, heading and refs. */
internal data class TagFilterGroup(val title: String, val tone: TagTone, val chips: List<Pair<String, String>>)

/** Groups shown in the sheet, in prototype order: 主题 → 资源类型 → 内容特征 → 个人. */
internal fun tagFilterGroups(taxonomy: BookmarkTaxonomy?, custom: List<PersonalTagDefinition>, selected: List<String>, query: String = ""): List<TagFilterGroup> {
    val q = query.trim().lowercase()
    fun hit(t: TaxonomyTerm) = q.isEmpty() || t.label.lowercase().contains(q) || t.aliases.any { it.lowercase().contains(q) }
    fun system(dimension: String, terms: List<TaxonomyTerm>) = terms
        .filter { (it.active || "system/$dimension/${it.id}" in selected) && hit(it) }
        .sortedBy { if (it.granularity == "broad") 0 else 1 }
        .map { "system/$dimension/${it.id}" to it.label }
    val personal = custom.filter { (it.active || "custom/default/${it.id}" in selected) && (q.isEmpty() || it.label.lowercase().contains(q)) }
        .map { "custom/default/${it.id}" to it.label }
    return listOf(
        TagFilterGroup("主题", TagTone.Topic, system("topics", taxonomy?.topics.orEmpty())),
        TagFilterGroup("资源类型", TagTone.Resource, system("resource_kinds", taxonomy?.resourceKinds.orEmpty())),
        TagFilterGroup("内容特征", TagTone.Feature, system("content_functions", taxonomy?.contentFunctions.orEmpty())),
        TagFilterGroup("个人标签", TagTone.Personal, personal),
    ).filter { it.chips.isNotEmpty() }
}

/**
 * 按标签筛选 (prototype and-filter): every tag type in one sheet, ANY / ALL
 * across them, applied as you tap. 更多条件 keeps source, time and the rest.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun ChipFilterSheet(
    filters: BookmarkFilters,
    taxonomy: BookmarkTaxonomy?,
    customCatalog: List<PersonalTagDefinition>,
    catalogError: Boolean,
    onRetryCatalog: () -> Unit,
    onChange: (BookmarkFilters) -> Unit,
    onDismiss: () -> Unit,
    topicNavigation: @Composable () -> Unit,
    advanced: Boolean,
    onToggleAdvanced: () -> Unit,
    advancedContent: @Composable ColumnScope.() -> Unit,
) {
    val p = CairnTheme.palette
    var query by rememberSaveable { mutableStateOf("") }
    val groups = tagFilterGroups(taxonomy, customCatalog, filters.tags, query)
    val count = filters.tags.distinct().size
    val legacyTopics = filters.topics.isNotEmpty() || filters.topic.isNotBlank() || filters.topicRefinements.isNotEmpty()
    ModalBottomSheet(onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.canvas, tonalElevation = 0.dp,
        shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f).testTag("bookmark_filter_sheet")) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("按标签筛选", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f).semantics { heading() })
                    SegmentedToggle(listOf("all" to "全部满足", "any" to "任一满足"), filters.tagsMode,
                        { onChange(filters.copy(tagsMode = it)) }, modifier = Modifier.testTag("tags_mode"))
                }
                Text(if (filters.tagsMode == "all") "带有全部所选标签的收藏会显示。" else "带有任一所选标签的收藏会显示。",
                    style = MaterialTheme.typography.bodySmall, color = p.muted)
                OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true,
                    placeholder = { Text("搜索标签或别名") },
                    leadingIcon = { Icon(androidx.compose.material.icons.Icons.Default.Search, contentDescription = null, modifier = Modifier.size(18.dp)) },
                    shape = RoundedCornerShape(10.dp),
                    colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = p.hairlineSoft, focusedBorderColor = p.terracotta,
                        unfocusedContainerColor = p.surface, focusedContainerColor = p.surface),
                    modifier = Modifier.fillMaxWidth().testTag("tag_filter_search"))
                if (taxonomy == null) Text("标签词表暂未加载；已选条件保留，也可清除后重试。", style = MaterialTheme.typography.bodySmall, color = p.tertiary)
                if (groups.isEmpty() && taxonomy != null) Text(if (query.isBlank()) "还没有可用的标签。" else "没有匹配「$query」的标签。",
                    style = MaterialTheme.typography.bodySmall, color = p.tertiary)
                for (group in groups) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(com.alpenl.cairn.share.ui.components.tagColor(group.tone)))
                        Text(group.title, style = MaterialTheme.typography.labelMedium, color = p.muted, modifier = Modifier.padding(start = 6.dp))
                        Text(group.chips.size.toString(), style = MaterialTheme.typography.labelSmall, color = p.faint, modifier = Modifier.padding(start = 6.dp))
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((ref, label) in group.chips) {
                            val on = ref in filters.tags
                            TagChip(label, tone = group.tone, state = TagState.Automatic, selected = on,
                                onClick = { onChange(filters.toggleTag(ref)) },
                                modifier = Modifier.testTag("tag_filter_$ref").semantics { stateDescription = if (on) "已选" else "未选" })
                        }
                    }
                }
                if (catalogError) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("个人标签暂时无法读取，已选条件保留。", style = MaterialTheme.typography.bodySmall, color = p.danger, modifier = Modifier.weight(1f))
                    TextButton(onClick = onRetryCatalog) { Text("重试") }
                }
                HorizontalDivider(color = p.hairlineSoft)
                TextButton(onClick = onToggleAdvanced, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("advanced_bookmark_filters")
                    .semantics { stateDescription = if (advanced) "已展开" else "已折叠" }) {
                    Text("更多条件", style = MaterialTheme.typography.labelLarge, color = p.ink)
                    Text("  来源 · 时间 · 处理状态", style = MaterialTheme.typography.labelSmall, color = p.tertiary, modifier = Modifier.weight(1f))
                    Icon(if (advanced) CairnIcons.Down else CairnIcons.Chevron, contentDescription = null, modifier = Modifier.size(14.dp))
                }
                if (advanced) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (legacyTopics) topicNavigation()
                    advancedContent()
                }
            }
            HorizontalDivider(color = p.hairlineSoft)
            Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { onChange(BookmarkFilters()) }, enabled = filters != BookmarkFilters(),
                    modifier = Modifier.heightIn(min = 48.dp).testTag("reset_filter_sheet")) { Text("清除", color = if (filters != BookmarkFilters()) p.ink else p.faint) }
                Text(if (count > 0) "已选 $count 个标签" else "", style = MaterialTheme.typography.labelSmall, color = p.tertiary, modifier = Modifier.weight(1f))
                Button(onClick = onDismiss, shape = RoundedCornerShape(12.dp), elevation = null,
                    modifier = Modifier.heightIn(min = 48.dp).testTag("view_filter_results")) {
                    Text("显示结果", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}
