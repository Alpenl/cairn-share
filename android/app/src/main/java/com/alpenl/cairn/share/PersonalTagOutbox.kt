package com.alpenl.cairn.share

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.alpenl.cairn.share.network.FailureKind
import com.alpenl.cairn.share.network.V2CurationClient
import com.alpenl.cairn.share.network.V2Result
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private val Context.personalTagDataStore by preferencesDataStore("cairn_personal_tag_outbox")

internal data class PersonalTagRequest(
    val path: String, val method: String, val body: String,
    val attachCreated: Boolean = false, val clearsName: Boolean = false,
    val attachmentSnapshot: PersonalTagSnapshot? = null,
) {
    val operationKey: String get() = JSONObject(body).getString("operation_key")
}

internal data class PendingPersonalTag(
    val account: String, val linkId: Int, val request: PersonalTagRequest,
    val conflictRevision: Long? = null, val failure: String? = null,
)

internal object PersonalTagOutboxJson {
    fun encode(rows: List<PendingPersonalTag>): String = JSONArray().also { array -> rows.forEach { row ->
        val request = row.request
        array.put(JSONObject().put("account", row.account).put("link_id", row.linkId)
            .put("path", request.path).put("method", request.method).put("body", request.body)
            .put("attach_created", request.attachCreated).put("clears_name", request.clearsName)
            .put("conflict_revision", row.conflictRevision ?: JSONObject.NULL).put("failure", row.failure ?: JSONObject.NULL)
            .apply { request.attachmentSnapshot?.let { snapshot -> put("attachment_snapshot", JSONObject()
                .put("revision", snapshot.revision).put("decision_id", snapshot.decisionId).put("content_revision", snapshot.contentRevision).put("custom_tags", JSONArray())) } })
    } }.toString()

    fun decode(value: String): List<PendingPersonalTag> = try {
        val array = JSONArray(value)
        List(array.length()) { index ->
            val row = array.getJSONObject(index)
            val account = row.getString("account")
            val id = row.getInt("link_id")
            val request = PersonalTagRequest(row.getString("path"), row.getString("method"), row.getString("body"),
                row.optBoolean("attach_created"), row.optBoolean("clears_name"), row.optJSONObject("attachment_snapshot")?.let(::parsePersonalTagSnapshot))
            require(account.startsWith("v2:") && id > 0 && request.operationKey.isNotBlank())
            require((request.path == "/api/bookmarks/$id/tags" && request.method == "POST") ||
                (request.path == "/api/custom-tags" && request.method == "POST") ||
                (Regex("^/api/custom-tags/[A-Za-z0-9_-]+$").matches(request.path) && request.method in setOf("PATCH", "DELETE")))
            require(!request.attachCreated || request.attachmentSnapshot != null)
            PendingPersonalTag(account, id, request, row.optLongOrNull("conflict_revision"), row.optString("failure").takeUnless { it.isBlank() || it == "null" })
        }
    } catch (error: Exception) { throw IOException("Cannot read personal tag outbox", error) }

    /** Validate the receipt before dropping an intent or advancing create → attach. */
    fun acknowledged(row: PendingPersonalTag, value: JSONObject): PendingPersonalTag? {
        require(value.opt("replayed") is Boolean)
        val request = row.request
        if (request.path == "/api/bookmarks/${row.linkId}/tags") {
            val revision = value.opt("operation_revision") as? Number
            require(value.opt("operation_id") == request.operationKey && value.optInt("id") == row.linkId &&
                revision != null && revision.toLong() > 0 && revision.toDouble() == revision.toLong().toDouble())
            return null
        }
        val tag = parsePersonalTags(JSONArray().put(value.optJSONObject("tag"))).singleOrNull()
            ?: throw IOException("Invalid custom tag acknowledgement")
        if (request.path != "/api/custom-tags") require(request.path.substringAfterLast('/') == tag.id)
        if (!request.attachCreated) return null
        require(tag.active)
        val snapshot = requireNotNull(request.attachmentSnapshot)
        val attachKey = UUID.nameUUIDFromBytes((request.operationKey + ":attach").toByteArray(Charsets.UTF_8)).toString()
        val attach = personalTagActionPayload(snapshot, JSONObject().put("action", "attach").put("tag_ref", tag.tagRef), attachKey)
        return row.copy(request = PersonalTagRequest("/api/bookmarks/${row.linkId}/tags", "POST", attach.toString(), clearsName = true), failure = null)
    }
}

/** Page-independent, account-scoped intent journal; no credentials or full snapshots. */
internal class PersonalTagOutbox(private val context: Context) {
    val actions = context.personalTagDataStore.data.map { PersonalTagOutboxJson.decode(it[KEY] ?: "[]") }
    suspend fun snapshot(): List<PendingPersonalTag> = actions.first()

    suspend fun enqueue(row: PendingPersonalTag) {
        // Validate our own record before accepting it into durable storage.
        PersonalTagOutboxJson.decode(PersonalTagOutboxJson.encode(listOf(row)))
        context.personalTagDataStore.edit { data ->
            require(row.linkId !in CurationActionStore(context).blockedLinkIds(row.account)) { "This bookmark is being deleted" }
            val current = PersonalTagOutboxJson.decode(data[KEY] ?: "[]")
            require(current.none { it.account == row.account && it.linkId == row.linkId && it.request.operationKey != row.request.operationKey }) { "Resolve the pending personal-tag edit first" }
            if (current.none { it.account == row.account && it.request.operationKey == row.request.operationKey }) data[KEY] = PersonalTagOutboxJson.encode(current + row)
        }
    }

    suspend fun replace(previous: PendingPersonalTag, next: PendingPersonalTag?) {
        context.personalTagDataStore.edit { data ->
            val current = PersonalTagOutboxJson.decode(data[KEY] ?: "[]")
            check(current.firstOrNull { it.account == previous.account && it.request.operationKey == previous.request.operationKey } == previous)
            data[KEY] = PersonalTagOutboxJson.encode(current.flatMap { if (it == previous) listOfNotNull(next) else listOf(it) })
        }
    }

    suspend fun discard(account: String, linkId: Int) = SYNC.withLock {
        context.personalTagDataStore.edit { data -> data[KEY] = PersonalTagOutboxJson.encode(
            PersonalTagOutboxJson.decode(data[KEY] ?: "[]").filterNot { it.account == account && it.linkId == linkId }) }
    }

    /** A stopped/foreign account never starts another request. Uncertain receipts remain queued. */
    suspend fun drain(account: String, token: String, client: V2CurationClient, blocked: Set<Int>, isCurrent: () -> Boolean): Set<Int> = SYNC.withLock {
        val changed = mutableSetOf<Int>()
        val failedLinks = mutableSetOf<Int>()
        while (isCurrent()) {
            val currentBlocked = blocked + CurationActionStore(context).blockedLinkIds(account)
            val row = snapshot().firstOrNull { it.account == account && it.linkId !in currentBlocked && it.linkId !in failedLinks && it.conflictRevision == null } ?: break
            val result = withContext(Dispatchers.IO) { client.tagRequest(row.request.path, row.request.method, token, JSONObject(row.request.body)) }
            when (result) {
                is V2Result.Loaded -> {
                    val next = try { PersonalTagOutboxJson.acknowledged(row, result.value) } catch (_: Exception) {
                        replace(row, row.copy(failure = FailureKind.Server.name)); failedLinks += row.linkId; continue
                    }
                    replace(row, next)
                    changed += row.linkId
                }
                is V2Result.Conflict -> { replace(row, row.copy(conflictRevision = result.revision, failure = null)); failedLinks += row.linkId }
                is V2Result.Failed -> { replace(row, row.copy(failure = result.kind.name)); failedLinks += row.linkId }
                V2Result.Unsupported -> { replace(row, row.copy(failure = "Unsupported")); failedLinks += row.linkId }
            }
        }
        changed
    }
    private companion object { val KEY = stringPreferencesKey("personal_tag_actions"); val SYNC = Mutex() }
}
