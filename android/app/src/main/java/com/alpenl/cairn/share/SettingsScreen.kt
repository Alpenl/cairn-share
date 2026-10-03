package com.alpenl.cairn.share

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp

@Composable
internal fun SettingsScreen(
    state: CairnLinksUiState,
    onCloseAfterSaveChange: (Boolean) -> Unit,
    onPreserveCompleteUrlChange: (Boolean) -> Unit,
    onApiTokenChange: (String) -> Unit,
    onOpenUploads: () -> Unit,
    onOpenConsole: () -> Unit,
    onOpenUpdate: () -> Unit,
    onOpenAbout: () -> Unit,
    onClearOffline: () -> Unit,
    onFlushPersonal: () -> Unit,
    onOpenOffline: () -> Unit,
) {
    var tokenDialogOpen by rememberSaveable { mutableStateOf(false) }
    var tokenDraft by rememberSaveable { mutableStateOf("") }
    var showToken by rememberSaveable { mutableStateOf(false) }
    var confirmClearCache by rememberSaveable { mutableStateOf(false) }
    var advancedExpanded by rememberSaveable { mutableStateOf(false) }
    val editToken = { tokenDraft = state.preferences.apiToken; showToken = false; tokenDialogOpen = true }

    ScreenColumn(scroll = true) {
        AppHeader(title = "设置", subtitle = "让收藏与阅读按你的习惯运行")
        SettingsGroup("连接") {
            SettingsRow(Icons.Default.Settings, "服务器地址", state.apiBaseUrl.removePrefix("https://").removePrefix("http://"), null)
            SettingsDivider()
            SettingsRow(Icons.Default.Check, "访问 Token",
                state.apiTokenSaveError.ifBlank { apiTokenSubtitle(state.preferences.apiToken) }, editToken,
                modifier = Modifier.testTag("settings_token").semantics { liveRegion = LiveRegionMode.Polite })
        }
        SettingsGroup("阅读与同步") {
            SettingsRow(Icons.Default.Refresh, "待上传队列", when {
                !state.pendingUploadsLoaded -> "正在读取本机队列"
                state.retryingUploads -> "正在上传 · ${state.pendingUploads.size} 条仍在本机"
                state.pendingUploads.isEmpty() -> "没有待上传链接"
                else -> "${state.pendingUploads.size} 条保存在本机"
            }, onOpenUploads)
            SettingsDivider()
            SettingsRow(Icons.Default.Refresh, "个人标签同步", when {
                state.personalTagPendingCount == 0 -> "没有待同步的个人标签修改"
                state.preferences.apiToken.isBlank() -> "${state.personalTagPendingCount} 条待同步 · 请先配置连接"
                else -> "${state.personalTagPendingCount} 条待同步 · 点按重试"
            }, when {
                state.personalTagPendingCount == 0 -> null
                state.preferences.apiToken.isBlank() -> editToken
                else -> onFlushPersonal
            }, modifier = Modifier.testTag("settings_personal_sync"))
            SettingsDivider()
            SettingsRow(CairnIcons.Offline, "离线阅读", "本机已存 ${state.offlineReads.size} 条正文 · 最近阅读与固定收藏", onOpenOffline)
            Text("最近 30 条正文与最多 20 条固定收藏，共用 16 MB 缓存；图片需要联网。",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp))
            TextButton(onClick = { confirmClearCache = true }, enabled = state.offlineReads.isNotEmpty(),
                modifier = Modifier.padding(start = 4.dp).heightIn(min = 48.dp).testTag("clear_offline_cache")) {
                Text("清除当前账号的离线缓存")
            }
        }
        SettingsGroup("分享") {
            SettingsSwitchRow(Icons.Default.Share, "保存后立即关闭", "链接保存到本机队列后关闭分享面板", state.preferences.closeAfterSave,
                onCloseAfterSaveChange, Modifier.testTag("settings_close_after_save"))
            SettingsDivider()
            SettingsSwitchRow(CairnIcons.External, "保留完整链接", "保留链接中的参数与页面定位", state.preferences.preserveCompleteUrl,
                onPreserveCompleteUrlChange, Modifier.testTag("settings_preserve_url"))
        }
        SettingsGroup("应用") {
            SettingsRow(Icons.Default.Refresh, "检查更新", updateSettingSubtitle(state), onOpenUpdate)
            SettingsDivider()
            SettingsRow(Icons.Default.Info, "关于", "版本、开源许可与数据说明", onOpenAbout)
            SettingsDivider()
            SettingsRow(CairnIcons.More, "高级", if (advancedExpanded) "收起开发工具" else "开发与诊断工具", { advancedExpanded = !advancedExpanded },
                modifier = Modifier.testTag("settings_advanced").semantics { stateDescription = if (advancedExpanded) "已展开" else "已折叠" },
                trailingIcon = if (advancedExpanded) CairnIcons.Down else CairnIcons.Chevron)
            if (advancedExpanded) {
                SettingsDivider()
                SettingsRow(Icons.Default.Settings, "API 调试台", "查看接口请求与原始响应", onOpenConsole, Modifier.testTag("settings_debug"))
            }
        }
        Spacer(Modifier.height(12.dp))
    }
    if (confirmClearCache) AlertDialog(
        onDismissRequest = { confirmClearCache = false },
        title = { Text("清除离线阅读缓存？") },
        text = { Text("仅清除当前账号在本机保存的正文与固定记录，云端收藏和待同步修改会保留。") },
        confirmButton = { TextButton(onClick = { confirmClearCache = false; onClearOffline() }) { Text("清除本机缓存") } },
        dismissButton = { TextButton(onClick = { confirmClearCache = false }) { Text("取消") } },
    )
    if (tokenDialogOpen) AlertDialog(
        onDismissRequest = { tokenDialogOpen = false }, title = { Text("访问 Token") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("用于访问你的云端收藏。保存后会更新当前连接。", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(value = tokenDraft, onValueChange = { tokenDraft = it }, label = { Text("Bearer Token") }, singleLine = true,
                    visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = { TextButton(onClick = { showToken = !showToken }, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (showToken) "隐藏" else "显示") } },
                    shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().testTag("settings_token_input"))
            }
        },
        confirmButton = { TextButton(onClick = { onApiTokenChange(tokenDraft); tokenDialogOpen = false }) { Text("保存") } },
        dismissButton = { TextButton(onClick = { tokenDialogOpen = false }) { Text("取消") } },
    )
}

@Composable
private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    SectionLabel(title)
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(vertical = 4.dp), content = content)
    }
}
@Composable
private fun SettingsDivider() { HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant) }

@Composable
internal fun SettingsRow(icon: ImageVector, title: String, subtitle: String, onClick: (() -> Unit)?, modifier: Modifier = Modifier, trailingIcon: ImageVector = CairnIcons.Chevron) {
    Row(modifier = modifier.fillMaxWidth().heightIn(min = 64.dp).clip(RoundedCornerShape(12.dp))
        .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
        .padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (onClick != null) Icon(trailingIcon, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SettingsSwitchRow(icon: ImageVector, title: String, subtitle: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier = modifier.fillMaxWidth().heightIn(min = 64.dp).clip(RoundedCornerShape(12.dp))
        .toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)
        .padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = null)
    }
}
