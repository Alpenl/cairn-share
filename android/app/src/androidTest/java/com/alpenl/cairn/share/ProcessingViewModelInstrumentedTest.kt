package com.alpenl.cairn.share

import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import kotlinx.coroutines.*
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real ViewModel + repository + DataStore + authenticated HTTP, including
 * account changes while persistence or a committed response is suspended. */
@RunWith(AndroidJUnit4::class)
class ProcessingViewModelInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val settings get() = SharePreferencesStore(context)
    private val curation get() = CurationActionStore(context)
    private val server = MockWebServer()
    private val models = ViewModelStore()
    private lateinit var base: String
    private val a = "processing-A-12345678"
    private val b = "processing-B-12345678"
    private val releaseResponse = CountDownLatch(1)
    private val started = CountDownLatch(1)
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val reads = AtomicInteger()
    private val detailReads = AtomicInteger()
    @Volatile private var holdResponse = false

    @Before fun setup() = runBlocking<Unit> {
        curation.clear(); PendingUploadStore(context).clear(); settings.setApiToken(a)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val auth = request.getHeader("Authorization")
                if (auth !in setOf("Bearer $a", "Bearer $b")) return MockResponse().setResponseCode(401)
                return when (request.requestUrl!!.encodedPath) {
                    "/api/bookmarks/4/processing" -> {
                        assertEquals("1", request.getHeader("X-Cairn-App-Processing"))
                        if (request.method == "GET") { reads.incrementAndGet(); ProcessingFixture.response(ProcessingFixture.status(missing = false)) }
                        else {
                            requests += request; started.countDown()
                            val body = JSONObject(request.body.clone().readUtf8())
                            val owner = accountKeyFor(base, auth!!.removePrefix("Bearer "))
                            val saved = runBlocking { ProcessingStore(context).load(owner, 4) }
                            assertNotNull("Real store must contain the exact request before HTTP", saved)
                            assertEquals(saved!!.intent.encode().toString(), body.toString())
                            if (holdResponse) assertTrue(releaseResponse.await(8, TimeUnit.SECONDS))
                            ProcessingFixture.response(ProcessingFixture.receipt(body))
                        }
                    }
                    "/api/links" -> MockResponse().setBody(JSONObject().put("items", JSONArray()).put("next_before_id", JSONObject.NULL).toString())
                    "/api/links/4", "/api/bookmarks/4" -> {
                        detailReads.incrementAndGet()
                        MockResponse().setHeader("Content-Type", "application/json").setBody(JSONObject()
                            .put("id", 4).put("url", "https://x.com/processing/status/4").put("note", "")
                            .put("created_at", "2026-10-17T00:00:00Z").put("learned", false).toString())
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start(); base = server.url("/").toString().trimEnd('/')
    }
    @After fun close() = runBlocking<Unit> {
        releaseResponse.countDown()
        withContext(Dispatchers.Main) { models.clear() }
        server.shutdown(); curation.clear()
    }
    private suspend fun start(repository: ProcessingRepository? = null): CairnLinksViewModel = withContext(Dispatchers.Main) {
        val processing = repository ?: ProcessingRepository(ProcessingClient(base), ProcessingStore(context))
        CairnLinksViewModel(LinksApiClient(base), UpdateApiClient("$base/latest"), settings, PendingUploadStore(context), ApiDebugClient(base),
            V2CurationRepository(V2ClientTransport(V2CurationClient(base))), curation, base, "$base/latest", "test", 1,
            processingRepository = processing).also { models.put("processing", it) }
    }
    private suspend fun await(model: CairnLinksViewModel, predicate: (CairnLinksUiState) -> Boolean) = withTimeout(15000) {
        while (!withContext(Dispatchers.Main) { predicate(model.uiState) }) delay(25)
    }
    private suspend fun display(model: CairnLinksViewModel): CurationDisplayContext = withContext(Dispatchers.Main) {
        CurationDisplayContext(accountKeyFor(base, model.uiState.preferences.apiToken), model.uiState.accountGeneration)
    }
    private suspend fun load(model: CairnLinksViewModel): Pair<CurationDisplayContext, ProcessingIntent> {
        val owner = display(model)
        withContext(Dispatchers.Main) { model.loadProcessing(4, owner) }
        await(model) { it.processingPanels[4]?.let { panel -> panel.storageReady && !panel.loading && panel.result is RunHistoryResult.Loaded } == true }
        val status = withContext(Dispatchers.Main) { (model.uiState.processingPanels.getValue(4).result as RunHistoryResult.Loaded).value }
        return owner to ProcessingIntent("viewmodel-operation", status.identity, ProcessingAction.RetryClassification)
    }

    @Test fun lateCommittedResponseCannotMutateAnotherAccountOrAnAToBToASession() = runBlocking<Unit> {
        holdResponse = true
        val model = start(); await(model) { it.preferencesLoaded && it.preferences.apiToken == a }
        val (owner, intent) = load(model)
        withContext(Dispatchers.Main) { model.submitProcessing(4, intent, owner) }
        assertTrue(withContext(Dispatchers.IO) { started.await(5, TimeUnit.SECONDS) })
        withContext(Dispatchers.Main) { model.setApiToken(b) }
        await(model) { it.preferences.apiToken == b && it.accountGeneration > owner.accountGeneration }
        load(model)
        releaseResponse.countDown()
        withTimeout(10000) { while (ProcessingStore(context).load(owner.accountKey, 4) != null) delay(25) }
        withContext(Dispatchers.Main) {
            assertEquals(b, model.uiState.preferences.apiToken)
            assertTrue(model.uiState.processingPanels.getValue(4).message.isBlank())
            assertNull(model.uiState.processingPanels.getValue(4).pending)
            model.submitProcessing(4, intent, owner)
        }
        assertEquals(1, requests.size)
        withContext(Dispatchers.Main) { model.setApiToken(a) }
        await(model) { it.preferences.apiToken == a && it.accountGeneration > owner.accountGeneration + 1 }
        load(model)
        withContext(Dispatchers.Main) { model.submitProcessing(4, intent, owner) }
        assertEquals(1, requests.size)
        assertEquals("Bearer $a", requests.single().getHeader("Authorization"))
    }

    @Test fun accountSwitchAfterRealPersistenceSendsNothingUntilExplicitSameIntentRecovery() = runBlocking<Unit> {
        val prepared = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val store = ProcessingStore(context)
        val journal = object : ProcessingJournal by store {
            override suspend fun prepare(value: StoredProcessingIntent, expected: StoredProcessingIntent?) {
                store.prepare(value, expected); prepared.complete(Unit); release.await()
            }
        }
        val model = start(ProcessingRepository(ProcessingClient(base), journal))
        await(model) { it.preferencesLoaded && it.preferences.apiToken == a }
        val (owner, intent) = load(model)
        withContext(Dispatchers.Main) { model.submitProcessing(4, intent, owner) }
        withTimeout(5000) { prepared.await() }
        assertEquals(intent, store.load(owner.accountKey, 4)!!.intent)
        withContext(Dispatchers.Main) { model.setApiToken(b) }
        await(model) { it.preferences.apiToken == b && it.accountGeneration > owner.accountGeneration }
        release.complete(Unit)
        load(model)
        assertTrue(requests.isEmpty())
        assertNull(store.load(accountKeyFor(base, b), 4))
        withContext(Dispatchers.Main) { model.setApiToken(a) }
        await(model) { it.preferences.apiToken == a && it.accountGeneration > owner.accountGeneration + 1 }
        val (current, _) = load(model)
        assertEquals(intent, withContext(Dispatchers.Main) { model.uiState.processingPanels.getValue(4).pending!!.intent })
        assertTrue(requests.isEmpty())
        withContext(Dispatchers.Main) { model.submitProcessing(4, intent, current) }
        await(model) { it.processingPanels[4]?.message?.contains("请求已保存") == true && !it.processingPanels.getValue(4).saving }
        assertEquals(1, requests.size); assertEquals(intent.encode().toString(), requests.single().body.clone().readUtf8())
        await(model) { detailReads.get() > 0 && it.detailLoads[4] == null }
        assertNull(store.load(owner.accountKey, 4))
        assertTrue(withContext(Dispatchers.Main) { model.uiState.processingPanels.getValue(4).message.contains("请求已保存") })
    }

    @Test fun confirmedDeletionDuringPrepareClearsOnlyItsJournalAndPreventsLateNetworkOrUiResurrection() = runBlocking<Unit> {
        val prepared = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val store = ProcessingStore(context)
        val journal = object : ProcessingJournal by store {
            override suspend fun prepare(value: StoredProcessingIntent, expected: StoredProcessingIntent?) {
                store.prepare(value, expected); prepared.complete(Unit); release.await()
            }
        }
        val model = start(ProcessingRepository(ProcessingClient(base), journal))
        await(model) { it.preferencesLoaded && it.preferences.apiToken == a }
        val (owner, intent) = load(model)
        withContext(Dispatchers.Main) { model.submitProcessing(4, intent, owner) }
        withTimeout(5000) { prepared.await() }
        curation.confirmDeletion(owner.accountKey, 4)
        await(model) { 4 !in it.processingPanels }
        assertNull(store.load(owner.accountKey, 4))
        release.complete(Unit)
        val before = reads.get()
        withContext(Dispatchers.Main) { model.loadProcessing(4, owner); model.submitProcessing(4, intent, owner) }
        assertEquals(before, reads.get()); assertTrue(requests.isEmpty())
        assertTrue(runCatching { store.prepare(StoredProcessingIntent(owner.accountKey, 4, intent), null) }.isFailure)
        assertTrue(withContext(Dispatchers.Main) { 4 !in model.uiState.processingPanels })
    }
}
