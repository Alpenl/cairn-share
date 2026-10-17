package com.alpenl.cairn.share

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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.EntityEvidenceReadState
import com.alpenl.cairn.share.network.EntityEvidenceResult
import com.alpenl.cairn.share.network.FailureKind
import com.alpenl.cairn.share.network.MultidimensionalSelection
import com.alpenl.cairn.share.network.evidenceReference

@Composable
internal fun EntitySourceDialog(
    read: EntityEvidenceReadState,
    selection: MultidimensionalSelection,
    onClose: (Long) -> Unit,
    onRetry: (Long) -> Unit,
    onRefresh: (Long) -> Unit,
) {
    // A late dispose from a previous popup must not cancel a newer request.
    DisposableEffect(read.requestId) { onDispose { onClose(read.requestId) } }
    val known = selection.state?.entityObservations.orEmpty().any { it.evidenceReference() == read.reference }
    val result = if (known) read.result else EntityEvidenceResult.Changed
    val highlight = MaterialTheme.colorScheme.secondaryContainer
    AlertDialog(
        modifier = Modifier.testTag("v2_entity_source_dialog"),
        onDismissRequest = { onClose(read.requestId) },
        title = { Text("来源片段") },
        text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("原始来源 · 第 ${read.reference.sourceRevision} 版")
                when (result) {
                    null -> Text("正在读取来源片段…", Modifier.testTag("v2_entity_source_loading"))
                    is EntityEvidenceResult.Loaded -> {
                        val value = result.value
                        val role = when (value.role) {
                            "primary" -> "原帖"
                            "author_continuation" -> "作者续帖"
                            "quoted" -> "引用内容"
                            "external_article" -> "外部正文"
                            "third_party" -> "第三方内容"
                            else -> "来源关系未知"
                        }
                        Text(role)
                        if (!value.current || selection.state?.contentRevision != read.reference.sourceRevision)
                            Text("原始来源已更新，正在查看引用的旧版本。", Modifier.testTag("v2_entity_source_stale"))
                        if (value.partial) Text("引用的来源材料不完整。")
                        if (value.clippedBefore) Text("…")
                        Text(buildAnnotatedString {
                            append(value.before)
                            withStyle(SpanStyle(background = highlight, fontWeight = FontWeight.SemiBold)) { append(value.quote) }
                            append(value.after)
                        }, Modifier.testTag("v2_entity_source_text"))
                        if (value.clippedAfter) Text("…")
                    }
                    else -> Text(when (result) {
                        EntityEvidenceResult.Unsupported -> "当前服务不支持来源片段定位。"
                        EntityEvidenceResult.Unavailable -> "原始片段不可用，请刷新依据后重试。"
                        EntityEvidenceResult.Changed -> "依据版本已变化，请刷新后重新选择。"
                        is EntityEvidenceResult.Failed -> when (result.kind) {
                            FailureKind.Unauthorized -> "访问凭据无效，请检查设置。"
                            FailureKind.Network -> "网络不可用，请稍后重试。"
                            FailureKind.Timeout -> "读取超时，请重试。"
                            FailureKind.Server -> "读取失败，请重试。"
                        }
                        else -> "读取失败，请重试。"
                    }, Modifier.testTag("v2_entity_source_error"))
                }
            }
        },
        confirmButton = { TextButton(onClick = { onClose(read.requestId) }, modifier = Modifier.testTag("v2_entity_source_close")) { Text("关闭片段") } },
        dismissButton = {
            when (result) {
                is EntityEvidenceResult.Failed -> TextButton(onClick = { onRetry(read.requestId) }, modifier = Modifier.testTag("v2_entity_source_retry")) { Text("重试") }
                EntityEvidenceResult.Changed, EntityEvidenceResult.Unavailable -> TextButton(
                    onClick = { onRefresh(read.requestId) }, modifier = Modifier.testTag("v2_entity_source_refresh"),
                ) { Text("刷新依据") }
                else -> Unit
            }
        },
    )
}
