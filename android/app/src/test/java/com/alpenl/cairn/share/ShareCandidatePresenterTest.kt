package com.alpenl.cairn.share

import com.alpenl.cairn.share.contract.UrlCandidate
import com.alpenl.cairn.share.contract.UrlCandidateExtractor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareCandidatePresenterTest {
    private val ambiguous = UrlCandidateExtractor.extract(
        sharePayload(extraText = "https://example.com/a?v=1 https://example.com/a?v=2"),
    )

    @Test
    fun singleCandidateIsSelectedButNeverSubmittedByThePresenter() {
        val single = UrlCandidateExtractor.extract(
            sharePayload(intentDataUrl = "HTTPS://Docs.Example.com:8443/Guide%20One?token=abc#top"),
        )

        assertEquals(0, ShareCandidatePresenter.initialSelectedIndex(single))
        assertEquals(
            "HTTPS://Docs.Example.com:8443/Guide%20One?token=abc#top",
            ShareCandidatePresenter.submissionValueAt(single, 0),
        )
        assertFalse(ShareCandidatePresenter.requiresSelection(single, 0))
    }

    @Test
    fun chooserAppearsOnlyUntilMultipleCandidatesHaveASelection() {
        assertFalse(ShareCandidatePresenter.requiresSelection(emptyList(), -1))
        assertFalse(ShareCandidatePresenter.requiresSelection(ambiguous.take(1), -1))
        assertTrue(ShareCandidatePresenter.requiresSelection(ambiguous, -1))
        assertFalse(ShareCandidatePresenter.requiresSelection(ambiguous, 1))
    }

    @Test
    fun rowsRenderLabelsWhileSelectionCarriesVerbatimUrl() {
        val model = ShareCandidatePresenter.screenModel(
            candidates = ambiguous,
            selectedIndex = -1,
            note = "",
            status = null,
            submitting = false,
        )

        assertEquals(listOf("example.com/a", "example.com/a"), model.rowLabels)
        assertEquals("https://example.com/a?v=2", ShareCandidatePresenter.submissionValueAt(ambiguous, 1))
    }

    @Test
    fun selectedScreenShowsLabelAndAllowsSave() {
        val model = ShareCandidatePresenter.screenModel(
            candidates = ambiguous,
            selectedIndex = 1,
            note = "draft",
            status = "ready",
            submitting = false,
        )

        assertEquals(emptyList<String>(), model.rowLabels)
        assertEquals("example.com/a", model.selectedLabel)
        assertEquals("draft", model.note)
        assertEquals("ready", model.statusText)
        assertTrue(model.saveEnabled)
    }

    @Test
    fun submittingBlocksSaveAndClose() {
        val model = ShareCandidatePresenter.screenModel(
            candidates = listOf(UrlCandidate("https://example.com/a", "example.com/a")),
            selectedIndex = 0,
            note = "",
            status = "saving",
            submitting = true,
        )

        assertFalse(model.saveEnabled)
        assertFalse(model.closeEnabled)
    }

    @Test
    fun unknownSelectionsCollapseToAbsentIndex() {
        assertEquals(-1, ShareCandidatePresenter.selectedIndexFromSubmission(ambiguous, "https://gone.example/x"))
        assertNull(ShareCandidatePresenter.selectedCandidate(ambiguous, -1))
        assertNull(ShareCandidatePresenter.submissionValueAt(ambiguous, ambiguous.size))
    }
}
