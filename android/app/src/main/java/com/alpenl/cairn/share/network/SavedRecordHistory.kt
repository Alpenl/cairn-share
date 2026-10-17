package com.alpenl.cairn.share.network

import java.net.URLEncoder
import org.json.JSONException
import org.json.JSONObject

internal enum class SavedRecordKind(val path: String, val label: String) {
    Sources("sources", "来源快照"), Entities("entities", "实体结果"),
    Overrides("overrides", "标签决定"), Events("events", "操作事件"),
}
internal data class SavedRecordScope(val kind: SavedRecordKind, val sourceRevision: Long? = null)
internal data class SavedRecordSummary(val key: String, val createdAt: String?, val fields: List<Pair<String, String?>>)
internal data class SavedRecordPage(val rows: List<SavedRecordSummary>, val nextAfter: String?)
internal data class SavedRecord(val summary: SavedRecordSummary, val exportJson: String)
private const val MAX_ID = 9_007_199_254_740_991L
private fun numericKey(value: String) = value.toLongOrNull()?.let { it in 1..MAX_ID && it.toString() == value } == true
private fun validKey(scope: SavedRecordScope, key: String) = if (scope.kind == SavedRecordKind.Entities)
    key.isNotBlank() && key.length <= 200 else numericKey(key)

private fun JSONObject.envelope(id: Int, scope: SavedRecordScope): Boolean {
    if (nonnegativeRevision("version") != 1L) return false
    if (!has("source_revision")) throw JSONException("missing saved source scope")
    val source = if (isNull("source_revision")) null else nonnegativeRevision("source_revision")
        ?.takeIf { it in 1..MAX_ID } ?: throw JSONException("invalid saved source scope")
    if (nonnegativeRevision("bookmark_id") != id.toLong() || opt("kind") != scope.kind.path ||
        source != scope.sourceRevision)
        throw JSONException("wrong saved record scope")
    return true
}
private fun JSONObject.savedSummary(scope: SavedRecordScope): SavedRecordSummary {
    val key = opt("key") as? String ?: throw JSONException("missing record key")
    if (!validKey(scope, key)) throw JSONException("invalid record key")
    val created = opt("created_at").let {
        if (it == null || it === JSONObject.NULL) null else it as? String ?: throw JSONException("invalid record time")
    }
    // Keep wire values here; labels belong to the renderer. Unknown and
    // unconfirmed legacy values must never acquire a human confirmation.
    val names = listOf("content_revision", "snapshot_id", "completeness", "truncated", "state", "outcome", "applied",
        "field", "action", "source", "confirmed", "revision")
    return SavedRecordSummary(key, created, names.filter { has(it) }.map { field ->
        val value = opt(field)
        field to if (value == null || value === JSONObject.NULL) null else when (value) {
            is String, is Number, is Boolean -> value.toString()
            else -> throw JSONException("invalid record metadata")
        }
    })
}
private fun advances(scope: SavedRecordScope, value: String, previous: String): Boolean {
    if (scope.kind != SavedRecordKind.Entities) return value.toLong() < previous.toLong()
    // SQLite BINARY order is UTF-8 byte order, unlike JVM UTF-16 comparison.
    val a = value.toByteArray(Charsets.UTF_8); val b = previous.toByteArray(Charsets.UTF_8)
    for (i in 0 until minOf(a.size, b.size)) {
        val delta = (a[i].toInt() and 255) - (b[i].toInt() and 255)
        if (delta != 0) return delta < 0
    }
    return a.size < b.size
}
internal fun decodeSavedRecordPage(json: JSONObject, id: Int, scope: SavedRecordScope, after: String?): RunHistoryResult<SavedRecordPage> {
    if (!json.envelope(id, scope)) return RunHistoryResult.Unsupported
    val rows = json.getJSONArray("records")
    if (rows.length() > 50) throw JSONException("unbounded saved records")
    var previous = after
    val values = (0 until rows.length()).map { index ->
        val row = rows.getJSONObject(index)
        for (field in listOf("payload", "term", "operation_key", "request_hash", "payload_hash"))
            if (row.has(field)) throw JSONException("payload in saved record page")
        val value = row.savedSummary(scope)
        if (previous != null && !advances(scope, value.key, previous!!)) throw JSONException("record cursor did not advance")
        previous = value.key
        value
    }
    if (!json.has("next_after")) throw JSONException("missing saved cursor")
    val next = if (json.isNull("next_after")) null else (json.opt("next_after") as? String)
        ?.takeIf { values.isNotEmpty() && it == values.last().key } ?: throw JSONException("invalid saved cursor")
    return RunHistoryResult.Loaded(SavedRecordPage(values, next))
}
internal fun decodeSavedRecord(json: JSONObject, id: Int, scope: SavedRecordScope, key: String): RunHistoryResult<SavedRecord> {
    if (!json.envelope(id, scope)) return RunHistoryResult.Unsupported
    val row = json.getJSONObject("record")
    if (scope.kind != SavedRecordKind.Overrides && !row.has("payload")) throw JSONException("missing saved payload")
    val summary = row.savedSummary(scope)
    if (summary.key != key) throw JSONException("wrong saved record")
    return RunHistoryResult.Loaded(SavedRecord(summary, json.toString()))
}
private fun savedPath(id: Int, scope: SavedRecordScope, parameter: String, value: String?): String {
    val query = mutableListOf<String>()
    scope.sourceRevision?.let { query += "source_revision=$it" }
    value?.let { query += "$parameter=${URLEncoder.encode(it, "UTF-8")}" }
    return "/api/bookmarks/$id/saved-records/${scope.kind.path}" + if (query.isEmpty()) "" else "?${query.joinToString("&")}"
}
private fun validScope(id: Int, scope: SavedRecordScope) = id > 0 && if (scope.kind == SavedRecordKind.Entities)
    scope.sourceRevision?.let { it in 1..MAX_ID } == true else scope.sourceRevision == null

internal suspend fun RunHistoryClient.savedPage(id: Int, scope: SavedRecordScope, after: String?, token: String): RunHistoryResult<SavedRecordPage> {
    if (!validScope(id, scope) || after != null && !validKey(scope, after)) return RunHistoryResult.Failed(FailureKind.Server)
    return read(savedPath(id, scope, "after_key", after), token, 128 * 1024, "X-Cairn-App-Saved-Records") {
        decodeSavedRecordPage(it, id, scope, after)
    }
}
internal suspend fun RunHistoryClient.savedRecord(id: Int, scope: SavedRecordScope, key: String, token: String): RunHistoryResult<SavedRecord> {
    if (!validScope(id, scope) || !validKey(scope, key)) return RunHistoryResult.Failed(FailureKind.Server)
    return read(savedPath(id, scope, "record_key", key), token, (if (scope.kind == SavedRecordKind.Sources) 10 else 2) * 1024 * 1024,
        "X-Cairn-App-Saved-Records") { decodeSavedRecord(it, id, scope, key) }
}
