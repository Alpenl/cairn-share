package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import org.json.JSONException
import org.json.JSONObject

internal data class EntityEvidenceReference(
    val snapshotId: Long,
    val sourceRevision: Long,
    val blockId: String,
    val start: Long,
    val end: Long,
    val surface: String,
) {
    fun valid(): Boolean = snapshotId in 1..9_007_199_254_740_991L &&
        sourceRevision in 1..9_007_199_254_740_991L && blockId.isNotBlank() && blockId.length <= 64 &&
        start >= 0 && end > start && end <= 100_000 && end - start <= 2048 &&
        surface.isNotBlank() && surface.codePointCount(0, surface.length).toLong() == end - start

    fun query(): String = "snapshot_id=$snapshotId&content_revision=$sourceRevision&block_id=" +
        URLEncoder.encode(blockId, "UTF-8") + "&start=$start&end=$end"
}

internal fun EntityObservation.evidenceReference(): EntityEvidenceReference? =
    EntityEvidenceReference(evidenceSnapshotId, sourceRevision, blockId, start, end, surface).takeIf { it.valid() }

internal data class EntitySourceEvidence(
    val before: String,
    val quote: String,
    val after: String,
    val role: String,
    val current: Boolean,
    val partial: Boolean,
    val clippedBefore: Boolean,
    val clippedAfter: Boolean,
)

internal sealed interface EntityEvidenceResult {
    data class Loaded(val value: EntitySourceEvidence) : EntityEvidenceResult
    data object Unsupported : EntityEvidenceResult
    data object Unavailable : EntityEvidenceResult
    data object Changed : EntityEvidenceResult
    data class Failed(val kind: FailureKind) : EntityEvidenceResult
}

internal data class EntityEvidenceReadState(
    val requestId: Long,
    val linkId: Int,
    val reference: EntityEvidenceReference,
    val result: EntityEvidenceResult? = null,
)

internal fun decodeEntityEvidence(json: JSONObject, id: Int, ref: EntityEvidenceReference): EntityEvidenceResult {
    fun invalid() = EntityEvidenceResult.Failed(FailureKind.Server)
    val version = json.nonnegativeRevision("version") ?: return invalid()
    if (version != 1L) return EntityEvidenceResult.Unsupported
    if (!ref.valid() || json.nonnegativeRevision("bookmark_id") != id.toLong() ||
        json.nonnegativeRevision("evidence_snapshot_id") != ref.snapshotId ||
        json.nonnegativeRevision("content_revision") != ref.sourceRevision ||
        json.opt("block_id") != ref.blockId || json.nonnegativeRevision("span_start") != ref.start ||
        json.nonnegativeRevision("span_end") != ref.end ||
        !(json.opt("content_hash") as? String).orEmpty().matches(Regex("[a-f0-9]{64}"))) return invalid()
    val before = json.opt("before") as? String ?: return invalid()
    val quote = json.opt("quote") as? String ?: return invalid()
    val after = json.opt("after") as? String ?: return invalid()
    val contextStart = json.nonnegativeRevision("context_start") ?: return invalid()
    val current = json.opt("current") as? Boolean ?: return invalid()
    val truncated = json.opt("truncated") as? Boolean ?: return invalid()
    val clippedBefore = json.opt("clipped_before") as? Boolean ?: return invalid()
    val clippedAfter = json.opt("clipped_after") as? Boolean ?: return invalid()
    val completeness = json.optString("completeness").takeIf { it in setOf("complete", "partial", "truncated") } ?: return invalid()
    val role = json.optString("role").takeIf { it in setOf("primary", "author_continuation", "quoted", "external_article", "third_party", "legacy_unknown") } ?: return invalid()
    if (quote != ref.surface || before.codePointCount(0, before.length) > 480 || after.codePointCount(0, after.length) > 480 ||
        contextStart > ref.start || contextStart + before.codePointCount(0, before.length) != ref.start ||
        clippedBefore != (contextStart > 0)) return invalid()
    return EntityEvidenceResult.Loaded(EntitySourceEvidence(before, quote, after, role, current,
        truncated || completeness != "complete", clippedBefore, clippedAfter))
}

/** A bounded, cancellable GET. It cannot request snapshots or management paths by URL. */
internal class EntityEvidenceClient(private val baseUrl: String) {
    suspend fun load(id: Int, ref: EntityEvidenceReference, token: String): EntityEvidenceResult = cancellableRead { cancellation ->
        if (id < 1 || !ref.valid()) return@cancellableRead EntityEvidenceResult.Failed(FailureKind.Server)
        val connection = URL("${baseUrl.trimEnd('/')}/api/bookmarks/$id/entity-evidence?${ref.query()}")
            .openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer ${token.trim()}")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", AppUserAgent.value())
            cancellation.attach(connection)
            val status = connection.responseCode
            val supported = connection.getHeaderField("X-Cairn-Entity-Evidence") == "1"
            when {
                status == 401 || status == 403 -> EntityEvidenceResult.Failed(FailureKind.Unauthorized)
                status == 405 || status == 501 -> EntityEvidenceResult.Unsupported
                status == 404 -> if (supported) EntityEvidenceResult.Unavailable else EntityEvidenceResult.Unsupported
                status == 409 && supported -> EntityEvidenceResult.Changed
                status != 200 -> EntityEvidenceResult.Failed(FailureKind.Server)
                !supported -> EntityEvidenceResult.Unsupported
                else -> {
                    val body = connection.inputStream.use { input ->
                        val bytes = ByteArray(32 * 1024 + 1)
                        var size = 0
                        while (size < bytes.size) {
                            val read = input.read(bytes, size, bytes.size - size)
                            if (read <= 0) break
                            size += read
                        }
                        if (size > 32 * 1024) null else runCatching {
                            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                                .decode(ByteBuffer.wrap(bytes, 0, size)).toString()
                        }.getOrNull()
                    }
                    if (body == null) EntityEvidenceResult.Failed(FailureKind.Server)
                    else decodeEntityEvidence(JSONObject(body), id, ref)
                }
            }
        } catch (_: SocketTimeoutException) {
            EntityEvidenceResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            EntityEvidenceResult.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            EntityEvidenceResult.Failed(FailureKind.Server)
        } finally {
            cancellation.release(connection)
            connection.disconnect()
        }
    }
}
