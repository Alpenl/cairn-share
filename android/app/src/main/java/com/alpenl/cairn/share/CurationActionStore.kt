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
import com.alpenl.cairn.share.network.ManualMaterialIntent
import com.alpenl.cairn.share.network.decodeMaterialIntent

private val Context.curationActionDataStore by preferencesDataStore("cairn_curation_actions")
private val MATERIALS_KEY = stringPreferencesKey("manual_material_intents_json")
private val DELETIONS_KEY = stringPreferencesKey("deleted_links_json")

/**
 * Persists the offline curation action queue.
 *
 * Only *actions* are stored, never a snapshot of the old object: replaying a
 * stale full object would overwrite newer server state, while an action with a
 * stable operation key is idempotent and safe to retry. The queue survives a
 * process death so a user edit made offline is not lost.
 */
internal class CurationActionStore(context: Context) : CurationQueue {
    internal val context = context.applicationContext
    // Shared by recreated ViewModels; enqueue remains independent of network IO.
    val syncMutex get() = SYNC_MUTEX

    val actions: Flow<List<QueuedCurationAction>> = context.curationActionDataStore.data.map { preferences ->
        CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
    }

    suspend fun enqueue(action: QueuedCurationAction) {
        context.curationActionDataStore.edit { preferences ->
            if (decodeDeletions(preferences[DELETIONS_KEY] ?: "[]").any { it.accountKey == action.accountKey && it.linkId == action.linkId }) return@edit
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

    val deletions: Flow<List<DeletionRecord>> = context.curationActionDataStore.data.map {
        decodeDeletions(it[DELETIONS_KEY] ?: "[]")
    }

    override suspend fun blockedLinkIds(accountKey: String): Set<Int> =
        deletions.first().filter { it.accountKey == accountKey }.map { it.linkId }.toSet()

    suspend fun beginDeletion(accountKey: String, linkId: Int) = recordDeletion(accountKey, linkId, false)
    suspend fun confirmDeletion(accountKey: String, linkId: Int) = recordDeletion(accountKey, linkId, true)

    private suspend fun recordDeletion(accountKey: String, linkId: Int, confirmed: Boolean) {
        require(accountKey.startsWith("v2:") && linkId > 0)
        context.curationActionDataStore.edit { preferences ->
            val current = decodeDeletions(preferences[DELETIONS_KEY] ?: "[]")
            val existing = current.firstOrNull { it.accountKey == accountKey && it.linkId == linkId }
            val record = DeletionRecord(accountKey, linkId, confirmed || existing?.confirmed == true)
            val next = current.filterNot { it.accountKey == accountKey && it.linkId == linkId } + record
            preferences[DELETIONS_KEY] = JSONArray().also { array -> next.forEach {
                array.put(JSONObject().put("account", it.accountKey).put("id", it.linkId).put("confirmed", it.confirmed))
            } }.toString()
            if (record.confirmed) {
                val actions = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
                preferences[ACTIONS_KEY] = CurationActionJson.encode(actions.filterNot { it.accountKey == accountKey && it.linkId == linkId })
                preferences[MATERIALS_KEY] = encodeMaterialDrafts(decodeMaterialDrafts(preferences[MATERIALS_KEY] ?: "[]")
                    .filterNot { it.accountKey == accountKey && it.linkId == linkId })
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
    suspend fun rebase(accountKey: String, linkId: Int, revision: Long, decisionId: Long? = null, contentRevision: Long? = null) {
        context.curationActionDataStore.edit { preferences ->
            val current = CurationActionJson.decode(preferences[ACTIONS_KEY] ?: "[]")
            val mine = current.filter { it.accountKey == accountKey && it.linkId == linkId }
            // A repeated tap may arrive after the first resolution completed.
            if (mine.firstOrNull()?.conflictRevision == null) return@edit
            var previous: String? = null
            val next = current.map { action ->
                if (action.accountKey != accountKey || action.linkId != linkId) action else {
                    val updated = action.copy(expectedRevision = if (previous == null) revision else null,
                        predecessorKey = previous, predecessorRevision = null, conflictRevision = null, queueVersion = 1,
                        expectedDecisionId = decisionId, expectedContentRevision = contentRevision)
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
        context.curationActionDataStore.edit { preferences -> preferences.remove(ACTIONS_KEY); preferences.remove(DELETIONS_KEY); preferences.remove(MATERIALS_KEY) }
    }

    private companion object {
        val SYNC_MUTEX = Mutex()
        val ACTIONS_KEY = stringPreferencesKey("curation_actions_json")
    }
}

/** One immutable, persisted request per account/bookmark. Null rejection means
 * the result is unknown, including a crash between persistence and first send.
 * An ordinary read never drains these potentially paid intents. */
internal data class StoredManualMaterial(val accountKey: String, val linkId: Int, val intent: ManualMaterialIntent, val rejected: String? = null)

internal class ManualMaterialStore(context: Context) {
    private val context = context.applicationContext
    suspend fun load(accountKey: String, linkId: Int): StoredManualMaterial? =
        decodeMaterialDrafts(context.curationActionDataStore.data.first()[MATERIALS_KEY] ?: "[]")
            .singleOrNull { it.accountKey == accountKey && it.linkId == linkId }

    suspend fun prepare(value: StoredManualMaterial, expected: StoredManualMaterial?) {
        require(value.accountKey.matches(Regex("v2:[a-f0-9]{64}")) && value.linkId > 0 && value.intent.valid() && value.rejected == null)
        context.curationActionDataStore.edit { preferences ->
            check(decodeDeletions(preferences[DELETIONS_KEY] ?: "[]").none { it.accountKey == value.accountKey && it.linkId == value.linkId })
            val current = decodeMaterialDrafts(preferences[MATERIALS_KEY] ?: "[]")
            val old = current.singleOrNull { it.accountKey == value.accountKey && it.linkId == value.linkId }
            check(old == expected && (old == null || old.rejected != null || old.intent == value.intent))
            val next = current.filterNot { it.accountKey == value.accountKey && it.linkId == value.linkId } + value
            check(next.size <= 20) { "Manual material draft storage is full" }
            preferences[MATERIALS_KEY] = encodeMaterialDrafts(next)
        }
    }
    suspend fun reject(value: StoredManualMaterial, code: String) = update(value, value.copy(rejected = code))
    suspend fun acknowledge(value: StoredManualMaterial) = update(value, null)
    private suspend fun update(value: StoredManualMaterial, replacement: StoredManualMaterial?) {
        context.curationActionDataStore.edit { preferences ->
            val current = decodeMaterialDrafts(preferences[MATERIALS_KEY] ?: "[]")
            if (current.singleOrNull { it.accountKey == value.accountKey && it.linkId == value.linkId } != value) return@edit
            preferences[MATERIALS_KEY] = encodeMaterialDrafts(current.filterNot { it == value } + listOfNotNull(replacement))
        }
    }
}

internal fun encodeMaterialDrafts(values: List<StoredManualMaterial>): String = JSONArray().also { rows -> values.forEach {
    rows.put(JSONObject().put("account", it.accountKey).put("id", it.linkId).put("intent", it.intent.encode())
        .put("role", it.intent.option.role).put("rejected", it.rejected ?: JSONObject.NULL))
} }.toString()

internal fun decodeMaterialDrafts(value: String): List<StoredManualMaterial> {
    try {
        val rows = JSONArray(value)
        require(rows.length() <= 20)
        return List(rows.length()) { index ->
            val row = rows.getJSONObject(index)
            val account = row.opt("account") as? String ?: error("missing material account")
            val id = row.opt("id") as? Number ?: error("missing material owner")
            require(account.matches(Regex("v2:[a-f0-9]{64}")) && id.toLong() in 1..Int.MAX_VALUE.toLong() && id.toDouble() == id.toInt().toDouble())
            require(row.has("rejected"))
            val rejected: String? = if (row.isNull("rejected")) null else {
                (row.opt("rejected") as? String)?.takeIf { it.isNotBlank() && it.length <= 200 }
                    ?: error("invalid material disposition")
            }
            StoredManualMaterial(account, id.toInt(), decodeMaterialIntent(row.getJSONObject("intent"), row.getString("role")), rejected)
        }.also { values -> require(values.distinctBy { it.accountKey to it.linkId }.size == values.size) }
    } catch (error: Exception) { throw java.io.IOException("Invalid manual material draft journal", error) }
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

/** Only numeric IDs, credential fingerprints and acknowledgement state persist. */
internal data class DeletionRecord(val accountKey: String, val linkId: Int, val confirmed: Boolean)

private fun decodeDeletions(value: String): List<DeletionRecord> = try {
    val rows = JSONArray(value)
    List(rows.length()) { index ->
        val row = rows.getJSONObject(index)
        val record = DeletionRecord(row.getString("account"), row.getInt("id"), row.getBoolean("confirmed"))
        require(record.accountKey.startsWith("v2:") && record.linkId > 0)
        record
    }
} catch (error: Exception) {
    throw java.io.IOException("Invalid deletion journal", error)
}
