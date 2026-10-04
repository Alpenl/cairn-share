package com.alpenl.cairn.share

import android.content.Context
import android.content.ContextWrapper
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import okhttp3.mockwebserver.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LocalLibraryInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val imageKey = "enrichment/28/${"a".repeat(64)}.png"
    private fun archive(id: Int, loaded: Boolean = true, revision: Int = 1) = JSONObject("""{"id":$id,"url":"https://example.com/$id","note":"本地备注","created_at":"2020-01-01T00:00:00Z","learned":false,
        "enrichment":{"ai_title":"收藏 $id","summary":"摘要","status":"completed","content_loaded":$loaded,"original_text":"${if (loaded) "只在正文出现的内容" else ""}","updated_at":"2020-01-01",
        "images":[{"key":"$imageKey"}],"classification":{"topics":["llm"]},
        "cache_identity":{"schema_version":1,"representation":"${if (loaded) "enrichment_detail" else "enrichment_summary"}","content_revision":$revision,"personal_revision":0,"body_revision":$revision,"latest_decision_id":1,"latest_entity_revision":0}}}""")
    private fun png(): ByteArray = ByteArrayOutputStream().use { output ->
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); bitmap.recycle(); output.toByteArray()
    }
    private class PrivateContext(base: Context) : ContextWrapper(base) {
        private val directory = File(base.filesDir, "local-library-test-${UUID.randomUUID()}").apply { mkdirs() }
        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = directory
        override fun getDatabasePath(name: String): File = File(directory, name)
        override fun openOrCreateDatabase(name: String, mode: Int, factory: SQLiteDatabase.CursorFactory?): SQLiteDatabase =
            SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name), factory)
        override fun openOrCreateDatabase(name: String, mode: Int, factory: SQLiteDatabase.CursorFactory?, errorHandler: DatabaseErrorHandler?): SQLiteDatabase =
            SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name).path, factory, errorHandler)
    }

    @Test fun jsonMigratesOnceIntoSqliteAndFullLibrarySurvivesRecreation() = runBlocking<Unit> {
        val isolated = PrivateContext(context)
        val account = accountKeyFor("https://migration.invalid", "one")
        val other = accountKeyFor("https://migration.invalid", "two")
        val old = OfflineReadEntry(account, LinkJson.decodeLink(archive(28)), 1, 2, true, listOf(ReaderTag("topic/llm", "LLM")))
        val source = File(isolated.filesDir, "offline-reading-v1.json")
        source.writeText(OfflineReadJson.encode(listOf(old, old.copy(account = other))))
        val store = OfflineReadStore(isolated)
        assertEquals(old, store.snapshot(account).single())
        assertTrue(isolated.getDatabasePath("local-library.db").exists())
        assertFalse(source.exists())
        for (id in 100..160) store.save(account, LinkJson.decodeLink(archive(id)))
        assertEquals(62, OfflineReadStore(isolated).snapshot(account).size)
        val taxonomy = BookmarkTaxonomy(listOf(TaxonomyTerm("portrait", "写真", true, granularity = "specific", navigation = false)), emptyList(), emptyList())
        store.saveTaxonomy(account, taxonomy)
        assertEquals(taxonomy, OfflineReadStore(isolated).taxonomy(account))
        assertNull(store.taxonomy(other))
        store.clear(account)
        assertNull(store.taxonomy(account))
        assertTrue(OfflineReadStore(isolated).catalog(account).isEmpty())
        assertEquals(old.copy(account = other), store.snapshot(other).single())
    }

    @Test fun changedVersionInvalidatesBodyAndDeletedOrEditedRowsRejectLateDownloads() = runBlocking<Unit> {
        val store = OfflineReadStore(PrivateContext(context))
        val account = accountKeyFor("https://versions.invalid", "one")
        val full = LinkJson.decodeLink(archive(28))
        store.save(account, full)
        store.saveCatalog(account, listOf(LinkJson.decodeLink(archive(28, false))))
        assertEquals(full.enrichment!!.originalText, store.snapshot(account).single().link.enrichment!!.originalText)
        val newer = LinkJson.decodeLink(archive(28, false, 2))
        store.saveCatalog(account, listOf(newer))
        assertTrue(store.snapshot(account).isEmpty())
        assertNull(store.saveDownloaded(account, full, full, emptyList()))
        assertEquals(newer, store.get(account, 28))
        store.remove(account, 28)
        assertNull(store.save(account, full))
        store.saveCatalog(account, listOf(newer))
        assertTrue(store.catalog(account).isEmpty())
        val legacy = archive(29).apply { getJSONObject("enrichment").remove("cache_identity") }
        store.saveCatalog(account, listOf(LinkJson.decodeLink(legacy)))
        assertFalse(store.catalog(account).single().enrichment!!.contentLoaded)
        assertTrue(store.snapshot(account).isEmpty())
    }

    @Test fun imagesPersistWithAccountAndVersionIsolationAndClearRejectsInFlightWrites() = runBlocking<Unit> {
        val isolated = PrivateContext(context)
        val store = LocalMediaStore(isolated)
        val account = accountKeyFor("https://images.invalid", "one")
        val other = accountKeyFor("https://images.invalid", "two")
        val bytes = png()
        assertArrayEquals(bytes, store.load(account, imageKey, "1") { bytes })
        assertArrayEquals(bytes, LocalMediaStore(isolated).load(account, imageKey, "1") { error("Must read disk") })
        assertNull(store.load(other, imageKey, "1") { null })
        assertNull(store.load(account, imageKey, "2") { null })
        val started = CountDownLatch(1); val release = CountDownLatch(1)
        val downloading = async(Dispatchers.IO) { store.load(account, imageKey, "2") { started.countDown(); release.await(5, TimeUnit.SECONDS); bytes } }
        assertTrue(started.await(5, TimeUnit.SECONDS))
        store.clear(account); release.countDown()
        assertNull(downloading.await())
        assertNull(store.load(account, imageKey, "2") { null })
        store.remove(account, 28)
        assertNull(store.load(account, imageKey, "1") { error("Deleted images cannot be fetched") })
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val oldRevision = BookmarkImageCache.revision
        BookmarkImageCache.clear(account)
        assertNull(BookmarkImageCache.put(account, imageKey, bitmap, "1", oldRevision))
        bitmap.recycle()
    }

    @Test fun allPagesDownloadAndRestartOfflineSearchReadsStoredBodies() = runBlocking<Unit> {
        val server = MockWebServer(); server.start()
        val base = server.url("/").toString()
        val token = "local-library-${UUID.randomUUID()}"
        val account = accountKeyFor(base, token)
        val offline = AtomicBoolean(false)
        val invalidPage = AtomicBoolean(false)
        val details = AtomicInteger()
        val mediaRequests = AtomicInteger()
        fun json(value: JSONObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(value.toString())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (offline.get()) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START)
                return when (request.requestUrl!!.encodedPath) {
                    "/api/links" -> {
                        val second = request.requestUrl!!.queryParameter("before_id") != null
                        if (invalidPage.get() && second) MockResponse().setResponseCode(503)
                        else json(JSONObject().put("items", JSONArray().put(archive(if (second) 27 else 28, false)))
                            .put("next_before_id", if (second) JSONObject.NULL else 28))
                    }
                    "/api/links/28", "/api/links/27" -> { details.incrementAndGet(); json(archive(request.requestUrl!!.encodedPath.substringAfterLast('/').toInt())) }
                    "/api/images/$imageKey" -> { mediaRequests.incrementAndGet(); MockResponse().setHeader("Content-Type", "image/png").setBody(okio.Buffer().write(png())) }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        val models = ViewModelStore()
        val settings = SharePreferencesStore(context)
        settings.setApiToken(token); settings.setLastFilter("all"); settings.setLastSearchQuery("")
        suspend fun model(): CairnLinksViewModel = withContext(Dispatchers.Main) {
            CairnLinksViewModel(LinksApiClient(base), UpdateApiClient("${base}latest"), settings, PendingUploadStore(context), ApiDebugClient(base),
                V2CurationRepository(V2ClientTransport(V2CurationClient(base))), CurationActionStore(context), base, "${base}latest", "test", 1).also { models.put("local", it) }
        }
        suspend fun await(model: CairnLinksViewModel, predicate: (CairnLinksUiState) -> Boolean) = withTimeout(20_000) {
            while (!withContext(Dispatchers.Main) { predicate(model.uiState) }) delay(25)
        }
        try {
            var vm = model()
            await(vm) { it.preferencesLoaded && !it.loading && it.links.size == 2 }
            withContext(Dispatchers.Main) { vm.downloadLibrary() }
            await(vm) { !it.downloadingLibrary && it.downloadStatus.contains("本次已保存") }
            assertEquals(2, OfflineReadStore(context).snapshot(account).size)
            assertEquals(2, details.get()); assertEquals(1, mediaRequests.get())
            withContext(Dispatchers.Main) { vm.downloadLibrary() }
            await(vm) { !it.downloadingLibrary }
            assertEquals(2, details.get()); assertEquals(1, mediaRequests.get())
            invalidPage.set(true)
            withContext(Dispatchers.Main) { vm.downloadLibrary() }
            await(vm) { !it.downloadingLibrary }
            assertEquals(2, OfflineReadStore(context).snapshot(account).size)
            offline.set(true)
            withContext(Dispatchers.Main) { models.clear() }
            vm = model()
            await(vm) { it.links.size == 2 && !it.loading }
            withContext(Dispatchers.Main) { vm.setSearchQuery("只在正文出现") }
            await(vm) { !it.searchLoading }
            withContext(Dispatchers.Main) {
                assertEquals(2, vm.uiState.searchResults.size)
                assertTrue(vm.uiState.searchStatusText.contains("本地"))
            }
        } finally {
            withContext(Dispatchers.Main) { models.clear() }
            OfflineReadStore(context).clear(account); LocalMediaStore(context).clear(account)
            server.shutdown()
        }
    }
}
