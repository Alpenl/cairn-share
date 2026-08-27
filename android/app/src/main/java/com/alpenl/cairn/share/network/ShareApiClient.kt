package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.charset.StandardCharsets

internal sealed interface ShareSubmitResult {
    data object Saved : ShareSubmitResult
    data class Failed(val kind: FailureKind) : ShareSubmitResult
}

internal enum class FailureKind {
    Network,
    Timeout,
    Server,
}

internal class ShareApiClient(
    private val baseUrl: String,
    private val connectTimeoutMillis: Int = 10_000,
    private val readTimeoutMillis: Int = 10_000,
    private val userAgent: String = AppUserAgent.value(),
) {
    fun save(url: String, note: String): ShareSubmitResult {
        val endpoint = URL(baseUrl.trimEnd('/') + "/api/links")
        val body = LinkRequestJson.encode(url, note).toByteArray(StandardCharsets.UTF_8)
        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = connectTimeoutMillis
            connection.readTimeout = readTimeoutMillis
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", userAgent)
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }

            val status = connection.responseCode
            drainResponse(connection)
            if (status == HttpURLConnection.HTTP_CREATED) {
                ShareSubmitResult.Saved
            } else {
                ShareSubmitResult.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            ShareSubmitResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            ShareSubmitResult.Failed(FailureKind.Network)
        } finally {
            connection.disconnect()
        }
    }

    private fun drainResponse(connection: HttpURLConnection) {
        val stream = runCatching {
            if (connection.responseCode >= 400) connection.errorStream else connection.inputStream
        }.getOrNull()
        stream?.use { it.readBytes() }
    }
}
