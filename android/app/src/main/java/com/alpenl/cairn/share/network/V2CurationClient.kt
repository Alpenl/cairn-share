package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.charset.StandardCharsets
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The multidimensional selection as returned by the v2 API.
 *
 * [available] is false when the server does not implement v2. The caller must
 * then degrade to the v1 projection instead of treating the selection as an
 * explicit empty value.
 */
internal data class MultidimensionalSelection(
    val topics: List<String> = emptyList(),
    val contentFunctions: List<String> = emptyList(),
    val carriers: List<String> = emptyList(),
    val affordances: List<String> = emptyList(),
    val form: String = "",
    val use: String = "",
    val v1ProjectionTopics: List<String> = emptyList(),
    val revision: Long = 0,
    val available: Boolean = false,
    val automatic: MultidimensionalSelection? = null,
    val unknownResetFields: Set<String> = emptySet(),
    val state: SelectionState? = null,
    val pendingFields: Set<String> = emptySet(),
)

internal sealed interface V2Result<out T> {
    data class Loaded<T>(val value: T) : V2Result<T>
    /** The server predates the v2 API; the caller must fall back safely. */
    data object Unsupported : V2Result<Nothing>
    /** A CAS conflict: [revision] is the server's current revision. */
    data class Conflict(val revision: Long) : V2Result<Nothing>
    data class Failed(val kind: FailureKind) : V2Result<Nothing>
}

/**
 * Talks to the App-scoped multidimensional endpoints on the Worker. The same
 * read/action contract is also served by the local dashboard. The App never
 * receives internal management credentials.
 */
internal class V2CurationClient(
    private val baseUrl: String,
    private val connectTimeoutMillis: Int = 10_000,
    private val readTimeoutMillis: Int = 10_000,
    private val userAgent: String = AppUserAgent.value(),
) {
    private fun endpoint(path: String): URL = URL("${baseUrl.trimEnd('/')}$path")

    private fun configure(connection: HttpURLConnection, method: String, apiToken: String) {
        connection.requestMethod = method
        connection.connectTimeout = connectTimeoutMillis
        connection.readTimeout = readTimeoutMillis
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("User-Agent", userAgent)
        if (apiToken.isNotBlank()) {
            connection.setRequestProperty("Authorization", "Bearer ${apiToken.trim()}")
        }
    }

    fun loadSelection(id: Int, apiToken: String): V2Result<MultidimensionalSelection> {
        val connection = endpoint("/api/bookmarks/$id/v2-selection?include_automatic=1&include_state=1").openConnection() as HttpURLConnection
        return try {
            configure(connection, "GET", apiToken)
            when (val status = connection.responseCode) {
                HttpURLConnection.HTTP_OK -> decodeSelection(JSONObject(connection.inputStream.bufferedReader().readText()))
                HttpURLConnection.HTTP_UNAUTHORIZED -> V2Result.Failed(FailureKind.Unauthorized)
                HttpURLConnection.HTTP_NOT_FOUND, HttpURLConnection.HTTP_BAD_METHOD -> V2Result.Unsupported
                else -> if (status == 501) V2Result.Unsupported else V2Result.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            V2Result.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            V2Result.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            V2Result.Failed(FailureKind.Server)
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Writes one field-level action. A rejected field stays rejected, and an
     * empty selection is distinct from resetting to the automatic suggestion.
     */
    fun applyOverride(id: Int, override: FieldOverride, apiToken: String): V2Result<JSONObject> {
        val body = override.encode().toByteArray(StandardCharsets.UTF_8)
        val connection = endpoint("/api/bookmarks/$id/v2-override").openConnection() as HttpURLConnection
        return try {
            configure(connection, "POST", apiToken)
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            when (connection.responseCode) {
                HttpURLConnection.HTTP_OK -> V2Result.Loaded(JSONObject(connection.inputStream.bufferedReader().readText()))
                HttpURLConnection.HTTP_UNAUTHORIZED -> V2Result.Failed(FailureKind.Unauthorized)
                HttpURLConnection.HTTP_NOT_FOUND, HttpURLConnection.HTTP_BAD_METHOD -> V2Result.Unsupported
                HttpURLConnection.HTTP_CONFLICT -> {
                    val payload = runCatching { JSONObject(connection.errorStream?.bufferedReader()?.readText() ?: "{}") }.getOrNull()
                    if (payload?.optString("error") == "revision_conflict") {
                        val revision = payload.opt("revision")
                        if (revision is Number && revision.toLong() >= 0 && revision.toDouble() == revision.toLong().toDouble()) {
                            V2Result.Conflict(revision.toLong())
                        } else V2Result.Failed(FailureKind.Server)
                    } else if (payload?.optString("error") == "v2_unsupported") {
                        V2Result.Unsupported
                    } else {
                        V2Result.Failed(FailureKind.Server)
                    }
                }
                else -> V2Result.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            V2Result.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            V2Result.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            V2Result.Failed(FailureKind.Server)
        } finally {
            connection.disconnect()
        }
    }

    fun loadTaxonomy(apiToken: String): V2Result<BookmarkTaxonomy> {
        val connection = endpoint("/api/v2-taxonomy").openConnection() as HttpURLConnection
        return try {
            configure(connection, "GET", apiToken)
            when (connection.responseCode) {
                HttpURLConnection.HTTP_OK -> {
                    val payload = JSONObject(connection.inputStream.bufferedReader().readText())
                    if (payload.optBoolean("available", true) == false) V2Result.Unsupported
                    else V2Result.Loaded(decodeTaxonomy(payload))
                }
                HttpURLConnection.HTTP_UNAUTHORIZED -> V2Result.Failed(FailureKind.Unauthorized)
                HttpURLConnection.HTTP_NOT_FOUND -> V2Result.Unsupported
                else -> V2Result.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            V2Result.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            V2Result.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            V2Result.Failed(FailureKind.Server)
        } finally {
            connection.disconnect()
        }
    }

    internal fun decodeSelection(payload: JSONObject): V2Result<MultidimensionalSelection> {
        if (payload.optBoolean("available", true) == false) return V2Result.Unsupported
        val selection = payload.optJSONObject("selection") ?: return V2Result.Failed(FailureKind.Server)
        val revision = payload.nonnegativeRevision("revision") ?: return V2Result.Failed(FailureKind.Server)
        if (decodeAutomatic(selection) == null) return V2Result.Failed(FailureKind.Server)
        val projection = payload.optJSONObject("v1_projection")
        val state = decodeSelectionState(payload.optJSONObject("state"), revision)?.takeIf { decoded ->
            decoded.fields.all { (field, detail) ->
                val values = if (field == "form" || field == "use") listOf(selection.optString(field)).filter { it.isNotEmpty() }
                    else selection.strings(field)
                detail.values.map { it.term } == values
            }
        }
        return V2Result.Loaded(
            MultidimensionalSelection(
                topics = selection.strings("topics"),
                contentFunctions = selection.strings("content_functions"),
                carriers = selection.strings("carriers"),
                affordances = selection.strings("affordances"),
                form = selection.optString("form"),
                use = selection.optString("use"),
                v1ProjectionTopics = projection.strings("topics"),
                revision = revision,
                available = true,
                automatic = decodeAutomatic(payload.optJSONObject("automatic")),
                state = state,
            )
        )
    }

    private fun decodeAutomatic(value: JSONObject?): MultidimensionalSelection? {
        if (value == null) return null
        for (field in listOf("topics", "content_functions", "carriers", "affordances")) {
            val values = value.optJSONArray(field) ?: return null
            if ((0 until values.length()).any { values.opt(it) !is String }) return null
        }
        if (value.opt("form") !is String || value.opt("use") !is String) return null
        return MultidimensionalSelection(topics = value.strings("topics"),
            contentFunctions = value.strings("content_functions"), carriers = value.strings("carriers"),
            affordances = value.strings("affordances"), form = value.getString("form"), use = value.getString("use"), available = true)
    }
}

private fun JSONObject?.strings(key: String): List<String> {
    val array: JSONArray = this?.optJSONArray(key) ?: return emptyList()
    return List(array.length()) { index -> array.optString(index) }.filter { it.isNotBlank() }
}

/**
 * The offline action queue stores *actions*, never a full snapshot of the old
 * object. Replaying a stale full object would overwrite newer server state; an
 * action with an operation key is idempotent and safe to retry.
 */
internal data class QueuedCurationAction(
    val linkId: Int,
    val operationKey: String,
    val field: String,
    val term: String,
    val action: String,
    val expectedRevision: Long?,
    val accountKey: String,
    val predecessorKey: String? = null,
    val predecessorRevision: Long? = null,
    val conflictRevision: Long? = null,
    val queueVersion: Int = 1,
) {
    val ready: Boolean get() = expectedRevision != null && (predecessorKey == null || predecessorRevision != null)

    fun encode(): JSONObject = JSONObject().apply {
        put("link_id", linkId)
        put("operation_key", operationKey)
        put("field", field)
        put("term", term)
        put("action", action)
        expectedRevision?.let { put("expected_revision", it) }
        put("account_key", accountKey)
        put("queue_version", queueVersion)
        predecessorKey?.let { put("predecessor_key", it) }
        predecessorRevision?.let { put("predecessor_revision", it) }
        conflictRevision?.let { put("conflict_revision", it) }
    }

    companion object {
        fun decode(json: JSONObject): QueuedCurationAction = QueuedCurationAction(
            linkId = json.optInt("link_id", 0),
            operationKey = json.optString("operation_key"),
            field = json.optString("field"),
            term = json.optString("term"),
            action = json.optString("action"),
            expectedRevision = if (json.has("expected_revision")) json.optLong("expected_revision") else null,
            accountKey = json.optString("account_key"),
            predecessorKey = if (json.has("predecessor_key")) json.getString("predecessor_key") else null,
            predecessorRevision = if (json.has("predecessor_revision")) json.getLong("predecessor_revision") else null,
            conflictRevision = if (json.has("conflict_revision")) json.getLong("conflict_revision") else null,
            queueVersion = json.optInt("queue_version", 0),
        )
    }
}

/**
 * Filters queued actions down to the ones that belong to the currently active
 * account and server. A queued action for another account must never be sent.
 */
internal fun pendingActionsFor(actions: List<QueuedCurationAction>, accountKey: String): List<QueuedCurationAction> =
    actions.filter { it.accountKey == accountKey }
