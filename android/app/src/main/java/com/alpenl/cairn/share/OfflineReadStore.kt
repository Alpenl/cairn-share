package com.alpenl.cairn.share

import android.content.Context
import android.util.AtomicFile
import com.alpenl.cairn.share.network.*
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal data class OfflineReadEntry(val account: String, val link: SavedLink, val savedAt: Long, val readAt: Long, val pinned: Boolean, val tagLabels: List<ReaderTag> = emptyList())
internal data class OfflineReadInfo(val savedAt: Long, val pinned: Boolean, val verified: Boolean = false, val tagLabels: List<ReaderTag> = emptyList()) {
    fun expired(now: Long = System.currentTimeMillis()): Boolean = now - savedAt >= 7 * 24 * 60 * 60 * 1000L
}

internal object OfflineReadJson {
    fun encode(rows: List<OfflineReadEntry>): String = JSONArray().also { array -> rows.forEach { row ->
        array.put(JSONObject().put("account", row.account).put("saved_at", row.savedAt).put("read_at", row.readAt).put("pinned", row.pinned).put("link", encodeLink(row.link))
            .put("tag_labels", JSONArray().also { labels -> row.tagLabels.forEach { labels.put(JSONObject().put("ref", it.ref).put("label", it.label)) } }))
    } }.toString()
    fun decode(value: String): List<OfflineReadEntry> {
        val array = JSONArray(value)
        return List(array.length()) { index ->
            val row = array.getJSONObject(index)
            val link = LinkJson.decodeLink(row.getJSONObject("link"))
            val labels = row.optJSONArray("tag_labels")
            val tags = List(labels?.length() ?: 0) { j -> val label = labels!!.getJSONObject(j); ReaderTag(label.getString("ref"), label.getString("label")) }
            require(tags.all { it.ref.isNotBlank() && it.label.isNotBlank() })
            val entry = OfflineReadEntry(row.getString("account"), link, row.getLong("saved_at"), row.getLong("read_at"), row.getBoolean("pinned"), tags)
            require(entry.account.startsWith("v2:") && link.id > 0 && link.enrichment?.contentLoaded == true && link.enrichment.cacheIdentity != null)
            entry
        }
    }
    fun encodeLink(link: SavedLink): JSONObject = JSONObject().put("id", link.id).put("url", link.url).put("note", link.note)
        .put("created_at", link.createdAt).put("learned", link.learned).put("learned_at", link.learnedAt ?: JSONObject.NULL)
        .put("custom_tags", JSONArray().also { array -> link.customTags.forEach { tag -> array.put(JSONObject().put("id", tag.id)
            .put("tag_ref", tag.tagRef).put("label", tag.label).put("revision", tag.revision).put("status", tag.status).put("owner_id", tag.ownerId)) } })
        .apply { link.enrichment?.let { enrichment -> put("enrichment", JSONObject()
            .put("status", enrichment.status).put("source", enrichment.source).put("ai_title", enrichment.aiTitle).put("summary", enrichment.summary)
            .put("original_language", enrichment.originalLanguage).put("original_text", enrichment.originalText).put("translated_text", enrichment.translatedText)
            .put("related_links", JSONArray(enrichment.relatedLinks)).put("images", JSONArray().also { array -> enrichment.imageKeys.forEach { array.put(JSONObject().put("key", it)) } })
            .put("content_loaded", enrichment.contentLoaded).put("why", enrichment.why).put("curation_status", enrichment.curationStatus.apiValue)
            .put("classification_reviewed", enrichment.classificationReviewed).put("entity_state", enrichment.entityState).put("updated_at", enrichment.updatedAt)
            .apply {
                enrichment.classification?.let { c -> put("classification", JSONObject().put("topics", JSONArray(c.topics)).put("resource_kinds", JSONArray(c.resourceKinds))
                    .put("content_functions", JSONArray(c.contentFunctions)).put("carriers", JSONArray(c.carriers)).put("affordances", JSONArray(c.affordances))
                    .put("form", c.form).put("use", c.use).put("why_suggestion", c.whySuggestion).put("entities", JSONArray(c.entities)).put("uncertainty", c.uncertainty)
                    .apply { if (!c.multiDimensional) { remove("content_functions"); remove("carriers"); remove("affordances") } }) }
                enrichment.cacheIdentity?.let { i -> put("cache_identity", JSONObject().put("schema_version", i.schemaVersion).put("representation", i.representation)
                    .put("content_revision", i.contentRevision).put("personal_revision", i.personalRevision).put("body_revision", i.bodyRevision)
                    .put("latest_decision_id", i.latestDecisionId).put("latest_entity_revision", i.latestEntityRevision)) }
            }) } }
}

/** Account-scoped SQLite records. A full body is retained only while its identity matches. */
internal class OfflineReadStore(context: Context) {
    private val app = context.applicationContext
    private val helper = synchronized(HELPERS) {
        HELPERS.getOrPut(app.getDatabasePath("local-library.db").absolutePath) { LibraryDatabase(app) }
    }
    private suspend fun <T> access(block: (android.database.sqlite.SQLiteDatabase) -> T): T = withContext(Dispatchers.IO) {
        LOCK.withLock {
            try {
                val db = helper.writableDatabase
                db.beginTransaction()
                val result = try {
                    migrate(db)
                    val result = block(db)
                    db.setTransactionSuccessful()
                    result
                } finally { db.endTransaction() }
                AtomicFile(File(app.filesDir, "offline-reading-v1.json")).delete()
                result
            } catch (error: android.database.SQLException) { throw IOException("本地资料库读写失败，请检查存储空间。", error) }
        }
    }
    private fun migrate(db: android.database.sqlite.SQLiteDatabase) {
        val done = db.rawQuery("SELECT value FROM metadata WHERE name='json_imported'", null).use { it.moveToFirst() }
        if (done) return
        val file = AtomicFile(File(app.filesDir, "offline-reading-v1.json"))
        if (file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()) {
            val rows = try { OfflineReadJson.decode(file.openRead().bufferedReader().use { it.readText() }) }
                catch (error: Exception) { throw IOException("旧离线资料读取失败，原文件已保留。", error) }
            rows.forEach { write(db, it) }
        }
        db.execSQL("INSERT INTO metadata(name,value) VALUES('json_imported','1')")
        // The source file is removed only after the SQLite transaction commits.
    }
    private fun row(db: android.database.sqlite.SQLiteDatabase, account: String, id: Int): OfflineReadEntry? =
        db.rawQuery("SELECT payload,saved_at,read_at,pinned,labels FROM links WHERE account=? AND id=?", arrayOf(account, id.toString())).use {
            if (it.moveToFirst()) decode(account, it) else null
        }
    private fun decode(account: String, c: android.database.Cursor): OfflineReadEntry {
        val labels = JSONArray(c.getString(4))
        return OfflineReadEntry(account, LinkJson.decodeLink(JSONObject(c.getString(0))), c.getLong(1), c.getLong(2), c.getInt(3) == 1,
            List(labels.length()) { i -> labels.getJSONObject(i).let { ReaderTag(it.getString("ref"), it.getString("label")) } })
    }
    private fun write(db: android.database.sqlite.SQLiteDatabase, entry: OfflineReadEntry) {
        val labels = JSONArray().also { array -> entry.tagLabels.forEach { array.put(JSONObject().put("ref", it.ref).put("label", it.label)) } }
        db.execSQL("INSERT OR REPLACE INTO links(account,id,payload,saved_at,read_at,pinned,labels,has_body) VALUES(?,?,?,?,?,?,?,?)",
            arrayOf(entry.account, entry.link.id, OfflineReadJson.encodeLink(entry.link).toString(), entry.savedAt, entry.readAt,
                if (entry.pinned) 1 else 0, labels.toString(), if (entry.link.enrichment?.contentLoaded == true) 1 else 0))
    }
    private fun SavedLink.cacheable(): SavedLink = if (enrichment?.cacheIdentity != null) this else copy(
        enrichment = enrichment?.copy(originalText = "", translatedText = "", relatedLinks = emptyList(), imageKeys = emptyList(), contentLoaded = false))

    private fun deleted(db: android.database.sqlite.SQLiteDatabase, account: String, id: Int): Boolean =
        db.rawQuery("SELECT 1 FROM deleted WHERE account=? AND id=?", arrayOf(account, id.toString())).use { it.moveToFirst() }
    suspend fun catalog(account: String): List<SavedLink> = access { db ->
        db.rawQuery("SELECT payload FROM links WHERE account=? ORDER BY id DESC", arrayOf(account)).use { c ->
            buildList { while (c.moveToNext()) add(LinkJson.decodeLink(JSONObject(c.getString(0)))) }
        }
    }
    suspend fun get(account: String, id: Int): SavedLink? = access { row(it, account, id)?.link }

    suspend fun taxonomy(account: String): BookmarkTaxonomy? = access { db ->
        db.rawQuery("SELECT value FROM metadata WHERE name=?", arrayOf("taxonomy:$account")).use {
            if (it.moveToFirst()) decodeTaxonomy(JSONObject(it.getString(0)), topicGranularity = true) else null
        }
    }
    suspend fun saveTaxonomy(account: String, taxonomy: BookmarkTaxonomy) = access { db ->
        val json = JSONObject()
        val groups = mapOf("topics" to taxonomy.topics, "forms" to taxonomy.forms, "uses" to taxonomy.uses,
            "resource_kinds" to taxonomy.resourceKinds) + if (taxonomy.multiDimensional) mapOf(
            "content_functions" to taxonomy.contentFunctions, "carriers" to taxonomy.carriers, "affordances" to taxonomy.affordances) else emptyMap()
        for ((key, terms) in groups) json.put(key, JSONArray().also { array -> terms.forEach { term ->
            array.put(JSONObject().put("id", term.id).put("label", term.label).put("active", term.active)
                .put("deprecated", term.deprecated).put("description", term.description).put("aliases", JSONArray(term.aliases))
                .put("granularity", term.granularity).put("navigation", term.navigation))
        } })
        db.execSQL("INSERT OR REPLACE INTO metadata(name,value) VALUES(?,?)", arrayOf("taxonomy:$account", json.toString()))
    }

    /** Compare and commit together: a late download cannot undo a confirmed edit. */
    suspend fun saveDownloaded(account: String, link: SavedLink, expected: SavedLink?, labels: List<ReaderTag>): OfflineReadEntry? = access { db ->
        require(account.startsWith("v2:"))
        val old = row(db, account, link.id)
        if (old?.link != expected || deleted(db, account, link.id)) return@access null
        val now = System.currentTimeMillis()
        val full = link.enrichment?.contentLoaded == true && link.enrichment.cacheIdentity != null
        val entry = OfflineReadEntry(account, link.cacheable(), if (full) now else 0, old?.readAt ?: now, old?.pinned ?: false, labels)
        write(db, entry)
        entry.takeIf { full }
    }
    suspend fun snapshot(account: String): List<OfflineReadEntry> = access { db ->
        db.rawQuery("SELECT payload,saved_at,read_at,pinned,labels FROM links WHERE account=? AND has_body=1 ORDER BY read_at DESC,id DESC", arrayOf(account)).use { c ->
            buildList { while (c.moveToNext()) add(decode(account, c)) }
        }
    }
    suspend fun saveCatalog(account: String, links: List<SavedLink>) = access { db ->
        require(account.startsWith("v2:"))
        for (link in links) {
            if (deleted(db, account, link.id)) continue
            val old = row(db, account, link.id)
            val merged = link.retainLoadedContent(old?.link).cacheable()
            if (merged == old?.link) continue
            write(db, OfflineReadEntry(account, merged, old?.savedAt ?: 0, old?.readAt ?: 0, old?.pinned ?: false,
                // Labels belong to the observed classification, not to a future revision.
                if (old != null && old.link.enrichment?.cacheIdentity == merged.enrichment?.cacheIdentity) old.tagLabels else emptyList()))
        }
    }
    suspend fun touch(account: String, id: Int, expected: SavedLink? = null, now: Long = System.currentTimeMillis()): Boolean = access { db ->
        val old = row(db, account, id) ?: return@access false
        if (expected != null && old.link != expected) return@access false
        db.execSQL("UPDATE links SET read_at=? WHERE account=? AND id=?", arrayOf(now, account, id)); true
    }
    suspend fun save(account: String, link: SavedLink, pinned: Boolean? = null, now: Long = System.currentTimeMillis(), labels: List<ReaderTag>? = null): OfflineReadEntry? = access { db ->
        if (!account.startsWith("v2:") || link.enrichment?.contentLoaded != true || link.enrichment.cacheIdentity == null || deleted(db, account, link.id)) return@access null
        val old = row(db, account, link.id)
        val entry = OfflineReadEntry(account, link, now, now, pinned ?: old?.pinned ?: false, labels ?: old?.tagLabels.orEmpty())
        write(db, entry); entry
    }
    suspend fun setPinned(account: String, id: Int, pinned: Boolean) = access { db ->
        val old = row(db, account, id) ?: throw IOException("请先读取正文再固定。")
        write(db, old.copy(pinned = pinned))
    }
    suspend fun remove(account: String, id: Int) = access { db ->
        db.execSQL("INSERT OR IGNORE INTO deleted(account,id) VALUES(?,?)", arrayOf(account, id))
        db.delete("links", "account=? AND id=?", arrayOf(account, id.toString()))
    }
    suspend fun clear(account: String) = access { db ->
        db.delete("links", "account=?", arrayOf(account))
        db.delete("metadata", "name=?", arrayOf("taxonomy:$account"))
    }
    private class LibraryDatabase(context: Context) : android.database.sqlite.SQLiteOpenHelper(context, "local-library.db", null, 1) {
        init { setWriteAheadLoggingEnabled(true) }
        override fun onCreate(db: android.database.sqlite.SQLiteDatabase) {
            db.execSQL("CREATE TABLE links(account TEXT NOT NULL,id INTEGER NOT NULL,payload TEXT NOT NULL,saved_at INTEGER NOT NULL,read_at INTEGER NOT NULL,pinned INTEGER NOT NULL,labels TEXT NOT NULL,has_body INTEGER NOT NULL,PRIMARY KEY(account,id))")
            db.execSQL("CREATE INDEX links_offline ON links(account,has_body,read_at)")
            db.execSQL("CREATE TABLE deleted(account TEXT NOT NULL,id INTEGER NOT NULL,PRIMARY KEY(account,id))")
            db.execSQL("CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL)")
        }
        override fun onUpgrade(db: android.database.sqlite.SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            throw android.database.SQLException("Unsupported local library upgrade")
        }
    }
    private companion object { val LOCK = Mutex(); val HELPERS = mutableMapOf<String, LibraryDatabase>() }
}
