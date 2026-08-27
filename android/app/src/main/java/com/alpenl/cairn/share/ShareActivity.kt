package com.alpenl.cairn.share

import android.content.Intent
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.lifecycle.lifecycleScope
import com.alpenl.cairn.share.contract.UrlCandidate
import com.alpenl.cairn.share.contract.UrlCandidateExtractor
import com.alpenl.cairn.share.network.FailureKind
import com.alpenl.cairn.share.network.ShareApiClient
import com.alpenl.cairn.share.network.ShareSubmitResult
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
    }

    private var candidates by mutableStateOf(emptyList<UrlCandidate>())
    private var selectedIndex by mutableIntStateOf(-1)
    private var note by mutableStateOf("")
    private var status by mutableStateOf<String?>(null)
    private var submitting by mutableStateOf(false)
    private var preferences by mutableStateOf(SharePreferences())
    private var submitGeneration = 0
    private var submitJob: Job? = null
    private var settingsJob: Job? = null
    private var apiBaseUrl = BuildConfig.CAIRN_SHARE_API_BASE_URL

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        makeWindowTranslucent()
        inspectIntent(intent)
        restoreState(savedInstanceState)
        observeSettings()
        setContent {
            CairnShareTheme {
                ShareBottomSheetScreen(
                    title = getString(R.string.share_sheet_title),
                    subtitle = shareSubtitle(),
                    candidates = candidates,
                    selectedIndex = selectedIndex,
                    note = note,
                    statusText = status.orEmpty(),
                    submitting = submitting,
                    preserveCompleteUrl = preferences.preserveCompleteUrl,
                    onSelectCandidate = ::selectCandidate,
                    onNoteChange = ::changeNote,
                    onSave = ::submitSelected,
                    onCancel = ::finish,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        submitJob?.cancel()
        submitJob = null
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
        settingsJob?.cancel()
        super.onDestroy()
    }

    private fun inspectIntent(intent: Intent) {
        apiBaseUrl = intent.getStringExtra(EXTRA_API_BASE_URL)
            ?.trim()
            ?.trimEnd('/')
            ?.takeIf(String::isNotEmpty)
            ?: BuildConfig.CAIRN_SHARE_API_BASE_URL

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
        status = if (savedInstanceState.getBoolean(STATE_SUBMITTING)) {
            getString(R.string.share_interrupted)
        } else {
            savedInstanceState.getString(STATE_STATUS) ?: status
        }
        submitting = false
    }

    private fun observeSettings() {
        settingsJob = lifecycleScope.launch {
            SharePreferencesStore(this@ShareActivity).preferences.collect {
                preferences = it
            }
        }
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
        val preparedUrl = if (preferences.preserveCompleteUrl) {
            candidate.submissionValue
        } else {
            removeQueryAndFragment(candidate.submissionValue)
        }
        if (!validateHttpUrl(preparedUrl)) {
            status = getString(R.string.library_invalid_url)
            return
        }
        if (note.length > MAX_NOTE_LENGTH) {
            status = getString(R.string.share_note_too_long)
            return
        }

        val generation = ++submitGeneration
        submitting = true
        status = getString(R.string.share_saving)
        submitJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                ShareApiClient(apiBaseUrl).save(preparedUrl, note)
            }
            if (!isActive || generation != submitGeneration) return@launch
            submitting = false
            when (result) {
                ShareSubmitResult.Saved -> {
                    status = getString(R.string.share_saved)
                    if (preferences.closeAfterSave) {
                        delay(300)
                        if (isActive && generation == submitGeneration) finish()
                    }
                }
                is ShareSubmitResult.Failed -> status = failureMessage(result.kind)
            }
        }
    }

    private fun shareSubtitle(): String =
        when (candidates.size) {
            0 -> getString(R.string.share_sheet_subtitle_empty)
            1 -> getString(R.string.share_sheet_subtitle_single)
            else -> getString(R.string.share_sheet_subtitle_many, candidates.size)
        }

    private fun makeWindowTranslucent() {
        setFinishOnTouchOutside(true)
        window.setBackgroundDrawable(ColorDrawable(Color.Transparent.toArgb()))
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.attributes = window.attributes.apply { dimAmount = 0.38f }
    }

    private fun failureMessage(kind: FailureKind): String =
        when (kind) {
            FailureKind.Network,
            FailureKind.Timeout,
            FailureKind.Server -> getString(R.string.share_failed)
        }
}
