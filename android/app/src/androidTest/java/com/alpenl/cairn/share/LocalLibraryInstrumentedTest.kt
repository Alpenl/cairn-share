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
import kotlinx.coroutines.flow.first
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

    @Test fun syncCursorContentAndMediaCommitTogetherRejectLateResponsesAndResumeReset() = runBlocking<Unit> {
        val isolated = PrivateContext(context)
        val store = OfflineReadStore(isolated)
        val account = accountKeyFor("https://sync.invalid", "one")
        val full = LinkJson.decodeLink(archive(28))
        val taxonomy = BookmarkTaxonomy(listOf(TaxonomyTerm("llm", "语言模型", true)), emptyList(), emptyList())
        val media = SyncMedia(28, imageKey, "etag-one", 12, true)
        fun page(cursor: String, snapshot: Boolean, more: Boolean, items: List<SavedLink> = listOf(full), deleted: List<Int> = emptyList()) =
            LibrarySyncPage(cursor, "epoch", snapshot, more, items, deleted, if(items.isEmpty()) emptyList() else listOf(media), taxonomy)
        val empty = store.syncState(account)
        assertTrue(store.applySyncPage(account, empty, page("baseline", true, true)))
        assertEquals("baseline", OfflineReadStore(isolated).syncState(account).cursor)
        assertEquals(listOf(media), OfflineReadStore(isolated).pendingMedia(account))
        assertEquals(taxonomy, store.taxonomy(account))
        assertFalse(store.applySyncPage(account, empty, page("late", true, true)))
        val old = store.syncState(account)
        store.saveCatalog(account, listOf(full.copy(note = "刚确认的编辑")))
        assertFalse(store.applySyncPage(account, old, page("stale", false, false)))
        assertEquals("刚确认的编辑", store.get(account, 28)!!.note)
        assertTrue(store.applySyncPage(account, store.syncState(account), page("done", false, false)))
        store.mediaSaved(account, media.copy(version = "wrong"))
        assertEquals(1, store.pendingMedia(account).size)
        store.mediaSaved(account, media)
        assertTrue(store.pendingMedia(account).isEmpty())
        val beforeDelete = store.syncState(account)
        assertTrue(store.applySyncPage(account, beforeDelete, page("deleted", false, false, emptyList(), listOf(28))))
        assertTrue(store.catalog(account).isEmpty())
        assertFalse(store.applySyncPage(account, beforeDelete, page("late-delete", false, false)))
        assertNull(store.saveDownloaded(account, full, null, emptyList()))
        // Expired cursors retain the old catalog until baseline AND replay finish.
        store.saveCatalog(account, listOf(full.copy(id = 29)))
        store.resetSync(account)
        assertTrue(store.applySyncPage(account, store.syncState(account), page("reset-start", true, true, emptyList())))
        assertNotNull(store.get(account, 29))
        assertTrue(store.applySyncPage(account, store.syncState(account), page("reset-done", false, false, emptyList())))
        assertTrue(store.catalog(account).isEmpty())
        assertTrue(store.pendingMedia(account).isEmpty())
        assertNull(store.syncState(accountKeyFor("https://sync.invalid", "other")).cursor)
    }

    @Test fun quotaFailureKeepsCursorAndPreviouslyCommittedContent() = runBlocking<Unit> {
        val isolated = PrivateContext(context)
        val store = OfflineReadStore(isolated)
        val account = accountKeyFor("https://quota.invalid", "one")
        val full = LinkJson.decodeLink(archive(28))
        store.save(account, full)
        val before = store.syncState(account)
        val accountDir = java.security.MessageDigest.getInstance("SHA-256").digest(account.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        val big = File(isolated.filesDir, "library-images/$accountDir/28/space-test").apply { parentFile!!.mkdirs() }
        try {
            java.io.RandomAccessFile(big, "rw").use { it.setLength(3L * 1024 * 1024 * 1024) }
            try {
                store.applySyncPage(account, before, LibrarySyncPage("blocked", "epoch", true, true, listOf(full.copy(id=29)), emptyList(), emptyList(), null))
                fail("quota must stop the page")
            } catch (_: java.io.IOException) { }
            assertEquals(before, store.syncState(account))
            assertEquals(listOf(28), store.catalog(account).map { it.id })
        } finally { big.delete() }
    }

    @Test fun incrementalEngineResumesMediaReusesVersionsAndAppliesRemoteDeletes() = runBlocking<Unit> {
        val isolated = PrivateContext(context)
        val server = MockWebServer(); server.start()
        val base = server.url("/").toString()
        val token = "engine-${UUID.randomUUID()}"
        val account = accountKeyFor(base, token)
        val settings = SharePreferencesStore(isolated)
        val original = settings.preferences.first()
        settings.setApiToken(token); settings.setImagesWifiOnly(false); settings.setAutomaticSync(false)
        val stage = AtomicInteger(0); val images = AtomicInteger(0)
        val bytes = png()
        val cursors = mutableListOf<String?>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl!!.encodedPath.startsWith("/api/images/")) {
                    images.incrementAndGet()
                    if (stage.get() == 0) return MockResponse().setResponseCode(503)
                    assertEquals("\"v${stage.get()}\"", request.getHeader("If-Match"))
                    return MockResponse().setHeader("Content-Type", "image/png").setBody(okio.Buffer().write(bytes))
                }
                if (request.requestUrl!!.encodedPath != "/api/sync") return MockResponse().setResponseCode(404)
                val cursor = request.requestUrl!!.queryParameter("cursor"); synchronized(cursors) { cursors.add(cursor) }
                val initial = cursor == null
                val deleted = stage.get() == 3
                val version = "v${stage.get().coerceAtLeast(1)}"
                val json = JSONObject().put("protocol_version", 1).put("epoch", "engine")
                    .put("cursor", if(initial) "baseline" else "c${stage.get()}").put("mode", if(initial) "snapshot" else "changes")
                    .put("has_more", initial).put("taxonomy", JSONObject.NULL)
                    .put("items", JSONArray().apply { if(!deleted) put(archive(28, revision=stage.get()+1)) })
                    .put("deleted", JSONArray().apply { if(deleted) put(28) })
                    .put("media", JSONArray().apply { if(!deleted) put(JSONObject().put("link_id",28).put("key",imageKey)
                        .put("version",version).put("bytes",bytes.size).put("available",true)) })
                return MockResponse().setHeader("X-Cairn-Sync", "1").setHeader("Content-Type","application/json").setBody(json.toString())
            }
        }
        try {
            assertTrue(LibrarySync.run(isolated, base, token))
            val store = OfflineReadStore(isolated)
            assertEquals(1, store.catalog(account).size)
            assertEquals(1, store.pendingMedia(account).size)
            assertEquals("c0", store.syncState(account).cursor)
            stage.set(1)
            assertTrue(LibrarySync.run(isolated, base, token))
            assertTrue(store.pendingMedia(account).isEmpty())
            val requests = images.get()
            assertTrue(LibrarySync.run(isolated, base, token))
            assertEquals(requests, images.get()) // Unchanged media never redownloads.
            stage.set(2)
            assertTrue(LibrarySync.run(isolated, base, token))
            assertEquals(requests + 1, images.get())
            assertEquals("v2", store.get(account,28)!!.enrichment!!.imageVersions[imageKey])
            stage.set(3)
            assertTrue(LibrarySync.run(isolated, base, token))
            assertTrue(store.catalog(account).isEmpty())
            assertTrue(store.pendingMedia(account).isEmpty())
            assertNull(LocalMediaStore(isolated).load(account,imageKey,"v2") { error("Deleted") })
            assertEquals(listOf(null,"baseline","c0","c1","c1","c2"), synchronized(cursors) { cursors.toList() })
            // Exercise actual on-demand WorkManager initialization and its persisted worker.
            settings.setAutomaticSync(true)
            LibrarySync.schedule(context, base, token, true)
            val manager = androidx.work.WorkManager.getInstance(context)
            withTimeout(30_000) {
                while (withContext(Dispatchers.IO) { manager.getWorkInfosForUniqueWork("library:$account:now").get() }
                    .none { it.state == androidx.work.WorkInfo.State.SUCCEEDED }) delay(100)
            }
            LibrarySync.schedule(context, base, token, false)
        } finally {
            LibrarySync.schedule(context, base, token, false)
            server.shutdown(); settings.setApiToken(original.apiToken); settings.setImagesWifiOnly(original.imagesWifiOnly); settings.setAutomaticSync(original.automaticSync)
        }
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
