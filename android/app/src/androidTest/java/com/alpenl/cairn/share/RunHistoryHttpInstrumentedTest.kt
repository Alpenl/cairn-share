package com.alpenl.cairn.share

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.alpenl.cairn.share.network.FailureKind
import com.alpenl.cairn.share.network.RunHistoryClient
import com.alpenl.cairn.share.network.RunHistoryResult
import com.alpenl.cairn.share.network.SavedRecordKind
import com.alpenl.cairn.share.network.SavedRecordScope
import com.alpenl.cairn.share.network.savedPage
import com.alpenl.cairn.share.network.savedRecord
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RunHistoryHttpInstrumentedTest {
    @Test fun savedRecordsKeepOpaqueKeysScopedAndNeverFallbackOrFollowRedirects() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val client = RunHistoryClient(server.url("/").toString())
            val scope = SavedRecordScope(SavedRecordKind.Entities, 2)
            val key = "结果 / + ?"
            server.enqueue(MockResponse().setHeader("X-Cairn-App-Saved-Records", "1").setBody(
                org.json.JSONObject().put("version", 1).put("bookmark_id", 4).put("kind", "entities").put("source_revision", 2)
                    .put("record", org.json.JSONObject().put("key", key).put("payload", org.json.JSONObject().put("state", "failed"))).toString()))
            assertTrue(client.savedRecord(4, scope, key, "synthetic-saved") is RunHistoryResult.Loaded)
            val request = server.takeRequest()
            assertEquals("GET", request.method)
            assertEquals("/api/bookmarks/4/saved-records/entities", request.requestUrl!!.encodedPath)
            assertEquals(key, request.requestUrl!!.queryParameter("record_key"))
            assertEquals("2", request.requestUrl!!.queryParameter("source_revision"))
            assertEquals("1", request.getHeader("X-Cairn-App-Saved-Records"))
            assertNull(request.getHeader("X-Cairn-App-Run-History"))
            val cases = listOf(
                MockResponse().setResponseCode(404) to RunHistoryResult.Unsupported,
                MockResponse().setResponseCode(404).setHeader("X-Cairn-App-Saved-Records", "1") to RunHistoryResult.Unavailable,
                MockResponse().setResponseCode(501) to RunHistoryResult.Unsupported,
                MockResponse().setResponseCode(302).setHeader("Location", server.url("/never")) to RunHistoryResult.Failed(FailureKind.Server),
                MockResponse().setHeader("X-Cairn-App-Saved-Records", "1").setChunkedBody("x".repeat(128 * 1024 + 1), 2048) to RunHistoryResult.Failed(FailureKind.Server),
                MockResponse().setHeader("X-Cairn-App-Saved-Records", "1").setBody(Buffer().write(byteArrayOf(123, -1, 125))) to RunHistoryResult.Failed(FailureKind.Server),
            )
            for ((response, result) in cases) {
                server.enqueue(response)
                assertEquals(result, client.savedPage(4, scope, null, "synthetic-saved"))
                server.takeRequest()
            }
            assertEquals(1 + cases.size, server.requestCount)
        } finally { server.shutdown() }
    }

    @Test fun unavailableUnsupportedMalformedAndRedirectedReadsNeverBecomeSuccessfulEmptyHistory() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val client = RunHistoryClient(server.url("/").toString())
            val failed = RunHistoryResult.Failed(FailureKind.Server)
            val samples = listOf(
                MockResponse().setResponseCode(501) to RunHistoryResult.Unsupported,
                MockResponse().setResponseCode(404) to RunHistoryResult.Unsupported,
                MockResponse().setResponseCode(404).setHeader("X-Cairn-App-Run-History", "1") to RunHistoryResult.Unavailable,
                MockResponse().setResponseCode(410).setHeader("X-Cairn-App-Run-History", "1") to RunHistoryResult.Unavailable,
                MockResponse().setResponseCode(403) to RunHistoryResult.Failed(FailureKind.Unauthorized),
                MockResponse().setResponseCode(503) to failed,
                MockResponse().setBody("{}") to RunHistoryResult.Unsupported,
                MockResponse().setResponseCode(302).setHeader("Location", server.url("/must-not-follow")) to failed,
                MockResponse().setHeader("X-Cairn-App-Run-History", "1").setBody("{}") to RunHistoryResult.Unsupported,
                MockResponse().setHeader("X-Cairn-App-Run-History", "1")
                    .setBody(Buffer().write(byteArrayOf(123, -1, 125))) to failed,
                MockResponse().setHeader("X-Cairn-App-Run-History", "1")
                    .setChunkedBody("x".repeat(128 * 1024 + 1), 2048) to failed,
            )
            for ((response, expected) in samples) {
                server.enqueue(response)
                assertEquals(expected, client.page(4, null, "synthetic-history"))
                val request = server.takeRequest()
                assertEquals("GET", request.method)
                assertEquals("/api/bookmarks/4/run-history", request.path)
                assertEquals("1", request.getHeader("X-Cairn-App-Run-History"))
                assertEquals("Bearer synthetic-history", request.getHeader("Authorization"))
            }
            assertEquals(samples.size, server.requestCount)
        } finally { server.shutdown() }
    }
}
