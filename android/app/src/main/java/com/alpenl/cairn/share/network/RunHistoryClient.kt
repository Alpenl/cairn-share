package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.CharacterCodingException
import org.json.JSONException
import org.json.JSONObject

internal data class RunHistorySummary(
    val id: Long,
    val status: String?,
    val createdAt: String?,
    val requestedModel: String?,
    val resolvedModel: String?,
    val contentRevision: Long?,
    val coverage: String?,
    val evidenceCoverage: String?,
    val archived: Boolean?,
)
internal data class RunHistoryPage(val runs: List<RunHistorySummary>, val nextAfterId: Long?)
internal data class RunHistoryRecord(val summary: RunHistorySummary, val exportJson: String)

internal sealed interface RunHistoryResult<out T> {
    data class Loaded<T>(val value: T) : RunHistoryResult<T>
    data object Unsupported : RunHistoryResult<Nothing>
    data object Unavailable : RunHistoryResult<Nothing>
    data class Failed(val kind: FailureKind) : RunHistoryResult<Nothing>
}

private const val MAX_HISTORY_ID = 9_007_199_254_740_991L
private fun JSONObject.historyString(key: String): String? {
    val value = opt(key)
    if (value == null || value === JSONObject.NULL) return null
    return value as? String ?: throw JSONException("invalid history string")
}
private fun JSONObject.historySummary(): RunHistorySummary {
    val id = nonnegativeRevision("id")?.takeIf { it in 1..MAX_HISTORY_ID }
        ?: throw JSONException("invalid history identity")
    val revision = if (has("content_revision") && !isNull("content_revision"))
        nonnegativeRevision("content_revision")?.takeIf { it <= MAX_HISTORY_ID }
            ?: throw JSONException("invalid history revision") else null
    val archived = opt("archived").let { value ->
        if (value == null || value === JSONObject.NULL) null
        else value as? Boolean ?: throw JSONException("invalid history archive flag")
    }
    return RunHistorySummary(id, historyString("status"), historyString("created_at"),
        historyString("requested_model"), historyString("resolved_model"), revision,
        historyString("coverage"), historyString("evidence_coverage"), archived)
}
private fun JSONObject.historyEnvelope(id: Int): Boolean {
    if (nonnegativeRevision("version") != 1L) return false
    if (nonnegativeRevision("bookmark_id") != id.toLong()) throw JSONException("wrong history owner")
    return true
}

internal fun decodeRunHistoryPage(json: JSONObject, id: Int, after: Long?): RunHistoryResult<RunHistoryPage> {
    if (!json.historyEnvelope(id)) return RunHistoryResult.Unsupported
    val rows = json.optJSONArray("runs") ?: throw JSONException("missing history page")
    if (rows.length() > 50) throw JSONException("unbounded history page")
    var previous = after
    val runs = (0 until rows.length()).map { index ->
        val row = rows.getJSONObject(index)
        for (field in listOf("policy", "answers", "usage", "raw_judgments", "operation_key"))
            if (row.has(field)) throw JSONException("payload in history summary")
        val value = row.historySummary()
        if (previous != null && value.id >= previous!!) throw JSONException("history did not advance")
        previous = value.id
        value
    }
    if (!json.has("next_after_id")) throw JSONException("missing history cursor")
    val next = if (json.isNull("next_after_id")) null else json.nonnegativeRevision("next_after_id")
        ?.takeIf { it in 1..MAX_HISTORY_ID && runs.isNotEmpty() && it == runs.last().id }
        ?: throw JSONException("invalid history cursor")
    return RunHistoryResult.Loaded(RunHistoryPage(runs, next))
}

internal fun decodeRunHistoryRecord(json: JSONObject, id: Int, runId: Long): RunHistoryResult<RunHistoryRecord> {
    if (!json.historyEnvelope(id)) return RunHistoryResult.Unsupported
    val summary = json.getJSONObject("run").historySummary()
    if (summary.id != runId) throw JSONException("wrong history record")
    // Keep the acknowledged envelope and all stored fields, including nulls.
    // No current model, source or policy is added to an old/partial record.
    return RunHistoryResult.Loaded(RunHistoryRecord(summary, json.toString()))
}

/** Two bounded, cancellable reads; no mutations or all-history fallback. */
internal class RunHistoryClient(private val baseUrl: String) {
    suspend fun page(id: Int, after: Long?, token: String): RunHistoryResult<RunHistoryPage> {
        if (id < 1 || after != null && after !in 1..MAX_HISTORY_ID) return RunHistoryResult.Failed(FailureKind.Server)
        return read("/api/bookmarks/$id/run-history" + (after?.let { "?after_id=$it" } ?: ""), token, 128 * 1024) {
            decodeRunHistoryPage(it, id, after)
        }
    }

    suspend fun record(id: Int, runId: Long, token: String): RunHistoryResult<RunHistoryRecord> {
        if (id < 1 || runId !in 1..MAX_HISTORY_ID) return RunHistoryResult.Failed(FailureKind.Server)
        return read("/api/bookmarks/$id/run-history/$runId", token, 5 * 1024 * 1024) {
            decodeRunHistoryRecord(it, id, runId)
        }
    }

    private suspend fun <T> read(path: String, token: String, limit: Int,
        decode: (JSONObject) -> RunHistoryResult<T>): RunHistoryResult<T> = cancellableRead { cancellation ->
        val connection = URL("${baseUrl.trimEnd('/')}$path").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer ${token.trim()}")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", AppUserAgent.value())
            connection.setRequestProperty("X-Cairn-App-Run-History", "1")
            cancellation.attach(connection)
            val status = connection.responseCode
            val supported = connection.getHeaderField("X-Cairn-App-Run-History") == "1"
            when {
                status == 401 || status == 403 -> RunHistoryResult.Failed(FailureKind.Unauthorized)
                status == 405 || status == 501 -> RunHistoryResult.Unsupported
                status == 404 -> if (supported) RunHistoryResult.Unavailable else RunHistoryResult.Unsupported
                status == 410 && supported -> RunHistoryResult.Unavailable
                status != 200 -> RunHistoryResult.Failed(FailureKind.Server)
                !supported -> RunHistoryResult.Unsupported
                connection.contentLengthLong > limit -> RunHistoryResult.Failed(FailureKind.Server)
                else -> {
                    val text = connection.inputStream.use { input ->
                        val bytes = ByteArray(limit + 1)
                        var count = 0
                        while (count < bytes.size) {
                            val size = input.read(bytes, count, bytes.size - count)
                            if (size < 0) break
                            if (size == 0) continue
                            count += size
                        }
                        if (count > limit) throw JSONException("history response too large")
                        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(bytes, 0, count)).toString()
                    }
                    decode(JSONObject(text))
                }
            }
        } catch (_: CharacterCodingException) {
            RunHistoryResult.Failed(FailureKind.Server)
        } catch (_: SocketTimeoutException) {
            RunHistoryResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            RunHistoryResult.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            RunHistoryResult.Failed(FailureKind.Server)
        } finally {
            cancellation.release(connection)
            connection.disconnect()
        }
    }
}
