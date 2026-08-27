package com.alpenl.cairn.share

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.alpenl.cairn.share.network.ApiDebugClient
import com.alpenl.cairn.share.network.ApiDebugMethod
import com.alpenl.cairn.share.network.ApiDebugResult
import com.alpenl.cairn.share.network.LinkCreateResult
import com.alpenl.cairn.share.network.LinkFilter
import com.alpenl.cairn.share.network.LinkGetResult
import com.alpenl.cairn.share.network.LinkListResult
import com.alpenl.cairn.share.network.LinkMutationResult
import com.alpenl.cairn.share.network.LinkPageResult
import com.alpenl.cairn.share.network.SavedLink
import com.alpenl.cairn.share.network.UpdateApiClient
import com.alpenl.cairn.share.network.UpdateCheckResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

internal data class CairnLinksUiState(
    val apiBaseUrl: String,
    val releasesApiUrl: String,
    val currentVersionName: String,
    val currentVersionCode: Int,
    val links: List<SavedLink> = emptyList(),
    val loading: Boolean = false,
    val statusText: String = "",
    val filter: LinkFilter = LinkFilter.All,
    val searchQuery: String = "",
    val searchResults: List<SavedLink> = emptyList(),
    val searchLoading: Boolean = false,
    val searchNextBeforeId: Int? = null,
    val searchStatusText: String = "",
    val busyIds: Set<Int> = emptySet(),
    val detailLoads: Map<Int, DetailLoadState> = emptyMap(),
    val editDraft: EditDraft? = null,
    val manualAdd: ManualAddState = ManualAddState(),
    val preferences: SharePreferences = SharePreferences(),
    val updateState: AppUpdateState = AppUpdateState.Hidden,
    val apiDebug: ApiDebugUiState = ApiDebugUiState(),
    val message: UiMessage? = null,
)

internal enum class DetailLoadState {
    Loading,
    NotFound,
    Failed,
}

internal data class EditDraft(
    val id: Int,
    val url: String,
    val note: String,
    val saving: Boolean = false,
    val error: String = "",
)

internal data class ManualAddState(
    val visible: Boolean = false,
    val url: String = "",
    val note: String = "",
    val submitting: Boolean = false,
    val statusText: String = "",
)

internal data class ApiDebugUiState(
    val method: ApiDebugMethod = ApiDebugMethod.GET,
    val path: String = "/api/links?limit=50&learned=false",
    val body: String = "{\n  \"url\": \"https://example.com\",\n  \"note\": \"\"\n}",
    val sending: Boolean = false,
    val statusLine: String = "未发送",
    val responseText: String = "",
)

internal data class UiMessage(
    val id: Long,
    val text: String,
    val actionLabel: String? = null,
    val undo: UndoLearned? = null,
)

internal data class UndoLearned(
    val linkId: Int,
    val learned: Boolean,
)

internal data class LinkStats(
    val total: Int,
    val pending: Int,
    val learned: Int,
    val weekDone: Int,
    val oldestPending: SavedLink?,
) {
    val progress: Float = if (total == 0) 0f else learned.toFloat() / total.toFloat()
}

internal class CairnLinksViewModel(
    private val repository: LinkRepository,
    private val updateApiClient: UpdateApiClient,
    private val settingsStore: SharePreferencesStore,
    private val apiDebugClient: ApiDebugClient,
    apiBaseUrl: String,
    releasesApiUrl: String,
    currentVersionName: String,
    currentVersionCode: Int,
) : ViewModel() {
    var uiState by mutableStateOf(
        CairnLinksUiState(
        apiBaseUrl = apiBaseUrl,
        releasesApiUrl = releasesApiUrl,
        currentVersionName = currentVersionName,
        currentVersionCode = currentVersionCode,
        ),
    )
        private set

    private var messageId = 0L
    private var searchJob: Job? = null

    init {
        observeSettings()
        refreshLinks()
        checkForUpdates()
    }

    fun refreshLinks() {
        if (uiState.loading) return
        val hadLinks = uiState.links.isNotEmpty()
        uiState = uiState.copy(
            loading = true,
            statusText = if (hadLinks) "正在刷新链接..." else "正在同步云端链接...",
        )
        viewModelScope.launch {
            when (val result = withContext(Dispatchers.IO) { repository.loadAll() }) {
                is LinkListResult.Loaded -> {
                    uiState = uiState.copy(
                        links = result.items.sortedByDescending { it.id },
                        loading = false,
                        statusText = if (result.items.isEmpty()) "还没有收藏链接。" else "已同步 ${result.items.size} 条链接。",
                    )
                }
                is LinkListResult.Failed -> {
                    uiState = uiState.copy(
                        loading = false,
                        statusText = "加载失败。请检查网络后重试。",
                        message = if (uiState.links.isNotEmpty()) {
                            nextMessage("同步失败，已保留当前列表。")
                        } else {
                            uiState.message
                        },
                    )
                }
            }
        }
    }

    fun setFilter(filter: LinkFilter) {
        uiState = uiState.copy(filter = filter)
    }

    fun setSearchQuery(value: String) {
        searchJob?.cancel()
        val query = value.trim()
        uiState = if (query.isEmpty()) {
            uiState.copy(
                searchQuery = value,
                searchResults = emptyList(),
                searchLoading = false,
                searchNextBeforeId = null,
                searchStatusText = "",
            )
        } else {
            uiState.copy(
                searchQuery = value,
                searchResults = emptyList(),
                searchLoading = true,
                searchNextBeforeId = null,
                searchStatusText = "正在搜索...",
            )
        }
        if (query.isEmpty()) return
        searchJob = viewModelScope.launch {
            delay(250)
            loadSearchPage(query = query, beforeId = null, append = false)
        }
    }

    fun loadMoreSearchResults() {
        val query = uiState.searchQuery.trim()
        val beforeId = uiState.searchNextBeforeId
        if (query.isEmpty() || beforeId == null || uiState.searchLoading) return
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            loadSearchPage(query = query, beforeId = beforeId, append = true)
        }
    }

    fun ensureLink(id: Int) {
        if (uiState.links.any { it.id == id } || uiState.detailLoads[id] == DetailLoadState.Loading) return
        uiState = uiState.copy(detailLoads = uiState.detailLoads + (id to DetailLoadState.Loading))
        viewModelScope.launch {
            when (val result = withContext(Dispatchers.IO) { repository.get(id) }) {
                is LinkGetResult.Loaded -> {
                    uiState = uiState.copy(
                        links = uiState.links.upsert(result.link),
                        detailLoads = uiState.detailLoads - id,
                    )
                }
                LinkGetResult.NotFound -> {
                    uiState = uiState.copy(detailLoads = uiState.detailLoads + (id to DetailLoadState.NotFound))
                }
                is LinkGetResult.Failed -> {
                    uiState = uiState.copy(detailLoads = uiState.detailLoads + (id to DetailLoadState.Failed))
                }
            }
        }
    }

    fun openManualAdd() {
        uiState = uiState.copy(manualAdd = ManualAddState(visible = true))
    }

    fun closeManualAdd() {
        if (uiState.manualAdd.submitting) return
        uiState = uiState.copy(manualAdd = ManualAddState())
    }

    fun setManualUrl(value: String) {
        uiState = uiState.copy(manualAdd = uiState.manualAdd.copy(url = value, statusText = ""))
    }

    fun setManualNote(value: String) {
        uiState = uiState.copy(manualAdd = uiState.manualAdd.copy(note = value, statusText = ""))
    }

    fun createManualLink() {
        val draft = uiState.manualAdd
        if (draft.submitting) return
        val url = draft.url.trim()
        val note = draft.note
        val preparedUrl = prepareUrlForSubmission(url)
        val error = validateLinkDraft(preparedUrl, note)
        if (error != null) {
            uiState = uiState.copy(manualAdd = draft.copy(statusText = error))
            return
        }

        uiState = uiState.copy(manualAdd = draft.copy(submitting = true, statusText = "保存中..."))
        viewModelScope.launch {
            when (val result = withContext(Dispatchers.IO) { repository.create(preparedUrl, note) }) {
                is LinkCreateResult.Created -> {
                    uiState = uiState.copy(
                        links = uiState.links.upsert(result.link),
                        manualAdd = ManualAddState(),
                        message = nextMessage("已保存到链接库。"),
                    )
                }
                is LinkCreateResult.Failed -> {
                    uiState = uiState.copy(
                        manualAdd = uiState.manualAdd.copy(
                            submitting = false,
                            statusText = "保存失败。请检查网络后重试。",
                        ),
                    )
                }
            }
        }
    }

    fun beginEdit(link: SavedLink) {
        if (uiState.editDraft?.id == link.id) return
        uiState = uiState.copy(editDraft = EditDraft(id = link.id, url = link.url, note = link.note))
    }

    fun setEditUrl(value: String) {
        uiState.editDraft?.let { uiState = uiState.copy(editDraft = it.copy(url = value, error = "")) }
    }

    fun setEditNote(value: String) {
        uiState.editDraft?.let { uiState = uiState.copy(editDraft = it.copy(note = value, error = "")) }
    }

    fun saveEdit(onSuccess: () -> Unit) {
        val draft = uiState.editDraft ?: return
        if (draft.saving) return
        val url = draft.url.trim()
        val error = validateLinkDraft(url, draft.note)
        if (error != null) {
            uiState = uiState.copy(editDraft = draft.copy(error = error))
            return
        }

        uiState = uiState.copy(editDraft = draft.copy(saving = true, error = ""))
        viewModelScope.launch {
            when (val result = withContext(Dispatchers.IO) {
                repository.update(id = draft.id, url = url, note = draft.note)
            }) {
                is LinkMutationResult.Updated -> {
                    uiState = uiState.copy(
                        links = uiState.links.upsert(result.link),
                        editDraft = null,
                        message = nextMessage("已保存修改。"),
                    )
                    onSuccess()
                }
                LinkMutationResult.Deleted -> Unit
                is LinkMutationResult.Failed -> {
                    uiState = uiState.copy(
                        editDraft = uiState.editDraft?.copy(
                            saving = false,
                            error = "保存失败。请检查网络后重试。",
                        ),
                    )
                }
            }
        }
    }

    fun toggleLearned(link: SavedLink) {
        if (link.id in uiState.busyIds) return
        setLearned(link.id, !link.learned, undoLearned = link.learned)
    }

    fun setLearned(linkId: Int, learned: Boolean, undoLearned: Boolean? = null) {
        if (linkId in uiState.busyIds) return
        uiState = uiState.copy(busyIds = uiState.busyIds + linkId)
        viewModelScope.launch {
            when (val result = withContext(Dispatchers.IO) { repository.update(linkId, learned = learned) }) {
                is LinkMutationResult.Updated -> {
                    val message = if (undoLearned != null) {
                        nextMessage(
                            text = if (learned) "已标记为已学习。" else "已改回待学习。",
                            actionLabel = "撤销",
                            undo = UndoLearned(linkId, undoLearned),
                        )
                    } else {
                        nextMessage(if (learned) "已标记为已学习。" else "已改回待学习。")
                    }
                    uiState = uiState.copy(
                        links = uiState.links.upsert(result.link),
                        busyIds = uiState.busyIds - linkId,
                        message = message,
                    )
                }
                LinkMutationResult.Deleted -> Unit
                is LinkMutationResult.Failed -> {
                    uiState = uiState.copy(
                        busyIds = uiState.busyIds - linkId,
                        message = nextMessage("学习状态保存失败。"),
                    )
                }
            }
        }
    }

    fun deleteLink(linkId: Int, onSuccess: () -> Unit) {
        if (linkId in uiState.busyIds) return
        uiState = uiState.copy(busyIds = uiState.busyIds + linkId)
        viewModelScope.launch {
            when (withContext(Dispatchers.IO) { repository.delete(linkId) }) {
                LinkMutationResult.Deleted -> {
                    uiState = uiState.copy(
                        links = uiState.links.filterNot { it.id == linkId },
                        busyIds = uiState.busyIds - linkId,
                        editDraft = uiState.editDraft?.takeUnless { it.id == linkId },
                        message = nextMessage("已删除链接。"),
                    )
                    onSuccess()
                }
                is LinkMutationResult.Updated -> Unit
                is LinkMutationResult.Failed -> {
                    uiState = uiState.copy(
                        busyIds = uiState.busyIds - linkId,
                        message = nextMessage("删除失败。请检查网络后重试。"),
                    )
                }
            }
        }
    }

    fun markAllPendingLearned() {
        val pending = uiState.queueLinks()
        if (pending.isEmpty()) {
            uiState = uiState.copy(message = nextMessage("待学习队列已经清空。"))
            return
        }
        viewModelScope.launch {
            var success = 0
            var failed = 0
            for (link in pending) {
                uiState = uiState.copy(busyIds = uiState.busyIds + link.id)
                when (val result = withContext(Dispatchers.IO) { repository.update(link.id, learned = true) }) {
                    is LinkMutationResult.Updated -> {
                        success += 1
                        uiState = uiState.copy(links = uiState.links.upsert(result.link))
                    }
                    LinkMutationResult.Deleted -> Unit
                    is LinkMutationResult.Failed -> failed += 1
                }
                uiState = uiState.copy(busyIds = uiState.busyIds - link.id)
            }
            uiState = uiState.copy(
                message = nextMessage(
                    if (failed == 0) {
                        "已标记 $success 条链接。"
                    } else {
                        "已标记 $success 条，$failed 条失败。"
                    },
                ),
            )
            if (failed > 0) refreshLinks()
        }
    }

    fun setCloseAfterSave(value: Boolean) {
        uiState = uiState.copy(preferences = uiState.preferences.copy(closeAfterSave = value))
        viewModelScope.launch { settingsStore.setCloseAfterSave(value) }
    }

    fun setPreserveCompleteUrl(value: Boolean) {
        uiState = uiState.copy(preferences = uiState.preferences.copy(preserveCompleteUrl = value))
        viewModelScope.launch { settingsStore.setPreserveCompleteUrl(value) }
    }

    fun checkForUpdates() {
        if (uiState.updateState == AppUpdateState.Checking || uiState.updateState is AppUpdateState.Downloading) return
        uiState = uiState.copy(updateState = AppUpdateState.Checking)
        viewModelScope.launch {
            val next = when (val result = withContext(Dispatchers.IO) { updateApiClient.check() }) {
                is UpdateCheckResult.Available -> AppUpdateState.Available(result.update)
                UpdateCheckResult.UpToDate -> AppUpdateState.UpToDate
                UpdateCheckResult.Failed -> AppUpdateState.Failed
            }
            uiState = uiState.copy(updateState = next)
        }
    }

    fun setUpdateState(updateState: AppUpdateState) {
        uiState = uiState.copy(updateState = updateState)
    }

    fun setApiDebugMethod(method: ApiDebugMethod) {
        uiState = uiState.copy(apiDebug = uiState.apiDebug.copy(method = method, path = defaultPath(method), body = defaultBody(method)))
    }

    fun setApiDebugPath(value: String) {
        uiState = uiState.copy(apiDebug = uiState.apiDebug.copy(path = value))
    }

    fun setApiDebugBody(value: String) {
        uiState = uiState.copy(apiDebug = uiState.apiDebug.copy(body = value))
    }

    fun sendApiDebugRequest() {
        val state = uiState.apiDebug
        if (state.sending) return
        uiState = uiState.copy(apiDebug = state.copy(sending = true, statusLine = "发送中..."))
        viewModelScope.launch {
            when (val result = withContext(Dispatchers.IO) {
                apiDebugClient.send(state.method, state.path, state.body)
            }) {
                is ApiDebugResult.Loaded -> {
                    val response = result.response
                    uiState = uiState.copy(
                        apiDebug = uiState.apiDebug.copy(
                            sending = false,
                            statusLine = "${response.statusCode} ${response.statusMessage} · ${response.elapsedMillis} ms",
                            responseText = response.body,
                        ),
                    )
                }
                is ApiDebugResult.Failed -> {
                    uiState = uiState.copy(
                        apiDebug = uiState.apiDebug.copy(
                            sending = false,
                            statusLine = result.message,
                            responseText = "",
                        ),
                    )
                }
            }
        }
    }

    fun consumeMessage(id: Long) {
        if (uiState.message?.id == id) {
            uiState = uiState.copy(message = null)
        }
    }

    private fun observeSettings() {
        viewModelScope.launch {
            settingsStore.preferences
                .catch { emit(SharePreferences()) }
                .collect { uiState = uiState.copy(preferences = it) }
        }
    }

    private suspend fun loadSearchPage(query: String, beforeId: Int?, append: Boolean) {
        uiState = uiState.copy(
            searchLoading = true,
            searchStatusText = if (append) "正在加载更多..." else "正在搜索...",
        )
        when (val result = withContext(Dispatchers.IO) { repository.searchPage(query, beforeId) }) {
            is LinkPageResult.Loaded -> {
                if (uiState.searchQuery.trim() != query) return
                val nextItems = if (append) {
                    (uiState.searchResults + result.page.items)
                        .distinctBy { it.id }
                        .sortedByDescending { it.id }
                } else {
                    result.page.items.sortedByDescending { it.id }
                }
                uiState = uiState.copy(
                    searchResults = nextItems,
                    searchLoading = false,
                    searchNextBeforeId = result.page.nextBeforeId,
                    searchStatusText = if (nextItems.isEmpty()) "没有匹配的链接。" else "找到 ${nextItems.size} 条结果。",
                )
            }
            is LinkPageResult.Failed -> {
                if (uiState.searchQuery.trim() != query) return
                uiState = uiState.copy(
                    searchLoading = false,
                    searchStatusText = if (append) "加载更多失败。" else "搜索失败。请检查网络后重试。",
                    message = nextMessage(if (append) "加载更多失败。" else "搜索失败。请检查网络。"),
                )
            }
        }
    }

    private fun validateLinkDraft(url: String, note: String): String? =
        when {
            url.length > MAX_URL_LENGTH -> "链接太长，最多 $MAX_URL_LENGTH 字。"
            !validateHttpUrl(url) -> "链接必须是有效的 http:// 或 https:// 地址，且不能包含用户名或密码。"
            note.length > MAX_NOTE_LENGTH -> "备注太长，最多 $MAX_NOTE_LENGTH 字。"
            else -> null
        }

    private fun prepareUrlForSubmission(url: String): String =
        if (uiState.preferences.preserveCompleteUrl) url.trim() else removeQueryAndFragment(url)

    private fun nextMessage(
        text: String,
        actionLabel: String? = null,
        undo: UndoLearned? = null,
    ): UiMessage =
        UiMessage(id = ++messageId, text = text, actionLabel = actionLabel, undo = undo)

    private fun defaultPath(method: ApiDebugMethod): String =
        when (method) {
            ApiDebugMethod.GET -> "/api/links?limit=50&learned=false"
            ApiDebugMethod.POST -> "/api/links"
            ApiDebugMethod.PATCH -> "/api/links/1"
            ApiDebugMethod.DELETE -> "/api/links/1"
        }

    private fun defaultBody(method: ApiDebugMethod): String =
        when (method) {
            ApiDebugMethod.GET,
            ApiDebugMethod.DELETE -> ""
            ApiDebugMethod.POST -> "{\n  \"url\": \"https://example.com\",\n  \"note\": \"\"\n}"
            ApiDebugMethod.PATCH -> "{\n  \"learned\": true\n}"
        }
}

internal fun CairnLinksUiState.visibleLibraryLinks(): List<SavedLink> {
    return links.asSequence().filter { link ->
        when (filter) {
            LinkFilter.All -> true
            LinkFilter.Unlearned -> !link.learned
            LinkFilter.Learned -> link.learned
        }
    }.sortedByDescending { it.id }.toList()
}

internal fun CairnLinksUiState.searchResultLinks(): List<SavedLink> {
    return searchResults.sortedByDescending { it.id }
}

internal fun CairnLinksUiState.queueLinks(): List<SavedLink> =
    links.filter { !it.learned }
        .sortedWith(compareBy<SavedLink> { parseInstantOrNull(it.createdAt) }.thenBy { it.id })

internal fun CairnLinksUiState.stats(): LinkStats {
    val learnedLinks = links.filter { it.learned }
    val weekStart = LocalDate.now(ZoneId.systemDefault())
        .with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        .atStartOfDay(ZoneId.systemDefault())
        .toInstant()
    return LinkStats(
        total = links.size,
        pending = links.count { !it.learned },
        learned = learnedLinks.size,
        weekDone = learnedLinks.count { link ->
            val learnedAt = link.learnedAt?.let(::parseInstantOrNull)
            learnedAt != null && !learnedAt.isBefore(weekStart)
        },
        oldestPending = queueLinks().firstOrNull(),
    )
}

private fun List<SavedLink>.upsert(link: SavedLink): List<SavedLink> =
    if (any { it.id == link.id }) {
        map { if (it.id == link.id) link else it }.sortedByDescending { it.id }
    } else {
        (this + link).sortedByDescending { it.id }
    }

internal class CairnLinksViewModelFactory(
    private val repository: LinkRepository,
    private val updateApiClient: UpdateApiClient,
    private val settingsStore: SharePreferencesStore,
    private val apiDebugClient: ApiDebugClient,
    private val apiBaseUrl: String,
    private val releasesApiUrl: String,
    private val currentVersionName: String,
    private val currentVersionCode: Int,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        CairnLinksViewModel(
            repository = repository,
            updateApiClient = updateApiClient,
            settingsStore = settingsStore,
            apiDebugClient = apiDebugClient,
            apiBaseUrl = apiBaseUrl,
            releasesApiUrl = releasesApiUrl,
            currentVersionName = currentVersionName,
            currentVersionCode = currentVersionCode,
        ) as T
}
