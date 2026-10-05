package com.alpenl.cairn.share

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal data class CollectionRecord(val id: String, val name: String, val description: String = "", val pinned: Boolean = false,
    val archived: Boolean = false, val deleted: Boolean = false, val revision: Long = 0) {
    fun json(): JSONObject = JSONObject().put("id", id).put("name", name).put("description", description).put("pinned", if(pinned) 1 else 0)
        .put("archived", if(archived) 1 else 0).put("deleted", if(deleted) 1 else 0).put("revision", revision)
    companion object { fun decode(j: JSONObject) = CollectionRecord(j.getString("id"), j.getString("name"), j.optString("description"),
        j.optInt("pinned") == 1, j.optInt("archived") == 1, j.optInt("deleted") == 1, j.getLong("revision")) }
}
internal data class CollectionMember(val collection: String, val link: Int, val position: Int, val note: String = "") {
    fun json(): JSONObject = JSONObject().put("collection_id", collection).put("link_id", link).put("position", position).put("note", note)
    companion object { fun decode(j: JSONObject) = CollectionMember(j.getString("collection_id"), j.getInt("link_id"), j.getInt("position"), j.optString("note")) }
}
internal data class CollectionPending(val id: String, val collection: String, val body: String, val error: String = "")
internal data class CollectionState(val collections: List<CollectionRecord> = emptyList(), val members: List<CollectionMember> = emptyList(),
    val pending: List<CollectionPending> = emptyList(), val cursor: Long = 0, val epoch: String = "", val message: String = "")

/** Pure optimistic projection: pending intent never overwrites the server snapshot. */
internal fun applyCollectionIntent(state: CollectionState, collection: String, body: JSONObject): CollectionState {
    val type = body.getString("type")
    val old = state.collections.find { it.id == collection }
    if (old?.deleted == true && type != "restore") return state
    if (old == null && type != "create") return state
    var record = old ?: CollectionRecord(collection, body.getString("name"), body.optString("description"))
    var members = state.members.toMutableList()
    when (type) {
        "edit" -> record = record.copy(name = if(body.has("name")) body.getString("name") else record.name,
            description = if(body.has("description")) body.getString("description") else record.description,
            pinned = if(body.has("pinned")) body.getBoolean("pinned") else record.pinned,
            archived = if(body.has("archived")) body.getBoolean("archived") else record.archived)
        "delete" -> record = record.copy(deleted = true)
        "restore" -> record = record.copy(deleted = false)
        "add", "remove" -> {
            val ids = body.getJSONArray("link_ids").let { a -> List(a.length()) { a.getInt(it) } }
            if(type == "remove") members.removeAll { it.collection == collection && it.link in ids }
            else for(id in ids) if(members.none { it.collection == collection && it.link == id }) members.add(CollectionMember(collection, id, (members.filter { it.collection == collection }.maxOfOrNull { it.position } ?: -1) + 1))
        }
        "note" -> members = members.map { if(it.collection == collection && it.link == body.getInt("link_id")) it.copy(note = body.getString("note")) else it }.toMutableList()
        "move" -> {
            val ordered = members.filter { it.collection == collection }.sortedBy { it.position }.toMutableList()
            val moving = ordered.find { it.link == body.getInt("link_id") }
            if(moving != null) {
                ordered.remove(moving)
                val index = if(body.isNull("before_id")) ordered.size else ordered.indexOfFirst { it.link == body.getInt("before_id") }.let { if(it < 0) ordered.size else it }
                ordered.add(index, moving)
                members.removeAll { it.collection == collection }
                members.addAll(ordered.mapIndexed { i, item -> item.copy(position = i) })
            }
        }
    }
    record = record.copy(revision = record.revision + 1)
    return state.copy(collections = state.collections.filterNot { it.id == collection } + record, members = members)
}

internal class CollectionStore(context: Context) {
    private val app = context.applicationContext
    private suspend fun <T> access(block: (SQLiteDatabase) -> T): T = withContext(Dispatchers.IO) { lock.withLock {
        val db = synchronized(helpers) { helpers.getOrPut(app.getDatabasePath("collections.db").path) { Database(app) } }.writableDatabase
        db.beginTransaction()
        try { val result = block(db); db.setTransactionSuccessful(); result }
        catch (e: android.database.SQLException) { throw IOException("合集无法保存到本机，请检查可用空间。", e) }
        finally { db.endTransaction() }
    } }
    private fun read(db: SQLiteDatabase, account: String): CollectionState {
        val definitions = db.rawQuery("SELECT payload FROM collection_defs WHERE account=?", arrayOf(account)).use { c -> buildList { while(c.moveToNext()) add(CollectionRecord.decode(JSONObject(c.getString(0)))) } }
        val members = db.rawQuery("SELECT payload FROM collection_members WHERE account=?", arrayOf(account)).use { c -> buildList { while(c.moveToNext()) add(CollectionMember.decode(JSONObject(c.getString(0)))) } }
        val pending = db.rawQuery("SELECT id,collection_id,body,error FROM collection_pending WHERE account=? ORDER BY seq", arrayOf(account)).use { c -> buildList { while(c.moveToNext()) add(CollectionPending(c.getString(0),c.getString(1),c.getString(2),c.getString(3))) } }
        val metadata = db.rawQuery("SELECT cursor,epoch,message FROM collection_sync WHERE account=?", arrayOf(account)).use { c -> if(c.moveToFirst()) Triple(c.getLong(0),c.getString(1),c.getString(2)) else Triple(0L,"","") }
        return CollectionState(definitions,members,pending,metadata.first,metadata.second,metadata.third)
    }
    private fun projected(state: CollectionState): CollectionState = state.pending.fold(state) { current, p -> applyCollectionIntent(current,p.collection,JSONObject(p.body)) }
    suspend fun snapshot(account: String): CollectionState = access { projected(read(it,account)) }
    suspend fun remote(account: String): CollectionState = access { read(it,account) }
    suspend fun enqueue(account: String, collection: String, type: String, fields: JSONObject = JSONObject(), operationKey: String = UUID.randomUUID().toString()) {
        access { db ->
            require(account.startsWith("v2:"))
            val exists = db.rawQuery("SELECT id FROM collection_pending WHERE account=? AND id=? UNION SELECT id FROM collection_done WHERE account=? AND id=?", arrayOf(account,operationKey,account,operationKey)).use { it.moveToFirst() }
            if(exists) return@access
            val state = projected(read(db,account)); val current = state.collections.find { it.id == collection }
            if(state.pending.size >= 500) throw IOException("待同步修改较多，请先联网同步。")
            if(type != "create" && current == null) throw IOException("合集尚未同步到本机，请先刷新。")
            if(current?.deleted == true && type != "restore") throw IOException("合集已删除，请先恢复。")
            val body = JSONObject(fields.toString()).put("type",type).put("expected_revision",current?.revision ?: 0).put("operation_key",operationKey)
            db.execSQL("INSERT INTO collection_pending(account,id,collection_id,body) VALUES(?,?,?,?)", arrayOf(account,operationKey,collection,body.toString()))
        }; updates.tryEmit(account)
    }
    private fun writeRecord(db: SQLiteDatabase, account: String, record: CollectionRecord) { db.execSQL("INSERT OR REPLACE INTO collection_defs(account,id,payload) VALUES(?,?,?)",arrayOf(account,record.id,record.json().toString())) }
    private fun writeMember(db: SQLiteDatabase, account: String, member: CollectionMember) { db.execSQL("INSERT OR REPLACE INTO collection_members(account,collection_id,link_id,payload) VALUES(?,?,?,?)",arrayOf(account,member.collection,member.link,member.json().toString())) }
    suspend fun applyPage(account: String, expected: CollectionState, page: JSONObject): Boolean = access { db ->
        val current = read(db,account)
        if(current.cursor != expected.cursor || current.epoch != expected.epoch) return@access false
        require(page.getInt("protocol_version") == 1)
        val epoch = page.getString("epoch"); val cursor = page.getLong("cursor")
        require(epoch.isNotBlank() && cursor >= current.cursor && (current.epoch.isEmpty() || current.epoch == epoch))
        val changes = page.getJSONArray("changes")
        require(changes.length() <= 200)
        var previous = expected.cursor
        for(i in 0 until changes.length()) {
            val event = changes.getJSONObject(i); val cid = event.getString("collection_id")
            require(event.getLong("seq") > previous && event.getLong("seq") <= cursor)
            previous = event.getLong("seq")
            if(event.isNull("link_id")) {
                if(event.isNull("value")) db.delete("collection_defs","account=? AND id=?",arrayOf(account,cid))
                else { val record=CollectionRecord.decode(event.getJSONObject("value")); require(record.id==cid && record.revision>0); writeRecord(db,account,record) }
            } else {
                val id = event.getInt("link_id")
                if(event.isNull("value")) db.delete("collection_members","account=? AND collection_id=? AND link_id=?",arrayOf(account,cid,id.toString()))
                else { val member=CollectionMember.decode(event.getJSONObject("value")); require(member.collection==cid && member.link==id && id>0 && member.position>=0); writeMember(db,account,member) }
            }
        }
        require(previous == cursor)
        db.execSQL("INSERT OR REPLACE INTO collection_sync(account,cursor,epoch,message) VALUES(?,?,?,'')",arrayOf(account,cursor,epoch)); true
    }
    suspend fun reset(account: String) { access { db ->
        db.delete("collection_defs","account=?",arrayOf(account));db.delete("collection_members","account=?",arrayOf(account));db.delete("collection_sync","account=?",arrayOf(account))
        db.execSQL("UPDATE collection_pending SET error='资料库已恢复，请核对最新内容后重试' WHERE account=?",arrayOf(account))
    }; updates.tryEmit(account) }
    suspend fun acknowledge(account: String, operation: CollectionPending, response: JSONObject) { access { db ->
        val state = read(db,account)
        if(state.pending.none { it.id == operation.id }) return@access
        val applied = response.getLong("revision")
        if((state.collections.find { it.id == operation.collection }?.revision ?: 0) < applied) {
            val next = applyCollectionIntent(state,operation.collection,JSONObject(operation.body))
            next.collections.find { it.id == operation.collection }?.let { writeRecord(db,account,it.copy(revision=applied)) }
            db.delete("collection_members","account=? AND collection_id=?",arrayOf(account,operation.collection))
            next.members.filter { it.collection == operation.collection }.forEach { writeMember(db,account,it) }
        }
        db.delete("collection_pending","account=? AND id=?",arrayOf(account,operation.id))
        db.execSQL("INSERT OR IGNORE INTO collection_done(account,id) VALUES(?,?)",arrayOf(account,operation.id))
    }; updates.tryEmit(account) }
    suspend fun fail(account: String, id: String, message: String) { access { it.execSQL("UPDATE collection_pending SET error=? WHERE account=? AND id=?",arrayOf(message,account,id)) };updates.tryEmit(account) }
    suspend fun message(account: String, message: String) { access { db ->
        // Android 8 ships SQLite before UPSERT support.
        db.execSQL("INSERT OR IGNORE INTO collection_sync(account,cursor,epoch,message) VALUES(?,0,'','')",arrayOf(account))
        db.execSQL("UPDATE collection_sync SET message=? WHERE account=?",arrayOf(message,account))
    };updates.tryEmit(account) }
    // Only a known rejected write can be discarded/rebased. Ambiguous network failures retain their receipt key.
    suspend fun resolve(account: String, operation: CollectionPending, retry: Boolean) { access { db ->
        val state = read(db,account); val pending = state.pending.find { it.id == operation.id } ?: return@access
        require(pending.error.isNotBlank())
        if(!retry) db.delete("collection_pending","account=? AND id=?",arrayOf(account,pending.id))
        var revision = state.collections.find { it.id == operation.collection }?.revision ?: 0
        for(p in state.pending.filter { it.collection == operation.collection && (retry || it.id != operation.id) }) {
            val body = JSONObject(p.body).put("expected_revision",revision++).put("operation_key",UUID.randomUUID().toString())
            db.execSQL("UPDATE collection_pending SET id=?,body=?,error='' WHERE account=? AND id=?",arrayOf(body.getString("operation_key"),body.toString(),account,p.id))
        }
    };updates.tryEmit(account) }
    private class Database(context: Context) : SQLiteOpenHelper(context,"collections.db",null,1) {
        init { setWriteAheadLoggingEnabled(true) }
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE collection_defs(account TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,id))")
            db.execSQL("CREATE TABLE collection_members(account TEXT NOT NULL,collection_id TEXT NOT NULL,link_id INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,collection_id,link_id))")
            db.execSQL("CREATE TABLE collection_pending(seq INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,id TEXT NOT NULL,collection_id TEXT NOT NULL,body TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',UNIQUE(account,id))")
            db.execSQL("CREATE TABLE collection_done(account TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(account,id))")
            db.execSQL("CREATE TABLE collection_sync(account TEXT PRIMARY KEY,cursor INTEGER NOT NULL,epoch TEXT NOT NULL,message TEXT NOT NULL)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }
    companion object { private val lock=Mutex();private val helpers=mutableMapOf<String,Database>();val updates=MutableSharedFlow<String>(extraBufferCapacity=32) }
}
