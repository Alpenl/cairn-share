package com.alpenl.cairn.share

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.alpenl.cairn.share.network.QueuedCurationAction
import com.alpenl.cairn.share.network.CurationQueue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject

private val Context.curationActionDataStore by preferencesDataStore("cairn_curation_actions")

/**
 * Persists the offline curation action queue.
 *
 * Only *actions* are stored, never a snapshot of the old object: replaying a
 * stale full object would overwrite newer server state, while an action with a
 * stable operation key is idempotent and safe to retry. The queue survives a
 * process death so a user edit made offline is not lost.
 */
internal class CurationActionStore(private val context: Context) : CurationQueue {
    // Shared by recreated ViewModels; enqueue remains independent of network IO.
    val syncMutex get() = SYNC_MUTEX

    val actions: Flow<List<QueuedCurationAction>> = context.curationActionDataStore.data.map { preferences ->
        CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
    }

    suspend fun enqueue(action: QueuedCurationAction) {
        context.curationActionDataStore.edit { preferences ->
            val current = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
            // The same logical action is never queued twice; a retry keeps its
            // original operation key.
            if (current.none { it.operationKey == action.operationKey }) {
                val predecessor = current.lastOrNull { it.accountKey == action.accountKey && it.linkId == action.linkId }
                val queued = if (predecessor == null) action else action.copy(
                    predecessorKey = predecessor.operationKey, predecessorRevision = null, expectedRevision = null,
                )
                preferences[ACTIONS_KEY] = CurationActionJson.encode(current + queued)
            }
        }
    }

    override suspend fun snapshot(): List<QueuedCurationAction> = actions.first()

    override suspend fun acknowledge(action: QueuedCurationAction, revision: Long) {
        require(revision > 0)
        context.curationActionDataStore.edit { preferences ->
            val current = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
            // A stale drainer cannot remove a rebased or replaced action.
            check(current.firstOrNull { it.operationKey == action.operationKey } == action)
            val next = current.filterNot { it.operationKey == action.operationKey }.map {
                if (it.accountKey == action.accountKey && it.linkId == action.linkId && it.predecessorKey == action.operationKey) {
                    it.copy(expectedRevision = revision, predecessorRevision = revision)
                } else it
            }
            preferences[ACTIONS_KEY] = CurationActionJson.encode(next)
        }
    }

    override suspend fun conflict(action: QueuedCurationAction, revision: Long) {
        context.curationActionDataStore.edit { preferences ->
            val current = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
            preferences[ACTIONS_KEY] = CurationActionJson.encode(current.map {
                if (it == action) it.copy(conflictRevision = revision) else it
            })
        }
    }

    /** Called only after the user explicitly chooses to reapply and reloads. */
    suspend fun rebase(accountKey: String, linkId: Int, revision: Long) {
        context.curationActionDataStore.edit { preferences ->
            val current = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
            val mine = current.filter { it.accountKey == accountKey && it.linkId == linkId }
            // A repeated tap may arrive after the first resolution completed.
            if (mine.firstOrNull()?.conflictRevision == null) return@edit
            var previous: String? = null
            val next = current.map { action ->
                if (action.accountKey != accountKey || action.linkId != linkId) action else {
                    val updated = action.copy(expectedRevision = if (previous == null) revision else null,
                        predecessorKey = previous, predecessorRevision = null, conflictRevision = null, queueVersion = 1)
                    previous = action.operationKey
                    updated
                }
            }
            preferences[ACTIONS_KEY] = CurationActionJson.encode(next)
        }
    }

    suspend fun discard(accountKey: String, linkId: Int) {
        context.curationActionDataStore.edit { preferences ->
            val current = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
            preferences[ACTIONS_KEY] = CurationActionJson.encode(current.filterNot { it.accountKey == accountKey && it.linkId == linkId })
        }
    }

    /** The user must explicitly confirm ownership; a suffix is not identity. */
    suspend fun adoptLegacy(legacyKey: String, accountKey: String, linkId: Int, observedRevision: Long): Boolean {
        require(accountKey.startsWith("v2:"))
        var adopted = false
        context.curationActionDataStore.edit { preferences ->
            val current = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
            // Merging two independently prepared chains would invent ordering.
            if (current.any { it.linkId == linkId && it.accountKey == accountKey }) return@edit
            val next = current.map { action ->
                if (action.linkId != linkId || action.accountKey != legacyKey) action else {
                    adopted = true
                    action.copy(accountKey = accountKey,
                        // Missing old CAS is an explicit conflict to resolve,
                        // never a guessed expected revision for automatic send.
                        conflictRevision = if (action.expectedRevision == null && action.predecessorKey == null)
                            observedRevision else action.conflictRevision)
                }
            }
            preferences[ACTIONS_KEY] = CurationActionJson.encode(next)
        }
        return adopted
    }

    suspend fun clear() {
        context.curationActionDataStore.edit { preferences -> preferences.remove(ACTIONS_KEY) }
    }

    private companion object {
        val SYNC_MUTEX = Mutex()
        val ACTIONS_KEY = stringPreferencesKey("curation_actions_json")
    }
}

internal object CurationActionJson {
    fun encode(actions: List<QueuedCurationAction>): String {
        val array = JSONArray()
        for (action in actions) array.put(action.encode())
        return array.toString()
    }

    fun decode(value: String): List<QueuedCurationAction> {
        val array = runCatching { JSONArray(value) }.getOrNull() ?: return emptyList()
        return List(array.length()) { index ->
            runCatching { QueuedCurationAction.decode(array.getJSONObject(index)) }.getOrNull()
        }.filterNotNull().filter {
            // A truncated or foreign entry is skipped rather than replayed with
            // empty defaults that the server would reject.
            it.linkId > 0 && it.operationKey.isNotBlank() && it.field.isNotBlank() && it.action.isNotBlank()
        }
    }
}

/** Full credential/server fingerprint; no raw token is stored in new actions. */
fun accountKeyFor(baseUrl: String, apiToken: String): String {
    val identity = baseUrl.trimEnd('/') + "\u0000" + apiToken.trim()
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
    return "v2:" + digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

/** Only for locating old actions to show an explicit ownership recovery UI. */
internal fun legacyAccountKeyFor(baseUrl: String, apiToken: String): String =
    baseUrl.trimEnd('/') + "|" + apiToken.trim().takeLast(8)

internal fun JSONObject.optLongOrNull(key: String): Long? =
    if (has(key) && !isNull(key)) optLong(key) else null
