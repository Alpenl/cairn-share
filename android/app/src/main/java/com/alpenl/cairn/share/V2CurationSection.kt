package com.alpenl.cairn.share

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.AlertDialog
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import com.alpenl.cairn.share.network.QueuedCurationAction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
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
import com.alpenl.cairn.share.network.SelectionFieldState

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
        val effective = draft ?: selection
        if (effective == null) {
            Text("正在读取整理结果…", modifier = Modifier.testTag("v2_selection_loading"))
            return@Column
        }
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
        DimensionRow("主题", "topics", taxonomy.topics.map { it.id to it.label }, effective.topics, busy, onAction, known = "topics" !in effective.unknownResetFields, state = effective.state?.fields?.get("topics"), pending = "topics" in effective.pendingFields)
        DimensionRow("内容功能", "content_functions", taxonomy.contentFunctions.map { it.id to it.label }, effective.contentFunctions, busy, onAction, known = "content_functions" !in effective.unknownResetFields, state = effective.state?.fields?.get("content_functions"), pending = "content_functions" in effective.pendingFields)
        DimensionRow("载体", "carriers", taxonomy.carriers.map { it.id to it.label }, effective.carriers, busy, onAction, singleValue = true, known = "carriers" !in effective.unknownResetFields, state = effective.state?.fields?.get("carriers"), pending = "carriers" in effective.pendingFields)
        DimensionRow("潜在用途", "affordances", taxonomy.affordances.map { it.id to it.label }, effective.affordances, busy, onAction, known = "affordances" !in effective.unknownResetFields, state = effective.state?.fields?.get("affordances"), pending = "affordances" in effective.pendingFields)
        Text("潜在用途描述内容可以用来做什么，不代表你的收藏意图。", style = MaterialTheme.typography.bodySmall)
        DimensionRow("形态", "form", taxonomy.forms.map { it.id to it.label }, listOf(effective.form).filter { it.isNotEmpty() }, busy, onAction,
            singleValue = true, state = effective.state?.fields?.get("form"), pending = "form" in effective.pendingFields, known = "form" !in effective.unknownResetFields)
        DimensionRow("用途", "use", taxonomy.uses.map { it.id to it.label }, listOf(effective.use).filter { it.isNotEmpty() }, busy, onAction,
            singleValue = true, state = effective.state?.fields?.get("use"), pending = "use" in effective.pendingFields, known = "use" !in effective.unknownResetFields)
        val entities = effective.state?.entities
        Text("实体：${entities?.label ?: "运行状态未知"}", modifier = Modifier.testTag("v2_entities_status"), style = MaterialTheme.typography.bodySmall)
        entities?.values?.forEach { Text("${it.term} · ${it.label}", style = MaterialTheme.typography.bodySmall) }
        if (effective.state?.evidencePartial == true) Text("来源证据不完整，建议仅基于已取得的内容。", modifier = Modifier.testTag("v2_evidence_partial"), style = MaterialTheme.typography.bodySmall)
        if (effective.state?.answersPartial == true) Text("部分分类问题尚无结果。", style = MaterialTheme.typography.bodySmall)
        Row {
            TextButton(onClick = onExport, modifier = Modifier.testTag("v2_export")) { Text("复制多维整理") }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DimensionRow(
    label: String,
    field: String,
    terms: List<Pair<String, String>>,
    selected: List<String>,
    busy: Boolean,
    onAction: (String, String, String) -> Unit,
    singleValue: Boolean = false,
    known: Boolean = true,
    state: SelectionFieldState? = null,
    pending: Boolean = false,
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
        if (!known) {
            Text("恢复自动：等待服务端确认", style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.testTag("v2_${field}_reset_pending"))
            return@Column
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
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
        Text(if (pending) "本地修改，待同步" else "自动判断：${state?.label ?: "运行状态未知"}",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("v2_${field}_status"))
        if (!pending) {
            var expanded by remember(field, selected) { mutableStateOf(false) }
            val visible = if (field == "topics" && !expanded) selected.take(3) else selected
            for (term in visible) {
                val termLabel = terms.firstOrNull { it.first == term }?.second ?: term
                val origin = state?.values?.firstOrNull { it.term == term }?.label ?: "来源未知"
                Text("$termLabel · $origin", style = MaterialTheme.typography.bodySmall)
            }
            if (field == "topics" && selected.size > 3) TextButton(onClick = { expanded = !expanded }) {
                Text(if (expanded) "收起主题" else "展开其余 ${selected.size - 3} 个主题")
            }
            if (selected.isEmpty()) Text(state?.emptyOrigin?.let { "明确留空 · ${it.label}" } ?: "当前没有有效值",
                style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 2.dp))
        }
        val candidates = state?.candidates.orEmpty()
        if (candidates.isNotEmpty()) {
            var showCandidates by remember(field) { mutableStateOf(false) }
            TextButton(onClick = { showCandidates = !showCandidates }, modifier = Modifier.testTag("v2_${field}_candidates")) {
                Text(if (showCandidates) "收起判断记录" else "查看判断记录（${candidates.size}）")
            }
            if (showCandidates) {
                Text("概率是模型判断，不是准确率；以下为已保存的策略结果。", style = MaterialTheme.typography.bodySmall)
                for (candidate in candidates) {
                    val termLabel = if (candidate.term == "none") "无适用项" else terms.firstOrNull { it.first == candidate.term }?.second ?: candidate.term
                    val verdict = when (candidate.verdict) { "accepted" -> "接受"; "rejected" -> "拒绝"; else -> "暂不判断" }
                    Text("$termLabel · $verdict${candidate.probability?.let { " · ${kotlin.math.round(it * 100).toInt()}%" }.orEmpty()}",
                        style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

/** Old suffix identities are displayed for explicit recovery, never auto-bound. */
@Composable
internal fun LegacyCurationRecoveryNotice(
    linkId: Int,
    accountIdentity: String,
    actions: List<QueuedCurationAction>,
    onRecover: () -> Unit,
) {
    // Consent belongs to this mounted account view. LazyColumn's saveable state
    // can restore an old open dialog after the account temporarily removes it.
    var confirming by remember(linkId, accountIdentity) { mutableStateOf(false) }
    Column(Modifier.testTag("v2_legacy_queue")) {
        Text("发现 ${actions.size} 条旧版离线修改，尚未确认账号归属。")
        TextButton(onClick = { confirming = true }, modifier = Modifier.testTag("v2_legacy_review")) {
            Text("查看并恢复")
        }
    }
    if (confirming) AlertDialog(
        onDismissRequest = { confirming = false },
        title = { Text("恢复这条收藏的旧版修改") },
        text = {
            Column(Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState())) {
                Text("请确认以下修改属于当前账号和这条收藏。旧版记录无法自动确认归属；恢复后，版本冲突仍需你处理。")
                for (action in actions) {
                    val field = when (action.field) {
                        "topics" -> "主题"
                        "content_functions" -> "内容功能"
                        "carriers" -> "载体"
                        "affordances" -> "潜在用途"
                        "form" -> "形态"
                        "use" -> "用途"
                        else -> action.field
                    }
                    val verb = when (action.action) {
                        "accept" -> "选择"
                        "reject" -> "移除"
                        "set_empty" -> "都不适用"
                        "reset" -> "恢复自动"
                        else -> action.action
                    }
                    Text("$field：$verb ${action.term}")
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { confirming = false; onRecover() }, modifier = Modifier.testTag("v2_legacy_confirm")) {
                Text("确认归属并恢复")
            }
        },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text("暂不恢复") } },
    )
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
): String {
    val label = { dimension: String, id: String ->
        val terms = when (dimension) {
            "topics" -> taxonomy?.topics
            "content_functions" -> taxonomy?.contentFunctions
            "carriers" -> taxonomy?.carriers
            "affordances" -> taxonomy?.affordances
            "form", "forms" -> taxonomy?.forms
            "use", "uses" -> taxonomy?.uses
            else -> null
        }
        terms?.firstOrNull { it.id == id }?.label ?: id
    }
    fun rendered(field: String, values: List<String>): String =
        if (field in selection?.unknownResetFields.orEmpty()) "（恢复自动，待服务端确认）"
        else values.joinToString(" / ") { term ->
            val origin = if (field in selection?.pendingFields.orEmpty()) "本地修改，待同步"
                else selection?.state?.fields?.get(field)?.values?.firstOrNull { it.term == term }?.label ?: "来源未知"
            "${label(field, term)}（$origin）"
        }.ifEmpty {
            if (field in selection?.pendingFields.orEmpty()) "本地留空，待同步"
            else selection?.state?.fields?.get(field)?.emptyOrigin?.let { "明确留空 · ${it.label}" } ?: "当前没有有效值"
        }
    val enrichment = link.enrichment
    val builder = StringBuilder()
    builder.appendLine("## ${enrichment?.aiTitle?.takeIf { it.isNotBlank() } ?: link.url}")
    builder.appendLine()
    builder.appendLine("- 链接：${link.url}")
    if (selection != null) {
        builder.appendLine("- 主题：${rendered("topics", selection.topics)}")
        builder.appendLine("- 内容功能：${rendered("content_functions", selection.contentFunctions)}")
        builder.appendLine("- 载体：${rendered("carriers", selection.carriers)}")
        builder.appendLine("- 潜在用途：${rendered("affordances", selection.affordances)}")
        builder.appendLine("- 形态：${rendered("form", listOf(selection.form).filter { it.isNotEmpty() })}")
        builder.appendLine("- 用途：${rendered("use", listOf(selection.use).filter { it.isNotEmpty() })}")
        val fieldNames = mapOf("topics" to "主题", "content_functions" to "内容功能", "carriers" to "载体", "affordances" to "潜在用途", "form" to "形态", "use" to "用途")
        for ((field, name) in fieldNames) builder.appendLine("- $name 自动判断：${selection.state?.fields?.get(field)?.label ?: "运行状态未知"}")
        if (selection.state?.evidencePartial == true) builder.appendLine("- 来源证据：不完整")
        if (selection.state?.answersPartial == true) builder.appendLine("- 分类覆盖：部分问题尚无结果")
    }
    enrichment?.why?.takeIf { it.isNotBlank() }?.let { builder.appendLine("- 收藏原因：$it") }
    builder.appendLine("- 整理状态：${enrichment?.curationStatus?.label ?: ""}")
    val entities = selection?.state?.entities
    builder.appendLine("- 实体状态：${entities?.label ?: "运行状态未知"}")
    if (!entities?.values.isNullOrEmpty()) builder.appendLine("- 实体：${entities!!.values.joinToString(" / ") { "${it.term}（${it.label}）" }}")
    enrichment?.summary?.takeIf { it.isNotBlank() }?.let {
        builder.appendLine()
        builder.appendLine("### 摘要")
        builder.appendLine()
        builder.appendLine(it)
    }
    return builder.toString()
}
