package com.alpenl.cairn.share

import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Each method is a separate Android process in tests/android-worker/run.sh.
 * Every business response comes from the real authenticated Worker/D1/R2. */
@RunWith(AndroidJUnit4::class)
class ProcessingWorkerIntegrationTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val base get() = InstrumentationRegistry.getArguments().getString("cairnWorkerUrl").orEmpty()
    private val token = "test-a-12345678"
    private val account get() = accountKeyFor(base, token)
    private val models = ViewModelStore()
    private val pidFile get() = File(context.filesDir, "processing-worker-pid.txt")
    private val mediaFile get() = File(context.filesDir, "processing-worker-media.sha256")
    private val intentFile get() = File(context.filesDir, "processing-worker-intent.json")
    private val original = "Human supplied complete primary 🙂\n" + "保留来源".repeat(2000)
    private val image = "enrichment/9004/" + "a".repeat(64) + ".png"

    @After fun close() = runBlocking<Unit> { withContext(Dispatchers.Main) { models.clear() } }
    private fun control(mode: String? = null): JSONObject {
        val c = URL("$base/__test/control").openConnection() as HttpURLConnection
        try {
            if (mode != null) { c.requestMethod = "POST"; c.doOutput = true
                c.outputStream.use { it.write(JSONObject().put("mode", mode).toString().toByteArray(Charsets.UTF_8)) } }
            assertEquals(200, c.responseCode)
            return JSONObject(c.inputStream.bufferedReader().readText())
        } finally { c.disconnect() }
    }
    private fun media(expectedStatus: Int = 200): String {
        val c = URL("$base/__test/direct/api/images/$image").openConnection() as HttpURLConnection
        try {
            c.useCaches = false; c.setRequestProperty("Authorization", "Bearer $token")
            assertEquals(expectedStatus, c.responseCode)
            if (expectedStatus != 200) return ""
            val data = c.inputStream.use { it.readBytes() }
            assertTrue(data.isNotEmpty())
            return MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it.toInt() and 255) }
        } finally { c.disconnect() }
    }
    private suspend fun start(): CairnLinksViewModel {
        SharePreferencesStore(context).setApiToken(token)
        return withContext(Dispatchers.Main) {
            CairnLinksViewModel(LinksApiClient(base), UpdateApiClient("$base/latest"), SharePreferencesStore(context), PendingUploadStore(context),
                ApiDebugClient(base), V2CurationRepository(V2ClientTransport(V2CurationClient(base))), CurationActionStore(context),
                base, "$base/latest", "test", 1).also { models.put("processing-worker", it) }
        }.also { model -> await(model) { it.preferencesLoaded && it.preferences.apiToken == token } }
    }
    private suspend fun await(model: CairnLinksViewModel, predicate: (CairnLinksUiState) -> Boolean) = withTimeout(15000) {
        while (!withContext(Dispatchers.Main) { predicate(model.uiState) }) delay(25)
    }
    private suspend fun display(model: CairnLinksViewModel) = withContext(Dispatchers.Main) { CurationDisplayContext(account, model.uiState.accountGeneration) }
    private suspend fun load(model: CairnLinksViewModel): ProcessingPanelState {
        val actor = display(model)
        withContext(Dispatchers.Main) { model.loadProcessing(9004, actor) }
        await(model) { it.processingPanels[9004]?.let { panel -> panel.storageReady && !panel.loading && panel.result is RunHistoryResult.Loaded } == true }
        return withContext(Dispatchers.Main) { model.uiState.processingPanels.getValue(9004) }
    }
    private fun anotherProcess() {
        assertNotEquals("Harness must start a distinct Android process", pidFile.readText().trim().toInt(), android.os.Process.myPid())
        println("processing actual Android pid=${android.os.Process.myPid()}")
    }

    @Test fun persistPrimaryWithActualViewModelAndLoseCommittedWorkerResponse() = runBlocking<Unit> {
        assumeTrue("requires isolated Worker harness", base.isNotEmpty())
        control("online")
        val model = start(); val panel = load(model)
        assertNull(panel.pending)
        val status = (panel.result as RunHistoryResult.Loaded).value
        assertTrue(status.actions.getValue(ProcessingAction.SavePrimary).allowed)
        mediaFile.writeText(media())
        val intent = ProcessingIntent("android-processing-primary", status.identity, ProcessingAction.SavePrimary, original)
        control("lose_processing")
        withContext(Dispatchers.Main) { model.submitProcessing(9004, intent, display(model)) }
        await(model) { it.processingPanels[9004]?.message?.contains("结果尚未确认") == true }
        val stored = ProcessingStore(context).load(account, 9004)!!
        assertEquals(intent, stored.intent); assertNull(stored.rejected)
        assertEquals(1, control().getJSONArray("processing").length())
        val record = RunHistoryClient("$base/__test/direct").savedRecord(9004, SavedRecordScope(SavedRecordKind.Sources),
            (status.identity.revision + 1).toString(), token) as RunHistoryResult.Loaded
        val snapshot = JSONObject(record.value.exportJson).getJSONObject("record").getJSONObject("payload")
        assertEquals("Stored image context", snapshot.getJSONArray("blocks").getJSONObject(0).getString("text"))
        assertEquals("legacy_unknown", snapshot.getJSONArray("blocks").getJSONObject(0).getString("role"))
        assertEquals(original, snapshot.getJSONArray("blocks").getJSONObject(1).getString("text"))
        assertEquals("primary", snapshot.getJSONArray("blocks").getJSONObject(1).getString("role"))
        assertEquals("manual", snapshot.getJSONArray("blocks").getJSONObject(1).getString("acquired"))
        assertTrue(snapshot.getJSONObject("truncation").getBoolean("truncated"))
        assertEquals(mediaFile.readText(), media())
        pidFile.writeText(android.os.Process.myPid().toString())
        println("processing actual Android pid=${android.os.Process.myPid()}")
    }

    @Test fun recoverPrimaryAfterProcessDeathAndRetryOnlyClassificationFromFreshState() = runBlocking<Unit> {
        assumeTrue("requires isolated Worker harness", base.isNotEmpty())
        anotherProcess(); control("online")
        val model = start(); val restored = load(model)
        val originalRequest = restored.pending!!
        assertEquals(original, originalRequest.intent.text); assertNull(originalRequest.rejected)
        assertEquals(1, control().getJSONArray("processing").length())
        val actor = display(model)
        withContext(Dispatchers.Main) { model.submitProcessing(9004, originalRequest.intent, actor) }
        await(model) { it.processingPanels[9004]?.let { panel -> panel.message.contains("已确认上次请求") && !panel.loading && panel.pending == null } == true }
        assertNull(ProcessingStore(context).load(account, 9004))
        val latest = load(model)
        val status = (latest.result as RunHistoryResult.Loaded).value
        assertTrue(status.actions.getValue(ProcessingAction.RetryClassification).allowed)
        val retry = ProcessingIntent("android-processing-classification", status.identity, ProcessingAction.RetryClassification)
        withContext(Dispatchers.Main) { model.submitProcessing(9004, retry, actor) }
        await(model) { it.processingPanels[9004]?.let { panel -> panel.message.contains("请求已保存") && !panel.saving && !panel.loading } == true }
        val trace = control().getJSONArray("processing")
        assertEquals(3, trace.length())
        assertEquals(trace.getJSONObject(0).toString(), trace.getJSONObject(1).toString())
        assertEquals("retry_classification", trace.getJSONObject(2).getString("action"))
        val current = (load(model).result as RunHistoryResult.Loaded).value
        assertEquals("completed", current.stages.single { it.key == "reading" }.state)
        assertEquals("queued", current.stages.single { it.key == "classification" }.state)
        assertEquals(mediaFile.readText(), media())
        val link = LinksApiClient(base).get(9004, token) as LinkGetResult.Loaded
        assertEquals(original, link.link.enrichment?.originalText)
        assertEquals("Keep title", link.link.enrichment?.aiTitle)
        assertEquals("Keep summary", link.link.enrichment?.summary)
        assertEquals("Keep translation", link.link.enrichment?.translatedText)
        intentFile.writeText(retry.encode().toString()); pidFile.writeText(android.os.Process.myPid().toString())
    }

    @Test fun confirmedRealDeletionErasesJournalAndRejectsDelayedKnownRequestWithoutResurrection() = runBlocking<Unit> {
        assumeTrue("requires isolated Worker harness", base.isNotEmpty())
        anotherProcess(); control("online")
        val retry = decodeProcessingIntent(JSONObject(intentFile.readText()))
        // Simulate a previous process dying before it removed its known server
        // receipt; the immutable intent is the one already committed in phase 2.
        ProcessingStore(context).prepare(StoredProcessingIntent(account, 9004, retry), null)
        val model = start(); assertEquals(retry, load(model).pending!!.intent)
        val deleted = java.util.concurrent.atomic.AtomicBoolean()
        withContext(Dispatchers.Main) { model.deleteLink(9004) { deleted.set(true) } }
        withTimeout(15000) { while (!deleted.get()) delay(25) }
        await(model) { 9004 !in it.processingPanels && it.links.none { link -> link.id == 9004 } }
        assertNull(ProcessingStore(context).load(account, 9004))
        assertEquals(ProcessingWriteResult.Rejected("not_found"), ProcessingClient(base).submit(9004, token, retry))
        assertTrue(runCatching { ProcessingStore(context).prepare(StoredProcessingIntent(account, 9004, retry), null) }.isFailure)
        media(404)
        assertTrue(pidFile.delete()); assertTrue(intentFile.delete()); assertTrue(mediaFile.delete())
    }
}
