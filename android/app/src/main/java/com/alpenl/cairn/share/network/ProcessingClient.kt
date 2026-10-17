package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import org.json.JSONException
import org.json.JSONObject

private const val PROCESSING_CAPABILITY = "X-Cairn-App-Processing"
private const val MAX_PROCESSING_REVISION = 9_007_199_254_740_991L
internal enum class ProcessingAction(val wire: String) {
    SavePrimary("save_primary"), RetryReading("retry_reading"), RetryClassification("retry_classification");
    companion object { fun fromWire(value: String) = entries.singleOrNull { it.wire == value } }
}
internal data class ProcessingIdentity(val fence: String, val revision: Long, val generation: Long) {
    fun valid() = Regex("[a-f0-9]{64}").matches(fence) && revision in 1..MAX_PROCESSING_REVISION && generation in 0..MAX_PROCESSING_REVISION
}
internal data class ProcessingStage(val key: String, val state: String, val outputState: String? = null, val revision: Long? = null,
    val events: Int? = null, val overrides: Int? = null, val supported: Boolean? = null)
internal data class ProcessingPermission(val allowed: Boolean, val reason: String?, val queues: List<String>)
internal data class ProcessingStatus(val identity: ProcessingIdentity, val stages: List<ProcessingStage>, val actions: Map<ProcessingAction, ProcessingPermission>)
internal data class ProcessingIntent(val operationKey: String, val source: ProcessingIdentity, val action: ProcessingAction, val text: String? = null) {
    fun encode(): JSONObject = JSONObject().put("version", 1).put("operation_key", operationKey).put("fence", source.fence)
        .put("expected_content_revision", source.revision).put("target_generation", source.generation).put("action", action.wire)
        .also { if (text != null) it.put("text", text) }
    fun valid(): Boolean = Regex("[A-Za-z0-9._:-]{1,200}").matches(operationKey) && source.valid() &&
        (if (action == ProcessingAction.SavePrimary) source.revision < MAX_PROCESSING_REVISION && text != null && text.isNotBlank() &&
            Charsets.UTF_8.newEncoder().canEncode(text) && text.toByteArray(Charsets.UTF_8).size <= 100000 else text == null) &&
        encode().toString().toByteArray(Charsets.UTF_8).size <= 128 * 1024
}
internal sealed interface ProcessingWriteResult {
    data class Confirmed(val revision: Long, val readingQueued: Boolean, val classificationQueued: Boolean, val replayed: Boolean) : ProcessingWriteResult
    data class Rejected(val code: String) : ProcessingWriteResult
    data class Unknown(val kind: FailureKind) : ProcessingWriteResult
}
internal interface ProcessingTransport {
    suspend fun status(id: Int, token: String): RunHistoryResult<ProcessingStatus>
    suspend fun submit(id: Int, token: String, intent: ProcessingIntent): ProcessingWriteResult
}
private fun JSONObject.processingString(key: String) = (opt(key) as? String)?.takeIf { it.isNotBlank() && it.length <= 200 }
    ?: throw JSONException("invalid processing string")
private fun JSONObject.processingBoolean(key: String) = opt(key) as? Boolean ?: throw JSONException("invalid processing boolean")
private fun JSONObject.processingNumber(key: String) = nonnegativeRevision(key)?.takeIf { it <= MAX_PROCESSING_REVISION }
    ?: throw JSONException("invalid processing number")
private fun JSONObject.processingEnvelope(id: Int): Boolean {
    if (processingNumber("id") != id.toLong()) throw JSONException("foreign processing owner")
    return processingNumber("version") == 1L
}
internal fun decodeProcessingStatus(json: JSONObject, id: Int): RunHistoryResult<ProcessingStatus> {
    if (!json.processingEnvelope(id)) return RunHistoryResult.Unsupported
    if (json.processingNumber("model_calls") != 0L || json.processingNumber("max_text_bytes") != 100000L) throw JSONException("unsafe processing capability")
    val identity = ProcessingIdentity(json.processingString("fence"), json.processingNumber("content_revision"), json.processingNumber("target_generation"))
    if (!identity.valid()) throw JSONException("invalid processing identity")
    val stages = json.getJSONObject("stages")
    val values = listOf("source", "reading", "classification", "human").map { key ->
        val row = stages.getJSONObject(key)
        val output = if (key == "reading" || key == "classification") row.processingString("output_state") else null
        val revision = if (key == "human") row.processingNumber("revision") else null
        val events = if (key == "human") row.processingNumber("events").takeIf { it <= Int.MAX_VALUE }?.toInt()
            ?: throw JSONException("invalid event count") else null
        val overrides = if (key == "human") row.processingNumber("overrides").takeIf { it <= Int.MAX_VALUE }?.toInt()
            ?: throw JSONException("invalid override count") else null
        ProcessingStage(key, row.processingString("state"), output, revision, events, overrides,
            if (key == "reading") row.processingBoolean("supported") else null)
    }
    val actions = json.getJSONObject("actions")
    val permissions = ProcessingAction.entries.associateWith { action ->
        val row = actions.getJSONObject(action.wire)
        val allowed = row.processingBoolean("allowed")
        if (!row.has("blocked_reason") || row.processingNumber("model_calls_now") != 0L || !row.processingBoolean("may_call_model_later"))
            throw JSONException("incomplete processing permission")
        val reason = if (row.isNull("blocked_reason")) null else row.processingString("blocked_reason")
        if (allowed != (reason == null)) throw JSONException("inconsistent processing permission")
        val array = row.getJSONArray("queues")
        if (array.length() !in 1..2) throw JSONException("invalid processing queue count")
        val queues = List(array.length()) { index -> array.opt(index) as? String ?: throw JSONException("invalid processing queue") }
        val valid = when (action) {
            ProcessingAction.SavePrimary -> queues == listOf("classification") || queues == listOf("reading", "classification")
            ProcessingAction.RetryReading -> queues == listOf("reading")
            ProcessingAction.RetryClassification -> queues == listOf("classification")
        }
        if (!valid) throw JSONException("unbound processing queues")
        ProcessingPermission(allowed, reason, queues)
    }
    return RunHistoryResult.Loaded(ProcessingStatus(identity, values, permissions))
}
internal fun decodeProcessingIntent(json: JSONObject): ProcessingIntent {
    val action = ProcessingAction.fromWire(json.processingString("action")) ?: throw JSONException("unsupported stored processing action")
    val fields = setOf("version", "operation_key", "fence", "expected_content_revision", "target_generation", "action") +
        if (action == ProcessingAction.SavePrimary) setOf("text") else emptySet()
    if (json.keys().asSequence().toSet() != fields || json.processingNumber("version") != 1L) throw JSONException("invalid stored processing intent")
    return ProcessingIntent(json.processingString("operation_key"), ProcessingIdentity(json.processingString("fence"),
        json.processingNumber("expected_content_revision"), json.processingNumber("target_generation")), action,
        if (action == ProcessingAction.SavePrimary) json.opt("text") as? String ?: throw JSONException("missing stored primary") else null)
        .also { if (!it.valid()) throw JSONException("invalid stored processing intent") }
}
internal fun decodeProcessingReceipt(json: JSONObject, id: Int, intent: ProcessingIntent): ProcessingWriteResult.Confirmed {
    if (!json.processingEnvelope(id) || json.processingString("operation_key") != intent.operationKey || json.processingString("action") != intent.action.wire ||
        json.processingNumber("target_generation") != intent.source.generation || !Regex("[a-f0-9]{64}").matches(json.processingString("source_hash")) ||
        json.processingNumber("model_calls") != 0L) throw JSONException("unbound processing receipt")
    val primary = intent.action == ProcessingAction.SavePrimary
    val revision = json.processingNumber("content_revision")
    val reading = json.processingBoolean("reading_queued")
    val classification = json.processingBoolean("classification_queued")
    if (revision != intent.source.revision + (if (primary) 1 else 0) || revision !in 1..MAX_PROCESSING_REVISION ||
        json.processingString("status") != (if (primary) "source_saved" else "queued") || classification != (intent.action != ProcessingAction.RetryReading) ||
        !primary && reading != (intent.action == ProcessingAction.RetryReading)) throw JSONException("inconsistent processing receipt")
    return ProcessingWriteResult.Confirmed(revision, reading, classification, json.processingBoolean("replayed"))
}

internal class ProcessingClient(private val baseUrl: String) : ProcessingTransport {
    override suspend fun status(id: Int, token: String): RunHistoryResult<ProcessingStatus> = if (id < 1) RunHistoryResult.Failed(FailureKind.Server)
        else RunHistoryClient(baseUrl).read("/api/bookmarks/$id/processing", token, 128 * 1024, PROCESSING_CAPABILITY) { decodeProcessingStatus(it, id) }

    /** The repository persists first. There is deliberately no auto retry. */
    override suspend fun submit(id: Int, token: String, intent: ProcessingIntent): ProcessingWriteResult {
        if (id < 1 || !intent.valid()) return ProcessingWriteResult.Rejected("invalid_action")
        val bytes = intent.encode().toString().toByteArray(Charsets.UTF_8)
        return cancellableRead { cancellation ->
            val connection = URL("${baseUrl.trimEnd('/')}/api/bookmarks/$id/processing").openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"; connection.instanceFollowRedirects = false
                connection.connectTimeout = 10000; connection.readTimeout = 10000; connection.doOutput = true
                connection.setRequestProperty("Authorization", "Bearer ${token.trim()}")
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setRequestProperty("User-Agent", AppUserAgent.value())
                connection.setRequestProperty(PROCESSING_CAPABILITY, "1")
                connection.setFixedLengthStreamingMode(bytes.size)
                cancellation.attach(connection)
                connection.outputStream.use { it.write(bytes) }
                val status = connection.responseCode
                if (status == 401 || status == 403) return@cancellableRead ProcessingWriteResult.Unknown(FailureKind.Unauthorized)
                if (connection.getHeaderField(PROCESSING_CAPABILITY) != "1" || connection.contentLengthLong > 128 * 1024 || status !in setOf(200, 400, 404, 409, 413))
                    return@cancellableRead ProcessingWriteResult.Unknown(FailureKind.Server)
                val input = if (status == 200) connection.inputStream else connection.errorStream
                    ?: return@cancellableRead ProcessingWriteResult.Unknown(FailureKind.Server)
                val payload = input.use {
                    val buffer = ByteArray(128 * 1024 + 1); var count = 0
                    while (count < buffer.size) { val n = it.read(buffer, count, buffer.size-count); if (n < 0) break; if (n > 0) count += n }
                    if (count > 128 * 1024) throw JSONException("processing response exceeds budget")
                    Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(buffer, 0, count)).toString()
                }
                val json = JSONObject(payload)
                if (status == 200) decodeProcessingReceipt(json, id, intent) else ProcessingWriteResult.Rejected(json.processingString("error"))
            } catch (_: SocketTimeoutException) { ProcessingWriteResult.Unknown(FailureKind.Timeout)
            } catch (_: IOException) { ProcessingWriteResult.Unknown(FailureKind.Network)
            } catch (_: JSONException) { ProcessingWriteResult.Unknown(FailureKind.Server)
            } finally { cancellation.release(connection); connection.disconnect() }
        }
    }
}
