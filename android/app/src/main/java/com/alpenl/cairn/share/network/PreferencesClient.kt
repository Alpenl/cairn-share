package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.UUID
import org.json.JSONObject

/**
 * Cross-device AI tagging preferences (/api/preferences), shared with the web settings page.
 * Defaults match the Worker: they keep the classifier's existing behaviour until the user changes them.
 */
internal data class AiPreferences(
    val suggestionLimit: Int = 5,
    val confirmBeforeApply: Boolean = false,
    val lowConfidenceReview: Boolean = false,
)

internal data class PreferencesSnapshot(val value: AiPreferences, val revision: Long)

internal sealed interface PreferencesResult {
    data class Loaded(val snapshot: PreferencesSnapshot) : PreferencesResult
    /** Someone else saved first; [latest] is the server's current value. */
    data class Conflict(val latest: PreferencesSnapshot?) : PreferencesResult
    /** The server predates preferences (404) — the AI page explains instead of failing. */
    data object Unsupported : PreferencesResult
    data class Failed(val message: String, val status: Int = 0) : PreferencesResult
}

internal object PreferencesJson {
    fun parse(json: JSONObject): PreferencesSnapshot {
        val v = json.optJSONObject("value") ?: JSONObject()
        val defaults = AiPreferences()
        return PreferencesSnapshot(
            AiPreferences(
                suggestionLimit = v.optInt("ai_suggestion_limit", defaults.suggestionLimit).coerceIn(1, 8),
                confirmBeforeApply = v.optBoolean("ai_confirm_before_apply", defaults.confirmBeforeApply),
                lowConfidenceReview = v.optBoolean("ai_low_confidence_review", defaults.lowConfidenceReview),
            ),
            json.optLong("revision", 0),
        )
    }

    /** Only the changed keys go into the patch; the server rejects unknown ones. */
    fun patch(before: AiPreferences, after: AiPreferences): JSONObject = JSONObject().apply {
        if (before.suggestionLimit != after.suggestionLimit) put("ai_suggestion_limit", after.suggestionLimit)
        if (before.confirmBeforeApply != after.confirmBeforeApply) put("ai_confirm_before_apply", after.confirmBeforeApply)
        if (before.lowConfidenceReview != after.lowConfidenceReview) put("ai_low_confidence_review", after.lowConfidenceReview)
    }

    fun operation(operationKey: String, expectedRevision: Long, patch: JSONObject): JSONObject =
        JSONObject().put("operation_key", operationKey).put("expected_revision", expectedRevision).put("patch", patch)
}

internal class PreferencesClient(
    private val baseUrl: String,
    private val userAgent: String = AppUserAgent.value(),
) {
    fun load(apiToken: String): PreferencesResult = call("GET", "/api/preferences", null, apiToken)

    /** [operationKey] is reused by the caller when retrying after a lost response. */
    fun save(apiToken: String, current: PreferencesSnapshot, next: AiPreferences, operationKey: String = UUID.randomUUID().toString()): PreferencesResult {
        val patch = PreferencesJson.patch(current.value, next)
        if (patch.length() == 0) return PreferencesResult.Loaded(current)
        return call("POST", "/api/preferences/operations", PreferencesJson.operation(operationKey, current.revision, patch), apiToken)
    }

    private fun call(method: String, path: String, body: JSONObject?, apiToken: String): PreferencesResult {
        if (apiToken.isBlank()) return PreferencesResult.Failed("请先配置访问 Token")
        val connection = try { URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection }
            catch (e: Exception) { return PreferencesResult.Failed("服务器地址无效") }
        return try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", userAgent)
            connection.setRequestProperty("Authorization", "Bearer ${apiToken.trim()}")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.use { it.readBytes().toString(StandardCharsets.UTF_8) }.orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
            when {
                status in 200..299 && json != null -> PreferencesResult.Loaded(PreferencesJson.parse(json))
                status == 404 -> PreferencesResult.Unsupported
                status == 409 && json?.optString("error") == "revision_conflict" ->
                    PreferencesResult.Conflict(json.takeIf { it.has("value") }?.let(PreferencesJson::parse))
                status == 401 || status == 403 -> PreferencesResult.Failed("访问 Token 无效或已过期", status)
                else -> PreferencesResult.Failed("保存失败（HTTP $status）", status)
            }
        } catch (e: IOException) {
            PreferencesResult.Failed("网络不可用，稍后重试")
        } finally {
            connection.disconnect()
        }
    }
}
