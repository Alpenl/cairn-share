package com.alpenl.webtag.share

import com.alpenl.webtag.share.contract.UrlCandidate

internal data class ShareScreenModel(
    val rowLabels: List<String>,
    val selectedLabel: String?,
    val statusText: String,
    val note: String,
    val saveEnabled: Boolean,
    val closeEnabled: Boolean,
    val submitting: Boolean,
    val labelMaxLines: Int,
)

internal object ShareCandidatePresenter {
    const val LABEL_MAX_LINES = 2

    fun initialSelectedIndex(candidates: List<UrlCandidate>): Int =
        if (candidates.size == 1) 0 else -1

    fun requiresSelection(candidates: List<UrlCandidate>, selectedIndex: Int): Boolean =
        candidates.size > 1 && selectedIndex !in candidates.indices

    fun selectedCandidate(candidates: List<UrlCandidate>, selectedIndex: Int): UrlCandidate? =
        candidates.getOrNull(selectedIndex)

    fun selectedIndexFromSubmission(candidates: List<UrlCandidate>, submissionValue: String?): Int =
        candidates.indexOfFirst { it.submissionValue == submissionValue }

    fun submissionValueAt(candidates: List<UrlCandidate>, index: Int): String? =
        candidates.getOrNull(index)?.submissionValue

    fun screenModel(
        candidates: List<UrlCandidate>,
        selectedIndex: Int,
        note: String,
        status: String?,
        submitting: Boolean,
    ): ShareScreenModel {
        val choosing = requiresSelection(candidates, selectedIndex)
        val selected = selectedCandidate(candidates, selectedIndex)
        return ShareScreenModel(
            rowLabels = if (choosing) candidates.map { it.displayLabel } else emptyList(),
            selectedLabel = selected?.displayLabel,
            statusText = status.orEmpty(),
            note = note,
            saveEnabled = selected != null && !submitting,
            closeEnabled = !submitting,
            submitting = submitting,
            labelMaxLines = LABEL_MAX_LINES,
        )
    }
}
