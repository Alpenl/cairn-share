package com.alpenl.cairn.share

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.alpenl.cairn.share.contract.UrlCandidate
import com.alpenl.cairn.share.network.ApiDebugMethod
import com.alpenl.cairn.share.network.LinkFilter
import com.alpenl.cairn.share.network.SavedLink

private object Routes {
    const val Library = "library"
    const val Queue = "queue"
    const val Settings = "settings"
    const val Detail = "detail/{id}"
    const val Edit = "edit/{id}"
    const val Update = "update"
    const val Console = "console"
    const val About = "about"

    fun detail(id: Int): String = "detail/$id"
    fun edit(id: Int): String = "edit/$id"
}

private data class TopDestination(
    val route: String,
    val label: String,
    val icon: ImageVector,
)

private val TopDestinations = listOf(
    TopDestination(Routes.Library, "链接库", Icons.Default.Search),
    TopDestination(Routes.Queue, "待学习", Icons.Default.Check),
    TopDestination(Routes.Settings, "设置", Icons.Default.Settings),
)

private val AvatarPalette = listOf(
    AvatarTone(Color(0xFFE1E8D8), Color(0xFF344C19)),
    AvatarTone(Color(0xFFD8E7EA), Color(0xFF174A53)),
    AvatarTone(Color(0xFFE8DEEF), Color(0xFF4C315D)),
    AvatarTone(Color(0xFFF0E1D3), Color(0xFF65411D)),
    AvatarTone(Color(0xFFDDE5F4), Color(0xFF29476C)),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CairnLinksApp(
    viewModel: CairnLinksViewModel,
    onOpenExternal: (String) -> Unit,
    onCopy: (String) -> Unit,
    onInstallUpdate: () -> Unit,
) {
    val state = viewModel.uiState
    val navController = rememberNavController()
    val snackbarHostState = remember { SnackbarHostState() }
    val currentEntry by navController.currentBackStackEntryAsState()
    val currentRoute = currentEntry?.destination?.route
    val showBottomBar = currentRoute in TopDestinations.map { it.route }

    LaunchedEffect(state.message?.id) {
        val message = state.message ?: return@LaunchedEffect
        val result = snackbarHostState.showSnackbar(
            message = message.text,
            actionLabel = message.actionLabel,
            duration = SnackbarDuration.Short,
        )
        if (result == SnackbarResult.ActionPerformed) {
            message.undo?.let { viewModel.setLearned(it.linkId, it.learned) }
        }
        viewModel.consumeMessage(message.id)
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            if (showBottomBar) {
                CairnBottomBar(
                    currentRoute = currentRoute,
                    pendingCount = state.stats().pending,
                    onNavigate = { route -> navController.navigateTop(route) },
                )
            }
        },
        floatingActionButton = {
            if (currentRoute == Routes.Library) {
                ExtendedFloatingActionButton(
                    text = { Text("添加链接") },
                    icon = { Icon(Icons.Default.Add, contentDescription = null) },
                    onClick = viewModel::openManualAdd,
                    elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 4.dp),
                    modifier = Modifier.testTag("add_link"),
                )
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
        modifier = Modifier.fillMaxSize(),
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Routes.Library,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            composable(Routes.Library) {
                LibraryScreen(
                    state = state,
                    onSearchQueryChange = viewModel::setSearchQuery,
                    onFilterChange = viewModel::setFilter,
                    onRefresh = viewModel::refreshLinks,
                    onOpenSettings = { navController.navigateTop(Routes.Settings) },
                    onOpenLinkDetail = { navController.navigate(Routes.detail(it.id)) },
                )
            }
            composable(Routes.Queue) {
                QueueScreen(
                    state = state,
                    onMarkAll = viewModel::markAllPendingLearned,
                    onOpenLinkDetail = { navController.navigate(Routes.detail(it.id)) },
                )
            }
            composable(Routes.Settings) {
                SettingsScreen(
                    state = state,
                    onCloseAfterSaveChange = viewModel::setCloseAfterSave,
                    onPreserveCompleteUrlChange = viewModel::setPreserveCompleteUrl,
                    onOpenConsole = { navController.navigate(Routes.Console) },
                    onOpenUpdate = { navController.navigate(Routes.Update) },
                    onOpenAbout = { navController.navigate(Routes.About) },
                )
            }
            composable(
                route = Routes.Detail,
                arguments = listOf(navArgument("id") { type = NavType.IntType }),
            ) { entry ->
                val id = entry.arguments?.getInt("id") ?: return@composable
                DetailScreen(
                    id = id,
                    state = state,
                    onEnsureLink = viewModel::ensureLink,
                    onBack = { navController.popBackStack() },
                    onEdit = { navController.navigate(Routes.edit(id)) },
                    onOpenExternal = onOpenExternal,
                    onCopy = onCopy,
                    onToggleLearned = viewModel::toggleLearned,
                    onDelete = { viewModel.deleteLink(id) { navController.popBackStack() } },
                )
            }
            composable(
                route = Routes.Edit,
                arguments = listOf(navArgument("id") { type = NavType.IntType }),
            ) { entry ->
                val id = entry.arguments?.getInt("id") ?: return@composable
                EditScreen(
                    id = id,
                    state = state,
                    onEnsureLink = viewModel::ensureLink,
                    onBeginEdit = viewModel::beginEdit,
                    onUrlChange = viewModel::setEditUrl,
                    onNoteChange = viewModel::setEditNote,
                    onSave = { viewModel.saveEdit { navController.popBackStack() } },
                    onDelete = {
                        viewModel.deleteLink(id) {
                            navController.popBackStack(Routes.Detail, inclusive = true)
                        }
                    },
                    onBack = { navController.popBackStack() },
                )
            }
            composable(Routes.Update) {
                UpdateScreen(
                    state = state,
                    onBack = { navController.popBackStack() },
                    onCheck = viewModel::checkForUpdates,
                    onInstallUpdate = onInstallUpdate,
                )
            }
            composable(Routes.Console) {
                ApiConsoleScreen(
                    state = state,
                    onBack = { navController.popBackStack() },
                    onMethodChange = viewModel::setApiDebugMethod,
                    onPathChange = viewModel::setApiDebugPath,
                    onBodyChange = viewModel::setApiDebugBody,
                    onSend = viewModel::sendApiDebugRequest,
                )
            }
            composable(Routes.About) {
                AboutScreen(
                    state = state,
                    onBack = { navController.popBackStack() },
                    onOpenExternal = onOpenExternal,
                )
            }
        }
    }

    if (state.manualAdd.visible) {
        ModalBottomSheet(
            onDismissRequest = viewModel::closeManualAdd,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            SaveLinkSheetContent(
                title = "保存到链接库",
                subtitle = "手动添加一条 HTTP 或 HTTPS 链接。",
                candidates = emptyList(),
                selectedIndex = -1,
                selectedLabel = null,
                onSelectCandidate = {},
                manualUrl = state.manualAdd.url,
                onManualUrlChange = viewModel::setManualUrl,
                note = state.manualAdd.note,
                onNoteChange = viewModel::setManualNote,
                statusText = state.manualAdd.statusText,
                submitting = state.manualAdd.submitting,
                submitEnabled = state.manualAdd.url.isNotBlank() && !state.manualAdd.submitting,
                preserveCompleteUrl = state.preferences.preserveCompleteUrl,
                onCancel = viewModel::closeManualAdd,
                onSave = viewModel::createManualLink,
                modifier = Modifier.navigationBarsPadding(),
            )
        }
    }
}

@Composable
private fun CairnBottomBar(
    currentRoute: String?,
    pendingCount: Int,
    onNavigate: (String) -> Unit,
) {
    NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceVariant) {
        TopDestinations.forEach { destination ->
            NavigationBarItem(
                selected = currentRoute == destination.route,
                onClick = { onNavigate(destination.route) },
                icon = {
                    BadgedIcon(
                        icon = destination.icon,
                        contentDescription = destination.label,
                        badge = if (destination.route == Routes.Queue && pendingCount > 0) pendingCount else null,
                    )
                },
                label = { Text(destination.label) },
                modifier = Modifier.testTag("nav_${destination.route}"),
            )
        }
    }
}

private fun NavHostController.navigateTop(route: String) {
    navigate(route) {
        popUpTo(Routes.Library) {
            saveState = true
        }
        launchSingleTop = true
        restoreState = true
    }
}

@Composable
private fun LibraryScreen(
    state: CairnLinksUiState,
    onSearchQueryChange: (String) -> Unit,
    onFilterChange: (LinkFilter) -> Unit,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenLinkDetail: (SavedLink) -> Unit,
) {
    val stats = state.stats()
    val items = state.visibleLibraryLinks()
    ScreenColumn {
        AppHeader(
            title = "链接库",
            subtitle = "${stats.total} 条收藏 · ${stats.pending} 条待读",
            actions = {
                IconButton(onClick = onRefresh, enabled = !state.loading, modifier = Modifier.testTag("refresh_links")) {
                    Icon(Icons.Default.Check, contentDescription = "刷新")
                }
                IconButton(onClick = onOpenSettings) {
                    Icon(Icons.Default.Settings, contentDescription = "设置")
                }
            },
        )
        SummaryCard(stats = stats, loading = state.loading)
        SearchField(
            value = state.searchQuery,
            onValueChange = onSearchQueryChange,
            enabled = !state.loading,
        )
        FilterRow(
            selected = state.filter,
            stats = stats,
            enabled = !state.loading,
            onFilterChange = onFilterChange,
        )
        StatusText(state.statusText, "library_status")
        LinkList(
            items = items,
            loading = state.loading,
            emptyText = libraryEmptyText(state),
            onOpenLinkDetail = onOpenLinkDetail,
        )
    }
}

@Composable
private fun QueueScreen(
    state: CairnLinksUiState,
    onMarkAll: () -> Unit,
    onOpenLinkDetail: (SavedLink) -> Unit,
) {
    val queue = state.queueLinks()
    ScreenColumn {
        AppHeader(
            title = "待学习",
            subtitle = if (queue.isEmpty()) "按收藏先后排队，先进先读" else "${queue.size} 条排队中，最早 ${queue.first().createdAt.shortDateTime()}",
            actions = {
                IconButton(onClick = onMarkAll, enabled = queue.isNotEmpty() && state.busyIds.isEmpty(), modifier = Modifier.testTag("mark_all_learned")) {
                    Icon(Icons.Default.Check, contentDescription = "全部标记为已学习")
                }
            },
        )
        LinkList(
            items = queue,
            loading = state.loading,
            emptyText = "没有待学习链接。分享新链接后会出现在这里。",
            onOpenLinkDetail = onOpenLinkDetail,
            fifo = true,
        )
    }
}

@Composable
private fun SettingsScreen(
    state: CairnLinksUiState,
    onCloseAfterSaveChange: (Boolean) -> Unit,
    onPreserveCompleteUrlChange: (Boolean) -> Unit,
    onOpenConsole: () -> Unit,
    onOpenUpdate: () -> Unit,
    onOpenAbout: () -> Unit,
) {
    ScreenColumn(scroll = true) {
        AppHeader(title = "设置", subtitle = "云端、分享与应用")
        SectionLabel("云端")
        SettingsRow(
            icon = Icons.Default.Settings,
            title = "服务器地址",
            subtitle = state.apiBaseUrl.removePrefix("https://").removePrefix("http://"),
            onClick = null,
        )
        SettingsRow(
            icon = Icons.Default.Info,
            title = "API 调试台",
            subtitle = "直接对 /api/links 发请求并查看原始响应",
            onClick = onOpenConsole,
        )
        SectionLabel("分享")
        SettingsSwitchRow(
            icon = Icons.Default.Share,
            title = "保存后立即关闭",
            subtitle = "保存成功就退出分享弹窗，不停留",
            checked = state.preferences.closeAfterSave,
            onCheckedChange = onCloseAfterSaveChange,
        )
        SettingsSwitchRow(
            icon = Icons.Default.Share,
            title = "保留完整链接",
            subtitle = "不删除 query 与 fragment",
            checked = state.preferences.preserveCompleteUrl,
            onCheckedChange = onPreserveCompleteUrlChange,
        )
        SectionLabel("应用")
        SettingsRow(
            icon = Icons.Default.Check,
            title = "检查更新",
            subtitle = updateSettingSubtitle(state),
            onClick = onOpenUpdate,
        )
        SettingsRow(
            icon = Icons.Default.Info,
            title = "关于",
            subtitle = "版本、开源许可与数据说明",
            onClick = onOpenAbout,
        )
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun DetailScreen(
    id: Int,
    state: CairnLinksUiState,
    onEnsureLink: (Int) -> Unit,
    onBack: () -> Unit,
    onEdit: () -> Unit,
    onOpenExternal: (String) -> Unit,
    onCopy: (String) -> Unit,
    onToggleLearned: (SavedLink) -> Unit,
    onDelete: () -> Unit,
) {
    val link = state.links.firstOrNull { it.id == id }
    val loadState = state.detailLoads[id]
    var confirmDelete by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(id) { onEnsureLink(id) }

    ScreenColumn(scroll = true) {
        DetailTopBar(
            title = "链接 #$id",
            onBack = onBack,
            actions = {
                IconButton(onClick = onEdit, enabled = link != null) {
                    Icon(Icons.Default.Edit, contentDescription = "编辑")
                }
                IconButton(onClick = { confirmDelete = true }, enabled = link != null && id !in state.busyIds) {
                    Icon(Icons.Default.Delete, contentDescription = "删除", tint = MaterialTheme.colorScheme.error)
                }
            },
        )
        when {
            link != null -> LinkDetailContent(
                link = link,
                busy = id in state.busyIds,
                onOpenExternal = onOpenExternal,
                onCopy = onCopy,
                onToggleLearned = onToggleLearned,
            )
            loadState == DetailLoadState.Loading -> LoadingState("正在加载链接详情...")
            loadState == DetailLoadState.NotFound -> EmptyState("这条链接不存在或已经被删除。")
            else -> EmptyState("无法加载链接详情。")
        }
    }

    if (confirmDelete) {
        ConfirmDeleteDialog(
            onDismiss = { confirmDelete = false },
            onConfirm = {
                confirmDelete = false
                onDelete()
            },
        )
    }
}

@Composable
private fun EditScreen(
    id: Int,
    state: CairnLinksUiState,
    onEnsureLink: (Int) -> Unit,
    onBeginEdit: (SavedLink) -> Unit,
    onUrlChange: (String) -> Unit,
    onNoteChange: (String) -> Unit,
    onSave: () -> Unit,
    onDelete: () -> Unit,
    onBack: () -> Unit,
) {
    val link = state.links.firstOrNull { it.id == id }
    val draft = state.editDraft?.takeIf { it.id == id }
    var confirmDelete by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(id) { onEnsureLink(id) }
    LaunchedEffect(link?.id) {
        if (link != null) onBeginEdit(link)
    }

    ScreenColumn(scroll = true) {
        DetailTopBar(
            title = "编辑链接",
            onBack = onBack,
            actions = {
                TextButton(onClick = onSave, enabled = draft != null && !draft.saving, modifier = Modifier.testTag("save_edit")) {
                    Text("保存")
                }
            },
        )
        if (draft == null) {
            LoadingState("正在准备编辑表单...")
        } else {
            OutlinedTextField(
                value = draft.url,
                onValueChange = onUrlChange,
                label = { Text("链接") },
                supportingText = { Text("${draft.url.length} / $MAX_URL_LENGTH") },
                enabled = !draft.saving,
                minLines = 3,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("edit_url"),
            )
            OutlinedTextField(
                value = draft.note,
                onValueChange = onNoteChange,
                label = { Text("备注") },
                supportingText = { Text("${draft.note.length} / $MAX_NOTE_LENGTH") },
                enabled = !draft.saving,
                minLines = 4,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("edit_note"),
            )
            StatusText(draft.error, "edit_status")
            Button(
                onClick = { confirmDelete = true },
                enabled = !draft.saving,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                shape = RoundedCornerShape(24.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("delete_editing"),
            ) {
                Icon(Icons.Default.Delete, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("删除这条链接")
            }
        }
    }

    if (confirmDelete) {
        ConfirmDeleteDialog(
            onDismiss = { confirmDelete = false },
            onConfirm = {
                confirmDelete = false
                onDelete()
            },
        )
    }
}

@Composable
private fun UpdateScreen(
    state: CairnLinksUiState,
    onBack: () -> Unit,
    onCheck: () -> Unit,
    onInstallUpdate: () -> Unit,
) {
    ScreenColumn(scroll = true) {
        DetailTopBar(title = "检查更新", onBack = onBack)
        UpdatePanel(
            updateState = state.updateState,
            currentVersionName = state.currentVersionName,
            onCheck = onCheck,
            onInstallUpdate = onInstallUpdate,
        )
        SectionLabel("更新说明")
        InfoBlock("更新来源是 GitHub Release。下载完成后会打开系统安装器；普通应用不能静默安装 APK。")
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun ApiConsoleScreen(
    state: CairnLinksUiState,
    onBack: () -> Unit,
    onMethodChange: (ApiDebugMethod) -> Unit,
    onPathChange: (String) -> Unit,
    onBodyChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    var confirmDanger by rememberSaveable { mutableStateOf(false) }
    val debug = state.apiDebug
    ScreenColumn(scroll = true) {
        DetailTopBar(
            title = "API 调试台",
            onBack = onBack,
            actions = {
                IconButton(
                    onClick = {
                        if (debug.method == ApiDebugMethod.DELETE) confirmDanger = true else onSend()
                    },
                    enabled = !debug.sending,
                    modifier = Modifier.testTag("api_send"),
                ) {
                    Icon(Icons.Default.Check, contentDescription = "发送请求")
                }
            },
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ApiDebugMethod.entries.forEach { method ->
                FilterChip(
                    selected = debug.method == method,
                    onClick = { onMethodChange(method) },
                    label = { Text(method.name) },
                )
            }
        }
        OutlinedTextField(
            value = debug.path,
            onValueChange = onPathChange,
            label = { Text("路径") },
            singleLine = true,
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        if (debug.method in setOf(ApiDebugMethod.POST, ApiDebugMethod.PATCH)) {
            OutlinedTextField(
                value = debug.body,
                onValueChange = onBodyChange,
                label = { Text("JSON 请求体") },
                minLines = 6,
                shape = RoundedCornerShape(18.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Button(
            onClick = {
                if (debug.method == ApiDebugMethod.DELETE) confirmDanger = true else onSend()
            },
            enabled = !debug.sending,
            shape = RoundedCornerShape(24.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (debug.sending) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text("发送 ${debug.method.name}")
        }
        SectionLabel("响应", debug.statusLine)
        ConsoleBlock(debug.responseText.ifBlank { "等待请求。" })
    }

    if (confirmDanger) {
        AlertDialog(
            onDismissRequest = { confirmDanger = false },
            title = { Text("发送 DELETE 请求？") },
            text = { Text("DELETE 会直接影响公开链接库，发送前请确认路径。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDanger = false
                        onSend()
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Text("发送")
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDanger = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun AboutScreen(
    state: CairnLinksUiState,
    onBack: () -> Unit,
    onOpenExternal: (String) -> Unit,
) {
    ScreenColumn(scroll = true) {
        DetailTopBar(title = "关于", onBack = onBack)
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Surface(
                shape = RoundedCornerShape(24.dp),
                color = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.size(72.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Info, contentDescription = null, modifier = Modifier.size(34.dp))
                }
            }
            Text("链接收集", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(
                "${state.currentVersionName} (${state.currentVersionCode}) · Cairn Share",
                style = MaterialTheme.typography.labelMedium,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        InfoBlock("接口不做登录与鉴权，所有保存的链接都按公开数据处理。不要提交包含私密信息的链接。")
        SettingsRow(
            icon = Icons.Default.Share,
            title = "源码仓库",
            subtitle = "github.com/Alpenl/cairn-share",
            onClick = { onOpenExternal("https://github.com/Alpenl/cairn-share") },
        )
        SettingsRow(
            icon = Icons.Default.Info,
            title = "开源许可",
            subtitle = "MIT · 含第三方组件清单",
            onClick = { onOpenExternal("https://github.com/Alpenl/cairn-share/blob/main/LICENSE") },
        )
    }
}

@Composable
private fun ScreenColumn(
    scroll: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val base = Modifier
        .fillMaxSize()
        .statusBarsPadding()
        .padding(horizontal = 16.dp)
        .padding(top = 6.dp, bottom = 10.dp)
    Column(
        modifier = if (scroll) base.verticalScroll(rememberScrollState()) else base,
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

@Composable
private fun AppHeader(
    title: String,
    subtitle: String,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = actions,
        )
    }
}

@Composable
private fun DetailTopBar(
    title: String,
    onBack: () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
        }
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(content = actions)
    }
}

@Composable
private fun SummaryCard(stats: LinkStats, loading: Boolean) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ProgressRing(stats.progress)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = if (loading) "正在同步云端链接" else "本周读完 ${stats.weekDone} 条",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = stats.oldestPending?.let {
                        "还有 ${stats.pending} 条排在待学习里，最早一条来自 ${it.createdAt.shortDateTime()}。"
                    } ?: "所有链接都已经读完。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ProgressRing(progress: Float) {
    Box(modifier = Modifier.size(44.dp), contentAlignment = Alignment.Center) {
        val trackColor = MaterialTheme.colorScheme.outlineVariant
        val valueColor = MaterialTheme.colorScheme.primary
        Canvas(modifier = Modifier.fillMaxSize()) {
            val strokeWidth = 4.dp.toPx()
            val diameter = size.minDimension - strokeWidth
            val topLeft = Offset((size.width - diameter) / 2f, (size.height - diameter) / 2f)
            val arcSize = Size(diameter, diameter)
            drawCircle(
                color = trackColor,
                radius = diameter / 2f,
                style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
            )
            drawArc(
                color = valueColor,
                startAngle = -90f,
                sweepAngle = 360f * progress.coerceIn(0f, 1f),
                useCenter = false,
                topLeft = topLeft,
                size = arcSize,
                style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
            )
        }
        Text(
            text = "${(progress.coerceIn(0f, 1f) * 100).toInt()}%",
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun SearchField(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text("搜索") },
        placeholder = { Text("搜索链接、备注或站点") },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        enabled = enabled,
        singleLine = true,
        shape = RoundedCornerShape(26.dp),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("library_search"),
    )
}

@Composable
private fun FilterRow(
    selected: LinkFilter,
    stats: LinkStats,
    enabled: Boolean,
    onFilterChange: (LinkFilter) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        FilterChip(
            selected = selected == LinkFilter.All,
            onClick = { onFilterChange(LinkFilter.All) },
            enabled = enabled,
            label = { Text("全部 ${stats.total}") },
            modifier = Modifier
                .weight(1f)
                .testTag("filter_all"),
        )
        FilterChip(
            selected = selected == LinkFilter.Unlearned,
            onClick = { onFilterChange(LinkFilter.Unlearned) },
            enabled = enabled,
            label = { Text("待学习 ${stats.pending}") },
            modifier = Modifier
                .weight(1f)
                .testTag("filter_unlearned"),
        )
        FilterChip(
            selected = selected == LinkFilter.Learned,
            onClick = { onFilterChange(LinkFilter.Learned) },
            enabled = enabled,
            label = { Text("已学习 ${stats.learned}") },
            modifier = Modifier
                .weight(1f)
                .testTag("filter_learned"),
        )
    }
}

@Composable
private fun StatusText(status: String, tag: String = "status") {
    if (status.isBlank()) return
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            status,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier
                .padding(horizontal = 14.dp, vertical = 12.dp)
                .testTag(tag),
        )
    }
}

@Composable
private fun ColumnScope.LinkList(
    items: List<SavedLink>,
    loading: Boolean,
    emptyText: String,
    onOpenLinkDetail: (SavedLink) -> Unit,
    fifo: Boolean = false,
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxWidth()
            .weight(1f, fill = true),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(bottom = 92.dp),
    ) {
        if (loading && items.isEmpty()) {
            item { LoadingState("正在加载链接...") }
        } else if (items.isEmpty()) {
            item { EmptyState(emptyText) }
        }
        items(items, key = { it.id }) { link ->
            LinkRow(
                link = link,
                fifo = fifo,
                onClick = { onOpenLinkDetail(link) },
            )
        }
    }
}

@Composable
private fun LinkRow(
    link: SavedLink,
    fifo: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(
            1.dp,
            if (link.learned) MaterialTheme.colorScheme.outlineVariant else MaterialTheme.colorScheme.primaryContainer,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("link_${link.id}")
            .clickable(role = Role.Button, onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            HostAvatar(link.url)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    text = link.displayTitle(),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "${if (fifo) "入队" else link.hostLabel()} · ${link.createdAt.shortDateTime()}",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontFamily = FontFamily.Monospace,
                )
                if (link.note.isNotBlank()) {
                    Text(
                        text = link.note,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            StateDot(learned = link.learned)
        }
    }
}

@Composable
private fun LinkDetailContent(
    link: SavedLink,
    busy: Boolean,
    onOpenExternal: (String) -> Unit,
    onCopy: (String) -> Unit,
    onToggleLearned: (SavedLink) -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.extraLarge,
        color = if (link.learned) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.tertiaryContainer,
        contentColor = if (link.learned) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onTertiaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            StatePill(learned = link.learned)
            Text(link.displayTitle(), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        }
    }
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                HostAvatar(link.url)
                Text(link.hostLabel(), modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                IconButton(onClick = { onCopy(link.url) }) {
                    Icon(Icons.Default.Share, contentDescription = "复制链接")
                }
            }
            SelectionContainer {
                Text(link.url, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        Button(
            onClick = { onOpenExternal(link.url) },
            shape = RoundedCornerShape(24.dp),
            modifier = Modifier.weight(1f),
        ) {
            Icon(Icons.Default.Share, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("打开链接")
        }
        OutlinedButton(
            onClick = { onToggleLearned(link) },
            enabled = !busy,
            shape = RoundedCornerShape(24.dp),
            modifier = Modifier.testTag("toggle_${link.id}"),
        ) {
            if (busy) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
            } else {
                Icon(Icons.Default.Check, contentDescription = null)
            }
            Spacer(Modifier.width(8.dp))
            Text(if (link.learned) "改回待学习" else "标为已学习")
        }
    }
    InfoBlock(title = "备注", text = link.note.ifBlank { "无备注" })
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            MetaRow("收藏于", link.createdAt.shortDateTime())
            MetaRow("学习于", link.learnedAt?.shortDateTime() ?: "未学习")
            MetaRow("记录 ID", "#${link.id}")
            MetaRow("来源", "公开链接库")
        }
    }
}

@Composable
private fun UpdatePanel(
    updateState: AppUpdateState,
    currentVersionName: String,
    onCheck: () -> Unit,
    onInstallUpdate: () -> Unit,
) {
    val title = when (updateState) {
        is AppUpdateState.Available -> "发现新版本 ${updateState.update.versionName}"
        AppUpdateState.Checking -> "正在检查更新"
        is AppUpdateState.Downloading -> "正在下载 ${updateState.update.versionName}"
        AppUpdateState.Failed -> "检查更新失败"
        AppUpdateState.Hidden -> "尚未检查更新"
        is AppUpdateState.InstallFailed -> "安装更新失败"
        is AppUpdateState.InstallPermissionRequired -> "需要安装权限"
        is AppUpdateState.InstallStarted -> "系统安装器已打开"
        AppUpdateState.UpToDate -> "已是最新版本"
    }
    val message = when (updateState) {
        is AppUpdateState.Available -> "当前版本是 $currentVersionName。点击后会在应用内下载 APK，并打开系统安装器。"
        AppUpdateState.Checking -> "正在连接 GitHub Release。"
        is AppUpdateState.Downloading -> "下载完成后会自动打开系统安装器。"
        AppUpdateState.Failed -> "无法读取 GitHub Release。请检查网络后重试。"
        AppUpdateState.Hidden -> "点击重新检查来读取 GitHub Release。"
        is AppUpdateState.InstallFailed -> "请检查网络、存储空间和安装权限后重试。"
        is AppUpdateState.InstallPermissionRequired -> "授权后返回应用，会继续打开系统安装器。"
        is AppUpdateState.InstallStarted -> "请在系统安装器中确认安装 ${updateState.update.versionName}。"
        AppUpdateState.UpToDate -> "当前版本 $currentVersionName 已经是最新版本。"
    }
    Surface(
        shape = MaterialTheme.shapes.extraLarge,
        color = MaterialTheme.colorScheme.primaryContainer,
        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("update_card"),
    ) {
        Column(modifier = Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("GITHUB RELEASE", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                if (updateState == AppUpdateState.Checking || updateState is AppUpdateState.Downloading) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                }
                Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("update_title"))
            }
            Text(message, style = MaterialTheme.typography.bodyMedium)
            if (updateState == AppUpdateState.Checking || updateState is AppUpdateState.Downloading) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                when (updateState) {
                    is AppUpdateState.Available,
                    is AppUpdateState.InstallFailed,
                    is AppUpdateState.InstallPermissionRequired -> Button(
                        onClick = onInstallUpdate,
                        shape = RoundedCornerShape(24.dp),
                        modifier = Modifier.testTag("download_update"),
                    ) {
                        Icon(Icons.Default.Check, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text(if (updateState is AppUpdateState.InstallPermissionRequired) "打开权限设置" else "下载并安装")
                    }
                    else -> Unit
                }
                OutlinedButton(onClick = onCheck, enabled = updateState != AppUpdateState.Checking && updateState !is AppUpdateState.Downloading, shape = RoundedCornerShape(24.dp), modifier = Modifier.testTag("check_update")) {
                    Text("重新检查")
                }
            }
        }
    }
}

@Composable
private fun SettingsRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: (() -> Unit)?,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (onClick != null) Icon(Icons.Default.Share, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SettingsSwitchRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .clickable(role = Role.Switch) { onCheckedChange(!checked) }
            .padding(horizontal = 12.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun SectionLabel(title: String, trailing: String? = null) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(top = 4.dp),
    ) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
        HorizontalDivider(modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        trailing?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = FontFamily.Monospace)
        }
    }
}

@Composable
private fun InfoBlock(text: String) {
    InfoBlock(title = null, text = text)
}

@Composable
private fun InfoBlock(title: String?, text: String) {
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            title?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold) }
            Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ConsoleBlock(text: String) {
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        SelectionContainer {
            Text(
                text,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(14.dp),
            )
        }
    }
}

@Composable
private fun MetaRow(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(72.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun LoadingState(text: String) {
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.padding(18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun EmptyState(text: String) {
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(horizontal = 28.dp, vertical = 38.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface, modifier = Modifier.size(56.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Info, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
                }
            }
            Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun HostAvatar(url: String) {
    val host = url.hostLabel()
    val tone = avatarTone(host)
    Surface(shape = RoundedCornerShape(14.dp), color = tone.container, contentColor = tone.content, modifier = Modifier.size(42.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = host.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun StateDot(learned: Boolean) {
    Box(
        modifier = Modifier
            .padding(top = 8.dp)
            .size(10.dp)
            .background(
                color = if (learned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary,
                shape = CircleShape,
            ),
    )
}

@Composable
private fun StatePill(learned: Boolean) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = if (learned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary,
        contentColor = if (learned) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onTertiary,
    ) {
        Row(modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(6.dp).background(MaterialTheme.colorScheme.onPrimary, CircleShape))
            Text(if (learned) "已学习" else "待学习", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun BadgedIcon(icon: ImageVector, contentDescription: String, badge: Int?) {
    Box {
        Icon(icon, contentDescription = contentDescription)
        if (badge != null) {
            Surface(
                shape = CircleShape,
                color = MaterialTheme.colorScheme.tertiary,
                contentColor = MaterialTheme.colorScheme.onTertiary,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .sizeIn(minWidth = 18.dp, minHeight = 18.dp),
            ) {
                Text(
                    text = badge.coerceAtMost(99).toString(),
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(horizontal = 5.dp),
                )
            }
        }
    }
}

@Composable
private fun ConfirmDeleteDialog(
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("删除这条链接？") },
        text = { Text("删除后无法恢复，云端记录也会一起移除。") },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.testTag("confirm_delete"),
            ) {
                Text("删除")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ShareBottomSheetScreen(
    title: String,
    subtitle: String,
    candidates: List<UrlCandidate>,
    selectedIndex: Int,
    note: String,
    statusText: String,
    submitting: Boolean,
    preserveCompleteUrl: Boolean,
    onSelectCandidate: (Int) -> Unit,
    onNoteChange: (String) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    val selected = candidates.getOrNull(selectedIndex)
    ModalBottomSheet(
        onDismissRequest = onCancel,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        SaveLinkSheetContent(
            title = title,
            subtitle = subtitle,
            candidates = candidates,
            selectedIndex = selectedIndex,
            selectedLabel = selected?.displayLabel,
            onSelectCandidate = onSelectCandidate,
            manualUrl = null,
            onManualUrlChange = {},
            note = note,
            onNoteChange = onNoteChange,
            statusText = statusText,
            submitting = submitting,
            submitEnabled = selected != null && !submitting,
            preserveCompleteUrl = preserveCompleteUrl,
            onCancel = onCancel,
            onSave = onSave,
            modifier = Modifier.navigationBarsPadding(),
        )
    }
}

@Composable
private fun SaveLinkSheetContent(
    title: String,
    subtitle: String,
    candidates: List<UrlCandidate>,
    selectedIndex: Int,
    selectedLabel: String?,
    onSelectCandidate: (Int) -> Unit,
    manualUrl: String?,
    onManualUrlChange: (String) -> Unit,
    note: String,
    onNoteChange: (String) -> Unit,
    statusText: String,
    submitting: Boolean,
    submitEnabled: Boolean,
    preserveCompleteUrl: Boolean,
    onCancel: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .imePadding()
            .padding(horizontal = 22.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (manualUrl != null) {
            OutlinedTextField(
                value = manualUrl,
                onValueChange = onManualUrlChange,
                label = { Text("链接") },
                placeholder = { Text("https://example.com/article") },
                minLines = 2,
                enabled = !submitting,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("manual_url"),
            )
            if (!preserveCompleteUrl && manualUrl.isNotBlank()) {
                Text(
                    "将保存：${removeQueryAndFragment(manualUrl)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        } else if (candidates.size > 1) {
            LazyColumn(
                modifier = Modifier.sizeIn(maxHeight = 220.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(candidates.indices.toList()) { index ->
                    CandidatePickRow(
                        label = candidates[index].displayLabel,
                        selected = selectedIndex == index,
                        onClick = { onSelectCandidate(index) },
                        modifier = Modifier.testTag("candidate_$index"),
                    )
                }
            }
        }
        selectedLabel?.let {
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("已选择", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onPrimaryContainer)
                    Text(
                        it,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.testTag("selected_label"),
                    )
                }
            }
        }
        OutlinedTextField(
            value = note,
            onValueChange = onNoteChange,
            label = { Text("备注") },
            placeholder = { Text("稍后阅读、项目资料") },
            supportingText = { Text("${note.length} / $MAX_NOTE_LENGTH") },
            enabled = !submitting,
            minLines = 2,
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier
                .fillMaxWidth()
                .testTag("note"),
        )
        StatusText(statusText)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = onCancel, enabled = !submitting, shape = RoundedCornerShape(24.dp), modifier = Modifier.weight(1f)) {
                Icon(Icons.Default.Close, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.share_cancel))
            }
            Button(onClick = onSave, enabled = submitEnabled, shape = RoundedCornerShape(24.dp), modifier = Modifier.weight(1.4f).testTag("save")) {
                if (submitting) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                } else {
                    Icon(Icons.Default.Check, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                }
                Text(stringResource(R.string.share_save))
            }
        }
    }
}

@Composable
private fun CandidatePickRow(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = modifier
            .fillMaxWidth()
            .clickable(role = Role.RadioButton, onClick = onClick),
    ) {
        Row(modifier = Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
            Box(
                modifier = Modifier
                    .padding(top = 3.dp)
                    .size(18.dp)
                    .background(if (selected) MaterialTheme.colorScheme.primary else Color.Transparent, CircleShape),
            )
            Text(label, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        }
    }
}

private data class AvatarTone(
    val container: Color,
    val content: Color,
)

private fun avatarTone(host: String): AvatarTone {
    val hash = host.fold(0) { acc, char -> (acc * 31 + char.code) and Int.MAX_VALUE }
    return AvatarPalette[hash % AvatarPalette.size]
}

private fun libraryEmptyText(state: CairnLinksUiState): String =
    if (state.searchQuery.isNotBlank()) {
        "没有匹配的链接。"
    } else {
        when (state.filter) {
            LinkFilter.All -> "还没有收藏链接。"
            LinkFilter.Unlearned -> "没有待学习链接。分享新链接后会出现在这里。"
            LinkFilter.Learned -> "没有已学习链接。"
        }
    }

private fun updateSettingSubtitle(state: CairnLinksUiState): String =
    when (val update = state.updateState) {
        is AppUpdateState.Available -> "发现 ${update.update.versionName} · 当前 ${state.currentVersionName}"
        AppUpdateState.Checking -> "正在检查 GitHub Release"
        is AppUpdateState.Downloading -> "正在下载 ${update.update.versionName}"
        AppUpdateState.Failed -> "检查失败 · 当前 ${state.currentVersionName}"
        AppUpdateState.Hidden -> "当前 ${state.currentVersionName} · 来源 GitHub Release"
        is AppUpdateState.InstallFailed -> "安装失败 · 可重试"
        is AppUpdateState.InstallPermissionRequired -> "需要安装权限"
        is AppUpdateState.InstallStarted -> "系统安装器已打开"
        AppUpdateState.UpToDate -> "当前 ${state.currentVersionName} · 已是最新"
    }
