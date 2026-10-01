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
import com.alpenl.cairn.share.network.FailureKind
import com.alpenl.cairn.share.network.LinkCreateResult
import com.alpenl.cairn.share.network.LinkFilter
import com.alpenl.cairn.share.network.LinkGetResult
import com.alpenl.cairn.share.network.LinksApiClient
import com.alpenl.cairn.share.network.BookmarkTaxonomy
import com.alpenl.cairn.share.network.BookmarkFilters
import com.alpenl.cairn.share.network.CurationSubmitResult
import com.alpenl.cairn.share.network.CurationUpdate
import com.alpenl.cairn.share.network.MultidimensionalSelection
import com.alpenl.cairn.share.network.QueuedCurationAction
import com.alpenl.cairn.share.network.TaxonomyResult
import com.alpenl.cairn.share.network.V2CurationRepository
import com.alpenl.cairn.share.network.V2Result
import com.alpenl.cairn.share.network.retainLoadedContent
import com.alpenl.cairn.share.network.LinkMutationResult
import com.alpenl.cairn.share.network.LinkPageResult
import com.alpenl.cairn.share.network.SavedLink
import com.alpenl.cairn.share.network.UpdateApiClient
import com.alpenl.cairn.share.network.UpdateCheckResult
import com.alpenl.cairn.share.network.QueryPageCache
import com.alpenl.cairn.share.network.QueryPageKey
import com.alpenl.cairn.share.network.QueuePageResult
import com.alpenl.cairn.share.network.cancellableRead
import com.alpenl.cairn.share.network.V2CurationClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

internal data class CairnLinksUiState(
    val apiBaseUrl: String,
    val releasesApiUrl: String,
    val currentVersionName: String,
    val currentVersionCode: Int,
    val accountGeneration: Long = 0,
    val links: List<SavedLink> = emptyList(),
    val loading: Boolean = false,
    val taxonomy: BookmarkTaxonomy? = null,
    val taxonomyLoading: Boolean = false,
    val statusText: String = "",
    val filter: LinkFilter = LinkFilter.All,
    val bookmarkFilters: BookmarkFilters = BookmarkFilters(),
    val libraryResults: List<SavedLink> = emptyList(),
    val libraryLoading: Boolean = false,
    val libraryNextBeforeId: Int? = null,
    val libraryStatusText: String = "",
    val libraryStale: Boolean = false,
    val searchQuery: String = "",
    val searchResults: List<SavedLink> = emptyList(),
    val searchLoading: Boolean = false,
    val searchNextBeforeId: Int? = null,
    val searchStatusText: String = "",
    val searchStale: Boolean = false,
    val queueResults: List<SavedLink> = emptyList(),
    val queueTotal: Int? = null,
    val queueNextCursor: String? = null,
    val queueLoading: Boolean = false,
    val queueStatusText: String = "",
    val queueAvailable: Boolean? = null,
    val offlineReads: Map<Int, OfflineReadInfo> = emptyMap(),
    val offlineLinks: List<SavedLink> = emptyList(),
    val personalTagPendingCount: Int = 0,
    val personalTagQueued: Map<Int, Int> = emptyMap(),
    val busyIds: Set<Int> = emptySet(),
    val detailLoads: Map<Int, DetailLoadState> = emptyMap(),
    val editDraft: EditDraft? = null,
    val manualAdd: ManualAddState = ManualAddState(),
    val preferences: SharePreferences = SharePreferences(),
    val preferencesLoaded: Boolean = false,
    val apiTokenSaveError: String = "",
    val pendingUploads: List<PendingUpload> = emptyList(),
    val pendingUploadsLoaded: Boolean = false,
    val uploadBusyIds: Set<String> = emptySet(),
    val retryingUploads: Boolean = false,
    val updateState: AppUpdateState = AppUpdateState.Hidden,
    val apiDebug: ApiDebugUiState = ApiDebugUiState(),
    // The effective multidimensional view per link, its local draft (which
    // always wins over a server refresh), the last conflict revision and the
    // offline queue size. A draft is never silently discarded.
    val v2Selections: Map<Int, MultidimensionalSelection> = emptyMap(),
    val v2Drafts: Map<Int, MultidimensionalSelection> = emptyMap(),
    val v2Conflicts: Map<Int, Long> = emptyMap(),
    val v2Busy: Set<Int> = emptySet(),
    val v2Queued: Map<Int, Int> = emptyMap(),
    val v2LegacyActions: Map<Int, List<QueuedCurationAction>> = emptyMap(),
    val v2SelectionAvailable: Boolean? = null,
    val v2TaxonomyAvailable: Boolean? = null,
    val v2Taxonomy: BookmarkTaxonomy? = null,
    val v2TaxonomyLoading: Boolean = false,
    val message: UiMessage? = null,
) {
    val v2Available: Boolean get() = v2SelectionAvailable != false && v2TaxonomyAvailable != false
}

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
    private val repository: LinksApiClient,
    private val updateApiClient: UpdateApiClient,
    private val settingsStore: SharePreferencesStore,
    private val pendingUploadStore: PendingUploadStore,
    private val apiDebugClient: ApiDebugClient,
    private val v2Repository: V2CurationRepository,
    private val curationActionStore: CurationActionStore,
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
    private var libraryJob: Job? = null
    private var libraryGeneration = 0L
    private var libraryFilterTime = Instant.now()
    private var searchFilterTime = Instant.now()
    private var searchGeneration = 0L
    private var refreshJob: Job? = null
    private var queueJob: Job? = null
    private var queueGeneration = 0L
    private val queryPages = QueryPageCache()
    private val personalTags = PersonalTagOutbox(curationActionStore.context.applicationContext)
    private val offlineReads = OfflineReadStore(curationActionStore.context.applicationContext)
    private var personalTagJob: Job? = null
    private var personalTagRetryRequested = false
    private val verifiedDetails = mutableSetOf<Int>()
    private var pendingUploadsRetryJob: Job? = null
    private var retryPendingUploadsAgain = false
    private var retryPendingUploadsAgainWithSummary = false
    private var loadedPreferencesOnce = false
    private var lastObservedToken = ""
    private var activeAccountToken: String? = null
    private var tokenIntent = 0L
    private var pendingTokenIntent: Long? = null
    private var minimumTokenRevision = 0L
    private val tokenWrites = Mutex()
    private val tokenWriteSignals = MutableStateFlow(0L)
    private val accountEditDrafts = mutableMapOf<String, EditDraft>()
    private val accountAddDrafts = mutableMapOf<String, ManualAddState>()
    private val selectionRequests = mutableMapOf<Int, Long>()
    private var automaticUploadRetryStarted = false
    // The serial curation action queue. A pending action is only removed after
    // the server confirms it (R2-04/R2-05).
    private var v2Pumping = false
    private var deletedLinks = emptySet<Int>()
    private var pendingDeletions = emptySet<Int>()

    init {
        observeSettings()
        observePendingUploads()
        observeCurationActions()
        observeDeletionRecords()
        observePersonalTags()
        checkForUpdates()
    }

    private fun observePersonalTags() {
        viewModelScope.launch {
            personalTags.actions.catch {
                uiState = uiState.copy(message = nextMessage("无法读取个人标签离线队列，请检查存储。"))
            }.collect { rows ->
                val mine = rows.filter { it.account == curationAccountKey() && it.linkId !in deletedLinks }
                uiState = uiState.copy(personalTagPendingCount = mine.size, personalTagQueued = mine.groupingBy { it.linkId }.eachCount())
            }
        }
    }

    fun flushPersonalTags() {
        if (currentApiToken().isBlank()) return
        if (personalTagJob?.isActive == true) { personalTagRetryRequested = true; return }
        personalTagRetryRequested = false
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        val token = currentApiToken()
        personalTagJob = viewModelScope.launch {
            try {
                // Shared with system tag writes and deletion. Two read CAS values
                // are never silently rebased to make concurrent edits succeed.
                val changed = curationActionStore.syncMutex.withLock {
                    personalTags.drain(account, token, V2CurationClient(uiState.apiBaseUrl),
                        curationActionStore.blockedLinkIds(account), { isCurrentAccount(generation) && curationAccountKey() == account })
                }
                if (isCurrentAccount(generation) && curationAccountKey() == account && changed.isNotEmpty()) {
                    for (id in changed) { loadV2Selection(id, force = true); verifiedDetails.remove(id); ensureLink(id, force = true) }
                    refreshSearchAfterMutation()
                }
            } catch (_: java.io.IOException) {
                if (isCurrentAccount(generation)) uiState = uiState.copy(message = nextMessage("个人标签队列读写失败，修改仍保留，请重试。"))
            } finally {
                if (!isCurrentAccount(generation) || personalTagRetryRequested) { personalTagJob = null; flushPersonalTags() }
            }
        }
    }

    private suspend fun queryPage(learned: LinkFilter, query: String, token: String, beforeId: Int?, filters: BookmarkFilters, time: Instant): LinkPageResult {
        val key = QueryPageKey.of(accountKeyFor(uiState.apiBaseUrl, token), learned, query, beforeId, filters, time)
        queryPages.get(key)?.let { return LinkPageResult.Loaded(it) }
        val version = queryPages.version()
        val result = cancellableRead { cancellation -> repository.listPage(learned, query, token, beforeId, filters, time, cancellation) }
        if (result is LinkPageResult.Loaded && token == currentApiToken()) queryPages.put(key, result.page, version)
        return result
    }

    // --- Multidimensional curation (B07) -------------------------------------

    private fun observeCurationActions() {
        viewModelScope.launch {
            curationActionStore.actions.catch { emit(emptyList()) }.collect { actions ->
                val mine = actions.filter { it.accountKey == curationAccountKey() && it.linkId !in deletedLinks }
                val queued = mine.groupingBy { it.linkId }.eachCount()
                val conflicts = mine.mapNotNull { action -> action.conflictRevision?.let { action.linkId to it } }.toMap()
                val legacyKey = legacyAccountKeyFor(uiState.apiBaseUrl, uiState.preferences.apiToken)
                val legacy = actions.filter { it.accountKey == legacyKey && it.linkId !in deletedLinks }.groupBy { it.linkId }
                uiState = uiState.copy(v2Queued = queued, v2Conflicts = conflicts, v2LegacyActions = legacy)
            }
        }
    }

    private fun observeDeletionRecords() {
        viewModelScope.launch {
            curationActionStore.deletions.catch {
                uiState = uiState.copy(message = nextMessage("无法读取本地删除记录，请检查存储后重试。"))
            }.collect { records ->
                val mine = records.filter { it.accountKey == curationAccountKey() }
                pendingDeletions = mine.filterNot { it.confirmed }.map { it.linkId }.toSet()
                val newlyDeleted = mine.filter { it.confirmed && it.linkId !in deletedLinks }
                for (record in newlyDeleted) forgetDeletedLink(record.linkId)
                if (newlyDeleted.isNotEmpty()) refreshSearchAfterMutation()
            }
        }
    }

    private fun curationAccountKey(): String =
        accountKeyFor(uiState.apiBaseUrl, uiState.preferences.apiToken)

    private fun clearV2AccountState() {
        uiState = uiState.copy(v2Selections = emptyMap(), v2Drafts = emptyMap(),
            v2Conflicts = emptyMap(), v2Busy = emptySet(), v2Queued = emptyMap(), v2LegacyActions = emptyMap(),
            v2Taxonomy = null, v2TaxonomyLoading = false, v2SelectionAvailable = null, v2TaxonomyAvailable = null)
    }

    /** Invalidate account-bound views immediately, including an A -> B -> A round trip. */
    private fun activateAccount(token: String) {
        if (activeAccountToken == token) return
        activeAccountToken?.let { previous ->
            val key = accountKeyFor(uiState.apiBaseUrl, previous)
            uiState.editDraft?.let { accountEditDrafts[key] = it.copy(saving = false) }
            if (uiState.manualAdd.visible) accountAddDrafts[key] = uiState.manualAdd.copy(submitting = false)
        }
        activeAccountToken = token
        deletedLinks = emptySet()
        pendingDeletions = emptySet()
        searchGeneration += 1
        libraryGeneration += 1
        refreshJob?.cancel()
        searchJob?.cancel()
        libraryJob?.cancel()
        queueJob?.cancel()
        queueGeneration += 1
        queryPages.clear()
        verifiedDetails.clear()
        selectionRequests.clear()
        val key = accountKeyFor(uiState.apiBaseUrl, token)
        clearV2AccountState()
        uiState = uiState.copy(accountGeneration = uiState.accountGeneration + 1,
            links = emptyList(), loading = false, taxonomy = null, taxonomyLoading = false,
            statusText = "", searchQuery = "", searchResults = emptyList(), searchLoading = false,
            searchNextBeforeId = null, searchStatusText = "", bookmarkFilters = BookmarkFilters(),
            libraryResults = emptyList(), libraryLoading = false, libraryNextBeforeId = null, libraryStatusText = "",
            libraryStale = false, searchStale = false, queueResults = emptyList(), queueTotal = null,
            queueNextCursor = null, queueLoading = false, queueStatusText = "", queueAvailable = null,
            offlineReads = emptyMap(), offlineLinks = emptyList(), personalTagPendingCount = 0, personalTagQueued = emptyMap(),
            busyIds = emptySet(), detailLoads = emptyMap(), editDraft = accountEditDrafts.remove(key),
            manualAdd = accountAddDrafts.remove(key) ?: ManualAddState(), apiDebug = ApiDebugUiState(), message = null)
    }

    private fun isCurrentAccount(generation: Long): Boolean = generation == uiState.accountGeneration

    /**
     * Loads the effective view. A local draft or a queued action is never
     * overwritten by a refresh, so a poll cannot discard an unsaved edit.
     */
    fun loadV2Selection(id: Int, force: Boolean = false) {
        if (id in deletedLinks) return
        val token = uiState.preferences.apiToken
        if (token.isBlank()) return
        if (!force && uiState.v2Selections.containsKey(id) && (uiState.v2Drafts.containsKey(id) || (uiState.v2Queued[id] ?: 0) > 0)) return
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        val request = (selectionRequests[id] ?: 0) + 1
        selectionRequests[id] = request
        viewModelScope.launch {
            val result = v2Repository.loadCancellable(id, token)
            if (id in deletedLinks || account != curationAccountKey() || !isCurrentAccount(generation) || selectionRequests[id] != request) return@launch
            when (result) {
                is V2Result.Loaded -> {
                    if (result.value.revision < (uiState.v2Selections[id]?.revision ?: 0)) return@launch
                    val pending = curationActionStore.snapshot().filter { it.accountKey == account && it.linkId == id }
                    if (id in deletedLinks || account != curationAccountKey() || !isCurrentAccount(generation) || selectionRequests[id] != request) return@launch
                    val draft = pending.fold(result.value) { current, action ->
                        v2Repository.applyLocal(current, result.value.automatic, action.field, action.term, action.action)
                    }
                    uiState = uiState.copy(
                        v2Selections = uiState.v2Selections + (id to result.value),
                        v2Drafts = if (pending.isEmpty()) uiState.v2Drafts - id else uiState.v2Drafts + (id to draft),
                        v2SelectionAvailable = true,
                    )
                }
                V2Result.Unsupported -> uiState = uiState.copy(v2SelectionAvailable = false)
                else -> Unit
            }
        }
    }

    /**
     * Loads the multidimensional vocabulary. It is a separate endpoint from the
     * v1 taxonomy, so a backend without v2 stays visibly read-only.
     */
    fun loadV2Taxonomy() = refreshV2Taxonomy(force = false)

    private fun refreshV2Taxonomy(force: Boolean) {
        val token = uiState.preferences.apiToken
        if (token.isBlank() || (!force && uiState.v2Taxonomy != null) || uiState.v2TaxonomyLoading) return
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        uiState = uiState.copy(v2TaxonomyLoading = true)
        viewModelScope.launch {
            val result = v2Repository.loadTaxonomyCancellable(token)
            if (account != curationAccountKey() || !isCurrentAccount(generation)) return@launch
            when (result) {
                is V2Result.Loaded -> uiState = uiState.copy(v2TaxonomyLoading = false, v2Taxonomy = result.value, v2TaxonomyAvailable = true)
                V2Result.Unsupported -> uiState = uiState.copy(v2TaxonomyLoading = false, v2TaxonomyAvailable = false)
                else -> uiState = uiState.copy(v2TaxonomyLoading = false)
            }
        }
    }

    /** Persist the original intent before the first HTTP attempt. */
    fun applyV2Action(id: Int, field: String, term: String, action: String) {
        if (id in deletedLinks || id in pendingDeletions) return
        if (uiState.preferences.apiToken.isBlank()) return
        val selection = uiState.v2Selections[id] ?: return
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        val draft = v2Repository.applyLocal(uiState.v2Drafts[id] ?: selection, selection.automatic, field, term, action)
        val queued = QueuedCurationAction(id, UUID.randomUUID().toString(), field, term, action, selection.revision, account,
            expectedDecisionId = selection.decisionId, expectedContentRevision = selection.contentRevision,
            legacyEndpoint = !selection.tagSystem)
        uiState = uiState.copy(v2Drafts = uiState.v2Drafts + (id to draft), v2Busy = uiState.v2Busy + id)
        viewModelScope.launch {
            try {
                curationActionStore.enqueue(queued)
                if (account == curationAccountKey() && isCurrentAccount(generation)) pumpV2Actions()
            } catch (error: java.io.IOException) {
                if (account == curationAccountKey() && isCurrentAccount(generation)) uiState = uiState.copy(v2Busy = uiState.v2Busy - id,
                    message = nextMessage("无法保存离线动作，草稿已保留，请重试。"))
            }
        }
    }

    private fun pumpV2Actions() {
        if (v2Pumping) return
        val token = uiState.preferences.apiToken
        if (token.isBlank()) return
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        v2Pumping = true
        viewModelScope.launch {
            try {
                curationActionStore.syncMutex.withLock {
                    v2Repository.flush(curationActionStore, account, token,
                        active = { account == curationAccountKey() && isCurrentAccount(generation) },
                    ) { pending, result ->
                        if (account == curationAccountKey() && isCurrentAccount(generation)) {
                            val selection = uiState.v2Selections[pending.linkId]
                            when (result) {
                                is CurationSubmitResult.Applied -> {
                                    val remaining = curationActionStore.snapshot().any { it.accountKey == account && it.linkId == pending.linkId }
                                    if (account != curationAccountKey() || !isCurrentAccount(generation)) return@flush
                                    if (selection != null) {
                                        val accepted = v2Repository.applyLocal(selection, selection.automatic, pending.field, pending.term, pending.action)
                                        uiState = uiState.copy(v2Selections = uiState.v2Selections + (pending.linkId to accepted.copy(revision = result.revision)))
                                    }
                                    refreshSearchAfterMutation()
                                    if (!remaining) {
                                        uiState = uiState.copy(v2Drafts = uiState.v2Drafts - pending.linkId,
                                            v2Conflicts = uiState.v2Conflicts - pending.linkId,
                                            message = nextMessage("已保存多维整理。"))
                                        loadV2Selection(pending.linkId, force = true)
                                    }
                                }
                                is CurationSubmitResult.Queued -> uiState = uiState.copy(
                                    message = nextMessage("网络不可用，动作已保存在离线队列，可稍后重试。"))
                                is CurationSubmitResult.Conflict -> {
                                    uiState = uiState.copy(v2Conflicts = uiState.v2Conflicts + (pending.linkId to result.revision),
                                        message = nextMessage("这条整理已被其他客户端更新。草稿已保留，可重新应用或放弃。"))
                                    loadV2Selection(pending.linkId, force = true)
                                }
                                is CurationSubmitResult.Failed -> uiState = uiState.copy(
                                    message = nextMessage("保存失败：${failureLabel(result.kind)}；动作已保留。"))
                            }
                        }
                    }
                }
            } catch (error: java.io.IOException) {
                if (account == curationAccountKey() && isCurrentAccount(generation)) uiState = uiState.copy(message = nextMessage("离线队列读写失败，请重试。"))
            } finally {
                v2Pumping = false
                if (account == curationAccountKey() && isCurrentAccount(generation)) uiState = uiState.copy(v2Busy = emptySet())
                else pumpV2Actions()
            }
        }
    }

    /** Explicit user resolution reloads the server before replaying the intents. */
    fun reapplyV2Draft(id: Int) {
        if (id in deletedLinks || id in pendingDeletions) return
        if (uiState.v2Conflicts[id] == null) return
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        val token = uiState.preferences.apiToken
        viewModelScope.launch {
            curationActionStore.syncMutex.withLock {
                val result = withContext(Dispatchers.IO) { v2Repository.load(id, token) }
                if (account != curationAccountKey() || !isCurrentAccount(generation)) return@withLock
                if (result is V2Result.Loaded) {
                    curationActionStore.rebase(account, id, result.value.revision, result.value.decisionId, result.value.contentRevision)
                    val actions = curationActionStore.snapshot().filter { it.accountKey == account && it.linkId == id }
                    if (account != curationAccountKey() || !isCurrentAccount(generation)) return@withLock
                    val draft = actions.fold(result.value) { current, action ->
                        v2Repository.applyLocal(current, result.value.automatic, action.field, action.term, action.action)
                    }
                    uiState = uiState.copy(v2Selections = uiState.v2Selections + (id to result.value),
                        v2Drafts = uiState.v2Drafts + (id to draft), v2Conflicts = uiState.v2Conflicts - id)
                } else {
                    uiState = uiState.copy(message = nextMessage("无法读取最新整理，已保留冲突和草稿。"))
                }
            }
            if (account == curationAccountKey() && isCurrentAccount(generation)) pumpV2Actions()
        }
    }

    fun discardV2Draft(id: Int) {
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        viewModelScope.launch {
            curationActionStore.syncMutex.withLock {
                curationActionStore.discard(account, id)
                if (account == curationAccountKey() && isCurrentAccount(generation)) {
                    uiState = uiState.copy(v2Drafts = uiState.v2Drafts - id,
                        v2Conflicts = uiState.v2Conflicts - id, v2Busy = uiState.v2Busy - id)
                    loadV2Selection(id, force = true)
                }
            }
        }
    }

    /** Invoked only by the explicit ownership confirmation in the detail UI. */
    fun recoverLegacyV2Actions(id: Int, confirmedAccount: String = curationAccountKey()) {
        if (id in deletedLinks || id in pendingDeletions) return
        val token = uiState.preferences.apiToken
        if (token.isBlank()) return
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        if (confirmedAccount != account) return
        val legacyKey = legacyAccountKeyFor(uiState.apiBaseUrl, token)
        viewModelScope.launch {
            var recovered = false
            curationActionStore.syncMutex.withLock {
                val result = withContext(Dispatchers.IO) { v2Repository.load(id, token) }
                if (account != curationAccountKey() || !isCurrentAccount(generation)) return@withLock
                if (result is V2Result.Loaded) {
                    val adopted = curationActionStore.adoptLegacy(legacyKey, account, id, result.value.revision)
                    recovered = adopted
                    if (account != curationAccountKey() || !isCurrentAccount(generation)) return@withLock
                    if (adopted) {
                        loadV2Selection(id, force = true)
                        uiState = uiState.copy(message = nextMessage("旧版动作已恢复；版本冲突会保留供你确认。"))
                    } else {
                        uiState = uiState.copy(message = nextMessage("请先同步或处理这条收藏现有的离线修改，再恢复旧版动作。"))
                    }
                } else {
                    uiState = uiState.copy(message = nextMessage("无法确认当前收藏，旧版动作仍保留在本地。"))
                }
            }
            if (recovered && account == curationAccountKey() && isCurrentAccount(generation)) pumpV2Actions()
        }
    }

    /** Flush only the active account; confirmed actions alone leave the store. */
    fun flushV2Queue() = pumpV2Actions()

    private fun valueOf(selection: MultidimensionalSelection, field: String): List<String> = when (field) {
        "topics" -> selection.topics
        "content_functions" -> selection.contentFunctions
        "affordances" -> selection.affordances
        "carriers" -> selection.carriers
        "form" -> if (selection.form.isEmpty()) emptyList() else listOf(selection.form)
        "use" -> if (selection.use.isEmpty()) emptyList() else listOf(selection.use)
        else -> emptyList()
    }

    private fun failureLabel(kind: FailureKind): String = when (kind) {
        FailureKind.Unauthorized -> "鉴权失败"
        FailureKind.Timeout -> "请求超时"
        FailureKind.Network -> "网络错误"
        FailureKind.Server -> "服务端错误"
    }

    fun refreshLinks() {
        val generation = uiState.accountGeneration
        if (!uiState.preferencesLoaded) return
        if (uiState.loading) return
        queryPages.clear()
        refreshQueue()
        flushPersonalTags()
        val apiToken = currentApiToken()
        if (apiToken.isBlank()) {
            uiState = uiState.copy(
                loading = false,
                statusText = "请先在设置中配置访问 Token。",
                message = if (uiState.links.isEmpty()) {
                    nextMessage("需要配置访问 Token 后才能同步。")
                } else {
                    uiState.message
                },
            )
            return
        }
        if (uiState.searchQuery.isNotBlank()) setSearchQuery(uiState.searchQuery)
        refreshLibraryFilters()
        refreshV2Taxonomy(force = true)
        for (id in uiState.v2Selections.keys + uiState.v2Drafts.keys) loadV2Selection(id, force = true)
        val hadLinks = uiState.links.isNotEmpty()
        uiState = uiState.copy(
            loading = true,
            statusText = if (hadLinks) "正在刷新链接..." else "正在同步云端链接...",
        )
        refreshJob = viewModelScope.launch {
            val collected = linkedMapOf<Int, SavedLink>()
            var published = uiState.links.associateBy { it.id }
            val edited = mutableMapOf<Int, SavedLink>()
            val deleted = mutableSetOf<Int>()
            var beforeId: Int? = null
            repeat(50) {
                val result = cancellableRead { cancellation -> repository.listPage(LinkFilter.All, "", apiToken, beforeId, cancellation = cancellation) }
                if (!isCurrentAccount(generation) || apiToken != currentApiToken()) return@launch
                when (result) {
                    is LinkPageResult.Loaded -> {
                        val current = uiState.links.associateBy { it.id }
                        for ((id, link) in current) if (published[id] != link) edited[id] = link
                        deleted += published.keys - current.keys
                        for (link in result.page.items.filterNot { it.id in deletedLinks }) collected[link.id] = link.retainLoadedContent(current[link.id])
                        collected.putAll(edited)
                        for (id in deleted + deletedLinks) collected.remove(id)
                        val next = result.page.nextBeforeId
                        if (next != null && (result.page.items.isEmpty() || (beforeId != null && next >= beforeId!!))) {
                            uiState = uiState.copy(loading = false, statusText = "分页响应无效，请重试。")
                            return@launch
                        }
                        // Publish each summary page immediately; the first screen
                        // no longer waits for the entire library to download.
                        val visible = if (next != null && hadLinks) current + collected else collected
                        val items = visible.values.map { it.retainLoadedContent(current[it.id]) }.sortedByDescending { it.id }
                        published = items.associateBy { it.id }
                        uiState = uiState.copy(
                            links = items,
                            loading = next != null,
                            statusText = if (next != null) "已加载 ${items.size} 条，正在同步更多..."
                                else if (items.isEmpty()) "还没有收藏链接。" else "已同步 ${items.size} 条链接。",
                        )
                        if (next == null) return@launch
                        beforeId = next
                    }
                    is LinkPageResult.Failed -> {
                        uiState = uiState.copy(
                            loading = false,
                            statusText = failureText(result.kind, "同步未完成，已保留当前列表，请重试。"),
                            message = nextMessage(failureText(result.kind, "同步未完成，已保留当前列表。")),
                        )
                        return@launch
                    }
                    LinkPageResult.UnsupportedFilters -> {
                        uiState = uiState.copy(loading = false, statusText = FILTER_UNSUPPORTED_MESSAGE)
                        return@launch
                    }
                }
            }
            uiState = uiState.copy(loading = false, statusText = "已加载 5000 条链接，请通过搜索查找更早的内容。")
        }
        loadTaxonomy()
    }

    fun setFilter(filter: LinkFilter) {
        uiState = uiState.copy(filter = filter)
        refreshLibraryFilters()
        viewModelScope.launch { settingsStore.setLastFilter(filter.apiValue) }
    }

    fun setBookmarkFilters(filters: BookmarkFilters) {
        uiState = uiState.copy(bookmarkFilters = filters)
        refreshLibraryFilters()
        if (uiState.searchQuery.isNotBlank()) setSearchQuery(uiState.searchQuery)
    }

    fun setSearchQuery(value: String) {
        searchGeneration += 1
        searchFilterTime = Instant.now()
        searchJob?.cancel()
        val query = value.trim()
        viewModelScope.launch { settingsStore.setLastSearchQuery(value) }
        uiState = if (query.isEmpty()) {
            uiState.copy(
                searchQuery = value,
                searchResults = emptyList(),
                searchLoading = false,
                searchNextBeforeId = null,
                searchStatusText = "",
                searchStale = false,
            )
        } else {
            uiState.copy(
                searchQuery = value,
                searchLoading = true,
                searchNextBeforeId = null,
                searchStale = uiState.searchResults.isNotEmpty(),
                searchStatusText = if (uiState.searchResults.isNotEmpty()) "正在更新搜索，暂时显示上一次结果…" else "正在搜索...",
            )
        }
        if (query.isEmpty()) return
        searchJob = viewModelScope.launch {
            if (queryPages.get(QueryPageKey.of(curationAccountKey(), LinkFilter.All, query, null, uiState.bookmarkFilters, searchFilterTime)) == null) delay(250)
            loadSearchPage(query = query, beforeId = null, append = false)
        }
    }

    // A confirmed mutation can change query/filter membership, even for a row
    // outside the current main list or page. Read a fresh first page instead of
    // merging stale membership or continuing its cursor. Debounce coalesces a
    // burst of confirmed actions; old requests cannot publish into this search.
    private fun refreshSearchAfterMutation() {
        queryPages.clear()
        refreshQueue()
        refreshLibraryFilters()
        if (uiState.searchQuery.isNotBlank()) setSearchQuery(uiState.searchQuery)
    }

    // Query membership is authoritative and independent of the bounded root
    // snapshot used for the queue. Draft actions do not change saved membership.
    private fun refreshLibraryFilters() {
        libraryGeneration += 1
        libraryJob?.cancel()
        libraryFilterTime = Instant.now()
        uiState = uiState.copy(libraryNextBeforeId = null, libraryStale = uiState.usesLibraryQuery() && uiState.libraryResults.isNotEmpty(),
            libraryLoading = uiState.usesLibraryQuery(), libraryStatusText = if (uiState.libraryResults.isNotEmpty()) "正在更新条件，暂时显示上一次结果…" else "")
        if (!uiState.usesLibraryQuery()) return
        libraryJob = viewModelScope.launch {
            if (queryPages.get(QueryPageKey.of(curationAccountKey(), uiState.filter, "", null, uiState.bookmarkFilters, libraryFilterTime)) == null) delay(250)
            loadLibraryPage(null, append = false)
        }
    }

    fun retryLibraryFilters() {
        // An explicit retry must observe the server, including a changed
        // capability or membership, instead of reusing a recent success.
        queryPages.clear()
        refreshLibraryFilters()
    }

    fun refreshQueue() {
        queueGeneration += 1
        queueJob?.cancel()
        uiState = uiState.copy(queueNextCursor = null, queueLoading = currentApiToken().isNotBlank(),
            queueStatusText = if (uiState.queueResults.isEmpty()) "正在读取全库待学习队列…" else "正在更新队列，暂时显示上次结果…")
        if (currentApiToken().isBlank()) return
        queueJob = viewModelScope.launch { loadQueuePage(null, append = false) }
    }

    fun loadMoreQueue() {
        val cursor = uiState.queueNextCursor ?: return
        if (uiState.queueLoading) return
        queueJob = viewModelScope.launch { loadQueuePage(cursor, append = true) }
    }

    private suspend fun loadQueuePage(cursor: String?, append: Boolean) {
        val account = uiState.accountGeneration
        val request = queueGeneration
        val token = currentApiToken()
        uiState = uiState.copy(queueLoading = true)
        val result = cancellableRead { repository.queuePage(token, cursor, it) }
        if (!isCurrentAccount(account) || request != queueGeneration || token != currentApiToken()) return
        when (result) {
            is QueuePageResult.Loaded -> {
                val before = if (append) uiState.queueResults else emptyList()
                val incoming = result.page.items.filterNot { it.id in deletedLinks }
                val all = (before + incoming).distinctBy { it.id }
                if (all != all.sortedWith(compareBy<SavedLink> { it.createdAt }.thenBy { it.id })) {
                    uiState = uiState.copy(queueLoading = false, queueNextCursor = null, queueStatusText = "队列分页顺序无效，请刷新。")
                    return
                }
                uiState = uiState.copy(queueResults = all, queueTotal = result.page.total, queueNextCursor = result.page.nextCursor,
                    queueLoading = false, queueAvailable = true, queueStatusText = if (all.isEmpty()) "没有待学习收藏。" else "全库 ${result.page.total} 条，已显示 ${all.size} 条。")
            }
            is QueuePageResult.Failed -> uiState = uiState.copy(queueLoading = false,
                queueStatusText = failureText(result.kind, "队列读取失败；已有结果保留，可刷新重试。"))
            QueuePageResult.Unsupported -> uiState = uiState.copy(queueLoading = false, queueAvailable = false,
                queueNextCursor = null, queueStatusText = "服务暂不支持全库学习队列，请更新服务；链接库仍可浏览。")
        }
    }

    fun setOfflinePinned(id: Int, pinned: Boolean) {
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        viewModelScope.launch {
            try {
                offlineReads.setPinned(account, id, pinned)
                if (isCurrentAccount(generation) && account == curationAccountKey()) {
                    val rows = offlineReads.snapshot(account)
                    if (!isCurrentAccount(generation)) return@launch
                    uiState = uiState.copy(offlineReads = rows.associate { it.link.id to OfflineReadInfo(it.savedAt, it.pinned, it.link.id in verifiedDetails, it.tagLabels) },
                        offlineLinks = rows.map { it.link },
                        message = nextMessage(if (pinned) "已固定离线正文；账号切换后不会显示给其他账号。" else "已取消固定，仍保留在最近阅读缓存中。"))
                }
            } catch (error: java.io.IOException) {
                if (isCurrentAccount(generation)) uiState = uiState.copy(message = nextMessage(error.message ?: "离线固定未保存，请重试。"))
            }
        }
    }

    fun clearOfflineReading() {
        val account = curationAccountKey()
        val generation = uiState.accountGeneration
        viewModelScope.launch {
            try {
                offlineReads.clear(account)
                if (isCurrentAccount(generation)) uiState = uiState.copy(offlineReads = emptyMap(), offlineLinks = emptyList(), message = nextMessage("已清除当前账号的离线阅读缓存。"))
            } catch (_: java.io.IOException) { if (isCurrentAccount(generation)) uiState = uiState.copy(message = nextMessage("缓存未能清除，请重试。")) }
        }
    }

    fun openOfflineLink(link: SavedLink) {
        if (link.id in deletedLinks || uiState.offlineLinks.none { it.id == link.id }) return
        // Keep an already observed newer server summary; the cached body must
        // not be grafted onto a different content revision.
        if (uiState.links.none { it.id == link.id }) uiState = uiState.copy(links = uiState.links.upsert(link))
    }

    fun loadMoreLibraryResults() {
        val before = uiState.libraryNextBeforeId
        if (!uiState.usesLibraryQuery() || uiState.libraryLoading || before == null) return
        libraryJob?.cancel()
        libraryJob = viewModelScope.launch { loadLibraryPage(before, append = true) }
    }

    private suspend fun loadLibraryPage(beforeId: Int?, append: Boolean) {
        val queryGeneration = libraryGeneration
        val account = uiState.accountGeneration
        val token = currentApiToken()
        val filters = uiState.bookmarkFilters
        val learned = uiState.filter
        val queryTime = libraryFilterTime
        if (token.isBlank()) {
            uiState = uiState.copy(libraryLoading = false, libraryStatusText = "请先在设置中配置访问 Token。")
            return
        }
        uiState = uiState.copy(libraryLoading = true, libraryStatusText = if (append) "正在加载更多..." else "正在筛选...")
        val result = queryPage(learned, "", token, beforeId, filters, queryTime)
        if (queryGeneration != libraryGeneration || !isCurrentAccount(account) || token != currentApiToken() ||
            filters != uiState.bookmarkFilters || learned != uiState.filter) return
        when (result) {
            is LinkPageResult.Loaded -> {
                if (!result.page.validContinuation(beforeId)) {
                    uiState = uiState.copy(libraryLoading = false, libraryNextBeforeId = null, libraryStatusText = "分页响应无效，请重新筛选。")
                    return
                }
                val known = (uiState.libraryResults + uiState.links).associateBy { it.id }
                val incoming = result.page.items.filterNot { it.id in deletedLinks }.map { it.retainLoadedContent(known[it.id]) }
                val rows = (if (append) uiState.libraryResults + incoming else incoming).distinctBy { it.id }.sortedByDescending { it.id }
                uiState = uiState.copy(libraryResults = rows, libraryLoading = false, libraryStale = false,
                    libraryNextBeforeId = result.page.nextBeforeId,
                    libraryStatusText = if (rows.isEmpty()) "没有符合条件的收藏。" else "已显示 ${rows.size} 条${if (result.page.nextBeforeId != null) "，还有更多。" else "。"}")
            }
            is LinkPageResult.Failed -> uiState = uiState.copy(libraryLoading = false,
                libraryStatusText = failureText(result.kind, if (append) "加载更多失败，请重试。" else "筛选失败，请检查网络后重试。"))
            LinkPageResult.UnsupportedFilters -> uiState = uiState.copy(libraryLoading = false,
                libraryNextBeforeId = null, libraryStatusText = FILTER_UNSUPPORTED_MESSAGE)
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

    fun ensureLink(id: Int, force: Boolean = false) {
        if (id in deletedLinks) return
        val generation = uiState.accountGeneration
        if (uiState.detailLoads[id] == DetailLoadState.Loading) return
        val loaded = uiState.links.firstOrNull { it.id == id && it.enrichment?.contentLoaded == true }
        if (!force && loaded != null && (id !in uiState.offlineReads || id in verifiedDetails)) {
            val account = curationAccountKey()
            verifiedDetails += id
            viewModelScope.launch {
                try {
                    if (!offlineReads.touch(account, id, expected = loaded)) offlineReads.save(account, loaded,
                        labels = readerTags(loaded, null, uiState.v2Taxonomy ?: uiState.taxonomy))
                    val rows = offlineReads.snapshot(account)
                    if (isCurrentAccount(generation) && id !in deletedLinks) uiState = uiState.copy(
                        offlineReads = rows.associate { it.link.id to OfflineReadInfo(it.savedAt, it.pinned, it.link.id in verifiedDetails, it.tagLabels) },
                        offlineLinks = rows.map { it.link })
                } catch (_: java.io.IOException) { if (isCurrentAccount(generation)) uiState = uiState.copy(message = nextMessage("离线正文未能保存，请检查本机存储。")) }
            }
            return
        }
        val apiToken = currentApiToken()
        if (apiToken.isBlank()) {
            uiState = uiState.copy(
                detailLoads = uiState.detailLoads + (id to DetailLoadState.Failed),
                message = nextMessage("需要配置访问 Token 后才能加载详情。"),
            )
            return
        }
        val initial = uiState.links.firstOrNull { it.id == id }
        uiState = uiState.copy(detailLoads = uiState.detailLoads + (id to DetailLoadState.Loading))
        viewModelScope.launch {
            val result = cancellableRead { repository.get(id, apiToken, it) }
            if (!isCurrentAccount(generation) || id in deletedLinks) return@launch
            if (uiState.links.firstOrNull { it.id == id } != initial) {
                // A refresh or confirmed edit advanced the visible link while
                // this read was in flight. Read again if its body is still absent.
                uiState = uiState.copy(detailLoads = uiState.detailLoads - id)
                ensureLink(id)
                return@launch
            }
            when (result) {
                is LinkGetResult.Loaded -> {
                    verifiedDetails += id
                    uiState = uiState.copy(
                        links = uiState.links.upsert(result.link),
                        libraryResults = uiState.libraryResults.map { if (it.id == result.link.id) result.link else it },
                        searchResults = uiState.searchResults.map { if (it.id == result.link.id) result.link else it },
                        detailLoads = uiState.detailLoads - id,
                    )
                    try {
                        val cached = offlineReads.save(curationAccountKey(), result.link,
                            labels = readerTags(result.link, null, uiState.v2Taxonomy ?: uiState.taxonomy))
                        if (isCurrentAccount(generation) && cached != null) {
                            val saved = offlineReads.snapshot(curationAccountKey())
                            if (isCurrentAccount(generation)) uiState = uiState.copy(
                                offlineReads = saved.associate { it.link.id to OfflineReadInfo(it.savedAt, it.pinned, it.link.id in verifiedDetails, it.tagLabels) },
                                offlineLinks = saved.map { it.link })
                        }
                    } catch (_: java.io.IOException) {
                        if (isCurrentAccount(generation)) uiState = uiState.copy(message = nextMessage("正文已读取；离线缓存未能保存，请检查存储。"))
                    }
                }
                LinkGetResult.NotFound -> {
                    try { offlineReads.remove(curationAccountKey(), id) } catch (_: java.io.IOException) {
                        if (isCurrentAccount(generation)) uiState = uiState.copy(message = nextMessage("收藏已不存在；本地缓存清理失败，请在设置重试。"))
                    }
                    if (!isCurrentAccount(generation)) return@launch
                    uiState = uiState.copy(offlineReads = uiState.offlineReads - id, offlineLinks = uiState.offlineLinks.filterNot { it.id == id }, links = uiState.links.filterNot { it.id == id })
                    uiState = uiState.copy(detailLoads = uiState.detailLoads + (id to DetailLoadState.NotFound))
                }
                is LinkGetResult.Failed -> {
                    uiState = uiState.copy(
                        detailLoads = uiState.detailLoads + (id to DetailLoadState.Failed),
                        message = if (result.kind == FailureKind.Unauthorized) {
                            nextMessage("Token 无效，请在设置中重新填写。")
                        } else {
                            uiState.message
                        },
                    )
                }
            }
        }
    }

    fun loadTaxonomy() {
        val generation = uiState.accountGeneration
        val token = currentApiToken()
        if (token.isBlank() || uiState.taxonomy != null || uiState.taxonomyLoading) return
        uiState = uiState.copy(taxonomyLoading = true)
        viewModelScope.launch {
            val result = cancellableRead { repository.taxonomy(token, it) }
            if (!isCurrentAccount(generation) || token != currentApiToken()) return@launch
            uiState = uiState.copy(taxonomyLoading = false, taxonomy = (result as? TaxonomyResult.Loaded)?.taxonomy)
        }
    }

    fun saveCuration(id: Int, update: CurationUpdate, onSuccess: () -> Unit) {
        val generation = uiState.accountGeneration
        if (id in uiState.busyIds) return
        val token = currentApiToken()
        if (token.isBlank()) {
            uiState = uiState.copy(message = nextMessage("请先在设置中配置访问 Token。"))
            return
        }
        uiState = uiState.copy(busyIds = uiState.busyIds + id)
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { repository.curate(id, update, token) }
            if (!isCurrentAccount(generation)) return@launch
            when (result) {
                is LinkMutationResult.Updated -> {
                    uiState = uiState.copy(
                        links = uiState.links.upsert(result.link),
                        searchResults = uiState.searchResults.map { if (it.id == result.link.id) result.link else it },
                        busyIds = uiState.busyIds - id,
                        message = nextMessage("已保存整理。"),
                    )
                    refreshSearchAfterMutation()
                    if (id in uiState.v2Selections || id in uiState.v2Drafts) loadV2Selection(id, force = true)
                    onSuccess()
                }
                is LinkMutationResult.Failed -> uiState = uiState.copy(
                    busyIds = uiState.busyIds - id,
                    message = nextMessage(failureText(result.kind, "整理保存失败，请重试。")),
                )
                LinkMutationResult.Deleted, LinkMutationResult.DeletionPending -> Unit
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
        val generation = uiState.accountGeneration
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
        val apiToken = currentApiToken()
        uiState = uiState.copy(manualAdd = draft.copy(submitting = true, statusText = "正在保存到本地..."))
        viewModelScope.launch {
            val pending = runCatching { pendingUploadStore.enqueue(preparedUrl, note) }.getOrNull()
            if (!isCurrentAccount(generation)) return@launch
            if (pending == null) {
                uiState = uiState.copy(
                    manualAdd = uiState.manualAdd.copy(
                        submitting = false,
                        statusText = "无法保存到本地，请检查设备存储空间。",
                    ),
                )
                return@launch
            }
            uiState = uiState.copy(
                manualAdd = ManualAddState(),
                message = nextMessage(
                    if (apiToken.isBlank()) {
                        "已保存到本地待上传队列，配置 Token 后可重试。"
                    } else {
                        "已保存到本地，正在上传。"
                    },
                ),
            )
            if (apiToken.isBlank()) return@launch

            val result = uploadPending(pending, apiToken)
            if (!isCurrentAccount(generation)) return@launch
            when (result) {
                is LinkCreateResult.Created -> {
                    uiState = uiState.copy(
                        message = nextMessage("已保存到链接库。"),
                    )
                }
                is LinkCreateResult.Failed -> {
                    uiState = uiState.copy(
                        message = nextMessage(pendingUploadRetainedText(result.kind)),
                    )
                }
                null -> Unit
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
        val generation = uiState.accountGeneration
        val draft = uiState.editDraft ?: return
        if (draft.saving) return
        val url = draft.url.trim()
        val error = validateLinkDraft(url, draft.note)
        if (error != null) {
            uiState = uiState.copy(editDraft = draft.copy(error = error))
            return
        }
        val apiToken = currentApiToken()
        if (apiToken.isBlank()) {
            uiState = uiState.copy(editDraft = draft.copy(error = "请先在设置中配置访问 Token。"))
            return
        }

        uiState = uiState.copy(editDraft = draft.copy(saving = true, error = ""))
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                repository.update(id = draft.id, url = url, note = draft.note, apiToken = apiToken)
            }
            if (!isCurrentAccount(generation)) return@launch
            when (result) {
                is LinkMutationResult.Updated -> {
                    uiState = uiState.copy(
                        links = uiState.links.upsert(result.link),
                        searchResults = uiState.searchResults.map { if (it.id == result.link.id) result.link else it },
                        editDraft = null,
                        message = nextMessage("已保存修改。"),
                    )
                    refreshSearchAfterMutation()
                    onSuccess()
                }
                LinkMutationResult.Deleted, LinkMutationResult.DeletionPending -> Unit
                is LinkMutationResult.Failed -> {
                    uiState = uiState.copy(
                        editDraft = uiState.editDraft?.copy(
                            saving = false,
                            error = failureText(result.kind, "保存失败。请检查网络后重试。"),
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
        val generation = uiState.accountGeneration
        if (linkId in uiState.busyIds) return
        val apiToken = currentApiToken()
        if (apiToken.isBlank()) {
            uiState = uiState.copy(message = nextMessage("请先在设置中配置访问 Token。"))
            return
        }
        uiState = uiState.copy(busyIds = uiState.busyIds + linkId)
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { repository.update(linkId, learned = learned, apiToken = apiToken) }
            if (!isCurrentAccount(generation)) return@launch
            when (result) {
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
                        searchResults = uiState.searchResults.map { if (it.id == result.link.id) result.link else it },
                        busyIds = uiState.busyIds - linkId,
                        message = message,
                    )
                    refreshSearchAfterMutation()
                }
                LinkMutationResult.Deleted, LinkMutationResult.DeletionPending -> Unit
                is LinkMutationResult.Failed -> {
                    uiState = uiState.copy(
                        busyIds = uiState.busyIds - linkId,
                        message = nextMessage(failureText(result.kind, "学习状态保存失败。")),
                    )
                }
            }
        }
    }

    private fun forgetDeletedLink(id: Int) {
        BookmarkImageCache.forget(curationAccountKey(), id)
        deletedLinks = deletedLinks + id
        pendingDeletions = pendingDeletions - id
        selectionRequests[id] = (selectionRequests[id] ?: 0) + 1
        uiState = uiState.copy(
            links = uiState.links.filterNot { it.id == id },
            queueResults = uiState.queueResults.filterNot { it.id == id },
            offlineReads = uiState.offlineReads - id,
            offlineLinks = uiState.offlineLinks.filterNot { it.id == id },
            personalTagQueued = uiState.personalTagQueued - id,
            libraryResults = uiState.libraryResults.filterNot { it.id == id },
            searchResults = uiState.searchResults.filterNot { it.id == id },
            detailLoads = uiState.detailLoads - id, busyIds = uiState.busyIds - id,
            editDraft = uiState.editDraft?.takeUnless { it.id == id },
            v2Selections = uiState.v2Selections - id, v2Drafts = uiState.v2Drafts - id,
            v2Conflicts = uiState.v2Conflicts - id, v2Busy = uiState.v2Busy - id,
            v2Queued = uiState.v2Queued - id, v2LegacyActions = uiState.v2LegacyActions - id,
        )
    }

    fun deleteLink(linkId: Int, onSuccess: () -> Unit) {
        val generation = uiState.accountGeneration
        val account = curationAccountKey()
        if (linkId in uiState.busyIds) return
        val apiToken = currentApiToken()
        if (apiToken.isBlank()) {
            uiState = uiState.copy(message = nextMessage("请先在设置中配置访问 Token。"))
            return
        }
        pendingDeletions = pendingDeletions + linkId
        uiState = uiState.copy(busyIds = uiState.busyIds + linkId)
        viewModelScope.launch {
            try {
                // Persist intent before networking. The shared queue lock prevents
                // a delayed acknowledgement from racing removal of its action.
                curationActionStore.beginDeletion(account, linkId)
                curationActionStore.syncMutex.withLock {
                    val result = withContext(Dispatchers.IO) { repository.delete(linkId, apiToken) }
                    if (result == LinkMutationResult.Deleted || result == LinkMutationResult.DeletionPending) {
                        curationActionStore.confirmDeletion(account, linkId)
                        personalTags.discard(account, linkId)
                        offlineReads.remove(account, linkId)
                        BookmarkImageCache.forget(account, linkId)
                        if (accountEditDrafts[account]?.id == linkId) accountEditDrafts.remove(account)
                        if (!isCurrentAccount(generation) || account != curationAccountKey()) return@withLock
                        forgetDeletedLink(linkId)
                        uiState = uiState.copy(message = nextMessage(if (result == LinkMutationResult.DeletionPending)
                            "收藏已移除，附件正在后台清理。" else "已删除链接。"))
                        refreshSearchAfterMutation()
                        onSuccess()
                    } else if (isCurrentAccount(generation) && account == curationAccountKey()) {
                        uiState = uiState.copy(busyIds = uiState.busyIds - linkId,
                            message = nextMessage("删除尚未确认，已保留删除请求；可重试，重启后也会继续。"))
                    }
                }
            } catch (error: java.io.IOException) {
                if (isCurrentAccount(generation) && account == curationAccountKey()) uiState = uiState.copy(
                    busyIds = uiState.busyIds - linkId,
                    message = nextMessage("删除记录保存失败，请重试；尚未确认本地清理完成。"))
            }
        }
    }

    fun markAllPendingLearned() {
        if (uiState.queueAvailable != true || uiState.queueLoading) return
        val generation = uiState.accountGeneration
        val pending = uiState.queueLinks()
        if (pending.isEmpty()) {
            uiState = uiState.copy(message = nextMessage("待学习队列已经清空。"))
            return
        }
        val apiToken = currentApiToken()
        if (apiToken.isBlank()) {
            uiState = uiState.copy(message = nextMessage("请先在设置中配置访问 Token。"))
            return
        }
        viewModelScope.launch {
            var success = 0
            var failed = 0
            for (link in pending) {
                uiState = uiState.copy(busyIds = uiState.busyIds + link.id)
                val result = withContext(Dispatchers.IO) { repository.update(link.id, learned = true, apiToken = apiToken) }
                if (!isCurrentAccount(generation)) return@launch
                when (result) {
                    is LinkMutationResult.Updated -> {
                        success += 1
                        uiState = uiState.copy(links = uiState.links.upsert(result.link),
                            searchResults = uiState.searchResults.map { if (it.id == result.link.id) result.link else it })
                        refreshSearchAfterMutation()
                    }
                    LinkMutationResult.Deleted, LinkMutationResult.DeletionPending -> Unit
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

    fun setApiToken(value: String) {
        val token = value.trim()
        val intent = ++tokenIntent
        pendingTokenIntent = intent
        refreshJob?.cancel()
        searchJob?.cancel()
        // The settings UI updates optimistically, before DataStore emits. Never
        // expose the previous account's selection to actions in that interval.
        activateAccount(token)
        uiState = uiState.copy(preferences = uiState.preferences.copy(apiToken = token), loading = false, taxonomy = null, taxonomyLoading = false, message = null, apiTokenSaveError = "")
        viewModelScope.launch {
            try {
                tokenWrites.withLock {
                    // Skip superseded settings still waiting to be written. A
                    // write already in progress finishes before the newest one.
                    if (intent != tokenIntent) return@withLock
                    val revision = settingsStore.setApiToken(token)
                    if (intent == tokenIntent) {
                        minimumTokenRevision = maxOf(minimumTokenRevision, revision)
                        pendingTokenIntent = null
                        uiState = uiState.copy(preferences = uiState.preferences.copy(apiTokenRevision = revision))
                        // Reconsider the latest stored value: a newer external
                        // write may have arrived while our acknowledgment was
                        // pending, and need not emit again afterward.
                        tokenWriteSignals.value += 1
                    }
                }
            } catch (error: java.io.IOException) {
                if (intent == tokenIntent) uiState = uiState.copy(
                    apiTokenSaveError = "Token 保存失败，请重试。",
                    message = nextMessage("Token 保存失败，请重试。"),
                )
            }
        }
        refreshLinks()
        if (token.isNotBlank()) startPendingUploadRetry(showSummary = true)
    }

    fun retryPendingUpload(id: String) {
        val generation = uiState.accountGeneration
        if (id in uiState.uploadBusyIds) return
        val pending = uiState.pendingUploads.firstOrNull { it.id == id } ?: return
        val apiToken = currentApiToken()
        if (apiToken.isBlank()) {
            uiState = uiState.copy(message = nextMessage("链接仍保存在本地，请先配置访问 Token。"))
            return
        }
        viewModelScope.launch {
            val result = uploadPending(pending, apiToken)
            if (!isCurrentAccount(generation)) return@launch
            when (result) {
                is LinkCreateResult.Created -> {
                    uiState = uiState.copy(message = nextMessage("已上传到链接库。"))
                }
                is LinkCreateResult.Failed -> {
                    uiState = uiState.copy(message = nextMessage(pendingUploadRetainedText(result.kind)))
                }
                null -> Unit
            }
        }
    }

    fun retryAllPendingUploads() {
        startPendingUploadRetry(showSummary = true)
    }

    fun discardPendingUpload(id: String) {
        if (id in uiState.uploadBusyIds) return
        viewModelScope.launch {
            val removed = runCatching { pendingUploadStore.remove(id) }.isSuccess
            uiState = uiState.copy(
                message = nextMessage(
                    if (removed) "已从本地待上传队列移除。" else "无法修改本地队列，请稍后重试。",
                ),
            )
        }
    }

    fun setLastRoute(route: String) {
        if (uiState.preferences.lastRoute == route) return
        uiState = uiState.copy(preferences = uiState.preferences.copy(lastRoute = route))
        viewModelScope.launch { settingsStore.setLastRoute(route) }
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
        val generation = uiState.accountGeneration
        val state = uiState.apiDebug
        val token = currentApiToken()
        if (state.sending) return
        uiState = uiState.copy(apiDebug = state.copy(sending = true, statusLine = "发送中..."))
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                apiDebugClient.send(state.method, state.path, state.body, token)
            }
            if (!isCurrentAccount(generation)) return@launch
            when (result) {
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
                .combine(tokenWriteSignals) { stored, _ -> stored }
                .collect { stored ->
                    // DataStore commits and Flow delivery are different events.
                    // A buffered old token may arrive after a newer setting has
                    // committed. Apply unrelated preferences but retain the
                    // latest local account until its revision is observed.
                    val acceptToken = pendingTokenIntent == null && stored.apiTokenRevision >= minimumTokenRevision
                    val preferences = if (acceptToken) stored else stored.copy(
                        apiToken = uiState.preferences.apiToken,
                        apiTokenRevision = uiState.preferences.apiTokenRevision,
                    )
                    if (acceptToken) minimumTokenRevision = maxOf(minimumTokenRevision, stored.apiTokenRevision)
                    val firstLoad = !loadedPreferencesOnce
                    activateAccount(preferences.apiToken.trim())
                    // Compare persisted emissions, not the optimistic settings UI.
                    val previousToken = lastObservedToken
                    lastObservedToken = preferences.apiToken.trim()
                    val restoredFilter = if (firstLoad) filterFromPreference(preferences.lastFilter) else uiState.filter
                    val restoredQuery = if (firstLoad) preferences.lastSearchQuery else uiState.searchQuery
                    loadedPreferencesOnce = true
                    uiState = uiState.copy(
                        preferences = preferences,
                        preferencesLoaded = true,
                        filter = restoredFilter,
                        searchQuery = restoredQuery,
                    )
                    if (firstLoad || previousToken != preferences.apiToken.trim()) {
                        val generation = uiState.accountGeneration
                        val deletionRecords = curationActionStore.deletions.first().filter { it.accountKey == curationAccountKey() }
                        if (!isCurrentAccount(generation)) return@collect
                        pendingDeletions = deletionRecords.filterNot { it.confirmed }.map { it.linkId }.toSet()
                        for (record in deletionRecords.filter { it.confirmed }) forgetDeletedLink(record.linkId)
                        val all = curationActionStore.snapshot()
                        if (!isCurrentAccount(generation)) return@collect
                        val mine = all.filter { it.accountKey == curationAccountKey() && it.linkId !in deletedLinks }
                        val legacyKey = legacyAccountKeyFor(uiState.apiBaseUrl, preferences.apiToken)
                        uiState = uiState.copy(v2Queued = mine.groupingBy { it.linkId }.eachCount(),
                            v2LegacyActions = all.filter { it.accountKey == legacyKey && it.linkId !in deletedLinks }.groupBy { it.linkId },
                            v2Conflicts = mine.mapNotNull { a -> a.conflictRevision?.let { a.linkId to it } }.toMap())
                        try {
                            val customPending = personalTags.snapshot().filter { it.account == curationAccountKey() && it.linkId !in deletedLinks }
                            if (!isCurrentAccount(generation)) return@collect
                            uiState = uiState.copy(personalTagPendingCount = customPending.size, personalTagQueued = customPending.groupingBy { it.linkId }.eachCount())
                        } catch (_: java.io.IOException) {
                            uiState = uiState.copy(message = nextMessage("个人标签离线队列暂时无法读取，请检查存储。"))
                        }
                        try {
                            val cached = offlineReads.snapshot(curationAccountKey()).filterNot { it.link.id in deletedLinks }
                            if (isCurrentAccount(generation)) uiState = uiState.copy(
                                links = (uiState.links + cached.map { it.link }).distinctBy { it.id }.sortedByDescending { it.id },
                                offlineReads = cached.associate { it.link.id to OfflineReadInfo(it.savedAt, it.pinned, tagLabels = it.tagLabels) },
                                offlineLinks = cached.map { it.link },
                                statusText = if (cached.isEmpty()) "" else "已读取 ${cached.size} 条离线正文，正在确认云端版本…")
                        } catch (_: java.io.IOException) {
                            if (isCurrentAccount(generation)) uiState = uiState.copy(message = nextMessage("离线正文暂时无法读取，请检查存储。"))
                        }
                        if (!isCurrentAccount(generation)) return@collect
                        refreshLinks()
                        for (id in pendingDeletions.toList()) deleteLink(id) {}
                        pumpV2Actions()
                    }
                    maybeStartAutomaticUploadRetry()
                    if (firstLoad && restoredQuery.isNotBlank()) {
                        searchJob?.cancel()
                        searchJob = viewModelScope.launch {
                            loadSearchPage(query = restoredQuery.trim(), beforeId = null, append = false)
                        }
                    }
                }
        }
    }

    private fun observePendingUploads() {
        viewModelScope.launch {
            pendingUploadStore.uploads
                .catch { emit(emptyList()) }
                .collect { uploads ->
                    uiState = uiState.copy(
                        pendingUploads = uploads,
                        pendingUploadsLoaded = true,
                    )
                    maybeStartAutomaticUploadRetry()
                }
        }
    }

    private fun maybeStartAutomaticUploadRetry() {
        if (automaticUploadRetryStarted || !uiState.preferencesLoaded || !uiState.pendingUploadsLoaded) return
        automaticUploadRetryStarted = true
        if (currentApiToken().isNotBlank() && uiState.pendingUploads.isNotEmpty()) {
            startPendingUploadRetry(showSummary = false)
        }
    }

    private fun startPendingUploadRetry(showSummary: Boolean) {
        val generation = uiState.accountGeneration
        if (pendingUploadsRetryJob?.isActive == true) {
            retryPendingUploadsAgain = true
            retryPendingUploadsAgainWithSummary = retryPendingUploadsAgainWithSummary || showSummary
            return
        }
        val uploads = uiState.pendingUploads.filterNot { it.id in uiState.uploadBusyIds }
        if (uploads.isEmpty()) {
            if (showSummary) uiState = uiState.copy(message = nextMessage("本地待上传队列已经清空。"))
            return
        }
        val apiToken = currentApiToken()
        if (apiToken.isBlank()) {
            if (showSummary) {
                uiState = uiState.copy(message = nextMessage("链接已保存在本地，请先配置访问 Token。"))
            }
            return
        }

        pendingUploadsRetryJob = viewModelScope.launch {
            uiState = uiState.copy(retryingUploads = true)
            var uploaded = 0
            var retained = 0
            for (pending in uploads) {
                if (!isCurrentAccount(generation)) break
                when (uploadPending(pending, apiToken)) {
                    is LinkCreateResult.Created -> uploaded += 1
                    is LinkCreateResult.Failed,
                    null -> retained += 1
                }
            }
            val attemptedIds = uploads.mapTo(mutableSetOf(), PendingUpload::id)
            val newlyQueued = uiState.pendingUploads.count { it.id !in attemptedIds }
            val remaining = retained + newlyQueued
            uiState = uiState.copy(
                retryingUploads = false,
                message = when {
                    !isCurrentAccount(generation) -> uiState.message
                    showSummary && remaining == 0 -> nextMessage("已上传 $uploaded 条本地链接，队列已清空。")
                    showSummary -> nextMessage("已上传 $uploaded 条，另有 $remaining 条保存在本地。")
                    uploaded > 0 -> nextMessage("已自动上传 $uploaded 条本地链接。")
                    else -> uiState.message
                },
            )
            val runAgain = retryPendingUploadsAgain
            val runAgainWithSummary = retryPendingUploadsAgainWithSummary
            retryPendingUploadsAgain = false
            retryPendingUploadsAgainWithSummary = false
            pendingUploadsRetryJob = null
            if (runAgain) startPendingUploadRetry(showSummary = runAgainWithSummary)
        }
    }

    private suspend fun uploadPending(pending: PendingUpload, apiToken: String): LinkCreateResult? {
        val generation = uiState.accountGeneration
        if (pending.id in uiState.uploadBusyIds) return null
        uiState = uiState.copy(uploadBusyIds = uiState.uploadBusyIds + pending.id)
        val result = withContext(Dispatchers.IO) {
            runCatching {
                repository.create(
                    url = pending.url,
                    note = pending.note,
                    apiToken = apiToken,
                    clientId = pending.id,
                )
            }.getOrElse { LinkCreateResult.Failed(FailureKind.Network) }
        }
        when (result) {
            is LinkCreateResult.Created -> {
                runCatching { pendingUploadStore.remove(pending.id) }
                if (isCurrentAccount(generation)) {
                    uiState = uiState.copy(links = uiState.links.upsert(result.link),
                        searchResults = uiState.searchResults.map { if (it.id == result.link.id) result.link else it })
                    refreshSearchAfterMutation()
                }
            }
            is LinkCreateResult.Failed -> {
                runCatching { pendingUploadStore.recordFailure(pending.id, result.kind) }
            }
        }
        uiState = uiState.copy(uploadBusyIds = uiState.uploadBusyIds - pending.id)
        return result
    }

    private suspend fun loadSearchPage(query: String, beforeId: Int?, append: Boolean) {
        val search = searchGeneration
        val generation = uiState.accountGeneration
        val apiToken = currentApiToken()
        val filters = uiState.bookmarkFilters
        if (apiToken.isBlank()) {
            uiState = uiState.copy(
                searchLoading = false,
                searchStatusText = "请先在设置中配置访问 Token。",
                message = nextMessage("需要配置访问 Token 后才能搜索。"),
            )
            return
        }
        uiState = uiState.copy(
            searchLoading = true,
            searchStatusText = if (append) "正在加载更多..." else "正在搜索...",
        )
        val queryTime = searchFilterTime
        val result = queryPage(LinkFilter.All, query, apiToken, beforeId, filters, queryTime)
        if (search != searchGeneration || !isCurrentAccount(generation) || uiState.searchQuery.trim() != query || uiState.bookmarkFilters != filters) return
        when (result) {
            is LinkPageResult.Loaded -> {
                if (uiState.searchQuery.trim() != query || uiState.bookmarkFilters != filters || apiToken != currentApiToken()) return
                if (!result.page.validContinuation(beforeId)) {
                    uiState = uiState.copy(searchLoading = false, searchNextBeforeId = null, searchStatusText = "分页响应无效，请重新搜索。")
                    return
                }
                val nextItems = if (append) {
                    (uiState.searchResults + result.page.items.filterNot { it.id in deletedLinks })
                        .distinctBy { it.id }
                        .sortedByDescending { it.id }
                } else {
                    result.page.items.filterNot { it.id in deletedLinks }.sortedByDescending { it.id }
                }
                uiState = uiState.copy(
                    searchResults = nextItems,
                    searchLoading = false,
                    searchStale = false,
                    searchNextBeforeId = result.page.nextBeforeId,
                    searchStatusText = if (nextItems.isEmpty()) "没有匹配的链接。" else "找到 ${nextItems.size} 条结果。",
                )
            }
            is LinkPageResult.Failed -> {
                if (uiState.searchQuery.trim() != query) return
                val authFailure = result.kind == FailureKind.Unauthorized
                uiState = uiState.copy(
                    searchLoading = false,
                    searchStatusText = when {
                        authFailure -> "Token 无效，请在设置中重新填写。"
                        append -> "加载更多失败。"
                        else -> "搜索失败。请检查网络后重试。"
                    },
                    message = nextMessage(
                        when {
                            authFailure -> "Token 无效，请在设置中重新填写。"
                            append -> "加载更多失败。"
                            else -> "搜索失败。请检查网络。"
                        },
                    ),
                )
            }
            LinkPageResult.UnsupportedFilters -> uiState = uiState.copy(searchLoading = false,
                searchNextBeforeId = null, searchStatusText = FILTER_UNSUPPORTED_MESSAGE)
        }
    }

    private fun currentApiToken(): String = uiState.preferences.apiToken.trim()

    private fun filterFromPreference(value: String): LinkFilter =
        LinkFilter.entries.firstOrNull { it.apiValue == value } ?: LinkFilter.All

    private fun failureText(kind: FailureKind, fallback: String): String =
        if (kind == FailureKind.Unauthorized) "Token 无效，请在设置中重新填写。" else fallback

    private fun pendingUploadRetainedText(kind: FailureKind): String =
        if (kind == FailureKind.Unauthorized) {
            "链接已保存在本地，请更新 Token 后重试。"
        } else {
            "链接已保存在本地待上传队列，联网后会再次尝试。"
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
    return (if (usesLibraryQuery()) libraryResults else links).sortedByDescending { it.id }
}

internal fun CairnLinksUiState.usesLibraryQuery(): Boolean = filter != LinkFilter.All || bookmarkFilters != BookmarkFilters()

private const val FILTER_UNSUPPORTED_MESSAGE = "服务暂不支持完整筛选，请更新服务或清除筛选后浏览。"

private fun com.alpenl.cairn.share.network.LinkPage.validContinuation(beforeId: Int?): Boolean {
    val ids = items.map { it.id }
    if (ids.any { it <= 0 || (beforeId != null && it >= beforeId) } || ids.distinct().size != ids.size || ids != ids.sortedDescending()) return false
    val next = nextBeforeId ?: return true
    return ids.isNotEmpty() && next == ids.last() && (beforeId == null || next < beforeId)
}

internal fun CairnLinksUiState.searchResultLinks(): List<SavedLink> {
    return searchResults.sortedByDescending { it.id }
}

internal fun CairnLinksUiState.queueLinks(): List<SavedLink> =
    queueResults

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
        oldestPending = links.asSequence().filter { !it.learned }
            .minWithOrNull(compareBy<SavedLink> { parseInstantOrNull(it.createdAt) }.thenBy { it.id }),
    )
}

private fun List<SavedLink>.upsert(link: SavedLink): List<SavedLink> =
    if (any { it.id == link.id }) {
        map { if (it.id == link.id) link else it }.sortedByDescending { it.id }
    } else {
        (this + link).sortedByDescending { it.id }
    }

internal class CairnLinksViewModelFactory(
    private val repository: LinksApiClient,
    private val updateApiClient: UpdateApiClient,
    private val settingsStore: SharePreferencesStore,
    private val pendingUploadStore: PendingUploadStore,
    private val apiDebugClient: ApiDebugClient,
    private val v2Repository: V2CurationRepository,
    private val curationActionStore: CurationActionStore,
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
            pendingUploadStore = pendingUploadStore,
            apiDebugClient = apiDebugClient,
            v2Repository = v2Repository,
            curationActionStore = curationActionStore,
            apiBaseUrl = apiBaseUrl,
            releasesApiUrl = releasesApiUrl,
            currentVersionName = currentVersionName,
            currentVersionCode = currentVersionCode,
        ) as T
}

/** One queued logical curation action with its stable operation identity. */
