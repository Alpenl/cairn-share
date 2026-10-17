package com.alpenl.cairn.share

import android.content.ActivityNotFoundException
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.FailureKind
import com.alpenl.cairn.share.network.RunHistoryClient
import com.alpenl.cairn.share.network.RunHistoryResult
import com.alpenl.cairn.share.network.RunHistorySummary
import com.alpenl.cairn.share.network.SavedRecordKind
import com.alpenl.cairn.share.network.SavedRecordScope
import com.alpenl.cairn.share.network.SavedRecordSummary
import com.alpenl.cairn.share.network.savedPage
import com.alpenl.cairn.share.network.savedRecord
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
internal fun RunHistorySection(linkId: Int, baseUrl: String, token: String, accountGeneration: Long) {
    // A new composition owns each account session and bookmark. Disposed
    // callbacks cannot restart reads or export a previous session's payload.
    key(accountKeyFor(baseUrl, token), accountGeneration, linkId) {
        RunHistoryControls(linkId, baseUrl, token, false)
        RunHistoryControls(linkId, baseUrl, token, true)
    }
}

@Composable
private fun RunHistoryControls(linkId: Int, baseUrl: String, token: String, saved: Boolean) {
    val prefix = if (saved) "saved_history" else "run_history"
    fun tag(name: String) = "${prefix}_$name"
    var sourceScope by remember { mutableStateOf(if (saved) SavedRecordScope(SavedRecordKind.Sources) else null) }
    val scope = rememberCoroutineScope()
    val resolver = LocalContext.current.contentResolver
    val client = remember { RunHistoryClient(baseUrl) }
    var active by remember { mutableStateOf(true) }
    var open by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    var exportJob by remember { mutableStateOf<Job?>(null) }
    var request by remember { mutableStateOf(0L) }
    var after by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }
    var page by remember { mutableStateOf<RunHistoryResult<HistoryDisplayPage>?>(null) }
    var record by remember { mutableStateOf<RunHistoryResult<HistoryDisplayRecord>?>(null) }
    var pendingExport by remember { mutableStateOf<HistoryDisplayRecord?>(null) }
    // Navigation may discard a pending export, but cannot reuse this launcher
    // until its earlier picker result returns. A late URI cannot select a new payload.
    var pickerOutstanding by remember { mutableStateOf(false) }
    var exportStatus by remember { mutableStateOf("") }
    var exporting by remember { mutableStateOf(false) }
    var exportRequest by remember { mutableStateOf(0L) }
    var preview by remember { mutableStateOf(false) }

    fun cancelExport() {
        exportRequest++; exportJob?.cancel(); exportJob = null
        pendingExport = null; exporting = false; exportStatus = ""
    }
    DisposableEffect(Unit) {
        onDispose {
            active = false; request++; job?.cancel(); job = null; cancelExport()
        }
    }
    fun close() {
        open = false; request++; job?.cancel(); job = null; cancelExport()
        busy = false; page = null; record = null
    }
    fun readPage(cursor: String?) {
        if (!active) return
        job?.cancel(); val sent = ++request
        after = cursor; selected = null; record = null; page = null; busy = true; preview = false
        cancelExport()
        job = scope.launch {
            val source = sourceScope
            val result = if (source == null) client.page(linkId, cursor?.toLong(), token).mapHistory {
                HistoryDisplayPage(it.runs.map(::runDisplay), it.nextAfterId?.toString())
            } else client.savedPage(linkId, source, cursor, token).mapHistory {
                HistoryDisplayPage(it.rows.map(::savedDisplay), it.nextAfter)
            }
            if (active && sent == request) { page = result; busy = false; job = null }
        }
    }
    fun readRecord(id: String) {
        if (!active) return
        job?.cancel(); val sent = ++request
        selected = id; record = null; busy = true; preview = false
        cancelExport()
        job = scope.launch {
            val source = sourceScope
            val result = if (source == null) client.record(linkId, id.toLong(), token).mapHistory {
                HistoryDisplayRecord(runDisplay(it.summary), it.exportJson)
            } else client.savedRecord(linkId, source, id, token).mapHistory {
                HistoryDisplayRecord(savedDisplay(it.summary), it.exportJson)
            }
            if (active && sent == request) { record = result; busy = false; job = null }
        }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        pickerOutstanding = false
        val value = pendingExport; pendingExport = null
        if (uri != null && active && open && value != null && selected == value.summary.key &&
            (record as? RunHistoryResult.Loaded)?.value === value) {
            exportJob?.cancel()
            val sent = ++exportRequest
            exporting = true
            exportJob = scope.launch {
                try {
                    withContext(Dispatchers.IO) {
                        if (!active || sent != exportRequest) return@withContext
                        val output = resolver.openOutputStream(uri, "wt") ?: throw IOException("export unavailable")
                        output.bufferedWriter(Charsets.UTF_8).use { it.write(value.exportJson) }
                    }
                    if (active && sent == exportRequest) exportStatus = "已导出所选记录。"
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: IOException) {
                    if (active && sent == exportRequest) exportStatus = "导出失败，请重试。"
                } catch (_: SecurityException) {
                    if (active && sent == exportRequest) exportStatus = "无法写入所选位置，请重新选择。"
                } finally {
                    if (active && sent == exportRequest) { exporting = false; exportJob = null }
                }
            }
        }
    }

    TextButton(onClick = { if (active) { open = true; readPage(null) } }, enabled = token.isNotBlank(),
        modifier = Modifier.testTag(tag("open"))) { Text(if (saved) "查看来源与操作记录" else "查看分类记录") }
    if (!open) return
    AlertDialog(
        modifier = Modifier.testTag(tag("dialog")), onDismissRequest = ::close,
        title = { Text((sourceScope?.kind?.label ?: "分类记录") + (selected?.let { " #$it" } ?: "")) },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("历史记录不代表当前有效标签。查看记录不会重新打标。", style = MaterialTheme.typography.bodySmall)
                if (saved) {
                    Text("仅显示仍保留的记录；缺失不代表未执行，旧记录不会补入当前值。", style = MaterialTheme.typography.bodySmall)
                    for (kind in listOf(SavedRecordKind.Sources, SavedRecordKind.Overrides, SavedRecordKind.Events))
                        TextButton(onClick = { sourceScope = SavedRecordScope(kind); readPage(null) },
                            modifier = Modifier.testTag(tag("kind_${kind.path}"))) { Text(kind.label) }
                    if (sourceScope?.kind == SavedRecordKind.Entities) Text("来源版本 ${sourceScope?.sourceRevision} 的实体回执，按记录标识分页。")
                }
                if (busy) Text("正在读取记录…", Modifier.testTag(tag("loading")))
                else if (selected == null) {
                    val result = page
                    if (result is RunHistoryResult.Loaded) {
                        if (result.value.rows.isEmpty()) Text(if (saved) "没有仍保留的记录；不能据此判断是否执行过。" else "没有已保存的分类记录。", Modifier.testTag(tag("empty")))
                        for (row in result.value.rows) TextButton(onClick = { readRecord(row.key) },
                            modifier = Modifier.testTag(tag("row_${row.key}"))) {
                            Column {
                                Text("#${row.key}")
                                row.fields.firstOrNull()?.let { Text(it.text, style = MaterialTheme.typography.bodySmall) }
                                Text(row.createdAt?.takeIf { it.isNotBlank() } ?: "时间未知", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        result.value.nextAfter?.let { cursor ->
                            TextButton(onClick = { readPage(cursor) }, modifier = Modifier.testTag(tag("more"))) { Text("更多记录") }
                        }
                        if (after != null) TextButton(onClick = { readPage(null) }, modifier = Modifier.testTag(tag("latest"))) { Text("回到首批记录") }
                    } else HistoryReadError(result, prefix, onRetry = { readPage(after) })
                } else {
                    val result = record
                    if (result is RunHistoryResult.Loaded) {
                        val row = result.value.summary
                        for (field in row.fields) Text(field.text, field.tag?.let { Modifier.testTag(tag(it)) } ?: Modifier)
                        if (sourceScope?.kind == SavedRecordKind.Sources) TextButton(onClick = {
                            sourceScope = SavedRecordScope(SavedRecordKind.Entities, row.key.toLong()); readPage(null)
                        }, modifier = Modifier.testTag(tag("source_entities"))) { Text("查看此来源的实体记录") }
                        TextButton(onClick = { preview = !preview }, modifier = Modifier.testTag(tag("preview_toggle"))) { Text(if (preview) "收起原始记录" else "查看原始记录") }
                        if (preview) {
                            if (result.value.exportJson.length > 16_384) Text("仅预览前 16384 字符，完整内容可导出。")
                            Text(result.value.exportJson.take(16_384), Modifier.testTag(tag("preview")), style = MaterialTheme.typography.bodySmall)
                        }
                        TextButton(onClick = {
                            if (active && open && selected == row.key && record === result && !pickerOutstanding && !exporting) {
                                pendingExport = result.value
                                pickerOutstanding = true
                                try {
                                    save.launch(if (saved) "cairn-${sourceScope?.kind?.path}-$linkId.json" else "cairn-classification-$linkId-${row.key}.json")
                                } catch (_: ActivityNotFoundException) {
                                    pendingExport = null; pickerOutstanding = false; exportStatus = "文件选择器不可用。"
                                }
                            }
                        }, enabled = !pickerOutstanding && !exporting, modifier = Modifier.testTag(tag("export"))) { Text("导出所选完整记录") }
                        if (exportStatus.isNotBlank()) Text(exportStatus, Modifier.testTag(tag("export_status")))
                    } else HistoryReadError(result, prefix, onRetry = { selected?.let(::readRecord) })
                }
            }
        },
        confirmButton = { TextButton(onClick = ::close, modifier = Modifier.testTag(tag("close"))) { Text("关闭") } },
        dismissButton = {
            if (selected != null) TextButton(onClick = {
                request++; job?.cancel(); job = null; cancelExport()
                selected = null; record = null; busy = false; preview = false
            }, modifier = Modifier.testTag(tag("back"))) { Text("返回记录列表") }
        },
    )
}

private data class HistoryDisplayField(val text: String, val tag: String? = null)
private data class HistoryDisplayRow(val key: String, val createdAt: String?, val fields: List<HistoryDisplayField>)
private data class HistoryDisplayPage(val rows: List<HistoryDisplayRow>, val nextAfter: String?)
private data class HistoryDisplayRecord(val summary: HistoryDisplayRow, val exportJson: String)
private fun savedDisplay(row: SavedRecordSummary) = HistoryDisplayRow(row.key, row.createdAt, row.fields.map { (field, value) ->
    val label = when (field) {
        "content_revision" -> "来源版本"
        "snapshot_id" -> "快照编号"
        "completeness" -> "完整性"
        "truncated" -> "采集是否截断"
        "state" -> "记录状态"
        "outcome" -> "处理结果"
        "applied" -> "记录处理"
        "field" -> "字段"
        "action" -> "动作"
        "source" -> "决定来源"
        "confirmed" -> "确认情况"
        "revision" -> "个人版本"
        else -> "未知字段"
    }
    val shown = when (field) {
        "state" -> mapOf("not_run" to "未执行", "failed" to "失败", "completed_empty" to "已完成，无实体",
            "completed_nonempty" to "已完成，有实体", "stale" to "已过期")[value]
        "outcome" -> mapOf("stored" to "已保存", "ignored_stale" to "已忽略旧结果")[value]
        "completeness" -> mapOf("complete" to "完整", "partial" to "部分")[value]
        "truncated" -> mapOf("0" to "未截断", "1" to "已截断")[value]
        "applied" -> mapOf("0" to "未处理", "1" to "已处理")[value]
        "confirmed" -> mapOf("0" to "未确认", "1" to "已确认")[value]
        "source" -> mapOf("human" to "人工", "legacy_unknown" to "旧记录，来源不明")[value]
        "field" -> mapOf("entities" to "实体名称", "entity" to "实体名称", "topics" to "主题", "topic" to "主题",
            "resource_types" to "资源类型", "content_functions" to "内容功能", "capabilities" to "能力",
            "carriers" to "载体", "form" to "形式", "use" to "用途")[value]
        "action" -> mapOf("accept" to "保留", "reject" to "排除", "set_empty" to "明确清空", "reset" to "恢复自动",
            "why" to "修改收藏原因", "status" to "修改阅读状态", "note" to "修改备注")[value]
        else -> value
    }
    HistoryDisplayField("$label：${shown ?: "未知"}")
})
private fun runDisplay(row: RunHistorySummary) = HistoryDisplayRow(row.id.toString(), row.createdAt, listOfNotNull(
    HistoryDisplayField("记录状态：${historyStatus(row)}", "status"),
    HistoryDisplayField("实际模型：${row.resolvedModel?.takeIf { it.isNotBlank() } ?: "未知"}", "model"),
    HistoryDisplayField("请求模型：${row.requestedModel?.takeIf { it.isNotBlank() } ?: "未知"}"),
    HistoryDisplayField("来源版本：${row.contentRevision ?: "未知"}"),
    HistoryDisplayField("回答完整性：${historyCoverage(row.coverage)}；证据完整性：${historyCoverage(row.evidenceCoverage)}"),
    if (row.archived == true) HistoryDisplayField("已从归档读取原始记录。") else null,
))
private fun <T, U> RunHistoryResult<T>.mapHistory(transform: (T) -> U): RunHistoryResult<U> = when (this) {
    is RunHistoryResult.Loaded -> RunHistoryResult.Loaded(transform(value))
    is RunHistoryResult.Failed -> RunHistoryResult.Failed(kind)
    RunHistoryResult.Unsupported -> RunHistoryResult.Unsupported
    RunHistoryResult.Unavailable -> RunHistoryResult.Unavailable
}

private fun historyStatus(row: RunHistorySummary): String = when (row.status) {
    "succeeded" -> "已完成"
    "partial" -> "部分完成"
    "failed" -> "失败"
    "expired" -> "已过保留期"
    else -> "状态未知"
}
private fun historyCoverage(value: String?): String = when (value) {
    "complete" -> "完整"
    "partial" -> "部分"
    else -> "未知"
}

@Composable
private fun HistoryReadError(result: RunHistoryResult<*>?, prefix: String, onRetry: () -> Unit) {
    Text(when (result) {
        RunHistoryResult.Unsupported -> "当前服务不支持这类完整历史记录。"
        RunHistoryResult.Unavailable -> "所选记录已不可用，不会用其他记录替代。"
        is RunHistoryResult.Failed -> when (result.kind) {
            FailureKind.Unauthorized -> "访问凭据无效，请检查设置。"
            FailureKind.Network -> "网络不可用，请重试。"
            FailureKind.Timeout -> "读取超时，请重试。"
            FailureKind.Server -> "读取失败，请重试。"
        }
        else -> "记录不可用。"
    }, Modifier.testTag("${prefix}_error"))
    if (result is RunHistoryResult.Failed) TextButton(onClick = onRetry, modifier = Modifier.testTag("${prefix}_retry")) { Text("重试") }
}
