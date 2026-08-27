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

internal sealed interface LinkPageResult {
    data class Loaded(val page: LinkPage) : LinkPageResult
    data class Failed(val kind: FailureKind) : LinkPageResult
}

internal data class LinkPage(
    val items: List<SavedLink>,
    val nextBeforeId: Int?,
)

internal sealed interface LinkGetResult {
    data class Loaded(val link: SavedLink) : LinkGetResult
    data object NotFound : LinkGetResult
    data class Failed(val kind: FailureKind) : LinkGetResult
}

internal sealed interface LinkCreateResult {
    data class Created(val link: SavedLink) : LinkCreateResult
    data class Failed(val kind: FailureKind) : LinkCreateResult
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
    fun list(filter: LinkFilter, query: String, apiToken: String): LinkListResult =
        listAll(filter, query, apiToken)

    fun listAll(
        filter: LinkFilter,
        query: String,
        apiToken: String,
        maxPages: Int = 50,
    ): LinkListResult {
        val collected = mutableListOf<SavedLink>()
        var beforeId: Int? = null
        repeat(maxPages) {
            when (val result = listPage(filter, query, apiToken, beforeId)) {
                is LinkPageResult.Failed -> return LinkListResult.Failed(result.kind)
                is LinkPageResult.Loaded -> {
                    collected += result.page.items
                    beforeId = result.page.nextBeforeId
                    if (beforeId == null) {
                        return LinkListResult.Loaded(collected)
                    }
                }
            }
        }
        return LinkListResult.Failed(FailureKind.Server)
    }

    fun listPage(filter: LinkFilter, query: String, apiToken: String, beforeId: Int? = null): LinkPageResult {
        val endpoint = URL(listUrl(filter, query, beforeId))
        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            configure(connection, apiToken)

            val status = connection.responseCode
            val body = responseBody(connection)
            when (status) {
                HttpURLConnection.HTTP_OK -> LinkPageResult.Loaded(LinkJson.decodePage(body))
                HttpURLConnection.HTTP_UNAUTHORIZED -> LinkPageResult.Failed(FailureKind.Unauthorized)
                else -> LinkPageResult.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            LinkPageResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            LinkPageResult.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            LinkPageResult.Failed(FailureKind.Server)
        } finally {
            connection.disconnect()
        }
    }

    fun get(id: Int, apiToken: String): LinkGetResult {
        val endpoint = URL("${baseUrl.trimEnd('/')}/api/links/$id")
        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            configure(connection, apiToken)

            val status = connection.responseCode
            val body = responseBody(connection)
            when (status) {
                HttpURLConnection.HTTP_OK -> LinkGetResult.Loaded(LinkJson.decodeLink(JSONObject(body)))
                HttpURLConnection.HTTP_NOT_FOUND -> LinkGetResult.NotFound
                HttpURLConnection.HTTP_UNAUTHORIZED -> LinkGetResult.Failed(FailureKind.Unauthorized)
                else -> LinkGetResult.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            LinkGetResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            LinkGetResult.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            LinkGetResult.Failed(FailureKind.Server)
        } finally {
            connection.disconnect()
        }
    }

    fun create(url: String, note: String, apiToken: String): LinkCreateResult {
        val endpoint = URL("${baseUrl.trimEnd('/')}/api/links")
        val body = LinkRequestJson.encode(url, note).toByteArray(StandardCharsets.UTF_8)
        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            configure(connection, apiToken)
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }

            val status = connection.responseCode
            val response = responseBody(connection)
            when (status) {
                HttpURLConnection.HTTP_CREATED -> LinkCreateResult.Created(LinkJson.decodeLink(JSONObject(response)))
                HttpURLConnection.HTTP_UNAUTHORIZED -> LinkCreateResult.Failed(FailureKind.Unauthorized)
                else -> LinkCreateResult.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            LinkCreateResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            LinkCreateResult.Failed(FailureKind.Network)
        } catch (_: JSONException) {
            LinkCreateResult.Failed(FailureKind.Server)
        } finally {
            connection.disconnect()
        }
    }

    fun update(
        id: Int,
        url: String? = null,
        note: String? = null,
        learned: Boolean? = null,
        apiToken: String,
    ): LinkMutationResult {
        val endpoint = URL("${baseUrl.trimEnd('/')}/api/links/$id")
        val body = LinkJson.encodeUpdate(url, note, learned).toByteArray(StandardCharsets.UTF_8)
        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "PATCH"
            configure(connection, apiToken)
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }

            val status = connection.responseCode
            val response = responseBody(connection)
            when (status) {
                HttpURLConnection.HTTP_OK -> LinkMutationResult.Updated(LinkJson.decodeLink(JSONObject(response)))
                HttpURLConnection.HTTP_UNAUTHORIZED -> LinkMutationResult.Failed(FailureKind.Unauthorized)
                else -> LinkMutationResult.Failed(FailureKind.Server)
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

    fun delete(id: Int, apiToken: String): LinkMutationResult {
        val endpoint = URL("${baseUrl.trimEnd('/')}/api/links/$id")
        val connection = endpoint.openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "DELETE"
            configure(connection, apiToken)
            val status = connection.responseCode
            responseBody(connection)
            when (status) {
                HttpURLConnection.HTTP_NO_CONTENT -> LinkMutationResult.Deleted
                HttpURLConnection.HTTP_UNAUTHORIZED -> LinkMutationResult.Failed(FailureKind.Unauthorized)
                else -> LinkMutationResult.Failed(FailureKind.Server)
            }
        } catch (_: SocketTimeoutException) {
            LinkMutationResult.Failed(FailureKind.Timeout)
        } catch (_: IOException) {
            LinkMutationResult.Failed(FailureKind.Network)
        } finally {
            connection.disconnect()
        }
    }

    private fun listUrl(filter: LinkFilter, query: String, beforeId: Int?): String {
        val params = mutableListOf(
            "limit=100",
            "learned=${filter.apiValue}",
        )
        if (beforeId != null) {
            params += "before_id=$beforeId"
        }
        val trimmed = query.trim()
        if (trimmed.isNotEmpty()) {
            params += "q=${URLEncoder.encode(trimmed, "UTF-8")}"
        }
        return "${baseUrl.trimEnd('/')}/api/links?${params.joinToString("&")}"
    }

    private fun configure(connection: HttpURLConnection, apiToken: String) {
        connection.connectTimeout = connectTimeoutMillis
        connection.readTimeout = readTimeoutMillis
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("User-Agent", userAgent)
        if (apiToken.isNotBlank()) {
            connection.setRequestProperty("Authorization", "Bearer ${apiToken.trim()}")
        }
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
        return decodePage(json).items
    }

    fun decodePage(json: String): LinkPage {
        val page = JSONObject(json)
        val items = page.optJSONArray("items") ?: JSONArray()
        return LinkPage(
            items = List(items.length()) { index ->
                decodeLink(items.getJSONObject(index))
            },
            nextBeforeId = page.opt("next_before_id")
                ?.takeUnless { it == JSONObject.NULL }
                ?.let {
                    when (it) {
                        is Number -> it.toInt()
                        is String -> it.toIntOrNull()
                        else -> null
                    }
                },
        )
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
