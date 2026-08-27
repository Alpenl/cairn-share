package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

internal data class SavedLink(
    val id: Int,
    val url: String,
    val note: String,
    val createdAt: String,
    val learned: Boolean,
    val learnedAt: String?,
)

internal enum class LinkFilter(val apiValue: String) {
    Unlearned("false"),
    Learned("true"),
    All("all"),
}

internal sealed interface LinkListResult {
    data class Loaded(val items: List<SavedLink>) : LinkListResult
    data class Failed(val kind: FailureKind) : LinkListResult
}

internal sealed interface LinkMutationResult {
    data class Updated(val link: SavedLink) : LinkMutationResult
    data object Deleted : LinkMutationResult
    data class Failed(val kind: FailureKind) : LinkMutationResult
}

internal class LinksApiClient(
    private val baseUrl: String,
    private val connectTimeoutMillis: Int = 10_000,
    private val readTimeoutMillis: Int = 10_000,
    private val userAgent: String = AppUserAgent.value(),
) {
    fun list(filter: LinkFilter, query: String): LinkListResult {
        val endpoint = URL(listUrl(filter, query))
        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            configure(connection)

            val status = connection.responseCode
            val body = responseBody(connection)
            if (status == HttpURLConnection.HTTP_OK) {
                LinkListResult.Loaded(LinkJson.decodeList(body))
            } else {
                LinkListResult.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            LinkListResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            LinkListResult.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            LinkListResult.Failed(FailureKind.Server)
        } finally {
            connection.disconnect()
        }
    }

    fun update(
        id: Int,
        url: String? = null,
        note: String? = null,
        learned: Boolean? = null,
    ): LinkMutationResult {
        val endpoint = URL("${baseUrl.trimEnd('/')}/api/links/$id")
        val body = LinkJson.encodeUpdate(url, note, learned).toByteArray(StandardCharsets.UTF_8)
        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "PATCH"
            configure(connection)
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }

            val status = connection.responseCode
            val response = responseBody(connection)
            if (status == HttpURLConnection.HTTP_OK) {
                LinkMutationResult.Updated(LinkJson.decodeLink(JSONObject(response)))
            } else {
                LinkMutationResult.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            LinkMutationResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            LinkMutationResult.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            LinkMutationResult.Failed(FailureKind.Server)
        } finally {
            connection.disconnect()
        }
    }

    fun delete(id: Int): LinkMutationResult {
        val endpoint = URL("${baseUrl.trimEnd('/')}/api/links/$id")
        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "DELETE"
            configure(connection)
            val status = connection.responseCode
            responseBody(connection)
            if (status == HttpURLConnection.HTTP_NO_CONTENT) {
                LinkMutationResult.Deleted
            } else {
                LinkMutationResult.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            LinkMutationResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            LinkMutationResult.Failed(FailureKind.Network)
        } finally {
            connection.disconnect()
        }
    }

    private fun listUrl(filter: LinkFilter, query: String): String {
        val params = mutableListOf(
            "limit=100",
            "learned=${filter.apiValue}",
        )
        val trimmed = query.trim()
        if (trimmed.isNotEmpty()) {
            params += "q=${URLEncoder.encode(trimmed, "UTF-8")}"
        }
        return "${baseUrl.trimEnd('/')}/api/links?${params.joinToString("&")}"
    }

    private fun configure(connection: HttpURLConnection) {
        connection.connectTimeout = connectTimeoutMillis
        connection.readTimeout = readTimeoutMillis
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("User-Agent", userAgent)
    }

    private fun responseBody(connection: HttpURLConnection): String {
        val stream = runCatching {
            if (connection.responseCode >= 400) connection.errorStream else connection.inputStream
        }.getOrNull()
        return stream?.use { it.reader(Charsets.UTF_8).readText() }.orEmpty()
    }
}

internal object LinkJson {
    fun encodeUpdate(url: String?, note: String?, learned: Boolean?): String {
        val json = JSONObject()
        url?.let { json.put("url", it) }
        note?.let { json.put("note", it) }
        learned?.let { json.put("learned", it) }
        return json.toString()
    }

    fun decodeList(json: String): List<SavedLink> {
        val items = JSONObject(json).optJSONArray("items") ?: JSONArray()
        return List(items.length()) { index ->
            decodeLink(items.getJSONObject(index))
        }
    }

    fun decodeLink(json: JSONObject): SavedLink =
        SavedLink(
            id = json.getInt("id"),
            url = json.getString("url"),
            note = json.optString("note"),
            createdAt = json.getString("created_at"),
            learned = json.getBoolean("learned"),
            learnedAt = json.optString("learned_at").takeUnless { it.isBlank() || it == "null" },
        )
}
