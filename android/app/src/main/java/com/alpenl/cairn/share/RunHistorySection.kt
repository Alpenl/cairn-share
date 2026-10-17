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
import com.alpenl.cairn.share.network.RunHistoryPage
import com.alpenl.cairn.share.network.RunHistoryRecord
import com.alpenl.cairn.share.network.RunHistoryResult
import com.alpenl.cairn.share.network.RunHistorySummary
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
        RunHistoryControls(linkId, baseUrl, token)
    }
}

@Composable
private fun RunHistoryControls(linkId: Int, baseUrl: String, token: String) {
    val scope = rememberCoroutineScope()
    val resolver = LocalContext.current.contentResolver
    val client = remember { RunHistoryClient(baseUrl) }
    var active by remember { mutableStateOf(true) }
    var open by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    var exportJob by remember { mutableStateOf<Job?>(null) }
    var request by remember { mutableStateOf(0L) }
    var after by remember { mutableStateOf<Long?>(null) }
    var selected by remember { mutableStateOf<Long?>(null) }
    var page by remember { mutableStateOf<RunHistoryResult<RunHistoryPage>?>(null) }
    var record by remember { mutableStateOf<RunHistoryResult<RunHistoryRecord>?>(null) }
    var pendingExport by remember { mutableStateOf<RunHistoryRecord?>(null) }
    var exportStatus by remember { mutableStateOf("") }
    var exporting by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose {
            active = false; request++; job?.cancel(); exportJob?.cancel(); pendingExport = null
        }
    }
    fun close() {
        open = false; request++; job?.cancel(); exportJob?.cancel()
        busy = false; page = null; record = null; pendingExport = null; exportStatus = ""
    }
    fun readPage(cursor: Long?) {
        if (!active) return
        job?.cancel(); val sent = ++request
        after = cursor; selected = null; record = null; page = null; busy = true; preview = false; pendingExport = null
        exportJob?.cancel()
        job = scope.launch {
            val result = client.page(linkId, cursor, token)
            if (active && sent == request) { page = result; busy = false }
        }
    }
    fun readRecord(id: Long) {
        if (!active) return
        job?.cancel(); val sent = ++request
        selected = id; record = null; busy = true; preview = false; exportStatus = ""; pendingExport = null
        exportJob?.cancel()
        job = scope.launch {
            val result = client.record(linkId, id, token)
            if (active && sent == request) { record = result; busy = false }
        }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val value = pendingExport; pendingExport = null
        if (uri != null && active && open && value != null && selected == value.summary.id &&
            (record as? RunHistoryResult.Loaded)?.value === value) {
            exportJob?.cancel()
            exporting = true
            exportJob = scope.launch {
                try {
                    withContext(Dispatchers.IO) {
                        if (!active) return@withContext
                        val output = resolver.openOutputStream(uri, "wt") ?: throw IOException("export unavailable")
                        output.bufferedWriter(Charsets.UTF_8).use { it.write(value.exportJson) }
                    }
                    if (active) exportStatus = "已导出所选记录。"
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: IOException) {
                    if (active) exportStatus = "导出失败，请重试。"
                } catch (_: SecurityException) {
                    if (active) exportStatus = "无法写入所选位置，请重新选择。"
                } finally {
                    if (active) exporting = false
                }
            }
        }
    }

    TextButton(onClick = { if (active) { open = true; readPage(null) } }, enabled = token.isNotBlank(),
        modifier = Modifier.testTag("run_history_open")) { Text("查看分类记录") }
    if (!open) return
    AlertDialog(
        modifier = Modifier.testTag("run_history_dialog"), onDismissRequest = ::close,
        title = { Text(if (selected == null) "分类记录" else "分类记录 #$selected") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("历史记录不代表当前有效标签。查看记录不会重新打标。", style = MaterialTheme.typography.bodySmall)
                if (busy) Text("正在读取记录…", Modifier.testTag("run_history_loading"))
                else if (selected == null) {
                    val result = page
                    if (result is RunHistoryResult.Loaded) {
                        if (result.value.runs.isEmpty()) Text("没有已保存的分类记录。", Modifier.testTag("run_history_empty"))
                        for (row in result.value.runs) TextButton(onClick = { readRecord(row.id) },
                            modifier = Modifier.testTag("run_history_row_${row.id}")) {
                            Column {
                                Text("#${row.id} · ${historyStatus(row)}")
                                Text(row.createdAt?.takeIf { it.isNotBlank() } ?: "时间未知", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        result.value.nextAfterId?.let { cursor ->
                            TextButton(onClick = { readPage(cursor) }, modifier = Modifier.testTag("run_history_more")) { Text("更早的记录") }
                        }
                        if (after != null) TextButton(onClick = { readPage(null) }, modifier = Modifier.testTag("run_history_latest")) { Text("回到最新记录") }
                    } else HistoryReadError(result, onRetry = { readPage(after) })
                } else {
                    val result = record
                    if (result is RunHistoryResult.Loaded) {
                        val row = result.value.summary
                        Text("记录状态：${historyStatus(row)}", Modifier.testTag("run_history_status"))
                        Text("实际模型：${row.resolvedModel?.takeIf { it.isNotBlank() } ?: "未知"}", Modifier.testTag("run_history_model"))
                        Text("请求模型：${row.requestedModel?.takeIf { it.isNotBlank() } ?: "未知"}")
                        Text("来源版本：${row.contentRevision ?: "未知"}")
                        Text("回答完整性：${historyCoverage(row.coverage)}；证据完整性：${historyCoverage(row.evidenceCoverage)}")
                        if (row.archived == true) Text("已从归档读取原始记录。")
                        TextButton(onClick = { preview = !preview }, modifier = Modifier.testTag("run_history_preview_toggle")) { Text(if (preview) "收起原始记录" else "查看原始记录") }
                        if (preview) {
                            if (result.value.exportJson.length > 16_384) Text("仅预览前 16384 字符，完整内容可导出。")
                            Text(result.value.exportJson.take(16_384), Modifier.testTag("run_history_preview"), style = MaterialTheme.typography.bodySmall)
                        }
                        TextButton(onClick = {
                            if (active && open && selected == row.id && record === result && pendingExport == null && !exporting) {
                                pendingExport = result.value
                                try {
                                    save.launch("cairn-classification-$linkId-${row.id}.json")
                                } catch (_: ActivityNotFoundException) {
                                    pendingExport = null; exportStatus = "文件选择器不可用。"
                                }
                            }
                        }, enabled = pendingExport == null && !exporting, modifier = Modifier.testTag("run_history_export")) { Text("导出所选完整记录") }
                        if (exportStatus.isNotBlank()) Text(exportStatus, Modifier.testTag("run_history_export_status"))
                    } else HistoryReadError(result, onRetry = { selected?.let(::readRecord) })
                }
            }
        },
        confirmButton = { TextButton(onClick = ::close, modifier = Modifier.testTag("run_history_close")) { Text("关闭") } },
        dismissButton = {
            if (selected != null) TextButton(onClick = {
                request++; job?.cancel(); exportJob?.cancel(); pendingExport = null
                selected = null; record = null; busy = false; preview = false
            }, modifier = Modifier.testTag("run_history_back")) { Text("返回记录列表") }
        },
    )
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
private fun HistoryReadError(result: RunHistoryResult<*>?, onRetry: () -> Unit) {
    Text(when (result) {
        RunHistoryResult.Unsupported -> "当前服务不支持完整分类历史。"
        RunHistoryResult.Unavailable -> "所选记录已不可用，不会用其他记录替代。"
        is RunHistoryResult.Failed -> when (result.kind) {
            FailureKind.Unauthorized -> "访问凭据无效，请检查设置。"
            FailureKind.Network -> "网络不可用，请重试。"
            FailureKind.Timeout -> "读取超时，请重试。"
            FailureKind.Server -> "读取失败，请重试。"
        }
        else -> "记录不可用。"
    }, Modifier.testTag("run_history_error"))
    if (result is RunHistoryResult.Failed) TextButton(onClick = onRetry, modifier = Modifier.testTag("run_history_retry")) { Text("重试") }
}
