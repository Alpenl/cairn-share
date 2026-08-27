package com.alpenl.cairn.share

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.alpenl.cairn.share.contract.UrlCandidate
import com.alpenl.cairn.share.contract.UrlCandidateExtractor
import com.alpenl.cairn.share.network.FailureKind
import com.alpenl.cairn.share.network.LinkFilter
import com.alpenl.cairn.share.network.LinkListResult
import com.alpenl.cairn.share.network.LinkMutationResult
import com.alpenl.cairn.share.network.LinksApiClient
import com.alpenl.cairn.share.network.SavedLink
import com.alpenl.cairn.share.network.ShareApiClient
import com.alpenl.cairn.share.network.ShareSubmitResult
import com.alpenl.cairn.share.network.UpdateApiClient
import com.alpenl.cairn.share.network.UpdateCheckResult
import com.alpenl.cairn.share.ui.theme.CairnShareTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ShareActivity : ComponentActivity() {
    companion object {
        const val EXTRA_API_BASE_URL = "com.alpenl.cairn.share.extra.API_BASE_URL"
        const val EXTRA_RELEASES_API_URL = "com.alpenl.cairn.share.extra.RELEASES_API_URL"

        private const val STATE_SELECTED_INDEX = "share.selected_index"
        private const val STATE_NOTE = "share.note"
        private const val STATE_STATUS = "share.status"
        private const val STATE_SUBMITTING = "share.submitting"
        private const val MAX_NOTE_LENGTH = 2000
    }

    private var candidates by mutableStateOf(emptyList<UrlCandidate>())
    private var selectedIndex by mutableIntStateOf(-1)
    private var note by mutableStateOf("")
    private var status by mutableStateOf<String?>(null)
    private var submitting by mutableStateOf(false)
    private var submitGeneration = 0
    private var submitJob: Job? = null
    private var apiBaseUrl = BuildConfig.CAIRN_SHARE_API_BASE_URL
    private var releasesApiUrl = BuildConfig.CAIRN_SHARE_RELEASES_API_URL
    private var updateState by mutableStateOf<AppUpdateState>(AppUpdateState.Hidden)
    private var updateJob: Job? = null
    private var libraryVisible by mutableStateOf(false)
    private var linkFilter by mutableStateOf(LinkFilter.All)
    private var linkSearchQuery by mutableStateOf("")
    private var linkItems by mutableStateOf(emptyList<SavedLink>())
    private var linkLoading by mutableStateOf(false)
    private var linkStatus by mutableStateOf("")
    private var editingLink by mutableStateOf<SavedLink?>(null)
    private var editUrl by mutableStateOf("")
    private var editNote by mutableStateOf("")
    private var editSaving by mutableStateOf(false)
    private var libraryJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        inspectIntent(intent)
        restoreState(savedInstanceState)
        setContent {
            CairnShareTheme {
                ShareScreen(
                    model = ShareCandidatePresenter.screenModel(
                        candidates = candidates,
                        selectedIndex = selectedIndex,
                        note = note,
                        status = status,
                        submitting = submitting,
                    ),
                    onSelectRow = ::selectCandidate,
                    onNoteChange = ::changeNote,
                    onSave = ::submitSelected,
                    updateState = updateState,
                    currentVersionName = BuildConfig.VERSION_NAME,
                    libraryModel = libraryModel(),
                    onFilterChange = ::changeFilter,
                    onSearchQueryChange = ::changeSearchQuery,
                    onSearch = ::loadLinks,
                    onRefreshLinks = ::loadLinks,
                    onOpenLink = ::openLink,
                    onToggleLearned = ::toggleLearned,
                    onEditLink = ::startEdit,
                    onEditUrlChange = ::changeEditUrl,
                    onEditNoteChange = ::changeEditNote,
                    onSaveEdit = ::saveEdit,
                    onCancelEdit = ::cancelEdit,
                    onDeleteEditing = ::deleteEditing,
                    onCheckUpdate = ::checkForUpdates,
                    onOpenUpdate = ::openUpdate,
                    onClose = ::finish,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        submitJob?.cancel()
        submitJob = null
        updateJob?.cancel()
        updateJob = null
        libraryJob?.cancel()
        libraryJob = null
        submitGeneration += 1
        note = ""
        status = null
        submitting = false
        inspectIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt(STATE_SELECTED_INDEX, selectedIndex)
        outState.putString(STATE_NOTE, note)
        status?.let { outState.putString(STATE_STATUS, it) }
        outState.putBoolean(STATE_SUBMITTING, submitting)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        submitJob?.cancel()
        updateJob?.cancel()
        libraryJob?.cancel()
        super.onDestroy()
    }

    private fun inspectIntent(intent: Intent) {
        apiBaseUrl = intent.getStringExtra(EXTRA_API_BASE_URL)
            ?.trim()
            ?.trimEnd('/')
            ?.takeIf(String::isNotEmpty)
            ?: BuildConfig.CAIRN_SHARE_API_BASE_URL
        releasesApiUrl = intent.getStringExtra(EXTRA_RELEASES_API_URL)
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?: BuildConfig.CAIRN_SHARE_RELEASES_API_URL

        if (intent.action == Intent.ACTION_MAIN) {
            libraryVisible = true
            candidates = emptyList()
            selectedIndex = -1
            status = null
            editingLink = null
            checkForUpdates()
            loadLinks()
            return
        }

        libraryVisible = false
        updateState = AppUpdateState.Hidden
        editingLink = null
        if (intent.action != Intent.ACTION_SEND || intent.type != "text/plain") {
            candidates = emptyList()
            selectedIndex = -1
            status = getString(R.string.share_no_supported_content)
            return
        }

        val clipData = intent.clipData
        candidates = UrlCandidateExtractor.extract(
            NativeShareSources.payload(
                intentDataUrl = intent.data?.toString(),
                clipItemCount = clipData?.itemCount ?: 0,
                clipUriAt = { index -> clipData?.getItemAt(index)?.uri?.toString() },
                extraText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
                clipTextAt = { index -> clipData?.getItemAt(index)?.text?.toString() },
            ),
        )
        selectedIndex = ShareCandidatePresenter.initialSelectedIndex(candidates)
        status = if (candidates.isEmpty()) getString(R.string.share_no_supported_content) else null
    }

    private fun restoreState(savedInstanceState: Bundle?) {
        if (savedInstanceState == null) return
        val restoredIndex = savedInstanceState.getInt(STATE_SELECTED_INDEX, selectedIndex)
        selectedIndex = if (restoredIndex in candidates.indices) restoredIndex else selectedIndex
        note = savedInstanceState.getString(STATE_NOTE).orEmpty()
        val wasSubmitting = savedInstanceState.getBoolean(STATE_SUBMITTING)
        status = if (wasSubmitting) {
            getString(R.string.share_interrupted)
        } else {
            savedInstanceState.getString(STATE_STATUS) ?: status
        }
        submitting = false
    }

    private fun selectCandidate(index: Int) {
        if (submitting || index !in candidates.indices) return
        selectedIndex = index
        status = null
    }

    private fun changeNote(value: String) {
        if (submitting) return
        note = value
        if (value.length <= MAX_NOTE_LENGTH && status == getString(R.string.share_note_too_long)) {
            status = null
        }
    }

    private fun submitSelected() {
        val candidate = ShareCandidatePresenter.selectedCandidate(candidates, selectedIndex) ?: return
        if (submitting) return
        if (note.length > MAX_NOTE_LENGTH) {
            status = getString(R.string.share_note_too_long)
            return
        }

        val generation = ++submitGeneration
        submitting = true
        status = getString(R.string.share_saving)
        submitJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                ShareApiClient(apiBaseUrl).save(candidate.submissionValue, note)
            }
            if (!isActive || generation != submitGeneration) return@launch
            submitting = false
            when (result) {
                ShareSubmitResult.Saved -> {
                    status = getString(R.string.share_saved)
                    delay(300)
                    if (isActive && generation == submitGeneration) finish()
                }
                is ShareSubmitResult.Failed -> {
                    status = failureMessage(result.kind)
                }
            }
        }
    }

    private fun libraryModel(): LinkLibraryModel? {
        if (!libraryVisible) return null
        val editing = editingLink?.let { link ->
            LinkEditModel(
                link = link,
                url = editUrl,
                note = editNote,
                saving = editSaving,
            )
        }
        return LinkLibraryModel(
            filter = linkFilter,
            searchQuery = linkSearchQuery,
            items = linkItems,
            loading = linkLoading,
            statusText = linkStatus,
            editing = editing,
        )
    }

    private fun changeFilter(filter: LinkFilter) {
        if (linkFilter == filter && linkItems.isNotEmpty()) return
        linkFilter = filter
        editingLink = null
        loadLinks()
    }

    private fun changeSearchQuery(value: String) {
        linkSearchQuery = value
    }

    private fun loadLinks() {
        if (!libraryVisible) return
        libraryJob?.cancel()
        linkLoading = true
        linkStatus = getString(R.string.library_loading)
        libraryJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                LinksApiClient(apiBaseUrl).list(linkFilter, linkSearchQuery)
            }
            if (!isActive) return@launch
            linkLoading = false
            when (result) {
                is LinkListResult.Loaded -> {
                    linkItems = result.items
                    linkStatus = loadedStatus(result.items.size)
                }
                is LinkListResult.Failed -> {
                    linkStatus = getString(R.string.library_load_failed)
                }
            }
        }
    }

    private fun loadedStatus(size: Int): String =
        if (size > 0) {
            getString(R.string.library_loaded_count, size)
        } else if (linkSearchQuery.isBlank()) {
            when (linkFilter) {
                LinkFilter.Unlearned -> getString(R.string.library_empty_unlearned)
                LinkFilter.Learned -> getString(R.string.library_empty_learned)
                LinkFilter.All -> getString(R.string.library_empty_all)
            }
        } else {
            getString(R.string.library_empty_search)
        }

    private fun openLink(link: SavedLink) {
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link.url)))
        }.onFailure {
            linkStatus = getString(R.string.library_open_failed)
        }
    }

    private fun toggleLearned(link: SavedLink) {
        mutateLinks(getString(R.string.library_saving)) {
            LinksApiClient(apiBaseUrl).update(link.id, learned = !link.learned)
        }
    }

    private fun startEdit(link: SavedLink) {
        editingLink = link
        editUrl = link.url
        editNote = link.note
        editSaving = false
        linkStatus = ""
    }

    private fun changeEditUrl(value: String) {
        editUrl = value
    }

    private fun changeEditNote(value: String) {
        editNote = value
        if (value.length <= MAX_NOTE_LENGTH && linkStatus == getString(R.string.share_note_too_long)) {
            linkStatus = ""
        }
    }

    private fun saveEdit() {
        val link = editingLink ?: return
        if (editNote.length > MAX_NOTE_LENGTH) {
            linkStatus = getString(R.string.share_note_too_long)
            return
        }
        val trimmedUrl = editUrl.trim()
        val normalizedUrl = trimmedUrl.lowercase()
        if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
            linkStatus = getString(R.string.library_invalid_url)
            return
        }

        editSaving = true
        mutateLinks(getString(R.string.library_saving), keepEditSaving = true) {
            LinksApiClient(apiBaseUrl).update(
                id = link.id,
                url = trimmedUrl,
                note = editNote,
            )
        }
    }

    private fun cancelEdit() {
        editingLink = null
        editSaving = false
    }

    private fun deleteEditing() {
        val link = editingLink ?: return
        editSaving = true
        mutateLinks(getString(R.string.library_deleting), keepEditSaving = true) {
            LinksApiClient(apiBaseUrl).delete(link.id)
        }
    }

    private fun mutateLinks(
        busyStatus: String,
        keepEditSaving: Boolean = false,
        block: () -> LinkMutationResult,
    ) {
        libraryJob?.cancel()
        linkLoading = !keepEditSaving
        linkStatus = busyStatus
        libraryJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { block() }
            if (!isActive) return@launch
            linkLoading = false
            editSaving = false
            when (result) {
                LinkMutationResult.Deleted -> {
                    val deletedId = editingLink?.id
                    if (deletedId != null) {
                        linkItems = linkItems.filterNot { it.id == deletedId }
                    }
                    editingLink = null
                    linkStatus = getString(R.string.library_deleted)
                }
                is LinkMutationResult.Updated -> {
                    val updated = result.link
                    linkItems = if (matchesCurrentView(updated)) {
                        linkItems.map { if (it.id == updated.id) updated else it }
                    } else {
                        linkItems.filterNot { it.id == updated.id }
                    }
                    editingLink = null
                    linkStatus = getString(R.string.library_saved)
                }
                is LinkMutationResult.Failed -> {
                    linkStatus = getString(R.string.library_save_failed)
                }
            }
        }
    }

    private fun matchesCurrentView(link: SavedLink): Boolean {
        val filterMatches = when (linkFilter) {
            LinkFilter.Unlearned -> !link.learned
            LinkFilter.Learned -> link.learned
            LinkFilter.All -> true
        }
        if (!filterMatches) return false
        val query = linkSearchQuery.trim()
        if (query.isEmpty()) return true
        return link.url.contains(query, ignoreCase = true) || link.note.contains(query, ignoreCase = true)
    }

    private fun checkForUpdates() {
        if (updateState == AppUpdateState.Checking) return
        updateJob?.cancel()
        updateState = AppUpdateState.Checking
        updateJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                UpdateApiClient(releasesApiUrl).check()
            }
            if (!isActive) return@launch
            updateState = when (result) {
                is UpdateCheckResult.Available -> AppUpdateState.Available(result.update)
                UpdateCheckResult.UpToDate -> AppUpdateState.UpToDate
                UpdateCheckResult.Failed -> AppUpdateState.Failed
            }
        }
    }

    private fun openUpdate() {
        val update = (updateState as? AppUpdateState.Available)?.update ?: return
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(update.downloadUrl)))
        }.onFailure {
            updateState = AppUpdateState.Failed
        }
    }

    private fun failureMessage(kind: FailureKind): String =
        when (kind) {
            FailureKind.Network,
            FailureKind.Timeout,
            FailureKind.Server -> getString(R.string.share_failed)
        }
}
