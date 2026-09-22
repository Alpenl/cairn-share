package com.alpenl.cairn.share

import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL

/** Run in two separate app processes by tests/android-worker/run.sh. */
@RunWith(AndroidJUnit4::class)
class CurationWorkerRecoveryTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val base get() = InstrumentationRegistry.getArguments().getString("cairnWorkerUrl").orEmpty()
    private val store get() = CurationActionStore(context)
    private val account get() = accountKeyFor(base, "app")
    private val models = ViewModelStore()

    private fun http(path: String, body: JSONObject? = null): JSONObject {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        connection.connectTimeout = 5_000
        connection.readTimeout = 5_000
        connection.setRequestProperty("Authorization", "Bearer app")
        try {
            if (body != null) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val expected = if (path == "/__test/direct/api/links") 201 else 200
            assertEquals("$path must use the authorized real Worker", expected, connection.responseCode)
            return JSONObject(connection.inputStream.bufferedReader().readText())
        } finally { connection.disconnect() }
    }

    private fun control(mode: String, key: String = "") = http("/__test/control", JSONObject().put("mode", mode).put("key", key))
    private fun remote(id: Int) = http("/__test/direct/api/bookmarks/$id/v2-selection")

    private suspend fun start(): CairnLinksViewModel = withContext(Dispatchers.Main) {
        CairnLinksViewModel(
            LinksApiClient(base), UpdateApiClient("$base/latest"), SharePreferencesStore(context),
            PendingUploadStore(context), ApiDebugClient(base),
            V2CurationRepository(V2ClientTransport(V2CurationClient(base, 1_000, 1_000))),
            store, base, "$base/latest", "test", 1,
        ).also { models.put("curation", it) }
    }

    private suspend fun waitFor(predicate: suspend () -> Boolean) = withTimeout(20_000) {
        while (!predicate()) delay(30)
    }

    @Test fun persistBeforeSendAndLoseFirstResponse() = runBlocking {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        store.clear()
        SharePreferencesStore(context).setApiToken("app")
        control("online")
        val created = http("/__test/direct/api/links", JSONObject().put("url", "https://example.com/android-recovery"))
        val id = created.getInt("id")
        val model = start()
        waitFor { withContext(Dispatchers.Main) { model.uiState.preferencesLoaded } }
        withContext(Dispatchers.Main) { model.loadV2Selection(id) }
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Selections.containsKey(id) } }
        control("offline")
        withContext(Dispatchers.Main) {
            model.applyV2Action(id, "topics", "llm", "accept")
            model.applyV2Action(id, "topics", "llm", "reject")
            model.applyV2Action(id, "carriers", "external_article", "accept")
            model.applyV2Action(id, "affordances", "", "set_empty")
            model.applyV2Action(id, "topics", "", "reset")
        }
        waitFor { store.snapshot().size == 5 && withContext(Dispatchers.Main) { model.uiState.v2Busy.isEmpty() } }
        val queued = store.snapshot()
        assertEquals(0L, queued.first().expectedRevision)
        queued.zipWithNext().forEach { (parent, child) ->
            assertEquals(parent.operationKey, child.predecessorKey)
            assertNull(child.expectedRevision)
        }
        // Keep an unrelated account's intent throughout both processes.
        store.enqueue(QueuedCurationAction(id, "foreign-account-action", "topics", "eval", "accept", 0, "other-account"))
        control("lose_first")
        withContext(Dispatchers.Main) { model.flushV2Queue() }
        waitFor { remote(id).getLong("revision") == 1L }
        waitFor { withContext(Dispatchers.Main) { model.uiState.message?.text?.contains("网络不可用") == true } }
        assertEquals(queued, store.snapshot().filter { it.accountKey == account })
        assertEquals(1L, remote(id).getLong("revision"))
        // The harness force-stops this app after instrumentation returns. No
        // in-memory queue or ViewModel survives the next test process.
        withContext(Dispatchers.Main) { models.clear() }
    }

    @Test fun recoverThenHandleTwoRealConflictsAndMidChainFailure() = runBlocking {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        val original = store.snapshot().filter { it.accountKey == account }
        assertEquals(5, original.size)
        val id = original.first().linkId
        val second = original[1].operationKey
        val third = original[2].operationKey
        control("conflict", second)
        val model = start() // Normal startup retries its persisted queue.
        waitFor { store.snapshot().any { it.operationKey == second && it.conflictRevision == 2L } }
        val remaining = store.snapshot().filter { it.accountKey == account }
        assertEquals(4, remaining.size)
        assertEquals(1L, remaining.first().expectedRevision)
        assertEquals(1L, remaining.first().predecessorRevision)
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Conflicts[id] == 2L && model.uiState.v2Drafts.containsKey(id) } }
        assertEquals(2L, remote(id).getLong("revision"))

        // An explicit reapply reloads 2, but another client wins CAS at 3.
        control("conflict", second)
        withContext(Dispatchers.Main) { model.reapplyV2Draft(id) }
        waitFor { store.snapshot().any { it.operationKey == second && it.conflictRevision == 3L } }
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Conflicts[id] == 3L } }
        control("fail_key", third)
        withContext(Dispatchers.Main) { model.reapplyV2Draft(id) }
        waitFor { store.snapshot().filter { it.accountKey == account }.size == 3 }
        waitFor { withContext(Dispatchers.Main) { model.uiState.message?.text?.contains("网络不可用") == true } }
        val stopped = store.snapshot().filter { it.accountKey == account }
        assertEquals(third, stopped.first().operationKey)
        assertEquals(4L, stopped.first().expectedRevision)
        assertEquals(4L, stopped.first().predecessorRevision)
        assertEquals(4L, remote(id).getLong("revision"))
        withContext(Dispatchers.Main) { assertTrue(model.uiState.v2Drafts.containsKey(id)) }

        control("online")
        withContext(Dispatchers.Main) { model.flushV2Queue() }
        waitFor { store.snapshot().none { it.accountKey == account } }
        val final = remote(id)
        assertEquals(7L, final.getLong("revision")) // Five intents plus two independent writes.
        val selection = final.getJSONObject("selection")
        assertEquals(0, selection.getJSONArray("topics").length())
        assertEquals("external_article", selection.getJSONArray("carriers").getString(0))
        assertEquals(0, selection.getJSONArray("affordances").length())
        assertEquals("foreign-account-action", store.snapshot().single().operationKey)
        waitFor { withContext(Dispatchers.Main) { !model.uiState.v2Drafts.containsKey(id) && !model.uiState.v2Conflicts.containsKey(id) } }
        val calls = http("/__test/control").getJSONArray("requests")
        val sent = (0 until calls.length()).map { calls.getJSONObject(it) }
        assertTrue(sent.none { it.getString("operation_key") == "foreign-account-action" })
        assertTrue(sent.count { it.getString("operation_key") == original.first().operationKey } >= 2)
        assertEquals(2, http("/__test/control").getInt("web_writes"))
        withContext(Dispatchers.Main) { models.clear() }
    }

    @Test fun discardAndAccountSwitchPreserveUnrelatedActions() = runBlocking {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        store.clear()
        SharePreferencesStore(context).setApiToken("app")
        control("online")
        val ids = listOf("discard", "retain").map {
            http("/__test/direct/api/links", JSONObject().put("url", "https://example.com/android-$it")).getInt("id")
        }
        val model = start()
        waitFor { withContext(Dispatchers.Main) { model.uiState.preferencesLoaded } }
        withContext(Dispatchers.Main) { ids.forEach { model.loadV2Selection(it) } }
        waitFor { withContext(Dispatchers.Main) { ids.all { model.uiState.v2Selections.containsKey(it) } } }
        control("offline")
        withContext(Dispatchers.Main) {
            ids.forEach { id ->
                model.applyV2Action(id, "topics", "llm", "accept")
                model.applyV2Action(id, "topics", "llm", "reject")
            }
        }
        waitFor { store.snapshot().size == 4 && withContext(Dispatchers.Main) { model.uiState.v2Busy.isEmpty() } }
        withContext(Dispatchers.Main) { model.discardV2Draft(ids[0]) }
        waitFor { store.snapshot().size == 2 }
        assertTrue(store.snapshot().all { it.linkId == ids[1] })
        withContext(Dispatchers.Main) { assertTrue(model.uiState.v2Drafts.containsKey(ids[1])) }

        SharePreferencesStore(context).setApiToken("different-account")
        waitFor { withContext(Dispatchers.Main) { model.uiState.preferences.apiToken == "different-account" } }
        control("online")
        withContext(Dispatchers.Main) { model.flushV2Queue() }
        delay(200)
        assertEquals(2, store.snapshot().size)
        assertEquals(0L, remote(ids[1]).getLong("revision"))
        SharePreferencesStore(context).setApiToken("app")
        waitFor { store.snapshot().isEmpty() }
        assertEquals(0L, remote(ids[0]).getLong("revision"))
        assertEquals(2L, remote(ids[1]).getLong("revision"))
        withContext(Dispatchers.Main) { models.clear() }
    }
}
