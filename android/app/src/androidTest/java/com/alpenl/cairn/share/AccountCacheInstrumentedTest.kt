package com.alpenl.cairn.share

import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Actual Android ViewModel/DataStore/HTTP, with delayed transport responses. */
@RunWith(AndroidJUnit4::class)
class AccountCacheInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val server = MockWebServer()
    private lateinit var base: String
    private val models = ViewModelStore()
    private val release = CountDownLatch(1)
    private val tokenA = "cache-a-12345678"
    private val tokenB = "cache-b-12345678"
    private val settings get() = SharePreferencesStore(context)
    private val actions get() = CurationActionStore(context)

    @Before fun setup() = runBlocking<Unit> {
        actions.clear()
        PendingUploadStore(context).clear()
        settings.setApiToken(tokenA)
        settings.setLastSearchQuery("")
        server.start()
        base = server.url("/").toString().trimEnd('/')
    }

    @After fun close() = runBlocking<Unit> {
        release.countDown()
        withContext(Dispatchers.Main) { models.clear() }
        server.shutdown()
    }

    private suspend fun start(): CairnLinksViewModel = withContext(Dispatchers.Main) {
        CairnLinksViewModel(LinksApiClient(base, 20_000, 20_000), UpdateApiClient("$base/latest"), settings,
            PendingUploadStore(context), ApiDebugClient(base, 20_000, 20_000),
            V2CurationRepository(V2ClientTransport(V2CurationClient(base, 20_000, 20_000))), actions,
            base, "$base/latest", "test", 1).also { models.put("cache", it) }
    }

    private suspend fun awaitState(model: CairnLinksViewModel, predicate: (CairnLinksUiState) -> Boolean) {
        try {
            withTimeout(15_000) {
                while (!withContext(Dispatchers.Main) { predicate(model.uiState) }) delay(25)
            }
        } catch (error: TimeoutCancellationException) {
            val observed = withContext(Dispatchers.Main) { model.uiState }
            throw AssertionError("State timeout: loading=${observed.loading}, status=${observed.statusText}, notes=${observed.links.map { it.note }}, message=${observed.message?.text}", error)
        }
    }

    private suspend fun awaitStoredToken(expected: String) {
        // Check the persisted value itself. A short-lived continuous collector
        // can miss the transition even while a fresh read and the UI see it.
        withTimeout(5_000) {
            while (settings.preferences.first().apiToken != expected) delay(25)
        }
    }

    private fun json(value: Any) = MockResponse().setHeader("Content-Type", "application/json").setBody(value.toString())
    private fun link(id: Int, owner: String, loaded: Boolean = false) = JSONObject()
        .put("id", id).put("url", "https://example.com/$id").put("note", owner)
        .put("created_at", "2026-09-22T00:00:00Z").put("learned", false)
        .put("enrichment", JSONObject().put("status", "completed").put("source", "other")
            .put("content_loaded", loaded).put("original_text", if (loaded) owner else ""))
    private fun page(owner: String) = json(JSONObject().put("items", JSONArray((1..4).map { link(it, owner) })).put("next_before_id", JSONObject.NULL))
    private fun taxonomy(label: String) = json(JSONObject().put("topics", JSONArray().put(JSONObject()
        .put("id", "llm").put("label", label).put("active", true))).put("forms", JSONArray()).put("uses", JSONArray()))
    private fun selection(topic: String, revision: Long = 0, automatic: String = topic): MockResponse {
        fun value(t: String) = JSONObject().put("topics", JSONArray().put(t)).put("content_functions", JSONArray())
            .put("carriers", JSONArray()).put("affordances", JSONArray()).put("form", "").put("use", "")
        return json(JSONObject().put("revision", revision).put("selection", value(topic)).put("automatic", value(automatic)))
    }

    @Test fun returningToSameAccountCannotPublishOldDetailSelectionTaxonomyOrDebug() = runBlocking<Unit> {
        val entered = CountDownLatch(4)
        val returned = CountDownLatch(4)
        val details = AtomicInteger()
        val selections = AtomicInteger()
        val vocabularies = AtomicInteger()
        val debugs = AtomicInteger()
        fun delayed(value: MockResponse): MockResponse {
            entered.countDown()
            if (!release.await(20, TimeUnit.SECONDS)) return MockResponse().setResponseCode(503)
            returned.countDown()
            return value
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> if (request.getHeader("Authorization") == "Bearer $tokenB") MockResponse().setResponseCode(401) else page("current A")
                "/api/links/1" -> if (details.incrementAndGet() == 1) delayed(json(link(1, "OLD A private detail", true))) else json(link(1, "current A detail", true))
                "/api/bookmarks/1/v2-selection" -> if (selections.incrementAndGet() == 1) delayed(selection("OLD", 99)) else selection("current", 1)
                "/api/v2-taxonomy" -> if (vocabularies.incrementAndGet() == 1) delayed(taxonomy("OLD")) else taxonomy("current")
                "/api/cache-debug" -> if (debugs.incrementAndGet() == 1) delayed(json(JSONObject().put("owner", "OLD"))) else json(JSONObject().put("owner", "current"))
                "/api/taxonomy" -> taxonomy("v1")
                else -> MockResponse().setResponseCode(404)
            }
        }
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) {
            model.beginEdit(model.uiState.links.first { it.id == 1 })
            model.setEditNote("unsaved A draft")
            model.ensureLink(1)
            model.loadV2Selection(1)
            model.loadV2Taxonomy()
            model.setApiDebugBody("")
            model.setApiDebugPath("/api/cache-debug")
            model.sendApiDebugRequest()
        }
        assertTrue("all delayed requests entered", entered.await(10, TimeUnit.SECONDS))
        withContext(Dispatchers.Main) {
            model.setApiToken(tokenB)
            assertTrue(model.uiState.links.isEmpty())
            assertTrue(model.uiState.searchResults.isEmpty())
            assertNull(model.uiState.editDraft)
            assertTrue(model.uiState.detailLoads.isEmpty())
            assertEquals("", model.uiState.apiDebug.responseText)
        }
        awaitStoredToken(tokenB)
        awaitState(model) { !it.loading && it.statusText.contains("Token 无效") }
        withContext(Dispatchers.Main) { model.setApiToken(tokenA) }
        awaitStoredToken(tokenA)
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) {
            assertEquals("unsaved A draft", model.uiState.editDraft?.note)
            model.ensureLink(1)
            model.loadV2Selection(1)
            model.loadV2Taxonomy()
            model.setApiDebugBody("")
            model.setApiDebugPath("/api/cache-debug")
            model.sendApiDebugRequest()
        }
        awaitState(model) { it.links.any { l -> l.note == "current A detail" } &&
            it.v2Selections[1]?.topics == listOf("current") && it.v2Taxonomy?.topics?.firstOrNull()?.label == "current" &&
            it.apiDebug.responseText.contains("current") }
        release.countDown()
        assertTrue(returned.await(5, TimeUnit.SECONDS))
        // Let the already-dispatched HTTP bodies reach the actual Main callbacks.
        delay(750)
        withContext(Dispatchers.Main) {
            assertEquals("current A detail", model.uiState.links.first { it.id == 1 }.note)
            assertEquals(listOf("current"), model.uiState.v2Selections[1]?.topics)
            assertEquals("current", model.uiState.v2Taxonomy?.topics?.first()?.label)
            assertFalse(model.uiState.apiDebug.responseText.contains("OLD"))
        }
    }

    @Test fun oldMutationsCannotReplaceDeleteOrNavigateTheNewAccount() = runBlocking<Unit> {
        val entered = CountDownLatch(4)
        val returned = CountDownLatch(4)
        val callbacks = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                if (request.method == "PATCH" || request.method == "DELETE") {
                    entered.countDown()
                    if (!release.await(20, TimeUnit.SECONDS)) return MockResponse().setResponseCode(503)
                    returned.countDown()
                    if (request.method == "DELETE") return MockResponse().setResponseCode(204)
                    return json(link(path.split('/')[3].toInt(), "OLD mutation", true))
                }
                return when (path) {
                    "/api/links" -> page(if (request.getHeader("Authorization") == "Bearer $tokenB") "B" else "A")
                    "/api/taxonomy" -> taxonomy("v1")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) {
            model.saveCuration(1, CurationUpdate(why = "A private why")) { callbacks.incrementAndGet() }
            model.setLearned(2, true)
            model.beginEdit(model.uiState.links.first { it.id == 3 })
            model.setEditNote("A edit")
            model.saveEdit { callbacks.incrementAndGet() }
            model.deleteLink(4) { callbacks.incrementAndGet() }
        }
        assertTrue("all delayed requests entered", entered.await(10, TimeUnit.SECONDS))
        withContext(Dispatchers.Main) { model.setApiToken(tokenB) }
        awaitStoredToken(tokenB)
        awaitState(model) { it.links.size == 4 && it.links.all { l -> l.note == "B" } && !it.loading }
        withContext(Dispatchers.Main) {
            model.beginEdit(model.uiState.links.first { it.id == 3 })
            model.setEditNote("unsaved B edit")
        }
        release.countDown()
        assertTrue(returned.await(5, TimeUnit.SECONDS))
        delay(750)
        withContext(Dispatchers.Main) {
            assertEquals(4, model.uiState.links.size)
            assertTrue(model.uiState.links.all { it.note == "B" && !it.learned })
            assertEquals("unsaved B edit", model.uiState.editDraft?.note)
            assertTrue(model.uiState.busyIds.isEmpty())
            assertEquals(0, callbacks.get())
            assertFalse(model.uiState.message?.text?.contains("已删除") == true)
        }
    }

    @Test fun lateDetailCannotUndoAnEditInTheSameAccount() = runBlocking<Unit> {
        val entered = CountDownLatch(1)
        val returned = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> page("before edit")
                "/api/taxonomy" -> taxonomy("v1")
                "/api/links/1" -> if (request.method == "GET") {
                    entered.countDown()
                    if (!release.await(20, TimeUnit.SECONDS)) MockResponse().setResponseCode(503)
                    else { returned.countDown(); json(link(1, "OLD detail", true)) }
                } else json(link(1, "confirmed edit", true))
                else -> MockResponse().setResponseCode(404)
            }
        }
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) { model.ensureLink(1) }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        withContext(Dispatchers.Main) {
            model.beginEdit(model.uiState.links.first { it.id == 1 })
            model.setEditNote("confirmed edit")
            model.saveEdit {}
        }
        awaitState(model) { it.links.first { l -> l.id == 1 }.note == "confirmed edit" }
        release.countDown()
        assertTrue(returned.await(5, TimeUnit.SECONDS))
        delay(750)
        withContext(Dispatchers.Main) {
            assertEquals("confirmed edit", model.uiState.links.first { it.id == 1 }.note)
            assertFalse(model.uiState.detailLoads.containsKey(1))
        }
    }

    @Test fun refreshRebasesResetPreviewWithoutChangingTheDurableIntentAndCapabilitiesStayIndependent() = runBlocking<Unit> {
        val baseline = AtomicReference("llm")
        val selectionStatus = AtomicInteger(200)
        val taxonomyStatus = AtomicInteger(200)
        val sends = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> page("current")
                "/api/taxonomy" -> taxonomy("v1")
                "/api/bookmarks/1/v2-selection" -> if (selectionStatus.get() == 200) selection("eng", automatic = baseline.get()) else MockResponse().setResponseCode(selectionStatus.get())
                "/api/v2-taxonomy" -> if (taxonomyStatus.get() == 200) taxonomy("v2") else MockResponse().setResponseCode(taxonomyStatus.get())
                "/api/bookmarks/1/v2-override" -> { sends.incrementAndGet(); MockResponse().setResponseCode(503) }
                else -> MockResponse().setResponseCode(404)
            }
        }
        val model = start()
        awaitState(model) { !it.loading && it.links.size == 4 }
        withContext(Dispatchers.Main) { model.loadV2Selection(1); model.loadV2Taxonomy() }
        awaitState(model) { it.v2Selections[1] != null && it.v2Taxonomy != null }
        withContext(Dispatchers.Main) { model.applyV2Action(1, "topics", "", "reset") }
        awaitState(model) { it.v2Busy.isEmpty() && sends.get() > 0 && it.v2Drafts[1]?.topics == listOf("llm") }
        val original = actions.snapshot()
        assertEquals(1, original.size)
        baseline.set("design")
        withContext(Dispatchers.Main) { model.refreshLinks() }
        awaitState(model) { it.v2Drafts[1]?.topics == listOf("design") }
        assertEquals(original, actions.snapshot())
        assertEquals(1, sends.get()) // Refresh is read-only.
        // Selection unavailable must survive a successful vocabulary read.
        withContext(Dispatchers.Main) { model.setApiToken(tokenB) }
        awaitStoredToken(tokenB)
        selectionStatus.set(404)
        withContext(Dispatchers.Main) { model.loadV2Selection(1) }
        awaitState(model) { !it.v2Available }
        withContext(Dispatchers.Main) { model.loadV2Taxonomy() }
        awaitState(model) { it.v2Taxonomy != null }
        withContext(Dispatchers.Main) { assertFalse(model.uiState.v2Available) }
        // And the inverse: loaded selection cannot mask an unsupported vocabulary.
        withContext(Dispatchers.Main) { model.setApiToken("cache-c-12345678") }
        awaitStoredToken("cache-c-12345678")
        taxonomyStatus.set(404)
        selectionStatus.set(200)
        withContext(Dispatchers.Main) { model.loadV2Taxonomy() }
        awaitState(model) { !it.v2Available }
        withContext(Dispatchers.Main) { model.loadV2Selection(1) }
        awaitState(model) { it.v2Selections[1] != null }
        withContext(Dispatchers.Main) { assertFalse(model.uiState.v2Available) }
        assertEquals(original, actions.snapshot())
    }
}
