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
                    .put("form", c.form).put("use", c.use).put("why_suggestion", c.whySuggestion).put("entities", JSONArray(c.entities)).put("uncertainty", c.uncertainty)) }
                enrichment.cacheIdentity?.let { i -> put("cache_identity", JSONObject().put("schema_version", i.schemaVersion).put("representation", i.representation)
                    .put("content_revision", i.contentRevision).put("personal_revision", i.personalRevision).put("body_revision", i.bodyRevision)
                    .put("latest_decision_id", i.latestDecisionId).put("latest_entity_revision", i.latestEntityRevision)) }
            }) } }
}

/** Private, bounded snapshots. Pins are local and never mutate the server's curation. */
internal class OfflineReadStore(context: Context) {
    private val file = AtomicFile(File(context.applicationContext.filesDir, "offline-reading-v1.json"))
    private suspend fun <T> access(block: (MutableList<OfflineReadEntry>) -> T): T = withContext(Dispatchers.IO) {
        LOCK.withLock {
            val rows = if (file.baseFile.exists()) try { OfflineReadJson.decode(file.openRead().bufferedReader().use { it.readText() }).toMutableList() }
                catch (error: Exception) { throw IOException("Cannot read offline library", error) } else mutableListOf()
            block(rows)
        }
    }
    suspend fun snapshot(account: String): List<OfflineReadEntry> = access { rows -> rows.filter { it.account == account }.sortedByDescending { it.readAt } }
    suspend fun touch(account: String, id: Int, expected: SavedLink? = null, now: Long = System.currentTimeMillis()): Boolean = access { rows ->
        val entry = rows.firstOrNull { it.account == account && it.link.id == id } ?: return@access false
        if (expected != null && entry.link != expected) return@access false
        rows[rows.indexOf(entry)] = entry.copy(readAt = now); write(rows); true
    }
    suspend fun save(account: String, link: SavedLink, pinned: Boolean? = null, now: Long = System.currentTimeMillis(), labels: List<ReaderTag>? = null): OfflineReadEntry? = access { rows ->
        if (!account.startsWith("v2:") || link.enrichment?.contentLoaded != true || link.enrichment.cacheIdentity == null) return@access null
        val previous = rows.firstOrNull { it.account == account && it.link.id == link.id }
        val pin = pinned ?: previous?.pinned ?: false
        if (pin && previous?.pinned != true && rows.count { it.pinned } >= MAX_PINS) throw IOException("最多固定 $MAX_PINS 条离线收藏，请先取消一条固定。")
        val next = OfflineReadEntry(account, link, now, now, pin, labels ?: previous?.tagLabels.orEmpty())
        if (OfflineReadJson.encode(listOf(next)).toByteArray(Charsets.UTF_8).size > MAX_ENTRY_BYTES) throw IOException("这篇正文超过离线缓存上限，仍可在线阅读。")
        rows.removeAll { it.account == account && it.link.id == link.id }; rows += next
        val recent = rows.filterNot { it.pinned }.sortedByDescending { it.readAt }.take(MAX_RECENT).toSet()
        rows.removeAll { !it.pinned && it !in recent }
        while (OfflineReadJson.encode(rows).toByteArray(Charsets.UTF_8).size > MAX_BYTES) {
            val oldest = rows.filterNot { it.pinned }.minByOrNull { it.readAt }
                ?: throw IOException("离线固定内容已占满缓存，请先取消一条固定。")
            rows.remove(oldest)
        }
        write(rows)
        next.takeIf { it in rows }
    }
    suspend fun setPinned(account: String, id: Int, pinned: Boolean) = access { rows ->
        val entry = rows.firstOrNull { it.account == account && it.link.id == id } ?: throw IOException("请先成功读取正文再固定。")
        if (pinned && !entry.pinned && rows.count { it.pinned } >= MAX_PINS) throw IOException("最多固定 $MAX_PINS 条离线收藏。")
        rows[rows.indexOf(entry)] = entry.copy(pinned = pinned)
        val recent = rows.filterNot { it.pinned }.sortedByDescending { it.readAt }.take(MAX_RECENT).toSet()
        rows.removeAll { !it.pinned && it !in recent }
        write(rows)
    }
    suspend fun remove(account: String, id: Int) = access { rows -> rows.removeAll { it.account == account && it.link.id == id }; write(rows) }
    suspend fun clear(account: String) = access { rows -> rows.removeAll { it.account == account }; write(rows) }
    private fun write(rows: List<OfflineReadEntry>) {
        val output = file.startWrite()
        try { output.write(OfflineReadJson.encode(rows).toByteArray(Charsets.UTF_8)); file.finishWrite(output) }
        catch (error: Exception) { file.failWrite(output); throw IOException("Cannot save offline library", error) }
    }
    private companion object { val LOCK = Mutex(); const val MAX_PINS = 20; const val MAX_RECENT = 30; const val MAX_BYTES = 16 * 1024 * 1024; const val MAX_ENTRY_BYTES = 2 * 1024 * 1024 }
}
