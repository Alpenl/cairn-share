package com.alpenl.cairn.share

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.ManualMaterialClient
import com.alpenl.cairn.share.network.ManualMaterialIntent
import com.alpenl.cairn.share.network.MaterialOption
import com.alpenl.cairn.share.network.MaterialOptions
import com.alpenl.cairn.share.network.MaterialWriteResult
import com.alpenl.cairn.share.network.RunHistoryResult
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun ManualMaterialSection(linkId: Int, baseUrl: String, token: String, accountGeneration: Long, onSaved: () -> Unit) {
    key(accountKeyFor(baseUrl, token), accountGeneration, linkId) {
        ManualMaterialControls(linkId, baseUrl, token, onSaved)
    }
}

@Composable
private fun ManualMaterialControls(linkId: Int, baseUrl: String, token: String, onSaved: () -> Unit) {
    val context = LocalContext.current
    val store = remember { ManualMaterialStore(context) }
    val client = remember { ManualMaterialClient(baseUrl) }
    val account = remember { accountKeyFor(baseUrl, token) }
    val scope = rememberCoroutineScope()
    var active by remember { mutableStateOf(true) }
    var open by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var readable by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<RunHistoryResult<MaterialOptions>?>(null) }
    var draft by remember { mutableStateOf<StoredManualMaterial?>(null) }
    var option by remember { mutableStateOf<MaterialOption?>(null) }
    var reprepare by remember { mutableStateOf(false) }
    var text by rememberSaveable { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    DisposableEffect(Unit) { onDispose { active = false } }
    fun load() {
        if (busy || !active) return
        busy = true; message = ""; open = true
        scope.launch {
            try {
                val stored = store.load(account, linkId)
                val loaded = client.options(linkId, token)
                if (active) {
                    draft = stored; result = loaded; readable = true
                    if (stored != null) text = stored.intent.text
                    option = (loaded as? RunHistoryResult.Loaded)?.value?.options?.firstOrNull()
                }
            } catch (error: CancellationException) { throw error
            } catch (_: Exception) { if (active) { readable = false; message = "读取本地草稿失败，未发送任何请求。" }
            } finally { if (active) busy = false }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { if (open) open = false else load() }, enabled = !busy, modifier = Modifier.testTag("manual_material_toggle")) {
            Text(if (open) "收起补充材料" else "补充缺失材料")
        }
        if (open) {
            Text("仅补充原文缺失的外链内容、图片文字或已截断内容。原文、媒体和人工标签保留；这不会自动整理阅读正文。")
            if (busy) Text("正在核对或保存…", modifier = Modifier.testTag("manual_material_busy"))
            val options = (result as? RunHistoryResult.Loaded)?.value
            if (draft != null && !reprepare) {
                Text(if (draft?.rejected == null) "上次保存结果未确认。保留原请求，只能核对或重试，不会另建任务。" else materialReason(draft?.rejected),
                    modifier = Modifier.testTag("manual_material_draft_status"))
                Text(materialOptionLabel(draft!!.intent.option))
            } else if (options != null) {
                if (!options.canSubmit) Text(materialReason(options.reason), modifier = Modifier.testTag("manual_material_blocked"))
                for ((index, value) in options.options.withIndex()) TextButton(onClick = { option = value }, enabled = !busy && options.canSubmit,
                    modifier = Modifier.testTag("manual_material_option_$index")) {
                    Text((if (option == value) "✓ " else "") + materialOptionLabel(value))
                }
            } else if (!busy && message.isEmpty()) Text(when (result) {
                RunHistoryResult.Unsupported -> "此服务暂不支持补充材料，未调用其他接口。"
                RunHistoryResult.Unavailable -> "这篇收藏已不存在。"
                else -> "暂时无法核对来源，可重试读取。"
            })
            OutlinedTextField(value = text, onValueChange = { if (it.length <= 100000) text = it }, label = { Text("粘贴实际缺失的文字") },
                enabled = !busy && readable && (draft == null || reprepare), minLines = 3, maxLines = 10,
                modifier = Modifier.fillMaxWidth().testTag("manual_material_text"))
            Text("保存只追加来源记录；有变化时会重新排队分类，后续判断可能产生模型费用。相同材料不重复排队。")
            val canPrepare = options?.canSubmit == true && options.source != null && option != null && text.isNotBlank() && text.toByteArray(Charsets.UTF_8).size <= 100000
            Button(enabled = !busy && readable && (draft != null && !reprepare || canPrepare), modifier = Modifier.testTag("manual_material_submit"), onClick = {
                if (!active || busy) return@Button
                val old = draft
                val intent = if (old != null && !reprepare) old.intent else {
                    val source = options?.source ?: return@Button
                    ManualMaterialIntent(UUID.randomUUID().toString(), source, option ?: return@Button, text)
                }
                if (!intent.valid()) { message = "材料过大或包含无效字符，请缩短后重试。"; return@Button }
                val sent = StoredManualMaterial(account, linkId, intent)
                busy = true; message = ""
                scope.launch {
                    try {
                        // Persist before the first network byte. A cancelled or
                        // lost response leaves this same nonce/body for recovery.
                        store.prepare(sent, old)
                        if (active) { draft = sent; reprepare = false }
                        when (val saved = client.submit(linkId, token, intent)) {
                            is MaterialWriteResult.Saved -> {
                                store.acknowledge(sent)
                                if (active) {
                                    draft = null; text = ""; result = null; readable = false
                                    message = if (saved.queued) "材料已保存，分类已排队。" else "相同材料已存在，没有重复排队。"
                                    onSaved()
                                }
                            }
                            is MaterialWriteResult.Rejected -> {
                                store.reject(sent, saved.code)
                                if (active) { draft = sent.copy(rejected = saved.code); message = materialReason(saved.code) }
                            }
                            is MaterialWriteResult.Unknown -> if (active) message = "结果尚未确认。原请求已保存；点击核对/重试会查询同一请求的回执。"
                        }
                    } catch (error: CancellationException) { throw error
                    } catch (_: Exception) { if (active) { readable = false; message = "草稿状态未确认，已停止发送；重新打开后核对。" }
                    } finally { if (active) busy = false }
                }
            }) { Text(if (draft != null && !reprepare) "核对 / 重试同一请求" else "保存补充并重新分类") }
            if (draft?.rejected != null && !reprepare) TextButton(enabled = !busy, modifier = Modifier.testTag("manual_material_reprepare"), onClick = {
                reprepare = true; load()
            }) { Text("保留文本，按当前来源准备新请求") }
            TextButton(onClick = { load() }, enabled = !busy, modifier = Modifier.testTag("manual_material_reload")) { Text("重新核对来源") }
            if (message.isNotEmpty()) Text(message, modifier = Modifier.testTag("manual_material_message"))
        }
    }
}

private fun materialOptionLabel(option: MaterialOption): String = when (option.kind) {
    "external_link" -> "外链材料：${option.sourceRef}"
    "image_text" -> "图片文字：${option.sourceRef.substringAfterLast('/').take(12)}…（出处未确认）"
    else -> "截断来源：${option.sourceRef}（补充片段，不声明已完整）"
}
private fun materialReason(reason: String?): String = when (reason) {
    "no_observed_gap", "gap_unavailable" -> "没有可核对的来源缺口，不会因分类不确定而补材料。"
    "provider_result_unknown" -> "已有模型调用的结果尚未核对，暂不发起新的分类。"
    "processing_busy" -> "这篇收藏仍在处理，完成后再核对来源。"
    "v2_required" -> "当前服务未启用所需的分类版本。"
    "primary_source_required", "source_snapshot_unavailable" -> "主来源尚未就绪，请先通过浏览器补齐原始正文。"
    "excluded_from_classification" -> "这篇收藏已被排除，不会自动重新分类。"
    "source_conflict" -> "来源或处理目标已变化，本次未保存。文本已保留，请核对后准备新请求。"
    "not_found" -> "收藏已不存在，本次未保存。"
    "operation_conflict" -> "请求标识有冲突，本次未应用，请先核对历史记录。"
    else -> "本次请求被拒绝，文本已保留。请核对来源后再操作。"
}
