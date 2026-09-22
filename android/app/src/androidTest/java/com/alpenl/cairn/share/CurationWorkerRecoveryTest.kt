package com.alpenl.cairn.share

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import org.json.JSONArray
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

/** Run in separate app processes by tests/android-worker/run.sh. */
@RunWith(AndroidJUnit4::class)
class CurationWorkerRecoveryTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val base get() = InstrumentationRegistry.getArguments().getString("cairnWorkerUrl").orEmpty()
    private val store get() = CurationActionStore(context)
    private val token = "test-a-12345678"
    private val account get() = accountKeyFor(base, token)
    private val models = ViewModelStore()

    private fun http(path: String, body: JSONObject? = null): JSONObject {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        connection.connectTimeout = 5_000
        connection.readTimeout = 5_000
        connection.setRequestProperty("Authorization", "Bearer $token")
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
    private fun remote(id: Int) = http("/__test/direct/api/bookmarks/$id/v2-selection?include_automatic=1")

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

    @Test fun persistBeforeSendAndLoseFirstResponse() = runBlocking<Unit> {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        store.clear()
        SharePreferencesStore(context).setApiToken(token)
        control("online")
        val created = http("/__test/direct/api/links", JSONObject().put("url", "https://example.com/android-recovery"))
        val id = created.getInt("id")
        val model = start()
        waitFor { withContext(Dispatchers.Main) { model.uiState.preferencesLoaded } }
        waitFor { withContext(Dispatchers.Main) { model.uiState.links.any { it.id == id } } }
        withContext(Dispatchers.Main) {
            val identity = model.uiState.links.first { it.id == id }.enrichment!!.cacheIdentity
            assertNotNull("real Worker list negotiates a recognized cache identity", identity)
            assertEquals("enrichment_summary", identity!!.representation)
            model.ensureLink(id)
        }
        waitFor { withContext(Dispatchers.Main) { model.uiState.links.first { it.id == id }.enrichment!!.contentLoaded } }
        withContext(Dispatchers.Main) {
            assertEquals("enrichment_detail", model.uiState.links.first { it.id == id }.enrichment!!.cacheIdentity!!.representation)
        }
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

    @Test fun recoverThenHandleTwoRealConflictsAndMidChainFailure() = runBlocking<Unit> {
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

    @Test fun discardAndAccountSwitchPreserveUnrelatedActions() = runBlocking<Unit> {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        store.clear()
        SharePreferencesStore(context).setApiToken(token)
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
        SharePreferencesStore(context).setApiToken(token)
        waitFor { store.snapshot().isEmpty() }
        assertEquals(0L, remote(ids[0]).getLong("revision"))
        assertEquals(2L, remote(ids[1]).getLong("revision"))
        withContext(Dispatchers.Main) { models.clear() }
    }

    @Test fun preserveAmbiguousLegacyAndSeparateSameSuffixAccounts() = runBlocking<Unit> {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        SharePreferencesStore(context).setApiToken(token)
        control("writes_offline")
        val id = http("/__test/direct/api/links", JSONObject().put("url", "https://example.com/legacy-owned")).getInt("id")
        val other = http("/__test/direct/api/links", JSONObject().put("url", "https://example.com/legacy-unknown-revision")).getInt("id")
        val legacy = legacyAccountKeyFor(base, token)
        val actions = listOf(
            QueuedCurationAction(id, "legacy-first", "topics", "llm", "accept", 0, legacy, queueVersion = 0),
            QueuedCurationAction(id, "legacy-second", "topics", "llm", "reject", 0, legacy, queueVersion = 0),
            QueuedCurationAction(other, "legacy-no-revision", "carriers", "single", "accept", null, legacy, queueVersion = 0),
            QueuedCurationAction(other, "bound-before-upgrade", "topics", "eng", "accept", 0, account),
            QueuedCurationAction(9999, "other-server-legacy", "topics", "eng", "accept", 0, legacyAccountKeyFor("https://other.example", token), queueVersion = 0),
        )
        // Emulate old on-disk preferences, before the production singleton is opened.
        val job = SupervisorJob()
        val oldStore = PreferenceDataStoreFactory.create(scope = CoroutineScope(job + Dispatchers.IO)) {
            context.preferencesDataStoreFile("cairn_curation_actions")
        }
        oldStore.edit { prefs ->
            val array = JSONArray()
            actions.forEach { action -> array.put(action.encode().apply { if (action.queueVersion == 0) remove("queue_version") }) }
            prefs[stringPreferencesKey("curation_actions_json")] = array.toString()
        }
        job.cancelAndJoin()
        // A historical success with a lost response must still confirm its original key.
        http("/__test/direct/api/bookmarks/$id/v2-override", JSONObject(FieldOverride("topics", "llm", "accept", "legacy-first", 0).encode()))
        val model = start()
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2LegacyActions[id]?.size == 2 && model.uiState.message?.text?.contains("网络不可用") == true } }
        withContext(Dispatchers.Main) { model.recoverLegacyV2Actions(other) }
        waitFor { withContext(Dispatchers.Main) { model.uiState.message?.text?.contains("先同步") == true } }
        assertEquals(actions, store.snapshot()) // No implicit merge of two independent chains.
        withContext(Dispatchers.Main) { model.loadV2Selection(id) }
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Selections.containsKey(id) } }
        val before = http("/__test/control").getJSONArray("requests").length()
        val collidingToken = "test-b-12345678"
        assertEquals(legacyAccountKeyFor(base, token), legacyAccountKeyFor(base, collidingToken))
        assertNotEquals(account, accountKeyFor(base, collidingToken))
        withContext(Dispatchers.Main) {
            model.setApiToken(collidingToken)
            assertTrue(model.uiState.v2Selections.isEmpty())
            assertTrue(model.uiState.v2Drafts.isEmpty())
            assertTrue(model.uiState.v2Queued.isEmpty())
        }
        waitFor { withContext(Dispatchers.Main) { model.uiState.preferences.apiToken == collidingToken && model.uiState.v2Queued.isEmpty() } }
        control("online")
        val readsBefore = http("/__test/control").getJSONArray("selection_reads").length()
        withContext(Dispatchers.Main) { model.flushV2Queue(); model.recoverLegacyV2Actions(id) }
        // Check the actual recovery authorization result. Concurrent list 401s
        // may replace a transient snackbar before the polling coroutine sees it.
        waitFor {
            val reads = http("/__test/control").getJSONArray("selection_reads")
            (readsBefore until reads.length()).any { index ->
                val read = reads.getJSONObject(index)
                read.getString("path") == "/api/bookmarks/$id/v2-selection" && read.getInt("status") == 401
            }
        }
        assertEquals(before, http("/__test/control").getJSONArray("requests").length())
        assertEquals(actions, store.snapshot())
        assertEquals(0L, remote(other).getLong("revision"))
        withContext(Dispatchers.Main) { models.clear() }
        SharePreferencesStore(context).setApiToken(token)
        control("writes_offline")
    }

    @Test fun explicitlyRecoverLegacyAfterRestart() = runBlocking<Unit> {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        val old = store.snapshot()
        val id = old.first { it.operationKey == "legacy-first" }.linkId
        val other = old.first { it.operationKey == "legacy-no-revision" }.linkId
        control("online")
        val model = start()
        waitFor { store.snapshot().none { it.operationKey == "bound-before-upgrade" } }
        assertEquals(4, store.snapshot().size)
        assertEquals(1L, remote(id).getLong("revision"))
        assertEquals(1L, remote(other).getLong("revision"))
        withContext(Dispatchers.Main) { model.recoverLegacyV2Actions(id) }
        waitFor { store.snapshot().any { it.operationKey == "legacy-second" && it.conflictRevision == 1L } }
        assertTrue(store.snapshot().none { it.operationKey == "legacy-first" })
        assertEquals(1L, remote(id).getLong("revision")) // Replay did not apply the first action twice.
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Conflicts[id] == 1L } }
        withContext(Dispatchers.Main) { model.reapplyV2Draft(id) }
        waitFor { store.snapshot().none { it.operationKey == "legacy-second" } }
        assertEquals(2L, remote(id).getLong("revision"))
        withContext(Dispatchers.Main) { model.recoverLegacyV2Actions(other) }
        waitFor { store.snapshot().any { it.operationKey == "legacy-no-revision" && it.conflictRevision == 1L } }
        assertNull(store.snapshot().first { it.operationKey == "legacy-no-revision" }.expectedRevision)
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Conflicts[other] == 1L } }
        withContext(Dispatchers.Main) { model.reapplyV2Draft(other) }
        waitFor { store.snapshot().size == 1 }
        assertEquals("other-server-legacy", store.snapshot().single().operationKey)
        assertEquals(2L, remote(other).getLong("revision"))
        assertEquals("single", remote(other).getJSONObject("selection").getJSONArray("carriers").getString(0))
        withContext(Dispatchers.Main) { models.clear() }
    }

    @Test fun persistResetWithIndependentAutomaticBaseline() = runBlocking<Unit> {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        store.clear()
        SharePreferencesStore(context).setApiToken(token)
        control("online")
        val id = InstrumentationRegistry.getArguments().getString("cairnBaselineID")!!.toInt()
        http("/__test/direct/api/bookmarks/$id/v2-override", JSONObject(FieldOverride("topics", "", "set_empty", "baseline-empty", 0).encode()))
        http("/__test/direct/api/bookmarks/$id/v2-override", JSONObject(FieldOverride("topics", "eng", "accept", "baseline-human", 1).encode()))
        val model = start()
        waitFor { withContext(Dispatchers.Main) { model.uiState.preferencesLoaded } }
        withContext(Dispatchers.Main) { model.loadV2Selection(id) }
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Selections.containsKey(id) } }
        withContext(Dispatchers.Main) {
            assertEquals(listOf("eng"), model.uiState.v2Selections[id]!!.topics)
            assertEquals(listOf("llm"), model.uiState.v2Selections[id]!!.automatic!!.topics)
        }
        control("writes_offline")
        withContext(Dispatchers.Main) { model.applyV2Action(id, "topics", "", "reset") }
        waitFor { store.snapshot().size == 1 && withContext(Dispatchers.Main) { model.uiState.v2Busy.isEmpty() } }
        withContext(Dispatchers.Main) {
            assertEquals(listOf("llm"), model.uiState.v2Drafts[id]!!.topics)
            assertTrue(model.uiState.v2Drafts[id]!!.unknownResetFields.isEmpty())
        }
        assertEquals("eng", remote(id).getJSONObject("selection").getJSONArray("topics").getString(0))
        withContext(Dispatchers.Main) { models.clear() }
    }

    @Test fun persistTermResetAfterExplicitEmpty() = runBlocking<Unit> {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        store.clear()
        SharePreferencesStore(context).setApiToken(token)
        control("online")
        val id = InstrumentationRegistry.getArguments().getString("cairnTermResetID")!!.toInt()
        http("/__test/direct/api/bookmarks/$id/v2-override", JSONObject(FieldOverride("topics", "", "set_empty", "term-empty", 0).encode()))
        val model = start()
        waitFor { withContext(Dispatchers.Main) { model.uiState.preferencesLoaded } }
        withContext(Dispatchers.Main) { model.loadV2Selection(id) }
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Selections.containsKey(id) } }
        withContext(Dispatchers.Main) {
            assertTrue(model.uiState.v2Selections[id]!!.topics.isEmpty())
            assertEquals(listOf("llm", "eval"), model.uiState.v2Selections[id]!!.automatic!!.topics)
        }
        control("writes_offline")
        withContext(Dispatchers.Main) { model.applyV2Action(id, "topics", "llm", "reset") }
        waitFor { store.snapshot().size == 1 && withContext(Dispatchers.Main) { model.uiState.v2Busy.isEmpty() } }
        withContext(Dispatchers.Main) { assertEquals(listOf("llm"), model.uiState.v2Drafts[id]!!.topics) }
        assertEquals(0, remote(id).getJSONObject("selection").getJSONArray("topics").length())
        withContext(Dispatchers.Main) { models.clear() }
    }

    @Test fun restoreTermResetAfterProcessDeath() = runBlocking<Unit> {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        val id = store.snapshot().single().linkId
        control("writes_offline")
        val model = start()
        waitFor { withContext(Dispatchers.Main) { model.uiState.preferencesLoaded } }
        withContext(Dispatchers.Main) { model.loadV2Selection(id) }
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Drafts[id]?.topics == listOf("llm") && model.uiState.v2Busy.isEmpty() } }
        assertEquals(1L, remote(id).getLong("revision"))
        control("online")
        withContext(Dispatchers.Main) { model.flushV2Queue() }
        waitFor { store.snapshot().isEmpty() && withContext(Dispatchers.Main) { model.uiState.v2Busy.isEmpty() } }
        val result = http("/__test/direct/api/bookmarks/$id/v2-selection?include_automatic=1&include_state=1")
        assertEquals(2L, result.getLong("revision"))
        assertEquals("[\"llm\"]", result.getJSONObject("selection").getJSONArray("topics").toString())
        assertEquals("[\"llm\",\"eval\"]", result.getJSONObject("automatic").getJSONArray("topics").toString())
        val topics = result.getJSONObject("state").getJSONObject("fields").getJSONObject("topics")
        assertTrue(topics.isNull("empty"))
        assertFalse(topics.getJSONArray("values").getJSONObject(0).getBoolean("confirmed"))
        assertEquals("human", topics.getJSONObject("cleared_automatic").getString("origin"))
        withContext(Dispatchers.Main) {
            assertEquals(listOf("llm"), model.uiState.v2Selections[id]!!.topics)
            models.clear()
        }
    }

    @Test fun restoreAutomaticDraftAfterProcessDeath() = runBlocking<Unit> {
        assumeTrue("requires the isolated real Worker harness", base.isNotEmpty())
        val id = store.snapshot().single().linkId
        control("writes_offline")
        val model = start()
        waitFor { withContext(Dispatchers.Main) { model.uiState.preferencesLoaded } }
        withContext(Dispatchers.Main) { model.loadV2Selection(id) }
        waitFor { withContext(Dispatchers.Main) { model.uiState.v2Drafts[id]?.topics == listOf("llm") && model.uiState.v2Busy.isEmpty() } }
        assertEquals(2L, remote(id).getLong("revision"))
        control("online")
        withContext(Dispatchers.Main) { model.flushV2Queue() }
        waitFor { store.snapshot().isEmpty() }
        val result = remote(id)
        assertEquals(3L, result.getLong("revision"))
        assertEquals("llm", result.getJSONObject("selection").getJSONArray("topics").getString(0))
        assertEquals("llm", result.getJSONObject("automatic").getJSONArray("topics").getString(0))
        withContext(Dispatchers.Main) { models.clear() }
    }
}
