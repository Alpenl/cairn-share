package com.alpenl.cairn.share

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.BookmarkTaxonomy
import com.alpenl.cairn.share.network.MultidimensionalSelection
import com.alpenl.cairn.share.network.SavedLink

/**
 * The multidimensional curation section (B07).
 *
 * It renders the effective view the server derived, plus a local draft while an
 * action is in flight or queued offline. A CAS conflict keeps the draft and
 * requires an explicit re-apply; a network failure queues the action instead of
 * dropping it.
 */
@Composable
internal fun MultidimensionalCurationSection(
    linkId: Int,
    taxonomy: BookmarkTaxonomy?,
    selection: MultidimensionalSelection?,
    draft: MultidimensionalSelection?,
    conflictRevision: Long?,
    busy: Boolean,
    queuedCount: Int,
    available: Boolean,
    onLoadTaxonomy: () -> Unit,
    onAction: (field: String, term: String, action: String) -> Unit,
    onReapply: () -> Unit,
    onDiscard: () -> Unit,
    onFlush: () -> Unit,
    onExport: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().testTag("v2_section"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("多维整理（v2）", style = MaterialTheme.typography.titleMedium)
            if (queuedCount > 0) {
                TextButton(onClick = onFlush, modifier = Modifier.testTag("v2_flush")) {
                    Text("离线待同步 $queuedCount 条，点击同步")
                }
            }
        }
        if (!available) {
            Text("后端不支持多维整理，已安全降级为只读。", style = MaterialTheme.typography.bodySmall)
            return@Column
        }
        if (taxonomy == null) {
            TextButton(onClick = onLoadTaxonomy) { Text("加载多维词表") }
            return@Column
        }
        val effective = draft ?: selection ?: MultidimensionalSelection(available = true)
        if (conflictRevision != null) {
            Column(Modifier.fillMaxWidth().testTag("v2_conflict")) {
                Text(
                    "这条整理已被其他客户端更新（服务端版本 $conflictRevision）。草稿已保留。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                Row {
                    TextButton(onClick = onReapply, modifier = Modifier.testTag("v2_conflict_reapply")) { Text("重新应用") }
                    TextButton(onClick = onDiscard, modifier = Modifier.testTag("v2_conflict_discard")) { Text("放弃修改") }
                }
            }
        }
        DimensionRow("主题", "topics", taxonomy.topics.map { it.id to it.label }, effective.topics, busy, onAction)
        DimensionRow("内容功能", "content_functions", taxonomy.contentFunctions.map { it.id to it.label }, effective.contentFunctions, busy, onAction)
        DimensionRow("载体", "carriers", taxonomy.carriers.map { it.id to it.label }, effective.carriers, busy, onAction, singleValue = true)
        DimensionRow("潜在用途", "affordances", taxonomy.affordances.map { it.id to it.label }, effective.affordances, busy, onAction)
        Row {
            TextButton(onClick = onExport, modifier = Modifier.testTag("v2_export")) { Text("复制多维整理") }
        }
    }
}

@Composable
private fun DimensionRow(
    label: String,
    field: String,
    terms: List<Pair<String, String>>,
    selected: List<String>,
    busy: Boolean,
    onAction: (String, String, String) -> Unit,
    singleValue: Boolean = false,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = MaterialTheme.typography.labelLarge)
            Row {
                TextButton(
                    onClick = { onAction(field, "", "set_empty") },
                    enabled = !busy,
                    modifier = Modifier.testTag("v2_${field}_empty"),
                ) { Text("都不适用") }
                TextButton(
                    onClick = { onAction(field, "", "reset") },
                    enabled = !busy,
                    modifier = Modifier.testTag("v2_${field}_reset"),
                ) { Text("恢复自动") }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((id, termLabel) in terms) {
                val isSelected = selected.contains(id)
                AssistChip(
                    onClick = {
                        // Tapping a selected tag rejects it; tapping an
                        // unselected one accepts it. A single-valued dimension
                        // replaces instead of accumulating.
                        if (isSelected) onAction(field, id, "reject")
                        else if (singleValue) onAction(field, id, "accept")
                        else onAction(field, id, "accept")
                    },
                    enabled = !busy,
                    label = { Text(if (isSelected) "$termLabel ×" else termLabel) },
                    colors = AssistChipDefaults.assistChipColors(),
                    modifier = Modifier.testTag("v2_${field}_chip_$id"),
                )
            }
        }
        if (selected.isEmpty()) {
            Text("（空）", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 2.dp))
        }
    }
}

/**
 * Builds the Markdown export for one link. It carries every effective v2
 * dimension, the why/source and the human origin so a share never loses the
 * folded tags or the provenance (B07-T07).
 */
internal fun v2ExportMarkdown(
    link: SavedLink,
    selection: MultidimensionalSelection?,
    taxonomy: BookmarkTaxonomy?,
    entityState: String?,
): String {
    val label = { dimension: String, id: String ->
        val terms = when (dimension) {
            "topics" -> taxonomy?.topics
            "content_functions" -> taxonomy?.contentFunctions
            "carriers" -> taxonomy?.carriers
            "affordances" -> taxonomy?.affordances
            "forms" -> taxonomy?.forms
            "uses" -> taxonomy?.uses
            else -> null
        }
        terms?.firstOrNull { it.id == id }?.label ?: id
    }
    val enrichment = link.enrichment
    val builder = StringBuilder()
    builder.appendLine("## ${enrichment?.aiTitle?.takeIf { it.isNotBlank() } ?: link.url}")
    builder.appendLine()
    builder.appendLine("- 链接：${link.url}")
    if (selection != null) {
        builder.appendLine("- 主题：${selection.topics.joinToString(" / ") { label("topics", it) }.ifEmpty { "（空）" }}")
        builder.appendLine("- 内容功能：${selection.contentFunctions.joinToString(" / ") { label("content_functions", it) }.ifEmpty { "（空）" }}")
        builder.appendLine("- 载体：${selection.carriers.joinToString(" / ") { label("carriers", it) }.ifEmpty { "（空）" }}")
        builder.appendLine("- 潜在用途：${selection.affordances.joinToString(" / ") { label("affordances", it) }.ifEmpty { "（空）" }}")
        builder.appendLine("- v1 形态/用途：${label("forms", selection.form)} / ${label("uses", selection.use)}")
    }
    enrichment?.why?.takeIf { it.isNotBlank() }?.let { builder.appendLine("- 收藏原因：$it") }
    builder.appendLine("- 整理状态：${enrichment?.curationStatus?.label ?: ""}")
    entityState?.takeIf { it.isNotBlank() }?.let { builder.appendLine("- 实体状态：$it") }
    val entities = enrichment?.classification?.entities ?: emptyList()
    if (entities.isNotEmpty()) {
        builder.appendLine("- 实体：${entities.joinToString(" / ")}")
    }
    enrichment?.summary?.takeIf { it.isNotBlank() }?.let {
        builder.appendLine()
        builder.appendLine("### 摘要")
        builder.appendLine()
        builder.appendLine(it)
    }
    return builder.toString()
}
