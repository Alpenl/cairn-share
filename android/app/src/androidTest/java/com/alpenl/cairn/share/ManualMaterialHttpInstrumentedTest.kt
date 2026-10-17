package com.alpenl.cairn.share

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ManualMaterialHttpInstrumentedTest {
    @Test fun markedRefusalIsDistinctFromUnknownAndRedirectNeverContactsTarget() = runBlocking {
        val server = MockWebServer(); server.start()
        val target = MockWebServer(); target.start()
        try {
            val client = ManualMaterialClient(server.url("/").toString())
            val intent = ManualMaterialIntent("same-request", MaterialSource(3, 8, "a".repeat(64), 2),
                MaterialOption("image_text", "image", "legacy_unknown"), "<human text> 🙂")
            server.enqueue(MockResponse().setResponseCode(409).setHeader("X-Cairn-App-Manual-Material", "1").setBody("{\"error\":\"source_conflict\"}"))
            assertEquals(MaterialWriteResult.Rejected("source_conflict"), client.submit(4, "synthetic-material", intent))
            val request = server.takeRequest()
            assertEquals("POST", request.method); assertEquals("/api/bookmarks/4/manual-material", request.path)
            assertEquals("1", request.getHeader("X-Cairn-App-Manual-Material"))
            assertEquals("Bearer synthetic-material", request.getHeader("Authorization"))
            assertEquals(intent.encode().toString(), request.body.readUtf8())
            for (status in listOf(302, 307, 308)) {
                server.enqueue(MockResponse().setResponseCode(status).setHeader("Location", target.url("/never")))
                assertTrue(client.submit(4, "synthetic-material", intent) is MaterialWriteResult.Unknown)
                server.takeRequest()
            }
            server.enqueue(MockResponse().setResponseCode(503).setHeader("X-Cairn-App-Manual-Material", "1").setBody("{}"))
            assertTrue(client.submit(4, "synthetic-material", intent) is MaterialWriteResult.Unknown); server.takeRequest()
            server.enqueue(MockResponse().setBody("{}"))
            assertTrue(client.submit(4, "synthetic-material", intent) is MaterialWriteResult.Unknown); server.takeRequest()
            assertEquals(6, server.requestCount); assertEquals(0, target.requestCount)
        } finally { server.shutdown(); target.shutdown() }
    }

    @Test fun journalSurvivesRecreationUsesCasAndDeletionOnlyClearsMatchingAccount() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val curation = CurationActionStore(context); curation.clear()
        try {
            val account = "v2:"+"a".repeat(64)
            val other = "v2:"+"b".repeat(64)
            val intent = ManualMaterialIntent("stored-request", MaterialSource(3, 8, "c".repeat(64), 2),
                MaterialOption("image_text", "image", "legacy_unknown"), "Preserve full human text 🙂")
            val value = StoredManualMaterial(account, 4, intent)
            val foreign = value.copy(accountKey = other)
            ManualMaterialStore(context).prepare(value, null)
            ManualMaterialStore(context).prepare(foreign, null)
            val store = ManualMaterialStore(context)
            assertEquals(value, store.load(account, 4)); assertEquals(foreign, store.load(other, 4))
            assertTrue(runCatching { store.prepare(value.copy(intent = intent.copy(operationKey = "not-allowed")), value) }.isFailure)
            store.reject(value, "source_conflict")
            val rejected = value.copy(rejected = "source_conflict")
            assertEquals(rejected, store.load(account, 4))
            val replacement = value.copy(intent = intent.copy(operationKey = "explicit-new-request"))
            store.prepare(replacement, rejected)
            store.acknowledge(value)
            assertEquals(replacement, store.load(account, 4))
            curation.confirmDeletion(account, 4)
            assertNull(store.load(account, 4)); assertEquals(foreign, store.load(other, 4))
            assertTrue(runCatching { store.prepare(value, null) }.isFailure)
            store.acknowledge(foreign); assertNull(store.load(other, 4))
        } finally { curation.clear() }
    }
}
