package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import org.json.JSONException
import org.json.JSONObject

private const val MAX_MATERIAL_ID = 9_007_199_254_740_991L
private const val MATERIAL_CAPABILITY = "X-Cairn-App-Manual-Material"
internal data class MaterialSource(val revision: Long, val snapshotId: Long, val hash: String, val generation: Long)
internal data class MaterialOption(val kind: String, val sourceRef: String, val role: String)
internal data class MaterialOptions(val source: MaterialSource?, val canSubmit: Boolean, val reason: String?, val options: List<MaterialOption>)
internal data class ManualMaterialIntent(val operationKey: String, val source: MaterialSource, val option: MaterialOption, val text: String) {
    fun encode(): JSONObject = JSONObject().put("version", 1).put("operation_key", operationKey)
        .put("expected_content_revision", source.revision).put("evidence_snapshot_id", source.snapshotId).put("source_hash", source.hash)
        .put("target_generation", source.generation).put("kind", option.kind).put("source_ref", option.sourceRef).put("text", text)
    fun valid(): Boolean = operationKey.isNotBlank() && operationKey.length <= 200 && source.valid() && option.valid() &&
        text.isNotBlank() && Charsets.UTF_8.newEncoder().canEncode(text) && text.toByteArray(Charsets.UTF_8).size <= 100000 &&
        encode().toString().toByteArray(Charsets.UTF_8).size <= 128 * 1024
}
internal sealed interface MaterialWriteResult {
    data class Saved(val revision: Long, val queued: Boolean, val replayed: Boolean) : MaterialWriteResult
    /** A marked refusal means this exact intent did not apply. Other failures remain unknown. */
    data class Rejected(val code: String) : MaterialWriteResult
    data class Unknown(val kind: FailureKind) : MaterialWriteResult
}
private fun MaterialSource.valid() = revision in 1..MAX_MATERIAL_ID && snapshotId in 1..MAX_MATERIAL_ID &&
    Regex("[a-f0-9]{64}").matches(hash) && generation in 0..MAX_MATERIAL_ID
private fun MaterialOption.valid() = kind in setOf("external_link", "image_text", "truncation") &&
    sourceRef.isNotBlank() && sourceRef.length <= 2048 && role in setOf("author_continuation", "quoted", "external_article", "third_party", "legacy_unknown")
private fun JSONObject.materialString(key: String) = opt(key) as? String ?: throw JSONException("invalid material string")
private fun JSONObject.materialBoolean(key: String) = opt(key) as? Boolean ?: throw JSONException("invalid material boolean")
private fun JSONObject.materialNumber(key: String) = nonnegativeRevision(key)?.takeIf { it <= MAX_MATERIAL_ID }
    ?: throw JSONException("invalid material number")
private fun JSONObject.materialEnvelope(id: Int): Boolean {
    if (materialNumber("id") != id.toLong()) throw JSONException("foreign material owner")
    return materialNumber("version") == 1L
}
internal fun decodeMaterialOptions(json: JSONObject, id: Int): RunHistoryResult<MaterialOptions> {
    if (!json.materialEnvelope(id)) return RunHistoryResult.Unsupported
    if (!json.has("source") || !json.has("blocked_reason") || json.materialNumber("max_text_bytes") != 100000L)
        throw JSONException("missing material capability")
    val source = if (json.isNull("source")) null else json.getJSONObject("source").let {
        MaterialSource(it.materialNumber("content_revision"), it.materialNumber("evidence_snapshot_id"), it.materialString("source_hash"), it.materialNumber("target_generation"))
            .also { value -> if (!value.valid()) throw JSONException("invalid material source") }
    }
    val canSubmit = json.materialBoolean("can_submit")
    val reason = if (json.isNull("blocked_reason")) null else json.materialString("blocked_reason").also {
        if (it.isBlank() || it.length > 200) throw JSONException("invalid material reason")
    }
    val rows = json.getJSONArray("options")
    if (rows.length() > 134) throw JSONException("unbounded material options")
    val options = (0 until rows.length()).map { index -> rows.getJSONObject(index).let {
        MaterialOption(it.materialString("kind"), it.materialString("source_ref"), it.materialString("role"))
            .also { option -> if (!option.valid()) throw JSONException("invalid material option") }
    } }
    if (options.distinctBy { it.kind to it.sourceRef }.size != options.size || canSubmit != (source != null && reason == null && options.isNotEmpty()) || !canSubmit && reason == null)
        throw JSONException("inconsistent material capability")
    return RunHistoryResult.Loaded(MaterialOptions(source, canSubmit, reason, options))
}
internal fun decodeMaterialIntent(json: JSONObject, role: String): ManualMaterialIntent {
    val fields = setOf("version", "operation_key", "expected_content_revision", "evidence_snapshot_id", "source_hash", "target_generation", "kind", "source_ref", "text")
    if (json.keys().asSequence().toSet() != fields || json.materialNumber("version") != 1L) throw JSONException("invalid stored material intent")
    return ManualMaterialIntent(json.materialString("operation_key"), MaterialSource(json.materialNumber("expected_content_revision"),
        json.materialNumber("evidence_snapshot_id"), json.materialString("source_hash"), json.materialNumber("target_generation")),
        MaterialOption(json.materialString("kind"), json.materialString("source_ref"), role), json.materialString("text"))
        .also { if (!it.valid()) throw JSONException("invalid stored material intent") }
}
internal fun decodeMaterialReceipt(json: JSONObject, id: Int, intent: ManualMaterialIntent): MaterialWriteResult.Saved {
    if (!json.materialEnvelope(id) || json.materialString("operation_key") != intent.operationKey ||
        json.materialString("request_id").isBlank() || json.materialString("status") != "material_saved" || json.materialNumber("model_calls") != 0L)
        throw JSONException("unbound material receipt")
    val changed = json.materialBoolean("changed")
    val queued = json.materialBoolean("classification_queued")
    val source = MaterialSource(json.materialNumber("content_revision"), json.materialNumber("evidence_snapshot_id"), json.materialString("source_hash"), intent.source.generation)
    if (!source.valid() || changed != queued || (if (changed) source.revision != intent.source.revision + 1 || source.snapshotId == intent.source.snapshotId || source.hash == intent.source.hash
        else source != intent.source)) throw JSONException("inconsistent material receipt")
    return MaterialWriteResult.Saved(source.revision, queued, json.materialBoolean("replayed"))
}

internal class ManualMaterialClient(private val baseUrl: String) {
    suspend fun options(id: Int, token: String): RunHistoryResult<MaterialOptions> = if (id < 1) RunHistoryResult.Failed(FailureKind.Server)
        else RunHistoryClient(baseUrl).read("/api/bookmarks/$id/manual-material", token, 128 * 1024, MATERIAL_CAPABILITY) { decodeMaterialOptions(it, id) }

    /** Only the user's explicit submit/confirm button calls this. The caller
     * persists the exact intent first; no redirect or automatic retry occurs. */
    suspend fun submit(id: Int, token: String, intent: ManualMaterialIntent): MaterialWriteResult {
        if (id < 1 || !intent.valid()) return MaterialWriteResult.Rejected("invalid_material")
        val bytes = intent.encode().toString().toByteArray(Charsets.UTF_8)
        return cancellableRead { cancellation ->
            val connection = URL("${baseUrl.trimEnd('/')}/api/bookmarks/$id/manual-material").openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"; connection.instanceFollowRedirects = false
                connection.connectTimeout = 10000; connection.readTimeout = 10000; connection.doOutput = true
                connection.setRequestProperty("Authorization", "Bearer ${token.trim()}")
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setRequestProperty("User-Agent", AppUserAgent.value())
                connection.setRequestProperty(MATERIAL_CAPABILITY, "1")
                connection.setFixedLengthStreamingMode(bytes.size)
                cancellation.attach(connection)
                connection.outputStream.use { it.write(bytes) }
                val status = connection.responseCode
                if (status == 401 || status == 403) return@cancellableRead MaterialWriteResult.Unknown(FailureKind.Unauthorized)
                if (connection.getHeaderField(MATERIAL_CAPABILITY) != "1" || connection.contentLengthLong > 128 * 1024 || status !in setOf(200, 400, 404, 409, 413))
                    return@cancellableRead MaterialWriteResult.Unknown(FailureKind.Server)
                val input = if (status == 200) connection.inputStream else connection.errorStream
                    ?: return@cancellableRead MaterialWriteResult.Unknown(FailureKind.Server)
                val payload = input.use {
                    val buffer = ByteArray(128 * 1024 + 1); var count = 0
                    while (count < buffer.size) { val n = it.read(buffer, count, buffer.size-count); if (n < 0) break; if (n > 0) count += n }
                    if (count > 128 * 1024) throw JSONException("material response exceeds budget")
                    Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(buffer, 0, count)).toString()
                }
                val json = JSONObject(payload)
                if (status == 200) decodeMaterialReceipt(json, id, intent) else MaterialWriteResult.Rejected(json.materialString("error"))
            } catch (_: SocketTimeoutException) { MaterialWriteResult.Unknown(FailureKind.Timeout)
            } catch (_: IOException) { MaterialWriteResult.Unknown(FailureKind.Network)
            } catch (_: JSONException) { MaterialWriteResult.Unknown(FailureKind.Server)
            } finally { cancellation.release(connection); connection.disconnect() }
        }
    }
}
