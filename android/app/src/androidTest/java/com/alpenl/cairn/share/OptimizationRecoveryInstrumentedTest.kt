package com.alpenl.cairn.share

import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import kotlinx.coroutines.*
import okhttp3.mockwebserver.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real DataStore, AtomicFile, ViewModel and GET transport; only local synthetic content. */
@RunWith(AndroidJUnit4::class)
class OptimizationRecoveryInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun json(body: JSONObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(body.toString())
    private fun definition() = JSONObject().put("id", "offline-tag").put("tag_ref", "custom/default/offline-tag").put("label", "稍后练习").put("revision", 1).put("status", "active")
    private fun archive(id: Int, loaded: Boolean = false) = JSONObject().put("id", id).put("url", "https://example.com/$id")
        .put("note", "local fixture").put("created_at", "2020-01-01T00:00:00Z").put("learned", false)
        .put("enrichment", JSONObject().put("content_loaded", loaded).put("original_text", if (loaded) "local archived text" else "")
            .put("cache_identity", JSONObject().put("schema_version", 1).put("representation", if (loaded) "enrichment_detail" else "enrichment_summary")
                .put("content_revision", 1).put("personal_revision", 0).put("body_revision", 1).put("latest_decision_id", 0).put("latest_entity_revision", 0)))
    private fun page(id: Int) = json(JSONObject().put("items", JSONArray().put(archive(id))).put("next_before_id", JSONObject.NULL).put("filter_contract_version", 1))
    private suspend fun await(model: CairnLinksViewModel, predicate: (CairnLinksUiState) -> Boolean) = withTimeout(10_000) {
        while (!withContext(Dispatchers.Main) { predicate(model.uiState) }) delay(25)
    }

    @Test fun lostCreateReceiptSurvivesStoreRecreationAndNeverSendsForeignAccount() = runBlocking<Unit> {
        val server = MockWebServer(); server.start()
        val base = server.url("/").toString().trimEnd('/')
        val account = accountKeyFor(base, "test-a")
        val other = accountKeyFor(base, "test-b")
        val store = PersonalTagOutbox(context)
        store.discard(account, 28); store.discard(other, 28)
        val calls = mutableListOf<String>()
        val creates = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                assertEquals("Bearer test-a", request.getHeader("Authorization"))
                val body = JSONObject(request.body.readUtf8())
                calls += body.getString("operation_key")
                return if (request.path == "/api/custom-tags") {
                    if (creates.incrementAndGet() == 1) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    else json(JSONObject().put("tag", definition()).put("replayed", true))
                } else {
                    assertEquals(12, body.getInt("expected_revision"))
                    assertEquals(17, body.getInt("expected_decision_id"))
                    json(JSONObject().put("id", 28).put("operation_id", body.getString("operation_key")).put("operation_revision", 13).put("replayed", false))
                }
            }
        }
        try {
            val request = PersonalTagRequest("/api/custom-tags", "POST", """{"operation_key":"create-recovery-once","label":"稍后练习"}""", true, true, PersonalTagSnapshot(12, 17, 3, emptyList()))
            store.enqueue(PendingPersonalTag(account, 28, request))
            store.enqueue(PendingPersonalTag(other, 28, request.copy(body = """{"operation_key":"foreign-retained","label":"other"}""")))
            store.drain(account, "test-a", V2CurationClient(base, 1_000, 1_000), emptySet()) { true }
            assertEquals(request, PersonalTagOutbox(context).snapshot().single { it.account == account }.request)
            PersonalTagOutbox(context).drain(account, "test-a", V2CurationClient(base), emptySet()) { true }
            assertEquals(listOf("foreign-retained"), store.snapshot().map { it.request.operationKey })
            assertEquals(2, calls.count { it == request.operationKey })
            assertEquals(3, calls.size)
        } finally { store.discard(account, 28); store.discard(other, 28); server.shutdown() }
    }

    @Test fun persistentConflictNeverRebasesUntilExplicitUserResolution() = runBlocking<Unit> {
        val server = MockWebServer(); server.start()
        val base = server.url("/").toString().trimEnd('/')
        val account = accountKeyFor(base, "test-conflict")
        val store = PersonalTagOutbox(context); store.discard(account, 28)
        try {
            val payload = personalTagActionPayload(PersonalTagSnapshot(12, 17, 3, emptyList()), JSONObject().put("action", "attach").put("tag_ref", "custom/default/offline-tag"), "old-cas")
            store.enqueue(PendingPersonalTag(account, 28, PersonalTagRequest("/api/bookmarks/28/tags", "POST", payload.toString())))
            server.enqueue(MockResponse().setResponseCode(409).setBody("{\"error\":\"revision_conflict\",\"revision\":13}"))
            store.drain(account, "test-conflict", V2CurationClient(base), emptySet()) { true }
            val conflict = PersonalTagOutbox(context).snapshot().single { it.account == account }
            assertEquals(13L, conflict.conflictRevision)
            store.drain(account, "test-conflict", V2CurationClient(base), emptySet()) { true }
            assertEquals(1, server.requestCount)
            val rebased = JSONObject(conflict.request.body).put("expected_revision", 13).put("operation_key", "explicit-new-cas")
            store.replace(conflict, conflict.copy(request = conflict.request.copy(body = rebased.toString()), conflictRevision = null))
            server.enqueue(json(JSONObject().put("id", 28).put("operation_id", "explicit-new-cas").put("operation_revision", 14).put("replayed", false)))
            store.drain(account, "test-conflict", V2CurationClient(base), emptySet()) { true }
            assertTrue(store.snapshot().none { it.account == account })
        } finally { store.discard(account, 28); server.shutdown() }
    }

    @Test fun privateOfflineBodyAndPinsSurviveRecreationWithoutCrossingAccounts() = runBlocking<Unit> {
        val account = accountKeyFor("https://offline.invalid", "a")
        val other = accountKeyFor("https://offline.invalid", "b")
        val store = OfflineReadStore(context); store.clear(account); store.clear(other)
        try {
            val saved = LinkJson.decodeLink(archive(28, loaded = true))
            store.save(account, saved, now = 1)
            store.setPinned(account, 28, true)
            val restored = OfflineReadStore(context).snapshot(account).single()
            assertEquals(saved, restored.link)
            assertTrue(restored.pinned)
            assertTrue(OfflineReadStore(context).snapshot(other).isEmpty())
            for (id in 100..130) store.save(account, LinkJson.decodeLink(archive(id, true)), now = id.toLong())
            val bounded = store.snapshot(account)
            assertEquals(31, bounded.size)
            assertTrue(bounded.any { it.link.id == 28 && it.pinned })
            assertFalse(bounded.any { it.link.id == 100 })
        } finally { store.clear(account); store.clear(other) }
    }

    @Test fun queryRetainsOldRowsWhileLoadingAndLateCancelledResultCannotReplaceCurrentQuery() = runBlocking<Unit> {
        val server = MockWebServer(); server.start()
        val base = server.url("/").toString().trimEnd('/')
        val hold = CountDownLatch(1); val second = CountDownLatch(1)
        val settings = SharePreferencesStore(context); settings.setApiToken("query-test"); settings.setLastFilter("all"); settings.setLastSearchQuery("")
        val models = ViewModelStore()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!
                return when (url.encodedPath) {
                    "/api/links" -> when (url.queryParameter("topics")) {
                        "one" -> page(10)
                        "two" -> { second.countDown(); hold.await(10, TimeUnit.SECONDS); page(20) }
                        "three" -> page(30)
                        else -> page(99)
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        try {
            val model = withContext(Dispatchers.Main) { CairnLinksViewModel(LinksApiClient(base), UpdateApiClient("$base/latest"), settings,
                PendingUploadStore(context), ApiDebugClient(base), V2CurationRepository(V2ClientTransport(V2CurationClient(base))), CurationActionStore(context),
                base, "$base/latest", "test", 1).also { models.put("query", it) } }
            await(model) { !it.loading && it.links.any { row -> row.id == 99 } }
            withContext(Dispatchers.Main) { model.setBookmarkFilters(BookmarkFilters(topics = listOf("one"))) }
            await(model) { !it.libraryLoading && it.libraryResults.map { row -> row.id } == listOf(10) }
            withContext(Dispatchers.Main) { model.setBookmarkFilters(BookmarkFilters(topics = listOf("two"))) }
            assertTrue(withContext(Dispatchers.IO) { second.await(5, TimeUnit.SECONDS) })
            withContext(Dispatchers.Main) {
                assertTrue(model.uiState.libraryStale)
                assertEquals(listOf(10), model.uiState.libraryResults.map { it.id })
                model.setBookmarkFilters(BookmarkFilters(topics = listOf("three")))
            }
            await(model) { !it.libraryLoading && it.libraryResults.map { row -> row.id } == listOf(30) }
            hold.countDown(); delay(100)
            withContext(Dispatchers.Main) { assertFalse(model.uiState.libraryStale); assertEquals(listOf(30), model.uiState.libraryResults.map { it.id }) }
        } finally { hold.countDown(); withContext(Dispatchers.Main) { models.clear() }; server.shutdown() }
    }
}
