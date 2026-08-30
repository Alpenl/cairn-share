package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.FailureKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingUploadJsonTest {
    @Test
    fun roundTripPreservesQueuedUploadMetadata() {
        val upload = PendingUpload(
            id = "3f55e9e8-4d52-4f45-a33d-89be8ef7ab45",
            url = "https://example.com/a?x=1#fragment",
            note = "稍后阅读\n保留换行",
            createdAtEpochMillis = 1_777_777_777_000,
            attemptCount = 2,
            lastAttemptAtEpochMillis = 1_777_777_888_000,
            lastFailure = FailureKind.Timeout,
        )

        assertEquals(listOf(upload), PendingUploadJson.decode(PendingUploadJson.encode(listOf(upload))))
    }

    @Test
    fun decoderSkipsInvalidEntriesAndFailsClosedForCorruptJson() {
        val decoded = PendingUploadJson.decode(
            """[{"id":"","url":"https://example.com","created_at":1},{"id":"ok","url":"https://example.com/ok","note":"","created_at":2}]""",
        )

        assertEquals(listOf("ok"), decoded.map(PendingUpload::id))
        assertTrue(PendingUploadJson.decode("not-json").isEmpty())
    }
}
