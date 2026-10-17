package com.alpenl.cairn.share

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.ProcessingAction
import com.alpenl.cairn.share.network.ProcessingIdentity
import com.alpenl.cairn.share.network.ProcessingIntent
import com.alpenl.cairn.share.network.ProcessingStage
import com.alpenl.cairn.share.network.RunHistoryResult
import com.alpenl.cairn.share.network.decodeProcessingIntent
import java.util.UUID
import org.json.JSONObject

@Composable
internal fun ProcessingSection(linkId: Int, accountKey: String, accountGeneration: Long, panel: ProcessingPanelState?,
    onLoad: () -> Unit, onSubmit: (ProcessingIntent) -> Unit, onDiscard: () -> Unit) {
    key(accountKey, accountGeneration, linkId) { ProcessingControls(panel ?: ProcessingPanelState(), onLoad, onSubmit, onDiscard) }
}

@Composable
private fun ProcessingControls(panel: ProcessingPanelState, onLoad: () -> Unit, onSubmit: (ProcessingIntent) -> Unit, onDiscard: () -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    var text by rememberSaveable { mutableStateOf("") }
    var editingFence by rememberSaveable { mutableStateOf<String?>(null) }
    var editingRevision by rememberSaveable { mutableStateOf(0L) }
    var editingGeneration by rememberSaveable { mutableStateOf(0L) }
    var restoredOperation by rememberSaveable { mutableStateOf<String?>(null) }
    var reprepare by rememberSaveable { mutableStateOf(false) }
    var confirming by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmingRecovery by rememberSaveable { mutableStateOf(false) }
    var discarding by rememberSaveable { mutableStateOf(false) }
    var discardRequested by rememberSaveable { mutableStateOf<String?>(null) }
    var localMessage by rememberSaveable { mutableStateOf("") }
    val status = (panel.result as? RunHistoryResult.Loaded)?.value
    val pending = panel.pending
    val busy = panel.loading || panel.saving
    fun adopt(value: ProcessingIdentity) { editingFence = value.fence; editingRevision = value.revision; editingGeneration = value.generation }
    val editing = editingFence?.let { ProcessingIdentity(it, editingRevision, editingGeneration) }?.takeIf { it.valid() }
    LaunchedEffect(open) { if (open) onLoad() }
    LaunchedEffect(pending?.intent?.operationKey, status?.identity) {
        if (pending != null && restoredOperation != pending.intent.operationKey && text.isBlank() && !reprepare) {
            text = pending.intent.text.orEmpty(); adopt(pending.intent.source); restoredOperation = pending.intent.operationKey
        }
        if (editingFence == null && text.isBlank() && status != null) adopt(status.identity)
    }
    LaunchedEffect(pending?.intent?.operationKey, panel.saving, panel.storageReady) {
        if (discardRequested != null && pending != null && pending.intent.operationKey != discardRequested) {
            discardRequested = null
        } else if (discardRequested != null && pending == null && !panel.saving && panel.storageReady) {
            text = ""; editingFence = null; restoredOperation = null; discardRequested = null
            status?.identity?.let(::adopt)
        }
    }
    fun confirm(intent: ProcessingIntent, recovery: Boolean = false) {
        if (!intent.valid()) { localMessage = "正文过大或包含无效字符，请检查后重试。"; return }
        confirming = intent.encode().toString(); confirmingRecovery = recovery; localMessage = ""
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { open = !open }, modifier = Modifier.testTag("processing_toggle")) { Text(if (open) "收起处理状态" else "处理状态") }
        if (open) {
            Text("来源、阅读、分类和人工整理分别记录。已有内容仍保留，打开此面板不会调用模型。", style = MaterialTheme.typography.bodySmall)
            if (busy) Text(if (panel.saving) "正在确认请求…" else "正在核对状态…", modifier = Modifier.testTag("processing_busy"))
            status?.stages?.forEach { ProcessingStageRow(it) }
            if (!busy && status == null) Text(when (panel.result) {
                RunHistoryResult.Unsupported -> "此服务尚未提供安全处理入口，未改用其他接口。"
                RunHistoryResult.Unavailable -> "这篇收藏已不存在。"
                else -> "暂时无法核对处理状态，请刷新后重试。"
            }, modifier = Modifier.testTag("processing_unavailable"))
            if (pending != null && !reprepare) {
                Text(if (pending.rejected == null) "上次请求结果未确认。只核对原请求，不会另建请求。" else "上次请求明确未执行。${processingReason(pending.rejected)}",
                    modifier = Modifier.testTag("processing_pending"))
                if (pending.intent.text != null) OutlinedTextField(value = pending.intent.text, onValueChange = {}, readOnly = true,
                    label = { Text("保留的正文") }, minLines = 3, maxLines = 8, modifier = Modifier.fillMaxWidth().testTag("processing_saved_text"))
                if (text.isNotBlank() && pending.intent.text != text) Text("另有未提交的编辑内容已保留，重新编辑时可继续核对。", style = MaterialTheme.typography.bodySmall)
                if (pending.rejected == null) Button(enabled = !busy && panel.storageReady && status != null,
                    onClick = { confirm(pending.intent, recovery = true) }, modifier = Modifier.testTag("processing_recover")) { Text("核对 / 重试原请求") }
                else {
                    TextButton(enabled = !busy && panel.storageReady && status != null, onClick = {
                        reprepare = true; status?.identity?.let(::adopt)
                    }, modifier = Modifier.testTag("processing_reprepare")) { Text("按当前状态重新编辑") }
                    TextButton(enabled = !busy && panel.storageReady, onClick = { discarding = true }, modifier = Modifier.testTag("processing_discard")) { Text("放弃未执行的请求") }
                }
            } else if (status != null) {
                val changed = editing != null && editing != status.identity
                if (changed) {
                    Text("资料或处理状态已变化，正文已保留。请核对后采用当前状态。", modifier = Modifier.testTag("processing_changed"))
                    TextButton(enabled = !busy && panel.storageReady, onClick = { adopt(status.identity) }, modifier = Modifier.testTag("processing_adopt")) { Text("采用当前处理状态") }
                }
                val primary = status.stages.firstOrNull { it.key == "source" }?.state == "missing_primary" || pending?.intent?.action == ProcessingAction.SavePrimary
                if (primary) OutlinedTextField(value = text, onValueChange = { if (it.length <= 100000) text = it },
                    readOnly = busy || !panel.storageReady, label = { Text("粘贴完整原文") }, minLines = 3, maxLines = 10,
                    modifier = Modifier.fillMaxWidth().testTag("processing_primary_text"))
                val actions = if (pending != null) listOf(pending.intent.action) else
                    (if (primary) listOf(ProcessingAction.SavePrimary) else emptyList()) + listOf(ProcessingAction.RetryReading, ProcessingAction.RetryClassification)
                for (action in actions) {
                    val permission = status.actions[action]
                    Button(enabled = !busy && panel.storageReady && permission?.allowed == true && editing == status.identity &&
                        (action != ProcessingAction.SavePrimary || text.isNotBlank()), onClick = {
                        val source = editing ?: return@Button
                        confirm(ProcessingIntent(UUID.randomUUID().toString(), source, action, if (action == ProcessingAction.SavePrimary) text else null))
                    }, modifier = Modifier.testTag("processing_action_${action.wire}")) { Text(when (action) {
                        ProcessingAction.SavePrimary -> "保存正文并排队处理"
                        ProcessingAction.RetryReading -> "重新排队阅读整理"
                        ProcessingAction.RetryClassification -> "重新排队分类"
                    }) }
                    if (permission?.allowed == false) Text(processingReason(permission.reason), style = MaterialTheme.typography.bodySmall)
                }
            }
            Text("请求本身不调用模型；后续排队的模型处理可能收费。已成功的同一请求只返回原回执。", style = MaterialTheme.typography.bodySmall)
            TextButton(enabled = !busy, onClick = onLoad, modifier = Modifier.testTag("processing_refresh")) { Text("刷新处理状态") }
            if (panel.message.isNotBlank()) Text(panel.message, modifier = Modifier.testTag("processing_message"))
            if (localMessage.isNotBlank()) Text(localMessage)
        }
    }
    if (confirming != null) AlertDialog(onDismissRequest = { confirming = null }, title = { Text(if (confirmingRecovery) "核对原请求" else "确认排队处理") },
        text = { Text(if (confirmingRecovery) "已成功时只返回原回执。若原请求尚未成功，会按原意图排队，后续模型处理可能收费。"
            else "本次保存并排队所选处理阶段，后续模型处理可能收费。已有阅读内容、媒体和人工标签仍保留。") },
        confirmButton = { TextButton(modifier = Modifier.testTag("processing_confirm"), onClick = {
            val intent = runCatching { decodeProcessingIntent(JSONObject(confirming!!)) }.getOrNull()
            confirming = null
            if (intent != null) { reprepare = false; onSubmit(intent) } else localMessage = "无法确认请求内容，请重新核对后提交。"
        }) { Text("确认") } }, dismissButton = { TextButton(onClick = { confirming = null }) { Text("返回") } })
    if (discarding) AlertDialog(onDismissRequest = { discarding = false }, title = { Text("放弃未执行的请求？") },
        text = { Text("仅清理本机已明确拒绝的请求草稿，服务端资料不会改变。结果未确认的请求不能在这里放弃。") },
        confirmButton = { TextButton(modifier = Modifier.testTag("processing_discard_confirm"), onClick = {
            discarding = false; reprepare = false; discardRequested = pending?.intent?.operationKey; onDiscard()
        }) { Text("放弃草稿") } }, dismissButton = { TextButton(onClick = { discarding = false }) { Text("保留") } })
}

/** The four stages share one accessible row; no fixed heights or nested scroll. */
@Composable
private fun ProcessingStageRow(stage: ProcessingStage) {
    val label = when (stage.key) { "source" -> "来源"; "reading" -> "阅读"; "classification" -> "分类"; else -> "人工整理" }
    Column(Modifier.fillMaxWidth().testTag("processing_stage_${stage.key}")) {
        Text("$label · ${processingStateLabel(stage.state)}", style = MaterialTheme.typography.bodyMedium)
        stage.outputState?.let { Text("已存结果：${processingOutputLabel(it)}", style = MaterialTheme.typography.bodySmall) }
        if (stage.key == "human" && stage.events != null && stage.overrides != null)
            Text("${stage.events} 条操作记录 · ${stage.overrides} 条字段决定", style = MaterialTheme.typography.bodySmall)
    }
}
internal fun processingReason(reason: String?): String = when (reason) {
    "state_conflict", "source_conflict" -> "资料或处理状态已更新，请核对后采用当前状态。"
    "provider_result_unknown" -> "上次模型调用尚未核对，暂不重复处理。"
    "processing_busy" -> "该阶段正在处理，请稍后核对。"
    "already_queued" -> "该阶段已在队列中，无需重复提交。"
    "primary_source_required" -> "请先补齐缺失的正文。"
    "primary_already_present" -> "原文已经存在，不能用补录覆盖。"
    "reading_unsupported" -> "此来源暂不支持阅读整理。"
    "excluded_from_processing" -> "这篇收藏已排除，不会自动处理。"
    "manual_queue_full" -> "当前处理队列已满，请稍后再试。"
    "v2_required" -> "服务尚未开通此处理能力。"
    "source_snapshot_unavailable", "source_metadata_unavailable" -> "已有来源记录不完整，需要先核对或重新采集。"
    "operation_conflict" -> "原请求记录不一致，需要先核对上次操作。"
    "invalid_action", "source_limit" -> "内容过大或格式不正确，请检查后重试。"
    "not_found" -> "这篇收藏已不存在。"
    else -> "当前暂不能执行此操作，请重新核对状态。"
}
private fun processingStateLabel(state: String): String = when (state) {
    "available" -> "已保存"; "missing_primary" -> "缺少正文"; "snapshot_unavailable" -> "来源待核对"
    "queued" -> "已排队"; "running" -> "处理中"; "completed" -> "队列已完成"; "failed" -> "处理失败"
    "exhausted" -> "已暂停重试"; "lease_expired" -> "上次处理已超时"; "waiting_source" -> "等待来源"
    "result_unknown" -> "上次结果待核对"; "not_run" -> "尚未执行"; "recorded" -> "有操作记录"
    "no_recorded_action" -> "无可核对的操作记录"; else -> "状态待核对"
}
private fun processingOutputLabel(state: String): String = when (state) {
    "current" -> "与当前来源一致"; "stale" -> "对应较早的来源或规则"; "partial" -> "仅覆盖部分内容"
    "unversioned" -> "历史来源版本未核实"; "absent" -> "无已保存结果"; "failed" -> "未成功完成"; else -> "状态待核对"
}
