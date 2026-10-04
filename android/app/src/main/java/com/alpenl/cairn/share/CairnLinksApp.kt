package com.alpenl.cairn.share

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
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
import androidx.compose.foundation.layout.WindowInsets
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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.SheetValue
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
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
import com.alpenl.cairn.share.network.CurationUpdate
import com.alpenl.cairn.share.network.BookmarkFilters

private object Routes {
    const val Library = "library"
    const val Queue = "queue"
    const val Settings = "settings"
    const val Search = "search"
    const val Detail = "detail/{id}"
    const val Edit = "edit/{id}"
    const val Update = "update"
    const val Uploads = "uploads"
    const val Console = "console"
    const val About = "about"
    const val Offline = "offline"

    fun detail(id: Int): String = "detail/$id"
    fun edit(id: Int): String = "edit/$id"
}

private data class TopDestination(
    val route: String,
    val label: String,
    val icon: ImageVector,
)

private val TopDestinations = listOf(
    TopDestination(Routes.Library, "收藏", CairnIcons.Library),
    TopDestination(Routes.Queue, "待读", CairnIcons.Reading),
    TopDestination(Routes.Settings, "设置", CairnIcons.Settings),
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
    if (!state.preferencesLoaded) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .background(MaterialTheme.colorScheme.background),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
        }
        return
    }

    val navController = rememberNavController()
    val snackbarHostState = remember { SnackbarHostState() }
    val currentEntry by navController.currentBackStackEntryAsState()
    val currentRoute = currentEntry?.destination?.route
    val onTagFilter: (ReaderTag) -> Unit = { tag ->
        viewModel.setBookmarkFilters(state.bookmarkFilters.withTag(tag))
        if (currentRoute != Routes.Library && currentRoute != Routes.Search) navController.navigate(Routes.Library) {
            launchSingleTop = true
        }
    }
    val showBottomBar = currentRoute in TopDestinations.map { it.route }
    val startDestination = restorableRoute(state.preferences.lastRoute) ?: Routes.Library

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

    LaunchedEffect(currentRoute) {
        currentRoute?.let(::restorableRoute)?.let(viewModel::setLastRoute)
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            if (showBottomBar) {
                CairnBottomBar(
                    currentRoute = currentRoute,
                    uploadCount = state.pendingUploads.size,
                    onNavigate = { route -> navController.navigateTop(route) },
                )
            }
        },
        floatingActionButton = {
            if (currentRoute == Routes.Library) {
                FloatingActionButton(
                    onClick = viewModel::openManualAdd,
                    shape = CircleShape,
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.primary,
                    elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 1.dp),
                    modifier = Modifier.size(52.dp).testTag("add_link"),
                ) { Icon(Icons.Default.Add, contentDescription = "收藏链接", modifier = Modifier.size(22.dp)) }
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets(0.dp),
        modifier = Modifier.fillMaxSize(),
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = startDestination,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .then(if (!showBottomBar) Modifier.navigationBarsPadding() else Modifier),
        ) {
            composable(Routes.Library) {
                LibraryScreen(
                    state = state,
                    onFilterChange = viewModel::setFilter,
                    onBookmarkFiltersChange = viewModel::setBookmarkFilters,
                    onTagFilter = onTagFilter,
                    onLoadMore = viewModel::loadMoreLibraryResults,
                    onRetryFilters = viewModel::retryLibraryFilters,
                    onRefresh = viewModel::refreshLinks,
                    onOpenSettings = { navController.navigateTop(Routes.Settings) },
                    onOpenSearch = { navController.navigate(Routes.Search) },
                    onOpenOffline = { navController.navigate(Routes.Offline) },
                    onOpenLinkDetail = { navController.navigate(Routes.detail(it.id)) },
                )
            }
            composable(Routes.Queue) {
                QueueScreen(
                    state = state,
                    onMarkAll = viewModel::markAllPendingLearned,
                    onRefresh = viewModel::refreshQueue,
                    onTagFilter = onTagFilter,
                    onLoadMore = viewModel::loadMoreQueue,
                    onOpenLinkDetail = { navController.navigate(Routes.detail(it.id)) },
                )
            }
            composable(Routes.Settings) {
                SettingsScreen(
                    state = state,
                    onCloseAfterSaveChange = viewModel::setCloseAfterSave,
                    onPreserveCompleteUrlChange = viewModel::setPreserveCompleteUrl,
                    onApiTokenChange = viewModel::setApiToken,
                    onOpenUploads = { navController.navigate(Routes.Uploads) },
                    onOpenConsole = { navController.navigate(Routes.Console) },
                    onOpenUpdate = { navController.navigate(Routes.Update) },
                    onOpenAbout = { navController.navigate(Routes.About) },
                    onClearOffline = viewModel::clearOfflineReading,
                    onDownloadLibrary = viewModel::downloadLibrary,
                    onAutomaticSync = viewModel::setAutomaticSync,
                    onImagesWifiOnly = viewModel::setImagesWifiOnly,
                    onStorageLimit = viewModel::setStorageLimitMb,
                    onCancelDownload = viewModel::cancelLibraryDownload,
                    onFlushPersonal = viewModel::flushPersonalTags,
                    onOpenOffline = { navController.navigate(Routes.Offline) },
                )
            }
            composable(Routes.Search) {
                SearchScreen(
                    state = state,
                    onBack = {
                        if (!navController.popBackStack()) {
                            navController.navigate(Routes.Library) {
                                popUpTo(navController.graph.startDestinationId) {
                                    inclusive = true
                                }
                                launchSingleTop = true
                            }
                        }
                    },
                    onSearchQueryChange = viewModel::setSearchQuery,
                    onLoadMoreSearchResults = viewModel::loadMoreSearchResults,
                    onTagFilter = onTagFilter,
                    onBookmarkFiltersChange = viewModel::setBookmarkFilters,
                    onOpenLinkDetail = { navController.navigate(Routes.detail(it.id)) },
                )
            }
            composable(Routes.Offline) {
                ScreenColumn {
                    DetailTopBar(title = "离线阅读", onBack = { navController.popBackStack() })
                    Text("本机保存的正文与图片；可在设置中下载或更新全部资料。", style = MaterialTheme.typography.bodySmall)
                    LinkList(items = state.offlineLinks.sortedWith(compareByDescending<SavedLink> { state.offlineReads[it.id]?.pinned == true }.thenByDescending { it.id }),
                        onTagFilter = onTagFilter,
                        taxonomy = state.v2Taxonomy ?: state.taxonomy,
                        loading = false, emptyText = "阅读后会自动保存正文；也可以在设置中下载全部资料。",
                        onOpenLinkDetail = { link -> viewModel.openOfflineLink(link); navController.navigate(Routes.detail(link.id)) })
                }
            }
            composable(
                route = Routes.Detail,
                arguments = listOf(navArgument("id") { type = NavType.IntType }),
            ) { entry ->
                val id = entry.arguments?.getInt("id") ?: return@composable
                DetailScreen(
                    id = id,
                    state = state,
                    onEnsureLink = { viewModel.ensureLink(it) },
                    onBack = { navController.popBackStack() },
                    onEdit = { navController.navigate(Routes.edit(id)) },
                    onOpenExternal = onOpenExternal,
                    onCopy = onCopy,
                    onToggleLearned = viewModel::toggleLearned,
                    onTagFilter = onTagFilter,
                    onLoadTaxonomy = { viewModel.loadTaxonomy() },
                    onSaveCuration = { update, onSuccess -> viewModel.saveCuration(id, update, onSuccess) },
                    onLoadV2 = viewModel::loadV2Selection,
                    onLoadV2Taxonomy = viewModel::loadV2Taxonomy,
                    onV2Action = { field, term, action -> viewModel.applyV2Action(id, field, term, action) },
                    onV2Reapply = { viewModel.reapplyV2Draft(id) },
                    onV2Discard = { viewModel.discardV2Draft(id) },
                    onFlushV2 = viewModel::flushV2Queue,
                    onFlushPersonal = viewModel::flushPersonalTags,
                    onOfflinePin = { pinned -> viewModel.setOfflinePinned(id, pinned) },
                    onRecoverLegacyV2 = { viewModel.recoverLegacyV2Actions(id, accountKeyFor(state.apiBaseUrl, state.preferences.apiToken)) },
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
            composable(Routes.Uploads) {
                PendingUploadsScreen(
                    state = state,
                    onBack = { navController.popBackStack() },
                    onRetryAll = viewModel::retryAllPendingUploads,
                    onRetry = viewModel::retryPendingUpload,
                    onDiscard = viewModel::discardPendingUpload,
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
        val savingNow by rememberUpdatedState(state.manualAdd.submitting)
        ModalBottomSheet(
            onDismissRequest = viewModel::closeManualAdd,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true,
                confirmValueChange = { it != SheetValue.Hidden || !savingNow }),
            properties = ModalBottomSheetProperties(shouldDismissOnBackPress = !state.manualAdd.submitting),
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            SaveLinkSheetContent(
                title = "收藏链接",
                subtitle = "把值得留住的内容，放进你的收藏。",
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
                completed = false,
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
private fun CairnBottomBar(currentRoute: String?, uploadCount: Int, onNavigate: (String) -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.navigationBarsPadding()) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(Modifier.fillMaxWidth()) {
                TopDestinations.forEach { destination ->
                    val selected = currentRoute == destination.route
                    val tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                    Surface(color = Color.Transparent, contentColor = tint,
                        modifier = Modifier.weight(1f).selectable(selected, role = Role.Tab,
                            onClick = { onNavigate(destination.route) }).testTag("nav_${destination.route}")) {
                        Column(Modifier.heightIn(min = 64.dp).padding(vertical = 9.dp),
                            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically)) {
                            BadgedIcon(destination.icon, destination.label, when (destination.route) {
                                Routes.Settings -> uploadCount.takeIf { it > 0 }
                                else -> null
                            })
                            Text(destination.label, style = MaterialTheme.typography.labelSmall,
                                fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal)
                        }
                    }
                }
            }
        }
    }
}

private fun NavHostController.navigateTop(route: String) {
    navigate(route) {
        popUpTo(graph.startDestinationId) {
            saveState = true
        }
        launchSingleTop = true
        restoreState = true
    }
}

private fun restorableRoute(route: String?): String? =
    when (route) {
        Routes.Library,
        Routes.Queue,
        Routes.Settings,
        Routes.Search -> route
        else -> null
    }

@Composable
private fun LibraryScreen(
    state: CairnLinksUiState,
    onFilterChange: (LinkFilter) -> Unit,
    onBookmarkFiltersChange: (BookmarkFilters) -> Unit,
    onTagFilter: (ReaderTag) -> Unit,
    onLoadMore: () -> Unit,
    onRetryFilters: () -> Unit,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenSearch: () -> Unit,
    onOpenOffline: () -> Unit,
    onOpenLinkDetail: (SavedLink) -> Unit,
) {
    val stats = remember(state.links, java.time.LocalDate.now()) { state.stats() }
    val items = remember(state.links, state.libraryResults, state.filter, state.bookmarkFilters) { state.visibleLibraryLinks() }
    val querying = state.usesLibraryQuery()
    val loading = if (querying) state.libraryLoading else state.loading
    ScreenColumn {
        LinkList(
            header = {
                Column(Modifier.testTag("library_header"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.fillMaxWidth().padding(top = 4.dp).heightIn(min = 48.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("收藏", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Medium)
                        Text(if (querying && !state.libraryStale && !loading) "${items.size} 条筛选结果" else "${stats.total} 条 · ${stats.pending} 未读",
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    HeaderIconButton(Icons.Default.Search, "搜索收藏", onOpenSearch, Modifier.testTag("open_search"))
                    if (state.offlineReads.isNotEmpty()) HeaderIconButton(CairnIcons.Offline, "离线阅读", onOpenOffline, Modifier.testTag("open_offline_reading"))
                    HeaderIconButton(Icons.Default.Refresh, if (querying) "重新筛选" else "刷新收藏", if (querying) onRetryFilters else onRefresh,
                        Modifier.testTag(if (querying) "retry_library_filters" else "refresh_library"), enabled = !loading)
                }
                if (state.preferences.apiToken.isBlank()) {
                    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.primaryContainer) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("连接你的收藏库", style = MaterialTheme.typography.titleMedium)
                            Text("填入访问 Token，即可同步和阅读已收藏的内容。", style = MaterialTheme.typography.bodySmall)
                            Button(onClick = onOpenSettings, modifier = Modifier.testTag("connect_library")) { Text("前往设置") }
                        }
                    }
                }
                BookmarkFilterPanel(state.bookmarkFilters, state.v2Taxonomy ?: state.taxonomy, onBookmarkFiltersChange,
                    state.apiBaseUrl, state.preferences.apiToken, learned = state.filter.apiValue,
                    leadingContent = { FilterRow(state.filter, true, onFilterChange, Modifier.weight(1f)) })
                if (!querying && !state.loading && state.statusText.isNotBlank() && !state.statusText.startsWith("已同步") && !state.statusText.startsWith("已加载")) StatusText(state.statusText)
                if (querying && !state.libraryStatusText.startsWith("已显示")) {
                    Text((if (state.libraryStale) "上一次条件的结果 · " else "") + state.libraryStatusText, Modifier.fillMaxWidth().testTag("library_filter_status"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                }
            },
            items = items,
            onTagFilter = onTagFilter,
            taxonomy = state.v2Taxonomy ?: state.taxonomy,
            loading = loading && items.isEmpty(),
            emptyText = if (querying) state.libraryStatusText.ifBlank { "正在筛选..." } else libraryEmptyText(state),
            onOpenLinkDetail = onOpenLinkDetail,
            refreshing = !querying && state.loading && items.isNotEmpty(),
            hasMore = querying && state.libraryNextBeforeId != null,
            loadingMore = querying && loading && items.isNotEmpty(),
            onLoadMore = onLoadMore,
        )
    }
}

@Composable
private fun SearchScreen(
    state: CairnLinksUiState,
    onBack: () -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onLoadMoreSearchResults: () -> Unit,
    onBookmarkFiltersChange: (BookmarkFilters) -> Unit,
    onTagFilter: (ReaderTag) -> Unit,
    onOpenLinkDetail: (SavedLink) -> Unit,
) {
    val results = remember(state.searchResults) { state.searchResultLinks() }
    ScreenColumn {
        DetailTopBar(title = "搜索", onBack = onBack)
        SearchField(
            value = state.searchQuery,
            onValueChange = onSearchQueryChange,
            enabled = true,
        )
        BookmarkFilterPanel(state.bookmarkFilters, state.v2Taxonomy ?: state.taxonomy, onBookmarkFiltersChange, state.apiBaseUrl, state.preferences.apiToken, query = state.searchQuery)
        if (state.searchQuery.isNotBlank()) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text((if (state.searchStale) "上一次搜索的结果 · " else "") + state.searchStatusText, Modifier.weight(1f).testTag("search_status"), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { onSearchQueryChange(state.searchQuery) }, enabled = !state.searchLoading) { Text("重新搜索") }
        }
        LinkList(
            items = results,
            onTagFilter = onTagFilter,
            taxonomy = state.v2Taxonomy ?: state.taxonomy,
            loading = state.searchLoading && results.isEmpty(),
            emptyText = when {
                state.searchQuery.isBlank() -> "搜索标题、正文、摘要、收藏原因或链接。"
                state.searchLoading -> "正在搜索..."
                else -> state.searchStatusText.ifBlank { "没有匹配的链接。" }
            },
            onOpenLinkDetail = onOpenLinkDetail,
            hasMore = state.searchNextBeforeId != null,
            loadingMore = state.searchLoading && results.isNotEmpty(),
            onLoadMore = onLoadMoreSearchResults,
        )
    }
}

@Composable
private fun QueueScreen(
    state: CairnLinksUiState,
    onMarkAll: () -> Unit,
    onRefresh: () -> Unit,
    onTagFilter: (ReaderTag) -> Unit,
    onLoadMore: () -> Unit,
    onOpenLinkDetail: (SavedLink) -> Unit,
) {
    val queue = state.queueResults
    var menuExpanded by remember { mutableStateOf(false) }
    var confirmLoaded by rememberSaveable(state.accountGeneration) { mutableStateOf(false) }
    LaunchedEffect(state.accountGeneration) { onRefresh() }
    ScreenColumn {
        AppHeader(
            title = "稍后阅读",
            subtitle = state.queueTotal?.let { "$it 条待读 · 从最早的收藏开始" } ?: "按收藏先后排队，先进先读",
            actions = {
                HeaderIconButton(Icons.Default.Refresh, "刷新待读", onRefresh, enabled = !state.queueLoading)
                Box {
                    IconButton(onClick = { menuExpanded = true }) { Icon(CairnIcons.More, contentDescription = "待读操作") }
                    DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                        DropdownMenuItem(text = { Text("将已加载的收藏标为已读") }, onClick = { menuExpanded = false; confirmLoaded = true },
                            enabled = state.queueAvailable == true && !state.queueLoading && queue.isNotEmpty() && state.busyIds.isEmpty(),
                            modifier = Modifier.testTag("mark_all_learned"))
                    }
                }
            },
        )
        if (state.queueStatusText.isNotBlank()) Text(state.queueStatusText, Modifier.testTag("queue_status"),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        LinkList(
            items = queue,
            onTagFilter = onTagFilter,
            taxonomy = state.v2Taxonomy ?: state.taxonomy,
            loading = state.queueLoading && queue.isEmpty(),
            emptyText = state.queueStatusText.ifBlank { "正在读取待读列表…" },
            onOpenLinkDetail = onOpenLinkDetail,
            fifo = true,
            hasMore = state.queueNextCursor != null,
            loadingMore = state.queueLoading && queue.isNotEmpty(),
            onLoadMore = onLoadMore,
        )
    }
    if (confirmLoaded) AlertDialog(onDismissRequest = { confirmLoaded = false },
        title = { Text("标记已显示的 ${queue.size} 条？") },
        text = { Text("仅将当前加载的收藏标记为已读；全库其余未加载收藏会继续排队。") },
        confirmButton = { TextButton(onClick = { confirmLoaded = false; onMarkAll() }, enabled = !state.queueLoading && state.queueAvailable == true) { Text("标记这 ${queue.size} 条") } },
        dismissButton = { TextButton(onClick = { confirmLoaded = false }) { Text("取消") } })
}

@Composable
private fun PendingUploadsScreen(
    state: CairnLinksUiState,
    onBack: () -> Unit,
    onRetryAll: () -> Unit,
    onRetry: (String) -> Unit,
    onDiscard: (String) -> Unit,
) {
    var discardId by rememberSaveable { mutableStateOf<String?>(null) }
    ScreenColumn {
        DetailTopBar(
            title = "待上传队列",
            onBack = onBack,
            actions = {
                IconButton(
                    onClick = onRetryAll,
                    enabled = state.pendingUploads.isNotEmpty() && !state.retryingUploads,
                    modifier = Modifier.testTag("retry_all_uploads"),
                ) {
                    Icon(Icons.Default.Refresh, contentDescription = "全部重试")
                }
            },
        )
        when {
            !state.pendingUploadsLoaded -> LoadingState("正在读取本地队列...")
            state.pendingUploads.isEmpty() -> EmptyState("没有待上传链接。网络不可用时，新链接会安全保存在这里。")
            else -> {
                Text(
                    "${state.pendingUploads.size} 条链接保存在本机。每次打开应用都会自动尝试上传。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                    contentPadding = PaddingValues(vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(state.pendingUploads, key = PendingUpload::id) { upload ->
                        PendingUploadRow(
                            upload = upload,
                            busy = upload.id in state.uploadBusyIds,
                            retryAllRunning = state.retryingUploads,
                            tokenConfigured = state.preferences.apiToken.isNotBlank(),
                            onRetry = { onRetry(upload.id) },
                            onDiscard = { discardId = upload.id },
                        )
                    }
                }
            }
        }
    }

    if (discardId != null) {
        AlertDialog(
            onDismissRequest = { discardId = null },
            title = { Text("移除本地链接？") },
            text = { Text("这条链接尚未上传。移除后无法从本地队列恢复。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        discardId?.let(onDiscard)
                        discardId = null
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    modifier = Modifier.testTag("confirm_discard_upload"),
                ) {
                    Text("移除")
                }
            },
            dismissButton = {
                TextButton(onClick = { discardId = null }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun PendingUploadRow(
    upload: PendingUpload,
    busy: Boolean,
    retryAllRunning: Boolean,
    tokenConfigured: Boolean,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("pending_upload_${upload.id}"),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                upload.url.hostLabel(),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                upload.url,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (upload.note.isNotBlank()) {
                Text(
                    upload.note,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                "本地保存于 ${upload.createdAtEpochMillis.shortDateTime()} · ${pendingUploadStatus(upload, busy, tokenConfigured)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedButton(
                    onClick = onRetry,
                    enabled = !busy && !retryAllRunning,
                    shape = RoundedCornerShape(24.dp),
                    modifier = Modifier
                        .weight(1f)
                        .testTag("retry_upload_${upload.id}"),
                ) {
                    if (busy) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    } else {
                        Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(if (busy) "上传中" else "重试")
                }
                IconButton(onClick = onDiscard, enabled = !busy && !retryAllRunning) {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = "从本地队列移除",
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
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
    onTagFilter: (ReaderTag) -> Unit,
    onLoadTaxonomy: () -> Unit,
    onSaveCuration: (CurationUpdate, () -> Unit) -> Unit,
    onLoadV2: (Int, Boolean) -> Unit,
    onLoadV2Taxonomy: () -> Unit,
    onV2Action: (String, String, String) -> Unit,
    onV2Reapply: () -> Unit,
    onV2Discard: () -> Unit,
    onFlushV2: () -> Unit,
    onFlushPersonal: () -> Unit,
    onOfflinePin: (Boolean) -> Unit,
    onRecoverLegacyV2: () -> Unit,
    onDelete: () -> Unit,
) {
    val link = state.links.firstOrNull { it.id == id }
    val loadState = state.detailLoads[id]
    var confirmDelete by rememberSaveable { mutableStateOf(false) }
    var showMenu by remember { mutableStateOf(false) }
    var showOriginal by rememberSaveable(id, state.accountGeneration) { mutableStateOf(false) }
    var curateExpanded by rememberSaveable(id, state.accountGeneration) { mutableStateOf(false) }
    val editorState = rememberSaveableStateHolder()
    val personalEditor = rememberSaveable(id, state.accountGeneration, saver = PersonalTagEditorDraft.saver) { PersonalTagEditorDraft() }
    val enrichment = link?.enrichment
    val readingText = if (showOriginal || enrichment?.translatedText.isNullOrBlank()) enrichment?.originalText.orEmpty() else enrichment?.translatedText.orEmpty()
    val paragraphs = remember(readingText) { readingText.split(Regex("\\n+")).map { it.trim() }.filter { it.isNotEmpty() } }
    LaunchedEffect(id, state.accountGeneration, link?.enrichment?.cacheIdentity,
        link?.enrichment?.updatedAt, link?.enrichment?.status, link?.url, link?.note) {
        onEnsureLink(id)
        onLoadV2(id, true)
        onLoadV2Taxonomy()
    }

    ScreenColumn {
        DetailTopBar(title = "阅读", onBack = onBack, actions = {
            Box {
                IconButton(onClick = { showMenu = true }, enabled = link != null, modifier = Modifier.size(48.dp).testTag("reader_more")) {
                    Icon(CairnIcons.More, contentDescription = "更多操作")
                }
                DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                    DropdownMenuItem(text = { Text("编辑链接") }, leadingIcon = { Icon(Icons.Default.Edit, contentDescription = "编辑") },
                        onClick = { showMenu = false; onEdit() })
                    DropdownMenuItem(text = { Text("复制链接") }, onClick = { showMenu = false; link?.let { onCopy(it.url) } })
                    state.offlineReads[id]?.let { cached ->
                        DropdownMenuItem(text = { Text(if (cached.pinned) "取消离线固定" else "固定离线正文") },
                            leadingIcon = { Icon(CairnIcons.Offline, contentDescription = null) },
                            onClick = { showMenu = false; onOfflinePin(!cached.pinned) }, modifier = Modifier.testTag("offline_read_pin"))
                    }
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text("删除收藏", color = MaterialTheme.colorScheme.error) },
                        leadingIcon = { Icon(Icons.Default.Delete, contentDescription = "删除", tint = MaterialTheme.colorScheme.error) },
                        enabled = id !in state.busyIds, onClick = { showMenu = false; confirmDelete = true })
                }
            }
        })
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f).testTag("detail_content"),
            verticalArrangement = Arrangement.spacedBy(14.dp), contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            if (link != null) {
                // 内容优先：标题与操作最先出现，归档正文紧随其后；
                // 整理、备注、元信息等次要内容全部沉到正文之后。
                item(key = "link") {
                    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        LinkDetailContent(link)
                    }
                }
                item(key = "curation_overview") {
                    Column(Modifier.fillMaxWidth().testTag("reader_curation"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        val effective = state.v2Drafts[id] ?: state.v2Selections[id]
                        val vocabulary = state.v2Taxonomy ?: state.taxonomy
                        val offlineLabels = state.offlineReads[id]?.tagLabels.orEmpty()
                        val tags = if (effective == null && vocabulary == null && offlineLabels.isNotEmpty()) offlineLabels else readerTags(link, effective, vocabulary)
                        if (!curateExpanded) {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                if (tags.isNotEmpty()) ReaderTagChips(tags, onTagFilter, Modifier.weight(1f).testTag("reader_tag_overview"))
                                else Text("标签与备注", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                IconButton(onClick = { curateExpanded = true }, modifier = Modifier.size(48.dp).testTag("reader_curation_toggle").semantics { stateDescription = "已折叠" }) {
                                    Icon(CairnIcons.Chevron, contentDescription = "编辑标签与备注", modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            if (enrichment?.why?.isNotBlank() == true) Text(enrichment.why, maxLines = 1,
                                overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                            if ((state.v2Queued[id] ?: 0) > 0 || state.v2Conflicts.containsKey(id) || (state.personalTagQueued[id] ?: 0) > 0) Text("有待同步或冲突的标签修改，展开后处理。", style = MaterialTheme.typography.bodySmall)
                        } else {
                            TextButton(onClick = { curateExpanded = false }, modifier = Modifier.testTag("reader_curation_toggle").semantics { stateDescription = "已展开" }) {
                                Text("收起标签与备注", style = MaterialTheme.typography.labelMedium)
                            }
                            editorState.SaveableStateProvider("$id:${state.accountGeneration}") {
                            MultidimensionalCurationSection(
                                linkId = id, taxonomy = state.v2Taxonomy ?: state.taxonomy,
                                selection = state.v2Selections[id], draft = state.v2Drafts[id],
                                conflictRevision = state.v2Conflicts[id], busy = id in state.v2Busy,
                                queuedCount = state.v2Queued[id] ?: 0, available = state.v2Available,
                                onLoadTaxonomy = onLoadV2Taxonomy, onAction = onV2Action,
                                onReapply = onV2Reapply, onDiscard = onV2Discard, onFlush = onFlushV2,
                                onExport = { onCopy(v2ExportMarkdown(link, effective, state.v2Taxonomy ?: state.taxonomy)) },
                            )
                            PersonalTagsSection(linkId = id, baseUrl = state.apiBaseUrl, apiToken = state.preferences.apiToken,
                                onChanged = { onLoadV2(id, true); onEnsureLink(id) }, onFlush = onFlushPersonal, editorDraft = personalEditor)
                            if (enrichment != null) BookmarkCuration(id, enrichment, state.v2Taxonomy ?: state.taxonomy,
                                id in state.busyIds, onLoadTaxonomy, onSaveCuration)
                            val legacyActions = state.v2LegacyActions[id].orEmpty()
                            if (legacyActions.isNotEmpty()) LegacyCurationRecoveryNotice(id, accountKeyFor(state.apiBaseUrl, state.preferences.apiToken),
                                legacyActions, onRecoverLegacyV2)
                            }
                        }
                    }
                }
                state.offlineReads[id]?.takeIf { !it.verified || loadState == DetailLoadState.Failed || it.expired() }?.let { cached ->
                    item(key = "offline_state") {
                        Text("本地缓存；云端版本尚未确认 · ${java.time.Instant.ofEpochMilli(cached.savedAt).toString().shortDateTime()}${if (cached.expired()) " · 超过 7 天，请联网刷新" else ""}",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.testTag("offline_read_status"))
                    }
                }
                if (loadState == DetailLoadState.Loading) item(key = "loading") { LoadingState("正在加载归档内容...") }
                if (loadState == DetailLoadState.Failed) item(key = "retry") {
                    TextButton(onClick = { onEnsureLink(id) }) { Text("读取归档内容失败，点击重试") }
                }
                if (enrichment != null) {
                    if (enrichment.summary.isNotBlank()) {
                        item(key = "summary") { InfoBlock("摘要", enrichment.summary) }
                    }
                    if (readingText.isNotBlank()) {
                        item(key = "reading_controls") {
                            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(if (showOriginal || enrichment.translatedText.isBlank()) "原文 ${enrichment.originalLanguage}" else "中文译文", modifier = Modifier.align(Alignment.CenterVertically), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                if (enrichment.originalText.isNotBlank() && enrichment.translatedText.isNotBlank()) TextButton(
                                    onClick = { showOriginal = !showOriginal }, modifier = Modifier.testTag("toggle_original"),
                                ) { Text(if (showOriginal) "查看译文" else "查看原文") }
                                TextButton(onClick = { onCopy(readingText) }) { Text("复制全文", style = MaterialTheme.typography.labelMedium) }
                            }
                        }
                        items(paragraphs.size, key = { "paragraph_$it" }, contentType = { "paragraph" }) { index ->
                            SelectionContainer { Text(paragraphs[index], style = MaterialTheme.typography.bodyLarge) }
                        }
                    }
                    items(enrichment.imageKeys, key = { "image_$it" }, contentType = { "image" }) { key ->
                        BookmarkImage(state.apiBaseUrl, state.preferences.apiToken, key, enrichment.imageVersions[key] ?: link.mediaVersion(), enrichment.imageVersions[key])
                    }
                    if (enrichment.relatedLinks.isNotEmpty()) item(key = "links_title") { SectionLabel("相关链接") }
                    items(enrichment.relatedLinks, key = { "related_$it" }, contentType = { "related" }) { url ->
                        TextButton(onClick = { if (validateHttpUrl(url)) onOpenExternal(url) }) { Text(url) }
                    }
                    // 次要区域：整理信息、备注与元数据，放在全部正文之后。
                    item(key = "secondary") {
                        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            Text(enrichment.statusLabel(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            LinkDetailSecondary(link)
                        }
                    }
                } else if (link.note.isNotBlank()) {
                    item(key = "note_only") { InfoBlock("备注", link.note) }
                }
            } else item {
                when (loadState) {
                    DetailLoadState.Loading -> LoadingState("正在加载链接详情...")
                    DetailLoadState.NotFound -> EmptyState("这条链接不存在或已经被删除。")
                    else -> TextButton(onClick = { onEnsureLink(id) }) { Text("无法加载链接详情，点击重试") }
                }
            }
        }
        if (link != null) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { onToggleLearned(link) }, enabled = id !in state.busyIds,
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
                    shape = MaterialTheme.shapes.small, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("toggle_${link.id}")) {
                    if (id in state.busyIds) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp)); Text(if (link.learned) "改为未读" else "标为已读")
                }
                Button(onClick = { onOpenExternal(link.url) }, shape = MaterialTheme.shapes.small,
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.primary),
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("open_original")) {
                    Text("打开原帖"); Spacer(Modifier.width(6.dp))
                    Icon(CairnIcons.External, contentDescription = null, modifier = Modifier.size(18.dp))
                }
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
    var confirmLeave by rememberSaveable(id, state.accountGeneration) { mutableStateOf(false) }
    val dirty = draft != null && link != null && (draft.url != link.url || draft.note != link.note)
    val requestBack = {
        if (draft?.saving != true) {
            if (dirty) confirmLeave = true else onBack()
        }
    }
    BackHandler(enabled = dirty || draft?.saving == true) { requestBack() }
    LaunchedEffect(id) { onEnsureLink(id) }
    LaunchedEffect(link?.id) {
        if (link != null) onBeginEdit(link)
    }

    ScreenColumn {
        DetailTopBar(
            title = "编辑链接",
            onBack = requestBack,
            actions = {
                TextButton(onClick = onSave, enabled = draft != null && !draft.saving, modifier = Modifier.testTag("save_edit")) {
                    Text("保存")
                }
            },
        )
        Column(Modifier.fillMaxWidth().weight(1f).imePadding().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
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
            OutlinedButton(
                onClick = { confirmDelete = true },
                enabled = !draft.saving,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                shape = MaterialTheme.shapes.small,
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
    }

    if (confirmLeave) AlertDialog(
        onDismissRequest = { confirmLeave = false },
        title = { Text("放弃尚未保存的修改？") },
        text = { Text("返回后，这次对链接和备注的修改将不会保存。") },
        confirmButton = { TextButton(onClick = {
            confirmLeave = false
            link?.let { onUrlChange(it.url); onNoteChange(it.note) }
            onBack()
        }, modifier = Modifier.testTag("discard_edit")) { Text("放弃修改") } },
        dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text("继续编辑") } },
    )

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
    val update = when (val updateState = state.updateState) {
        is AppUpdateState.Available -> updateState.update
        is AppUpdateState.Downloading -> updateState.update
        is AppUpdateState.InstallFailed -> updateState.update
        is AppUpdateState.InstallPermissionRequired -> updateState.update
        is AppUpdateState.InstallStarted -> updateState.update
        AppUpdateState.Checking,
        AppUpdateState.Failed,
        AppUpdateState.Hidden,
        AppUpdateState.UpToDate -> null
    }
    ScreenColumn(scroll = true) {
        DetailTopBar(title = "检查更新", onBack = onBack)
        UpdatePanel(
            updateState = state.updateState,
            currentVersionName = state.currentVersionName,
            onCheck = onCheck,
            onInstallUpdate = onInstallUpdate,
        )
        if (update != null) {
            SectionLabel("${update.versionName} 更新内容")
            InfoBlock(update.releaseNotes)
        }
        SectionLabel("安装方式")
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
        InfoBlock("接口使用部署侧访问 Token 保护。Token 和尚未上传的链接保存在本机；本地链接上传成功后会从待上传队列移除。")
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
internal fun ScreenColumn(scroll: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize().statusBarsPadding(), contentAlignment = Alignment.TopCenter) {
        val base = Modifier.widthIn(max = 720.dp).fillMaxSize().padding(horizontal = 20.dp).padding(bottom = 8.dp)
        Column(modifier = if (scroll) base.verticalScroll(rememberScrollState()) else base,
            verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

@Composable
internal fun AppHeader(
    title: String,
    subtitle: String,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
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
        IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", modifier = Modifier.size(20.dp))
        }
        Text(
            title,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Normal,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(content = actions)
    }
}

@Composable
private fun HeaderIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(48.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
    ) {
        Icon(icon, contentDescription = contentDescription, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun SearchField(value: String, onValueChange: (String) -> Unit, enabled: Boolean) {
    val focus = LocalFocusManager.current
    OutlinedTextField(value = value, onValueChange = onValueChange,
        placeholder = { Text("搜索标题、正文或备注") },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        trailingIcon = { if (value.isNotEmpty()) IconButton(onClick = { onValueChange("") }, modifier = Modifier.testTag("clear_search")) {
            Icon(Icons.Default.Close, contentDescription = "清除搜索")
        } },
        enabled = enabled, singleLine = true, shape = MaterialTheme.shapes.small,
        colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
        modifier = Modifier.fillMaxWidth().testTag("library_search"))
}

@Composable
private fun FilterRow(
    selected: LinkFilter,
    enabled: Boolean,
    onFilterChange: (LinkFilter) -> Unit,
    modifier: Modifier = Modifier,
) {
    // 用轻量的文本切换代替一排 Chip，降低视觉噪声，让链接列表成为主角。
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = modifier.fillMaxWidth()) {
        FilterTab("全部", selected == LinkFilter.All, enabled, { onFilterChange(LinkFilter.All) }, Modifier.weight(1f).testTag("filter_all"))
        FilterTab("未读", selected == LinkFilter.Unlearned, enabled, { onFilterChange(LinkFilter.Unlearned) }, Modifier.weight(1f).testTag("filter_unlearned"))
        FilterTab("已读", selected == LinkFilter.Learned, enabled, { onFilterChange(LinkFilter.Learned) }, Modifier.weight(1f).testTag("filter_learned"))
    }
}

@Composable
private fun FilterTab(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        color = Color.Transparent,
        contentColor = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.selectable(selected = selected, enabled = enabled, role = Role.Tab, onClick = onClick)) {
        val accent = MaterialTheme.colorScheme.primary
        Box(Modifier.heightIn(min = 48.dp).drawBehind {
            if (selected) drawLine(accent, Offset(size.width * 0.4f, size.height - 1.dp.toPx()), Offset(size.width * 0.6f, size.height - 1.dp.toPx()), 2.dp.toPx())
        }.padding(horizontal = 8.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
            Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal)
        }
    }
}

@Composable
internal fun StatusText(status: String, tag: String = "status") {
    if (status.isBlank()) return
    Surface(
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceVariant,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            status,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .padding(horizontal = 12.dp, vertical = 10.dp)
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
    onTagFilter: ((ReaderTag) -> Unit)? = null,
    fifo: Boolean = false,
    refreshing: Boolean = false,
    hasMore: Boolean = false,
    loadingMore: Boolean = false,
    onLoadMore: (() -> Unit)? = null,
    taxonomy: com.alpenl.cairn.share.network.BookmarkTaxonomy? = null,
    header: (@Composable () -> Unit)? = null,
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxWidth()
            .weight(1f, fill = true),
        verticalArrangement = Arrangement.spacedBy(0.dp),
        contentPadding = PaddingValues(bottom = 92.dp),
    ) {
        if (header != null) item(key = "list_header", contentType = "header") { header() }
        if (refreshing) {
            item {
                LinearProgressIndicator(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("list_refreshing"),
                )
            }
        }
        if (loading && items.isEmpty()) {
            item { LoadingState("正在加载链接...") }
        } else if (items.isEmpty()) {
            item { EmptyState(emptyText) }
        }
        items(items, key = { it.id }, contentType = { "link" }) { link ->
            LinkRow(
                link = link,
                fifo = fifo,
                taxonomy = taxonomy,
                onTagFilter = onTagFilter,
                onClick = { onOpenLinkDetail(link) },
            )
        }
        if (loadingMore) {
            item {
                LinearProgressIndicator(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("list_loading_more"),
                )
            }
        } else if (hasMore && onLoadMore != null) {
            item {
                OutlinedButton(
                    onClick = onLoadMore,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("load_more"),
                ) {
                    Text("加载更多")
                }
            }
        }
    }
}

@Composable
private fun LinkRow(link: SavedLink, fifo: Boolean, taxonomy: com.alpenl.cairn.share.network.BookmarkTaxonomy?,
    onTagFilter: ((ReaderTag) -> Unit)?, onClick: () -> Unit) {
    val title = remember(link.url, link.enrichment?.aiTitle) { link.displayTitle() }
    val preview = link.searchExcerpt.takeIf { it.isNotBlank() } ?: link.enrichment?.summary?.takeIf { it.isNotBlank() }
        ?: link.note.ifBlank { link.enrichment?.why.orEmpty() }
    Surface(onClick = onClick, color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().testTag("link_${link.id}")) {
        Column {
        Column(Modifier.padding(vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StateDot(link.learned)
                Text(link.hostLabel(), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text((if (fifo) "收藏于 " else "") + link.createdAt.shortDateTime(), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Medium,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (preview.isNotBlank()) Text(preview, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val tags = readerTags(link, null, taxonomy)
            if (tags.isNotEmpty()) {
                if (onTagFilter != null) ReaderTagChips(tags, onTagFilter, Modifier.testTag("link_tags_${link.id}"), compact = true)
                else Text(tags.take(5).joinToString(" · ") { it.label }, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("link_tags_${link.id}"))
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

@Composable
private fun LinkDetailContent(link: SavedLink) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        Text("${link.hostLabel()} · ${link.createdAt.shortDateTime()}",
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(link.displayTitle(), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun LinkDetailSecondary(link: SavedLink) {
    if (link.note.isNotBlank()) InfoBlock(title = "我的备注", text = link.note)
    Text("收藏于 ${link.createdAt.shortDateTime()}" + (link.learnedAt?.let { " · 已读于 ${it.shortDateTime()}" } ?: ""),
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
internal fun SectionLabel(title: String, trailing: String? = null) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(top = 4.dp),
    ) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
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
    val lineColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.22f)
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).drawBehind {
        drawLine(lineColor, Offset.Zero, Offset(0f, size.height), 2.dp.toPx())
    }.padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            title?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
private fun LoadingState(text: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(strokeWidth = 1.5.dp, modifier = Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun EmptyState(text: String) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 28.dp, vertical = 38.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(CairnIcons.Library, contentDescription = null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(24.dp))
            Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
}

@Composable
private fun StateDot(learned: Boolean) {
    Box(
        modifier = Modifier
            .semantics { stateDescription = if (learned) "已读" else "未读" }
            .size(6.dp)
            .background(
                color = if (learned) MaterialTheme.colorScheme.outlineVariant else MaterialTheme.colorScheme.primary,
                shape = CircleShape,
            ),
    )
}

@Composable
private fun BadgedIcon(icon: ImageVector, contentDescription: String, badge: Int?) {
    Box {
        Icon(icon, contentDescription = contentDescription, modifier = Modifier.size(20.dp))
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

private fun libraryEmptyText(state: CairnLinksUiState): String =
    when (state.filter) {
        LinkFilter.All -> "还没有收藏链接。"
        LinkFilter.Unlearned -> "没有未读收藏。新收藏的内容会出现在这里。"
        LinkFilter.Learned -> "还没有已读收藏。"
    }

private fun pendingUploadStatus(upload: PendingUpload, busy: Boolean, tokenConfigured: Boolean): String =
    when {
        busy -> "正在上传"
        !tokenConfigured -> "等待配置 Token"
        upload.lastFailure == null -> "等待首次上传"
        upload.lastFailure == com.alpenl.cairn.share.network.FailureKind.Unauthorized -> "等待更新 Token"
        upload.lastFailure == com.alpenl.cairn.share.network.FailureKind.Network -> "等待网络恢复"
        upload.lastFailure == com.alpenl.cairn.share.network.FailureKind.Timeout -> "等待网络稳定"
        else -> "等待服务恢复"
    }

internal fun apiTokenSubtitle(token: String): String {
    val trimmed = token.trim()
    return if (trimmed.isBlank()) {
        "未配置 · 新链接只保存在本地"
    } else {
        "已保存 · ${maskedToken(trimmed)}"
    }
}

private fun maskedToken(token: String): String =
    if (token.length <= 10) {
        "••••"
    } else {
        "${token.take(4)}••••${token.takeLast(4)}"
    }

internal fun updateSettingSubtitle(state: CairnLinksUiState): String =
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
