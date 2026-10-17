package com.alpenl.cairn.share

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProcessingHttpInstrumentedTest {
    @Test fun realHttpKeepsUnmarkedErrorsUnknownAndNeverFollowsRedirects() = runBlocking {
        val server = MockWebServer(); server.start()
        val target = MockWebServer(); target.start()
        try {
            val client = ProcessingClient(server.url("/").toString())
            val intent = ProcessingIntent("original-request", ProcessingIdentity("a".repeat(64), 3, 0), ProcessingAction.SavePrimary, "Exact original 🙂\n ")
            server.enqueue(ProcessingFixture.response(ProcessingFixture.status()))
            assertTrue(client.status(4, "synthetic-processing") is RunHistoryResult.Loaded)
            assertEquals("GET", server.takeRequest().method)
            server.enqueue(ProcessingFixture.response(JSONObject().put("error", "state_conflict"), 409))
            assertEquals(ProcessingWriteResult.Rejected("state_conflict"), client.submit(4, "synthetic-processing", intent))
            val request = server.takeRequest()
            assertEquals("POST", request.method); assertEquals("/api/bookmarks/4/processing", request.path)
            assertEquals("1", request.getHeader("X-Cairn-App-Processing")); assertEquals("Bearer synthetic-processing", request.getHeader("Authorization"))
            assertEquals(intent.encode().toString(), request.body.readUtf8())
            for (status in listOf(302, 307, 308)) {
                server.enqueue(MockResponse().setResponseCode(status).setHeader("Location", target.url("/never")))
                assertTrue(client.submit(4, "synthetic-processing", intent) is ProcessingWriteResult.Unknown); server.takeRequest()
            }
            server.enqueue(MockResponse().setResponseCode(409).setBody("{\"error\":\"state_conflict\"}"))
            assertTrue(client.submit(4, "synthetic-processing", intent) is ProcessingWriteResult.Unknown); server.takeRequest()
            server.enqueue(ProcessingFixture.response(JSONObject().put("error", "receipt_unavailable"), 503))
            assertTrue(client.submit(4, "synthetic-processing", intent) is ProcessingWriteResult.Unknown); server.takeRequest()
            server.enqueue(ProcessingFixture.response(ProcessingFixture.receipt(intent.encode()).put("target_generation", 1)))
            assertTrue(client.submit(4, "synthetic-processing", intent) is ProcessingWriteResult.Unknown); server.takeRequest()
            server.enqueue(ProcessingFixture.response(ProcessingFixture.receipt(intent.encode(), replayed = true)))
            assertEquals(ProcessingWriteResult.Confirmed(4, true, true, true), client.submit(4, "synthetic-processing", intent)); server.takeRequest()
            assertEquals(9, server.requestCount); assertEquals(0, target.requestCount)
        } finally { server.shutdown(); target.shutdown() }
    }

    @Test fun actualJournalUsesCasForDiscardAndDeletionWithoutClearingAnotherAccount() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val curation = CurationActionStore(context); curation.clear()
        try {
            val account = "v2:" + "a".repeat(64); val other = "v2:" + "b".repeat(64)
            val intent = ProcessingIntent("persisted-request", ProcessingIdentity("c".repeat(64), 3, 0), ProcessingAction.SavePrimary, "Retain full primary 🙂")
            val value = StoredProcessingIntent(account, 4, intent); val foreign = value.copy(accountKey = other)
            ProcessingStore(context).prepare(value, null); ProcessingStore(context).prepare(foreign, null)
            val store = ProcessingStore(context)
            assertEquals(value, store.load(account, 4)); assertEquals(foreign, store.load(other, 4))
            assertTrue(runCatching { store.discardRefused(value) }.isFailure)
            store.reject(value, "state_conflict")
            val refused = value.copy(rejected = "state_conflict")
            val updated = value.copy(intent = intent.copy(operationKey = "new-explicit-request"))
            store.prepare(updated, refused)
            assertTrue(runCatching { store.discardRefused(refused) }.isFailure)
            assertEquals(updated, store.load(account, 4))
            store.acknowledge(value); assertEquals(updated, store.load(account, 4))
            curation.confirmDeletion(account, 4)
            assertNull(store.load(account, 4)); assertEquals(foreign, store.load(other, 4))
            assertTrue(runCatching { store.prepare(value, null) }.isFailure)
            store.reject(foreign, "state_conflict")
            store.discardRefused(foreign.copy(rejected = "state_conflict")); assertNull(store.load(other, 4))
        } finally { curation.clear() }
    }
}
