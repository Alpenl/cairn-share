package com.alpenl.cairn.share

import com.alpenl.cairn.share.contract.UrlCandidateExtractor
import org.junit.Assert.assertEquals
import org.junit.Test

class NativeShareExtractionTest {
    @Test
    fun oneShareFlattensDataUrisExtraTextAndEveryClipTextInOrder() {
        val candidates = extract(
            intentDataUrl = "https://data.example/intent",
            extraText = "title https://extra.example/from-extra-text",
            clipItems = listOf(
                ClipItem(
                    uri = "https://clip.example/uri-one",
                    text = "first https://clip.example/text-one",
                ),
                ClipItem(
                    uri = "https://clip.example/uri-two",
                    text = "second https://clip.example/text-two and https://clip.example/text-three",
                ),
            ),
        )

        assertEquals(
            listOf(
                "https://data.example/intent",
                "https://clip.example/uri-one",
                "https://clip.example/uri-two",
                "https://extra.example/from-extra-text",
                "https://clip.example/text-one",
                "https://clip.example/text-two",
                "https://clip.example/text-three",
            ),
            candidates,
        )
    }

    @Test
    fun clipTextsAreScannedWhetherExtraTextIsPresentEmptyOrMissing() {
        val clipItems = listOf(
            ClipItem(text = "one https://clip.example/one"),
            ClipItem(text = "two https://clip.example/two"),
        )
        val fromClip = listOf("https://clip.example/one", "https://clip.example/two")

        assertEquals(
            listOf("https://extra.example/x") + fromClip,
            extract(extraText = "see https://extra.example/x", clipItems = clipItems),
        )
        assertEquals(fromClip, extract(extraText = "", clipItems = clipItems))
        assertEquals(fromClip, extract(extraText = null, clipItems = clipItems))
        assertEquals(fromClip, extract(extraText = "title only", clipItems = clipItems))
    }

    @Test
    fun onlyExplicitHttpUrisLeaveTheStructuredStage() {
        val payload = sharePayload(
            intentDataUrl = "content://media/external/images/1",
            clipItems = listOf(
                ClipItem(uri = "content://com.other.app/note/1"),
                ClipItem(uri = "https://second.example/b"),
                ClipItem(uri = "app://private/item"),
                ClipItem(uri = "HTTPS://Fourth.example/D"),
            ),
        )

        assertEquals(
            listOf("https://second.example/b", "HTTPS://Fourth.example/D"),
            payload.structuredUrls,
        )
        assertEquals(emptyList<String>(), payload.texts)
    }

    @Test
    fun duplicatesAcrossSourcesKeepTheFirstSubmissionString() {
        assertEquals(
            listOf("https://Example.com/Article?ref=A"),
            extract(
                intentDataUrl = "https://Example.com/Article?ref=A",
                extraText = "https://EXAMPLE.com/Article?ref=A",
                clipItems = listOf(
                    ClipItem(
                        uri = "https://example.com/Article?ref=A",
                        text = "https://example.com/Article?ref=A",
                    ),
                ),
            ),
        )
    }

    @Test
    fun urlsThatShareALabelButDifferAfterThePathStaySeparateCandidates() {
        val candidates = UrlCandidateExtractor.extract(
            sharePayload(
                extraText = "https://example.com/a?v=1 https://example.com/a?v=2 https://example.com/a#tail",
            ),
        )

        assertEquals(
            listOf("https://example.com/a?v=1", "https://example.com/a?v=2", "https://example.com/a#tail"),
            candidates.map { it.submissionValue },
        )
        assertEquals(listOf("example.com/a", "example.com/a", "example.com/a"), candidates.map { it.displayLabel })
    }

    private fun extract(
        intentDataUrl: String? = null,
        extraText: String? = null,
        clipItems: List<ClipItem> = emptyList(),
    ): List<String> = UrlCandidateExtractor
        .extract(sharePayload(intentDataUrl, extraText, clipItems))
        .map { it.submissionValue }
}
