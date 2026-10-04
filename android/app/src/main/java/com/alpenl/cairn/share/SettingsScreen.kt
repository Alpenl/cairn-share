package com.alpenl.cairn.share

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

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
    onDownloadLibrary: () -> Unit = {},
    onCancelDownload: () -> Unit = {},
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
            SettingsRow(CairnIcons.Offline, "本地资料", "已保存 ${state.offlineReads.size} 条正文 · 点按离线阅读", onOpenOffline)
            Text("正文与图片保存在本机，下载完成后可断网阅读。下载期间请保持 APP 打开。",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 32.dp, end = 4.dp))
            if (state.downloadStatus.isNotBlank()) Text(state.downloadStatus, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 32.dp, top = 8.dp).testTag("library_download_status"))
            TextButton(onClick = if (state.downloadingLibrary) onCancelDownload else onDownloadLibrary,
                enabled = state.preferences.apiToken.isNotBlank(),
                modifier = Modifier.padding(start = 20.dp).heightIn(min = 48.dp).testTag("download_library")) {
                Text(if (state.downloadingLibrary) "暂停下载" else "下载 / 更新全部资料", style = MaterialTheme.typography.labelMedium)
            }
            TextButton(onClick = { confirmClearCache = true }, enabled = !state.downloadingLibrary,
                modifier = Modifier.padding(start = 20.dp).heightIn(min = 48.dp).testTag("clear_offline_cache")) {
                Text("清除当前账号的本地资料", style = MaterialTheme.typography.labelMedium)
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
        text = { Text("仅清除当前账号在本机保存的列表、正文、图片与固定记录，云端收藏和待同步修改会保留。") },
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
                    shape = RoundedCornerShape(6.dp), modifier = Modifier.fillMaxWidth().testTag("settings_token_input"))
            }
        },
        confirmButton = { TextButton(onClick = { onApiTokenChange(tokenDraft); tokenDialogOpen = false }) { Text("保存") } },
        dismissButton = { TextButton(onClick = { tokenDialogOpen = false }) { Text("取消") } },
    )
}

@Composable
private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Text(title, style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 0.4.sp),
            fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp, bottom = 8.dp).semantics { heading() })
        Column(content = content)
    }
}
@Composable
private fun SettingsDivider() {
    HorizontalDivider(modifier = Modifier.padding(start = 32.dp), thickness = 0.5.dp,
        color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
internal fun SettingsRow(icon: ImageVector, title: String, subtitle: String, onClick: (() -> Unit)?, modifier: Modifier = Modifier, trailingIcon: ImageVector = CairnIcons.Chevron) {
    Row(modifier = modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(4.dp))
        .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
        .padding(vertical = 9.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.78f), modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp))
            Text(subtitle, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 17.sp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (onClick != null) Icon(trailingIcon, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f))
    }
}

@Composable
private fun SettingsSwitchRow(icon: ImageVector, title: String, subtitle: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier = modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(4.dp))
        .toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)
        .padding(vertical = 9.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.78f), modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp))
            Text(subtitle, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 17.sp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // The whole row owns the toggle semantics and touch target; this is only its visual state.
        Box(Modifier.width(36.dp).height(22.dp).clip(RoundedCornerShape(11.dp))
            .background(if (checked) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f) else MaterialTheme.colorScheme.outlineVariant)
            .padding(3.dp)) {
            Box(Modifier.align(if (checked) Alignment.CenterEnd else Alignment.CenterStart).size(16.dp).clip(CircleShape)
                .background(if (checked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)))
        }
    }
}
