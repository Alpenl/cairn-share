package com.alpenl.cairn.share

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL

/** Executed by the isolated Worker harness in two separate Android processes. */
@RunWith(AndroidJUnit4::class)
class LibrarySyncWorkerIntegrationTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val base get() = InstrumentationRegistry.getArguments().getString("cairnWorkerUrl").orEmpty()
    private val token = "test-a-12345678"
    private fun call(path: String, method: String = "GET", body: String? = null): Pair<Int, String> {
        val c = URL("$base$path").openConnection() as HttpURLConnection
        return try {
            c.requestMethod = method; c.connectTimeout = 10000; c.readTimeout = 10000
            c.setRequestProperty("Authorization", "Bearer $token")
            if(body != null) { c.doOutput = true; c.setRequestProperty("Content-Type","application/json"); c.outputStream.use { it.write(body.toByteArray()) } }
            val status = c.responseCode
            status to (if(status >= 400) c.errorStream else c.inputStream).bufferedReader().use { it.readText() }
        } finally { c.disconnect() }
    }
    @Test fun persistBaselineWithRealWorker() = runBlocking<Unit> {
        assumeTrue(base.isNotBlank())
        val prefs = SharePreferencesStore(context)
        prefs.setApiToken(token); prefs.setAutomaticSync(false); prefs.setImagesWifiOnly(false)
        val store = OfflineReadStore(context)
        val account = accountKeyFor(base, token)
        store.clear(account)
        val created = call("/api/links", "POST", """{"url":"https://example.com/library-sync-restart","note":"initial"}""")
        assertEquals(201, created.first)
        val id = JSONObject(created.second).getInt("id")
        assertTrue(LibrarySync.run(context, base, token))
        assertEquals("initial", store.get(account,id)!!.note)
        assertNotNull(store.syncState(account).cursor)
        assertFalse(store.syncState(account).reconciling)
        context.getSharedPreferences("sync-harness", 0).edit().putInt("id", id).putString("cursor",store.syncState(account).cursor).commit()
    }
    @Test fun resumeRealCursorApplyUpdatesAndDeletesAfterProcessDeath() = runBlocking<Unit> {
        assumeTrue(base.isNotBlank())
        val stored = context.getSharedPreferences("sync-harness", 0)
        val id = stored.getInt("id", 0)
        assertTrue(id > 0)
        val store = OfflineReadStore(context)
        val account = accountKeyFor(base, token)
        assertEquals(stored.getString("cursor", null), store.syncState(account).cursor)
        assertEquals(200, call("/api/links/$id", "PATCH", """{"note":"updated after restart","learned":true}""").first)
        assertTrue(LibrarySync.run(context, base, token))
        assertEquals("updated after restart", store.get(account,id)!!.note)
        assertTrue(store.get(account,id)!!.learned)
        val deletion = call("/api/links/$id", "DELETE")
        assertTrue(deletion.first in listOf(200,204))
        assertTrue(LibrarySync.run(context, base, token))
        assertNull(store.get(account,id))
        assertTrue(store.pendingMedia(account).none { it.linkId == id })
        assertTrue(LibrarySync.run(context, base, token))
        assertNull(store.get(account,id))
    }
}
