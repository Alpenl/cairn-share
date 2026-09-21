package com.alpenl.cairn.share

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.alpenl.cairn.share.network.QueuedCurationAction
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
internal class CurationActionStore(private val context: Context) {

    val actions: Flow<List<QueuedCurationAction>> = context.curationActionDataStore.data.map { preferences ->
        CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
    }

    suspend fun enqueue(action: QueuedCurationAction) {
        context.curationActionDataStore.edit { preferences ->
            val current = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
            // The same logical action is never queued twice; a retry keeps its
            // original operation key.
            if (current.none { it.operationKey == action.operationKey }) {
                preferences[ACTIONS_KEY] = CurationActionJson.encode(current + action)
            }
        }
    }

    suspend fun remove(operationKey: String) {
        context.curationActionDataStore.edit { preferences ->
            val current = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
            preferences[ACTIONS_KEY] = CurationActionJson.encode(current.filterNot { it.operationKey == operationKey })
        }
    }

    suspend fun replace(actions: List<QueuedCurationAction>) {
        context.curationActionDataStore.edit { preferences ->
            preferences[ACTIONS_KEY] = CurationActionJson.encode(actions)
        }
    }

    suspend fun clear() {
        context.curationActionDataStore.edit { preferences -> preferences.remove(ACTIONS_KEY) }
    }

    private companion object {
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

/** The active account/server identity an action belongs to. */
fun accountKeyFor(baseUrl: String, apiToken: String): String =
    baseUrl.trimEnd('/') + "|" + apiToken.trim().takeLast(8)

internal fun JSONObject.optLongOrNull(key: String): Long? =
    if (has(key) && !isNull(key)) optLong(key) else null
