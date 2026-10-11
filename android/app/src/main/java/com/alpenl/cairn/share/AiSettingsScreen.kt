package com.alpenl.cairn.share

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.AiPreferences
import com.alpenl.cairn.share.network.PreferencesClient
import com.alpenl.cairn.share.network.PreferencesResult
import com.alpenl.cairn.share.network.PreferencesSnapshot
import com.alpenl.cairn.share.ui.components.SegmentedToggle
import com.alpenl.cairn.share.ui.components.SettingsGroup
import com.alpenl.cairn.share.ui.components.SettingsRow
import com.alpenl.cairn.share.ui.theme.CairnTheme
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 设置 · AI 打标. Same preferences as the web settings page, saved on the server. */
@Composable
internal fun AiSettingsScreen(baseUrl: String, apiToken: String, onBack: () -> Unit) {
    val client = remember(baseUrl) { PreferencesClient(baseUrl) }
    val scope = rememberCoroutineScope()
    var snapshot by remember { mutableStateOf<PreferencesSnapshot?>(null) }
    var unsupported by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("正在读取…") }
    var busy by remember { mutableStateOf(false) }
    // A lost response is retried with the same key, so the server applies it once.
    var pending by remember { mutableStateOf<Pair<AiPreferences, String>?>(null) }

    suspend fun reload() {
        when (val r = withContext(Dispatchers.IO) { client.load(apiToken) }) {
            is PreferencesResult.Loaded -> { snapshot = r.snapshot; status = "" }
            PreferencesResult.Unsupported -> { unsupported = true; status = "" }
            is PreferencesResult.Conflict -> { r.latest?.let { snapshot = it }; status = "" }
            is PreferencesResult.Failed -> status = r.message
        }
    }
    fun save(next: AiPreferences, key: String = UUID.randomUUID().toString()) {
        val current = snapshot ?: return
        if (busy) return
        busy = true
        pending = next to key
        scope.launch {
            when (val r = withContext(Dispatchers.IO) { client.save(apiToken, current, next, key) }) {
                is PreferencesResult.Loaded -> { snapshot = r.snapshot; pending = null; status = "已保存，所有设备生效" }
                is PreferencesResult.Conflict -> { pending = null; r.latest?.let { snapshot = it } ?: reload(); status = "设置已在其他设备更新，已显示最新值" }
                PreferencesResult.Unsupported -> { pending = null; unsupported = true }
                is PreferencesResult.Failed -> status = r.message + " · 可重试"
            }
            busy = false
        }
    }
    LaunchedEffect(baseUrl, apiToken) { reload() }

    val p = CairnTheme.palette
    ScreenColumn {
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回") }
            Text("AI 打标", style = MaterialTheme.typography.headlineSmall)
        }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text("决定 AI 为新收藏建议多少标签，以及哪些建议需要你确认。和网页设置共用，修改后所有设备生效。",
                style = MaterialTheme.typography.bodySmall, color = p.muted)
            if (unsupported) {
                Text("服务尚未支持这些设置，请先更新服务端。", style = MaterialTheme.typography.bodyMedium, color = p.danger,
                    modifier = Modifier.testTag("ai_unsupported"))
                return@Column
            }
            val v = snapshot?.value
            if (v == null) {
                Text(status, style = MaterialTheme.typography.bodySmall, color = p.tertiary)
                if (status.isNotBlank() && status != "正在读取…") TextButton(onClick = { scope.launch { status = "正在读取…"; reload() } }) { Text("重试") }
                return@Column
            }
            SettingsGroup("建议数量") {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("每条收藏最多建议多少个标签", style = MaterialTheme.typography.bodyMedium)
                    val choices = (listOf(2, 3, 4, 5) + v.suggestionLimit).distinct().sorted()
                    SegmentedToggle(choices.map { it to it.toString() }, v.suggestionLimit, { save(v.copy(suggestionLimit = it)) },
                        enabled = !busy, modifier = Modifier.testTag("ai_limit"))
                    Text("数量越少，建议越集中在最有把握的标签上。", style = MaterialTheme.typography.bodySmall, color = p.tertiary)
                }
            }
            SettingsGroup("确认") {
                SettingsRow("建议需我确认后才生效", description = "开启后，AI 的建议先以虚线显示，确认后才参与筛选和合集规则。",
                    modifier = Modifier.testTag("ai_confirm")) {
                    Switch(v.confirmBeforeApply, { save(v.copy(confirmBeforeApply = it)) }, enabled = !busy, colors = switchColors())
                }
                SettingsRow("低把握的建议总要确认", description = "即使上一项关闭，AI 不太确定的标签也会等你确认。", divider = false,
                    modifier = Modifier.testTag("ai_low_confidence")) {
                    Switch(v.lowConfidenceReview, { save(v.copy(lowConfidenceReview = it)) }, enabled = !busy, colors = switchColors())
                }
            }
            if (status.isNotBlank()) Row(verticalAlignment = Alignment.CenterVertically) {
                Text(status, style = MaterialTheme.typography.bodySmall, color = p.tertiary,
                    modifier = Modifier.weight(1f).testTag("ai_status").semantics { liveRegion = LiveRegionMode.Polite })
                pending?.takeIf { !busy }?.let { (next, key) -> TextButton(onClick = { save(next, key) }) { Text("重试") } }
            }
        }
    }
}

@Composable
private fun switchColors() = with(CairnTheme.palette) {
    SwitchDefaults.colors(checkedTrackColor = olive, checkedThumbColor = onAccent, checkedBorderColor = olive,
        uncheckedTrackColor = hairline, uncheckedThumbColor = surface, uncheckedBorderColor = hairline)
}
