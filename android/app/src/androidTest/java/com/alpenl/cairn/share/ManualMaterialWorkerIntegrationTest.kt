package com.alpenl.cairn.share

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Two separate Android processes, one actual authenticated Worker/D1. */
@RunWith(AndroidJUnit4::class)
class ManualMaterialWorkerIntegrationTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val base get() = InstrumentationRegistry.getArguments().getString("cairnWorkerUrl").orEmpty()
    private val token = "test-a-12345678"
    private val account get() = accountKeyFor(base, token)
    private val fragment = "Human image transcription 🙂\n" + "保留完整内容".repeat(1000)
    private fun control(mode: String? = null): JSONObject {
        val connection = URL("$base/__test/control").openConnection() as HttpURLConnection
        try {
            if (mode != null) {
                connection.requestMethod = "POST"; connection.doOutput = true
                connection.outputStream.use { it.write(JSONObject().put("mode", mode).toString().toByteArray(Charsets.UTF_8)) }
            }
            assertEquals(200, connection.responseCode)
            return JSONObject(connection.inputStream.bufferedReader().readText())
        } finally { connection.disconnect() }
    }
    private fun fixtureId(): Int {
        val connection = URL("$base/__test/direct/api/links?limit=100").openConnection() as HttpURLConnection
        connection.setRequestProperty("Authorization", "Bearer $token")
        try {
            assertEquals(200, connection.responseCode)
            val rows = JSONObject(connection.inputStream.bufferedReader().readText()).getJSONArray("items")
            return (0 until rows.length()).map { rows.getJSONObject(it) }.single { it.getString("url") == "https://example.com/android-manual-material" }.getInt("id")
        } finally { connection.disconnect() }
    }

    @Test fun persistManualMaterialBeforeSendAndLoseActualCommitResponse() = runBlocking<Unit> {
        assumeTrue("requires isolated Worker harness", base.isNotEmpty())
        control("online")
        val id = fixtureId()
        val options = (ManualMaterialClient(base).options(id, token) as RunHistoryResult.Loaded).value
        assertTrue(options.canSubmit)
        val option = options.options.single()
        assertEquals("image_text", option.kind); assertEquals("legacy_unknown", option.role)
        val value = StoredManualMaterial(account, id, ManualMaterialIntent("device-material-commit", options.source!!, option, fragment))
        val store = ManualMaterialStore(context)
        store.prepare(value, null)
        control("lose_first")
        assertTrue(ManualMaterialClient(base).submit(id, token, value.intent) is MaterialWriteResult.Unknown)
        assertEquals(value, ManualMaterialStore(context).load(account, id))
        // Direct inspection bypasses only the injected transport failure, not
        // App authentication. The real new snapshot exists before process exit.
        val record = RunHistoryClient("$base/__test/direct").savedRecord(id, SavedRecordScope(SavedRecordKind.Sources),
            (options.source.revision+1).toString(), token) as RunHistoryResult.Loaded
        val blocks = JSONObject(record.value.exportJson).getJSONObject("record").getJSONObject("payload").getJSONArray("blocks")
        assertEquals("Manual fixture original source", blocks.getJSONObject(0).getString("text"))
        assertEquals(fragment, blocks.getJSONObject(1).getString("text")); assertEquals("manual", blocks.getJSONObject(1).getString("acquired"))
        assertEquals(1, control().getJSONArray("materials").length())
    }

    @Test fun recoverManualMaterialAfterProcessDeathWithoutAnotherVersionOrQueue() = runBlocking<Unit> {
        assumeTrue("requires isolated Worker harness", base.isNotEmpty())
        control("online")
        val id = fixtureId()
        val store = ManualMaterialStore(context)
        val saved = store.load(account, id)!!
        assertEquals("device-material-commit", saved.intent.operationKey); assertEquals(fragment, saved.intent.text); assertNull(saved.rejected)
        val client = ManualMaterialClient(base)
        val options = (client.options(id, token) as RunHistoryResult.Loaded).value
        assertEquals(saved.intent.source.revision+1, options.source!!.revision)
        assertEquals(1, control().getJSONArray("materials").length()) // Read never drains saved intents.
        assertEquals(MaterialWriteResult.Saved(options.source.revision, true, true), client.submit(id, token, saved.intent))
        store.acknowledge(saved); assertNull(ManualMaterialStore(context).load(account, id))
        val duplicate = saved.copy(intent = saved.intent.copy(operationKey="device-material-duplicate", source=options.source))
        store.prepare(duplicate, null)
        assertEquals(MaterialWriteResult.Saved(options.source.revision, false, false), client.submit(id, token, duplicate.intent))
        store.acknowledge(duplicate)
        val requests = control().getJSONArray("materials")
        assertEquals(3, requests.length()); assertEquals(requests.getJSONObject(0).toString(), requests.getJSONObject(1).toString())
        assertNull(store.load(accountKeyFor(base,"wrong-account"), id))
        assertEquals(RunHistoryResult.Failed(FailureKind.Unauthorized), client.options(id,"wrong-account"))
        assertEquals(options.source, ((client.options(id,token) as RunHistoryResult.Loaded).value).source)
    }
}
