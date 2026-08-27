package com.alpenl.cairn.share.network

import com.alpenl.cairn.share.MAX_NOTE_LENGTH
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.charset.StandardCharsets
import kotlin.system.measureTimeMillis

internal enum class ApiDebugMethod {
    GET,
    POST,
    PATCH,
    DELETE,
}

internal data class ApiDebugResponse(
    val statusCode: Int,
    val statusMessage: String,
    val elapsedMillis: Long,
    val body: String,
)

internal sealed interface ApiDebugResult {
    data class Loaded(val response: ApiDebugResponse) : ApiDebugResult
    data class Failed(val message: String) : ApiDebugResult
}

internal class ApiDebugClient(
    private val baseUrl: String,
    private val connectTimeoutMillis: Int = 10_000,
    private val readTimeoutMillis: Int = 10_000,
    private val userAgent: String = AppUserAgent.value(),
) {
    fun send(method: ApiDebugMethod, path: String, body: String): ApiDebugResult {
        val endpoint = endpointFor(path) ?: return ApiDebugResult.Failed("路径必须是当前服务器下的相对路径。")
        if (body.length > MAX_REQUEST_BODY_LENGTH) {
            return ApiDebugResult.Failed("请求体太长，最多 $MAX_REQUEST_BODY_LENGTH 字。")
        }
        if (method == ApiDebugMethod.GET && body.isNotBlank()) {
            return ApiDebugResult.Failed("GET 请求不发送 JSON 请求体。")
        }

        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            var status = 0
            var statusMessage = ""
            var text = ""
            val elapsed = measureTimeMillis {
                connection.requestMethod = method.name
                connection.instanceFollowRedirects = false
                connection.connectTimeout = connectTimeoutMillis
                connection.readTimeout = readTimeoutMillis
                connection.setRequestProperty("Accept", "application/json, text/plain, */*")
                connection.setRequestProperty("User-Agent", userAgent)

                if (method in setOf(ApiDebugMethod.POST, ApiDebugMethod.PATCH)) {
                    val bytes = body.ifBlank { "{}" }.toByteArray(StandardCharsets.UTF_8)
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    connection.setFixedLengthStreamingMode(bytes.size)
                    connection.outputStream.use { it.write(bytes) }
                }
                status = connection.responseCode
                statusMessage = connection.responseMessage.orEmpty()
                text = limitedResponseBody(connection)
            }
            ApiDebugResult.Loaded(
                ApiDebugResponse(
                    statusCode = status,
                    statusMessage = statusMessage,
                    elapsedMillis = elapsed,
                    body = text,
                ),
            )
        } catch (_: SocketTimeoutException) {
            ApiDebugResult.Failed("请求超时。")
        } catch (_: IOException) {
            ApiDebugResult.Failed("请求失败。")
        } finally {
            connection.disconnect()
        }
    }

    private fun endpointFor(path: String): URL? {
        val trimmed = path.trim()
        if (trimmed.isBlank() || trimmed.startsWith("http://") || trimmed.startsWith("https://")) return null
        val base = URL(baseUrl.trimEnd('/') + "/")
        val resolved = URL(base, trimmed.removePrefix("/"))
        if (resolved.protocol != base.protocol || resolved.host != base.host || resolved.port != base.port) return null
        return resolved
    }

    private fun limitedResponseBody(connection: HttpURLConnection): String {
        val stream = runCatching {
            if (connection.responseCode >= 400) connection.errorStream else connection.inputStream
        }.getOrNull() ?: return ""
        return stream.use { input ->
            val bytes = input.readBytes()
            val limited = if (bytes.size > MAX_RESPONSE_BODY_BYTES) {
                bytes.copyOf(MAX_RESPONSE_BODY_BYTES)
            } else {
                bytes
            }
            buildString {
                append(limited.toString(StandardCharsets.UTF_8))
                if (bytes.size > MAX_RESPONSE_BODY_BYTES) {
                    append("\n\n... 响应已截断。")
                }
            }
        }
    }

    private companion object {
        const val MAX_REQUEST_BODY_LENGTH = MAX_NOTE_LENGTH * 8
        const val MAX_RESPONSE_BODY_BYTES = 64 * 1024
    }
}
