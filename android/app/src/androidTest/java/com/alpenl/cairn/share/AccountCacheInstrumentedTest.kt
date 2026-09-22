package com.alpenl.cairn.share

import androidx.lifecycle.ViewModelStore
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onEach
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

    private suspend fun start(preferences: SharePreferencesStore = settings): CairnLinksViewModel = withContext(Dispatchers.Main) {
        CairnLinksViewModel(LinksApiClient(base, 20_000, 20_000), UpdateApiClient("$base/latest"), preferences,
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
    private fun page(owner: String) = json(JSONObject().put("items", JSONArray((4 downTo 1).map { link(it, owner) })).put("next_before_id", JSONObject.NULL))
    private fun taxonomy(label: String) = json(JSONObject().put("topics", JSONArray().put(JSONObject()
        .put("id", "llm").put("label", label).put("active", true))).put("forms", JSONArray()).put("uses", JSONArray()))
    private fun selection(topic: String, revision: Long = 0, automatic: String = topic): MockResponse {
        fun value(t: String) = JSONObject().put("topics", JSONArray().put(t)).put("content_functions", JSONArray())
            .put("carriers", JSONArray()).put("affordances", JSONArray()).put("form", "").put("use", "")
        return json(JSONObject().put("revision", revision).put("selection", value(topic)).put("automatic", value(automatic)))
    }

    @Test fun blankKeywordLibraryLoadsServerMembershipBeyondLocalProjection() = runBlocking<Unit> {
        settings.setLastFilter("all")
        val filteredRequest = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!
                return when (url.encodedPath) {
                    "/api/links" -> {
                        val topics = listOfNotNull(url.queryParameter("topic"), url.queryParameter("topics")).flatMap { it.split(',') }
                        if ("design" !in topics) page("local unfiltered snapshot") else {
                            assertTrue("no keyword is needed for a library filter", url.queryParameter("q").isNullOrEmpty())
                            filteredRequest.countDown()
                            // The matching row is absent from the unfiltered
                            // local snapshot; its v1 summary cannot express the
                            // fourth topic. Membership belongs to the server.
                            val row = link(99, "confirmed fourth topic")
                            row.getJSONObject("enrichment").put("classification", JSONObject()
                                .put("topics", JSONArray(listOf("llm", "eng", "eval"))))
                            json(JSONObject().put("items", JSONArray().put(row))
                                .put("next_before_id", JSONObject.NULL).put("filter_contract_version", 1))
                        }
                    }
                    "/api/taxonomy" -> taxonomy("v1")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) { model.setBookmarkFilters(BookmarkFilters(topic = "design")) }
        assertTrue("blank-keyword library must request server membership", withContext(Dispatchers.IO) { filteredRequest.await(5, TimeUnit.SECONDS) })
        awaitState(model) { it.visibleLibraryLinks().map { row -> row.id } == listOf(99) }
        withContext(Dispatchers.Main) {
            assertEquals("", model.uiState.searchQuery)
            assertEquals("queue snapshot stays separate from filtered membership", listOf(1, 2, 3, 4), model.uiState.links.map { it.id }.sorted())
        }
    }

    @Test fun effectiveFiltersRequireServerConfirmationAndStablePagingTime() = runBlocking<Unit> {
        val client = LinksApiClient(base)
        val filters = BookmarkFilters(topics = listOf("llm", "design"), contentFunctions = listOf("method", "data"),
            carriers = listOf("single", "external_article"), affordances = listOf("practice"),
            entityState = "failed,stale", recentDays = 7)
        val instant = java.time.Instant.parse("2026-09-23T00:00:00Z")
        for (version in listOf<Any?>(null, JSONObject.NULL, 0, 2, "1", 1)) {
            val payload = JSONObject().put("items", JSONArray()).put("next_before_id", JSONObject.NULL)
            if (version != null) payload.put("filter_contract_version", version)
            server.enqueue(json(payload))
            val result = withContext(Dispatchers.IO) { client.listPage(LinkFilter.All, "", tokenA, 99, filters, instant) }
            if (version == 1) assertTrue(result is LinkPageResult.Loaded) else assertEquals(LinkPageResult.UnsupportedFilters, result)
            val query = server.takeRequest(5, TimeUnit.SECONDS)!!.requestUrl!!
            for ((key, value) in filters.parameters(instant)) assertEquals(value, query.queryParameter(key))
            assertEquals("1", query.queryParameter("filter_contract_version"))
            assertEquals("99", query.queryParameter("before_id"))
            assertNull(query.queryParameter("q"))
        }
        server.enqueue(json(JSONObject().put("items", JSONArray()).put("next_before_id", JSONObject.NULL)))
        assertTrue(withContext(Dispatchers.IO) { client.listPage(LinkFilter.All, "", tokenA) } is LinkPageResult.Loaded)
        assertNull(server.takeRequest(5, TimeUnit.SECONDS)!!.requestUrl!!.queryParameter("filter_contract_version"))
    }

    @Test fun delayedLibraryPageCannotCrossFiltersAndBadCursorStopsPaging() = runBlocking<Unit> {
        settings.setLastFilter("all")
        val entered = CountDownLatch(1)
        val returned = CountDownLatch(1)
        fun matches(id: Int, next: Int? = null) = json(JSONObject().put("items", JSONArray().put(link(id, "filtered")))
            .put("next_before_id", next ?: JSONObject.NULL).put("filter_contract_version", 1))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!
                return when (url.encodedPath) {
                    "/api/links" -> when (url.queryParameter("topics")) {
                        "design" -> if (url.queryParameter("before_id") == null) matches(100, 100) else {
                            entered.countDown()
                            if (!release.await(20, TimeUnit.SECONDS)) MockResponse().setResponseCode(503) else {
                                returned.countDown(); matches(90)
                            }
                        }
                        "llm" -> matches(200)
                        "eng" -> matches(200, 300) // Must never advance using an invalid cursor.
                        else -> page("unfiltered")
                    }
                    "/api/taxonomy" -> taxonomy("v1")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) { model.setBookmarkFilters(BookmarkFilters(topics = listOf("design"))) }
        awaitState(model) { it.libraryResults.map { row -> row.id } == listOf(100) && !it.libraryLoading }
        withContext(Dispatchers.Main) { model.loadMoreLibraryResults() }
        assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
        withContext(Dispatchers.Main) { model.setBookmarkFilters(BookmarkFilters(topics = listOf("llm"))) }
        awaitState(model) { it.libraryResults.map { row -> row.id } == listOf(200) && !it.libraryLoading }
        release.countDown()
        assertTrue(withContext(Dispatchers.IO) { returned.await(5, TimeUnit.SECONDS) })
        delay(300)
        withContext(Dispatchers.Main) {
            assertEquals(listOf(200), model.uiState.visibleLibraryLinks().map { it.id })
            assertNull(model.uiState.libraryNextBeforeId)
            model.setBookmarkFilters(BookmarkFilters(topics = listOf("eng")))
        }
        awaitState(model) { !it.libraryLoading && it.libraryStatusText.contains("分页响应无效") }
        withContext(Dispatchers.Main) {
            assertTrue(model.uiState.libraryResults.isEmpty())
            assertNull(model.uiState.libraryNextBeforeId)
            model.loadMoreLibraryResults()
            model.setBookmarkFilters(BookmarkFilters())
            assertEquals(listOf(4, 3, 2, 1), model.uiState.visibleLibraryLinks().map { it.id })
        }
    }

    @Test fun libraryPaginationFreezesConditionsAndConfirmedCurationRestartsMembership() = runBlocking<Unit> {
        settings.setLastFilter("all")
        val confirmed = AtomicReference(false)
        val queries = java.util.Collections.synchronizedList(mutableListOf<Map<String, String?>>())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!
                return when (url.encodedPath) {
                    "/api/links" -> if (url.queryParameter("topic") == null) page("root") else {
                        queries += listOf("topic", "since", "content_functions", "filter_contract_version").associateWith { url.queryParameter(it) }
                        val before = url.queryParameter("before_id")
                        val id = when (before) { null -> 7; "7" -> 5; else -> 1 }
                        val next: Any = if (id == 1 || (confirmed.get() && id == 5)) JSONObject.NULL else id
                        json(JSONObject().put("items", JSONArray().put(link(id, "filtered")))
                            .put("next_before_id", next).put("filter_contract_version", 1))
                    }
                    "/api/links/1/curation" -> { confirmed.set(true); json(link(1, "curation confirmed", true)) }
                    "/api/taxonomy" -> taxonomy("v1")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        val model = start()
        awaitState(model) { !it.loading && it.links.size == 4 }
        withContext(Dispatchers.Main) { model.setBookmarkFilters(BookmarkFilters(topic = "design", contentFunctions = listOf("method", "data"), recentDays = 7)) }
        for (expected in listOf(listOf(7), listOf(7, 5), listOf(7, 5, 1))) {
            awaitState(model) { !it.libraryLoading && it.libraryResults.map { row -> row.id } == expected }
            if (expected.size < 3) withContext(Dispatchers.Main) { model.loadMoreLibraryResults() }
        }
        assertEquals("paging must reuse the exact since boundary", 1, queries.toList().distinct().size)
        withContext(Dispatchers.Main) {
            assertNull(model.uiState.libraryNextBeforeId)
            model.saveCuration(1, CurationUpdate(classification = BookmarkClassification(topics = emptyList(), form = "", use = "", uncertainty = false))) {}
        }
        awaitState(model) { !it.libraryLoading && it.links.first { row -> row.id == 1 }.note == "curation confirmed" && it.libraryResults.map { row -> row.id } == listOf(7) }
        withContext(Dispatchers.Main) {
            assertEquals(7, model.uiState.libraryNextBeforeId)
            model.loadMoreLibraryResults()
        }
        awaitState(model) { !it.libraryLoading && it.libraryResults.map { row -> row.id } == listOf(7, 5) }
        withContext(Dispatchers.Main) { assertNull(model.uiState.libraryNextBeforeId) }
        assertEquals(5, queries.size)
    }

    @Test fun libraryResponseCannotReturnThroughAnAccountRoundTrip() = runBlocking<Unit> {
        settings.setLastFilter("all")
        val entered = CountDownLatch(1)
        val returned = CountDownLatch(1)
        val requests = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> if (request.requestUrl!!.queryParameter("topics") == null) page("root") else {
                    val old = requests.incrementAndGet() == 1
                    if (old) {
                        entered.countDown()
                        assertTrue(release.await(20, TimeUnit.SECONDS))
                        returned.countDown()
                    }
                    json(JSONObject().put("items", JSONArray().put(link(if (old) 100 else 200, if (old) "OLD" else "current")))
                        .put("next_before_id", JSONObject.NULL).put("filter_contract_version", 1))
                }
                "/api/taxonomy" -> taxonomy("v1")
                else -> MockResponse().setResponseCode(404)
            }
        }
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) { model.setBookmarkFilters(BookmarkFilters(topics = listOf("design"))) }
        assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
        for (token in listOf(tokenB, tokenA)) {
            withContext(Dispatchers.Main) { model.setApiToken(token); assertTrue(model.uiState.libraryResults.isEmpty()) }
            awaitStoredToken(token)
            awaitState(model) { it.links.size == 4 && !it.loading }
        }
        withContext(Dispatchers.Main) { model.setBookmarkFilters(BookmarkFilters(topics = listOf("design"))) }
        awaitState(model) { !it.libraryLoading && it.libraryResults.map { row -> row.id } == listOf(200) }
        release.countDown()
        assertTrue(withContext(Dispatchers.IO) { returned.await(5, TimeUnit.SECONDS) })
        delay(300)
        withContext(Dispatchers.Main) { assertEquals(listOf(200), model.uiState.visibleLibraryLinks().map { it.id }) }
    }

    @Test fun delayedPersistedTokenCannotReactivateTheAccountAfterANewerSetting() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val file = context.preferencesDataStoreFile("credential-race-${System.nanoTime()}")
        val delegate = PreferenceDataStoreFactory.create(scope = scope, produceFile = { file })
        val entered = CompletableDeferred<Unit>()
        val deliver = CompletableDeferred<Unit>()
        val restored = CompletableDeferred<Unit>()
        val holdAck = AtomicReference(false)
        val ackEntered = CompletableDeferred<Unit>()
        val ackRelease = CompletableDeferred<Unit>()
        val newerObserved = CompletableDeferred<Unit>()
        val tokenKey = stringPreferencesKey("api_token")
        val events = java.util.Collections.synchronizedList(mutableListOf<String>())
        suspend fun step(label: String, block: suspend () -> Unit) {
            try { withTimeout(5_000) { block() } }
            catch (error: TimeoutCancellationException) { throw AssertionError("$label: $events", error) }
        }
        val delayed = object : DataStore<Preferences> {
            override val data = delegate.data.onEach { value ->
                if (value[tokenKey] == tokenB) {
                    events.add("observed B")
                    entered.complete(Unit)
                    deliver.await()
                    if (holdAck.get()) newerObserved.complete(Unit)
                } else if (value[tokenKey] == tokenA && entered.isCompleted) restored.complete(Unit)
            }
            override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences {
                events.add("write started")
                val result = delegate.updateData { old -> transform(old).also { events.add("transform ${if (it[tokenKey] == tokenA) "A" else "B"}") } }
                events.add("write returned ${if (result[tokenKey] == tokenA) "A" else "B"}")
                if (holdAck.get() && result[tokenKey] == tokenA) {
                    ackEntered.complete(Unit)
                    ackRelease.await()
                }
                return result
            }
        }
        try {
            // Old installations have a token but no revision key.
            delegate.edit { it[tokenKey] = tokenA }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = when (request.requestUrl!!.encodedPath) {
                    "/api/links" -> page(if (request.getHeader("Authorization") == "Bearer $tokenB") "B" else "A")
                    "/api/taxonomy" -> taxonomy("v1")
                    else -> MockResponse().setResponseCode(404)
                }
            }
            val model = start(SharePreferencesStore(delayed))
            awaitState(model) { it.links.size == 4 && !it.loading }
            withContext(Dispatchers.Main) { assertEquals(0L, model.uiState.preferences.apiTokenRevision) }
            withContext(Dispatchers.Main) { model.setApiToken(tokenB) }
            step("old B notification must be captured") { entered.await() }
            val expectedGeneration = withContext(Dispatchers.Main) {
                model.setApiToken(tokenA)
                model.uiState.accountGeneration
            }
            step("new A must be committed while B notification is delayed") {
                while (delegate.data.first()[tokenKey] != tokenA) delay(25)
            }
            deliver.complete(Unit)
            step("the ordered A notification must follow B") { restored.await() }
            awaitState(model) { it.preferences.apiToken == tokenA && it.links.size == 4 && !it.loading }
            withContext(Dispatchers.Main) {
                assertEquals("old persisted B must not create two extra account sessions", expectedGeneration, model.uiState.accountGeneration)
                assertTrue(model.uiState.links.all { it.note == "A" })
            }
            val revisionKey = longPreferencesKey("api_token_revision")
            val previousRevision = delegate.data.first()[revisionKey]!!
            val rapidGeneration = withContext(Dispatchers.Main) {
                model.setApiToken(tokenB)
                model.setApiToken(tokenA)
                model.setApiToken(tokenB)
                model.setApiToken(tokenA)
                model.uiState.accountGeneration
            }
            step("the newest rapid setting must be persisted") {
                while (delegate.data.first().let { (it[revisionKey] ?: 0) <= previousRevision || it[tokenKey] != tokenA }) delay(25)
            }
            awaitState(model) { it.preferences.apiTokenRevision > previousRevision && !it.loading }
            withContext(Dispatchers.Main) { assertEquals(rapidGeneration, model.uiState.accountGeneration) }
            // A newer external setting can arrive after our write commits but
            // before its acknowledgment reaches the ViewModel. Do not lose it
            // while the local write is still considered pending.
            holdAck.set(true)
            withContext(Dispatchers.Main) { model.setApiToken(tokenA) }
            step("the local write must commit before its acknowledgment") { ackEntered.await() }
            SharePreferencesStore(delegate).setApiToken(tokenB)
            step("the newer external write must be observed before the old acknowledgment") { newerObserved.await() }
            withContext(Dispatchers.Main) { assertEquals(tokenA, model.uiState.preferences.apiToken) }
            ackRelease.complete(Unit)
            awaitState(model) { it.preferences.apiToken == tokenB && it.links.all { row -> row.note == "B" } && it.links.size == 4 && !it.loading }
            withContext(Dispatchers.Main) { assertEquals(rapidGeneration + 1, model.uiState.accountGeneration) }
        } finally {
            deliver.complete(Unit)
            ackRelease.complete(Unit)
            withContext(Dispatchers.Main) { models.clear() }
            scope.coroutineContext[Job]!!.cancelAndJoin()
            file.delete()
        }
    }

    @Test fun failedCredentialPersistenceKeepsTheChosenSessionAndRetrySurvivesRestart() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val file = context.preferencesDataStoreFile("credential-failure-${System.nanoTime()}")
        val delegate = PreferenceDataStoreFactory.create(scope = scope, produceFile = { file })
        val tokenKey = stringPreferencesKey("api_token")
        val fail = AtomicReference(true)
        val storage = object : DataStore<Preferences> {
            override val data = delegate.data
            override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences {
                if (fail.get()) throw java.io.IOException("synthetic persistence failure")
                return delegate.updateData(transform)
            }
        }
        try {
            delegate.edit { it[tokenKey] = tokenA }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = when (request.requestUrl!!.encodedPath) {
                    "/api/links" -> page(if (request.getHeader("Authorization") == "Bearer $tokenB") "B" else "A")
                    "/api/taxonomy" -> taxonomy("v1")
                    else -> MockResponse().setResponseCode(404)
                }
            }
            val model = start(SharePreferencesStore(storage))
            awaitState(model) { it.links.size == 4 && !it.loading }
            withContext(Dispatchers.Main) { model.setApiToken(tokenB) }
            awaitState(model) { it.apiTokenSaveError == "Token 保存失败，请重试。" && !it.loading }
            assertEquals(tokenA, delegate.data.first()[tokenKey])
            SharePreferencesStore(delegate).setCloseAfterSave(false)
            awaitState(model) { !it.preferences.closeAfterSave }
            withContext(Dispatchers.Main) {
                assertEquals(tokenB, model.uiState.preferences.apiToken)
                assertEquals("Token 保存失败，请重试。", model.uiState.apiTokenSaveError)
                assertTrue(model.uiState.links.all { it.note == "B" })
            }
            fail.set(false)
            withContext(Dispatchers.Main) { model.setApiToken(tokenB) }
            awaitState(model) { it.preferences.apiTokenRevision > 0 && it.apiTokenSaveError.isEmpty() && !it.loading }
            assertEquals(tokenB, delegate.data.first()[tokenKey])
            withContext(Dispatchers.Main) { models.clear() }
            val restoredModel = start(SharePreferencesStore(storage))
            awaitState(restoredModel) { it.preferences.apiToken == tokenB && it.links.size == 4 && !it.loading }
        } finally {
            withContext(Dispatchers.Main) { models.clear() }
            scope.coroutineContext[Job]!!.cancelAndJoin()
            file.delete()
        }
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

    @Test fun lateSearchCannotUndoAnEditInTheSameAccount() = runBlocking<Unit> {
        val entered = CountDownLatch(1)
        val searches = AtomicInteger()
        val confirmed = AtomicReference(false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> if (request.requestUrl!!.queryParameter("q") == "match" && searches.incrementAndGet() == 2) {
                    entered.countDown()
                    if (!release.await(20, TimeUnit.SECONDS)) MockResponse().setResponseCode(503) else page("before edit")
                } else page(if (confirmed.get()) "confirmed edit" else "before edit")
                "/api/taxonomy" -> taxonomy("v1")
                "/api/links/1" -> { confirmed.set(true); json(link(1, "confirmed edit", true)) }
                else -> MockResponse().setResponseCode(404)
            }
        }
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) { model.setSearchQuery("match") }
        awaitState(model) { it.searchResults.size == 4 && !it.searchLoading }
        withContext(Dispatchers.Main) { model.setSearchQuery("match") }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        withContext(Dispatchers.Main) {
            model.beginEdit(model.uiState.links.first { it.id == 1 })
            model.setEditNote("confirmed edit")
            model.saveEdit {}
        }
        awaitState(model) { it.links.first { l -> l.id == 1 }.note == "confirmed edit" }
        release.countDown()
        awaitState(model) { !it.searchLoading }
        withContext(Dispatchers.Main) {
            assertEquals("confirmed edit", model.uiState.links.first { it.id == 1 }.note)
            assertEquals("confirmed edit", model.uiState.searchResults.first { it.id == 1 }.note)
        }
        assertEquals("one replacement search reads confirmed server state", 3, searches.get())
    }

    @Test fun lateSearchCannotRestoreADeletedResultOutsideTheMainList() = runBlocking<Unit> {
        val entered = CountDownLatch(1)
        val searches = AtomicInteger()
        val deleted = AtomicReference(false)
        fun matches() = json(JSONObject().put("items", JSONArray().put(link(8, "search only"))).put("next_before_id", 8))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> if (request.requestUrl!!.queryParameter("q") == "match") {
                    val attempt = searches.incrementAndGet()
                    if (attempt == 2) {
                        val stale = matches()
                        entered.countDown()
                        if (!release.await(20, TimeUnit.SECONDS)) MockResponse().setResponseCode(503) else stale
                    } else if (deleted.get()) json(JSONObject().put("items", JSONArray()).put("next_before_id", JSONObject.NULL)) else matches()
                } else page("main")
                "/api/links/8" -> { assertEquals("DELETE", request.method); deleted.set(true); MockResponse().setResponseCode(204) }
                "/api/taxonomy" -> taxonomy("v1")
                else -> MockResponse().setResponseCode(404)
            }
        }
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) { model.setSearchQuery("match") }
        awaitState(model) { it.searchResults.map { row -> row.id } == listOf(8) && !it.searchLoading }
        withContext(Dispatchers.Main) { model.setSearchQuery("match") }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        val removed = AtomicInteger()
        withContext(Dispatchers.Main) { model.deleteLink(8) { removed.incrementAndGet() } }
        awaitState(model) { removed.get() == 1 }
        release.countDown()
        awaitState(model) { !it.searchLoading }
        withContext(Dispatchers.Main) {
            assertTrue(model.uiState.searchResults.isEmpty())
            assertNull(model.uiState.searchNextBeforeId)
            assertTrue(model.uiState.links.none { it.id == 8 })
        }
        assertEquals(3, searches.get())
    }

    @Test fun editDuringPaginationRestartsMembershipAndDiscardsTheOldCursor() = runBlocking<Unit> {
        val entered = CountDownLatch(1)
        val pages = AtomicInteger()
        val changed = AtomicReference(false)
        fun result(ids: List<Int>, cursor: Int?) = json(JSONObject().put("items", JSONArray(ids.map { link(it, "match") }))
            .put("next_before_id", cursor ?: JSONObject.NULL))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> if (request.requestUrl!!.queryParameter("q") == "match") {
                    if (request.requestUrl!!.queryParameter("before_id") != null) {
                        if (pages.incrementAndGet() == 1) {
                            val stale = result(listOf(2, 1), null)
                            entered.countDown()
                            if (!release.await(20, TimeUnit.SECONDS)) MockResponse().setResponseCode(503) else stale
                        } else result(if (changed.get()) listOf(1) else listOf(2, 1), null)
                    } else result(listOf(4, 3), 3)
                } else page("match")
                "/api/links/2" -> { changed.set(true); json(link(2, "no longer relevant", true)) }
                "/api/taxonomy" -> taxonomy("v1")
                else -> MockResponse().setResponseCode(404)
            }
        }
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) { model.setSearchQuery("match") }
        awaitState(model) { it.searchResults.size == 2 && !it.searchLoading }
        withContext(Dispatchers.Main) { model.loadMoreSearchResults() }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        withContext(Dispatchers.Main) {
            model.beginEdit(model.uiState.links.first { it.id == 2 })
            model.setEditNote("no longer relevant")
            model.saveEdit {}
        }
        awaitState(model) { it.links.first { row -> row.id == 2 }.note == "no longer relevant" }
        release.countDown()
        awaitState(model) { !it.searchLoading }
        withContext(Dispatchers.Main) {
            assertEquals(listOf(4, 3), model.uiState.searchResults.map { it.id })
            assertEquals(3, model.uiState.searchNextBeforeId)
            model.loadMoreSearchResults()
        }
        awaitState(model) { !it.searchLoading }
        withContext(Dispatchers.Main) {
            assertEquals(listOf(4, 3, 1), model.uiState.searchResults.map { it.id })
            assertNull(model.uiState.searchNextBeforeId)
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
        selectionStatus.set(404)
        withContext(Dispatchers.Main) { model.setApiToken(tokenB) }
        awaitStoredToken(tokenB)
        withContext(Dispatchers.Main) { model.loadV2Selection(1) }
        awaitState(model) { !it.v2Available }
        withContext(Dispatchers.Main) { model.loadV2Taxonomy() }
        awaitState(model) { it.v2Taxonomy != null }
        withContext(Dispatchers.Main) { assertFalse(model.uiState.v2Available) }
        // And the inverse: loaded selection cannot mask an unsupported vocabulary.
        // Configure the new account before activation: the library now loads
        // its vocabulary immediately, so a later change races that first read.
        taxonomyStatus.set(404)
        selectionStatus.set(200)
        withContext(Dispatchers.Main) { model.setApiToken("cache-c-12345678") }
        awaitStoredToken("cache-c-12345678")
        withContext(Dispatchers.Main) { model.loadV2Taxonomy() }
        awaitState(model) { !it.v2Available }
        withContext(Dispatchers.Main) { model.loadV2Selection(1) }
        awaitState(model) { it.v2Selections[1] != null }
        withContext(Dispatchers.Main) { assertFalse(model.uiState.v2Available) }
        assertEquals(original, actions.snapshot())
    }

    @Test fun deletionPurgesOwnedActionsAndRejectsLateSelectionAndDetail() = runBlocking<Unit> {
        val selectionEntered = CountDownLatch(1)
        val detailEntered = CountDownLatch(1)
        val deleted = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> page("other rows") // ID 99 exists only in the detail route.
                "/api/taxonomy" -> taxonomy("v1")
                "/api/links/99" -> if (request.method == "DELETE") {
                    deleted.incrementAndGet(); MockResponse().setResponseCode(204)
                } else {
                    detailEntered.countDown()
                    if (!release.await(20, TimeUnit.SECONDS)) MockResponse().setResponseCode(503)
                    else json(link(99, "deleted private body", true))
                }
                "/api/bookmarks/99/v2-selection" -> {
                    selectionEntered.countDown()
                    if (!release.await(20, TimeUnit.SECONDS)) MockResponse().setResponseCode(503)
                    else selection("llm")
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        val own = accountKeyFor(base, tokenA)
        val other = accountKeyFor(base, tokenB)
        actions.enqueue(QueuedCurationAction(99,"delete-own","topics","llm","accept",0,own))
        actions.enqueue(QueuedCurationAction(99,"keep-other","topics","eng","accept",0,other))
        val model = start()
        awaitState(model) { it.links.size == 4 && !it.loading }
        withContext(Dispatchers.Main) { model.ensureLink(99); model.loadV2Selection(99) }
        assertTrue(detailEntered.await(10, TimeUnit.SECONDS)); assertTrue(selectionEntered.await(10, TimeUnit.SECONDS))
        val confirmed = CountDownLatch(1)
        withContext(Dispatchers.Main) { model.deleteLink(99) { confirmed.countDown() } }
        assertTrue(confirmed.await(10, TimeUnit.SECONDS)); assertEquals(1,deleted.get())
        release.countDown(); delay(750)
        withContext(Dispatchers.Main) {
            assertFalse("late detail must not revive a deleted link",model.uiState.links.any { it.id==99 })
            assertFalse("late selection must not revive private state",model.uiState.v2Selections.containsKey(99))
            assertFalse(model.uiState.v2Drafts.containsKey(99)); assertFalse(model.uiState.v2Queued.containsKey(99))
            assertFalse(model.uiState.detailLoads.containsKey(99))
        }
        assertEquals(listOf("keep-other"), actions.snapshot().map { it.operationKey })
        // A recreated store must retain the deletion boundary for late enqueuers.
        CurationActionStore(context).enqueue(QueuedCurationAction(99,"late-own","topics","llm","accept",0,own))
        assertEquals(listOf("keep-other"), actions.snapshot().map { it.operationKey })
    }


    @Test fun deletionClientDistinguishesBackgroundCleanupFromUnconfirmedFailure() = runBlocking<Unit> {
        val client = LinksApiClient(base)
        server.enqueue(MockResponse().setResponseCode(503).setBody("{\"error\":\"deletion_cleanup_pending\"}"))
        assertEquals(LinkMutationResult.DeletionPending, withContext(Dispatchers.IO) { client.delete(1, tokenA) })
        for (body in listOf("{\"error\":\"overloaded\"}", "invalid json", "{}")) {
            server.enqueue(MockResponse().setResponseCode(503).setBody(body))
            assertEquals(LinkMutationResult.Failed(FailureKind.Server), withContext(Dispatchers.IO) { client.delete(1, tokenA) })
        }
        server.enqueue(MockResponse().setResponseCode(401))
        assertEquals(LinkMutationResult.Failed(FailureKind.Unauthorized), withContext(Dispatchers.IO) { client.delete(1, tokenA) })
    }

    @Test fun pendingDeletionSurvivesViewModelRecreationAndFiltersStalePages() = runBlocking<Unit> {
        val deletes = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when(request.requestUrl!!.encodedPath) {
                "/api/links" -> page("stale page still containing deleted ID")
                "/api/taxonomy" -> taxonomy("v1")
                "/api/links/1" -> if(request.method == "DELETE") {
                    if (deletes.incrementAndGet()==1) MockResponse().setResponseCode(503).setBody("{\"error\":\"temporary_outage\"}")
                    else MockResponse().setResponseCode(503).setBody("{\"error\":\"deletion_cleanup_pending\"}")
                } else json(link(1,"body",true))
                else -> MockResponse().setResponseCode(404)
            }
        }
        val own=accountKeyFor(base,tokenA)
        actions.enqueue(QueuedCurationAction(1,"pending-delete-owned","topics","llm","accept",0,own))
        val model=start()
        awaitState(model){!it.loading && it.links.size==4}
        withContext(Dispatchers.Main){model.deleteLink(1){fail("unconfirmed failure is not success")}}
        awaitState(model){1 !in it.busyIds && deletes.get()==1}
        assertFalse(actions.deletions.first().single().confirmed)
        assertEquals(1,actions.snapshot().size)
        withContext(Dispatchers.Main){models.clear()}
        val restored=start()
        awaitState(restored){deletes.get()==2 && it.message?.text=="收藏已移除，附件正在后台清理。"}
        assertTrue(actions.deletions.first().single().confirmed)
        assertTrue(actions.snapshot().isEmpty())
        withContext(Dispatchers.Main){restored.refreshLinks()}
        awaitState(restored){!it.loading}
        withContext(Dispatchers.Main){assertFalse(restored.uiState.links.any{it.id==1});models.clear()}
        val again=start()
        awaitState(again){!it.loading && it.links.size==3}
        assertEquals("confirmed deletion does not loop",2,deletes.get())
    }

    @Test fun deletionFinishingAfterAccountSwitchOnlyPurgesItsOriginalAccount() = checkDeletionAccountSwitch(false)
    @Test fun deletionConfirmationAfterAccountRoundTripPurgesTheActiveAccount() = checkDeletionAccountSwitch(true)

    private fun checkDeletionAccountSwitch(returnToA: Boolean) = runBlocking<Unit> {
        val entered=CountDownLatch(1)
        val finished=CountDownLatch(1)
        server.dispatcher=object:Dispatcher(){
            override fun dispatch(request:RecordedRequest):MockResponse=when(request.requestUrl!!.encodedPath){
                "/api/links" -> page(if(request.getHeader("Authorization")=="Bearer $tokenA") "A" else "B")
                "/api/taxonomy" -> taxonomy("v1")
                "/api/links/1" -> {
                    entered.countDown()
                    if(!release.await(20,TimeUnit.SECONDS)) MockResponse().setResponseCode(503)
                    else {finished.countDown();MockResponse().setResponseCode(204)}
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        val own=accountKeyFor(base,tokenA);val other=accountKeyFor(base,tokenB)
        actions.enqueue(QueuedCurationAction(1,"a-owned","topics","llm","accept",0,own))
        actions.enqueue(QueuedCurationAction(1,"b-keep","topics","eng","accept",0,other))
        val model=start();awaitState(model){it.links.size==4 && !it.loading}
        withContext(Dispatchers.Main){model.deleteLink(1){fail("old-account callback must not navigate current account")}}
        assertTrue(entered.await(10,TimeUnit.SECONDS))
        withContext(Dispatchers.Main){model.setApiToken(tokenB)}
        awaitStoredToken(tokenB);awaitState(model){it.links.all{row->row.note=="B"} && it.links.size==4}
        if (returnToA) {
            withContext(Dispatchers.Main){model.setApiToken(tokenA)}
            awaitStoredToken(tokenA)
            awaitState(model){it.links.size==4 && it.links.all{row->row.note=="A"}}
        }
        release.countDown();assertTrue(finished.await(5,TimeUnit.SECONDS))
        withTimeout(5000){while(actions.deletions.first().none{it.confirmed}) delay(25)}
        assertEquals(listOf("b-keep"),actions.snapshot().map{it.operationKey})
        if (returnToA) awaitState(model){it.links.none{row->row.id==1}}
        else withContext(Dispatchers.Main){assertTrue(model.uiState.links.any{it.id==1 && it.note=="B"})}
    }

}
