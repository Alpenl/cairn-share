package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import org.json.JSONObject

internal data class SyncMedia(val linkId: Int, val key: String, val version: String, val bytes: Long, val available: Boolean)
internal data class LibrarySyncPage(val cursor: String, val epoch: String, val snapshot: Boolean, val more: Boolean,
    val items: List<SavedLink>, val deleted: List<Int>, val media: List<SyncMedia>, val taxonomy: BookmarkTaxonomy?)
internal sealed interface LibrarySyncResult {
    data class Page(val value: LibrarySyncPage) : LibrarySyncResult
    data object Reset : LibrarySyncResult
    data object Unsupported : LibrarySyncResult
    data object Unauthorized : LibrarySyncResult
    data object Failed : LibrarySyncResult
}
internal class LibrarySyncClient(private val baseUrl: String) {
    suspend fun page(token: String, cursor: String?): LibrarySyncResult = cancellableRead { cancellation ->
        val query = cursor?.let { "?cursor=${URLEncoder.encode(it, "UTF-8")}" }.orEmpty()
        val connection = URL("${baseUrl.trimEnd('/')}/api/sync$query").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10_000; connection.readTimeout = 30_000
            connection.setRequestProperty("Authorization", "Bearer $token")
            for (header in listOf("X-Cairn-Sync", "X-Cairn-Tag-System", "X-Cairn-Content-Functions", "X-Cairn-Topic-Granularity")) connection.setRequestProperty(header, "1")
            cancellation.attach(connection)
            when (connection.responseCode) {
                401, 403 -> LibrarySyncResult.Unauthorized
                404, 405 -> LibrarySyncResult.Unsupported
                409 -> if (connection.errorStream?.bufferedReader()?.use { JSONObject(it.readText()).optString("error") } == "reset_required") LibrarySyncResult.Reset else LibrarySyncResult.Unsupported
                200 -> {
                    if (connection.getHeaderField("X-Cairn-Sync") != "1") return@cancellableRead LibrarySyncResult.Unsupported
                    val body = connection.inputStream.use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        while (true) {
                            val count = input.read(buffer); if (count < 0) break
                            if (output.size() + count > 40 * 1024 * 1024) throw IOException("Sync page too large")
                            output.write(buffer, 0, count)
                        }
                        output.toString("UTF-8")
                    }
                    LibrarySyncResult.Page(decode(JSONObject(body)))
                }
                else -> LibrarySyncResult.Failed
            }
        } catch (_: IOException) { LibrarySyncResult.Failed }
        catch (_: org.json.JSONException) { LibrarySyncResult.Failed }
        catch (_: IllegalArgumentException) { LibrarySyncResult.Failed }
        finally { cancellation.release(connection); connection.disconnect() }
    }
    private fun decode(json: JSONObject): LibrarySyncPage {
        require(json.getInt("protocol_version") == 1)
        val cursor = json.getString("cursor"); val epoch = json.getString("epoch"); val mode = json.getString("mode")
        require(cursor.isNotBlank() && epoch.isNotBlank() && mode in listOf("snapshot", "changes"))
        val mediaJson = json.getJSONArray("media")
        val media = List(mediaJson.length()) { i -> mediaJson.getJSONObject(i).let { row ->
            val id = row.getInt("link_id"); val key = row.getString("key"); val version = row.getString("version"); val bytes = row.getLong("bytes")
            require(id > 0 && Regex("enrichment/$id/[0-9a-f]{64}\\.(jpg|png|webp|gif|avif)").matches(key) && version.isNotBlank() && bytes in 0..15L * 1024 * 1024)
            SyncMedia(id, key, version, bytes, row.getBoolean("available"))
        } }
        val rows = json.getJSONArray("items")
        val items = List(rows.length()) { i ->
            val link = LinkJson.decodeLink(rows.getJSONObject(i)); require(link.id > 0 && link.enrichment?.cacheIdentity != null)
            link.copy(enrichment = link.enrichment!!.copy(imageVersions = media.filter { it.linkId == link.id }.associate { it.key to it.version }))
        }
        val deletes = json.getJSONArray("deleted"); val deleted = List(deletes.length()) { deletes.getInt(it).also { id -> require(id > 0) } }
        require(items.map { it.id }.distinct().size == items.size && items.none { it.id in deleted })
        require(media.map { it.key }.distinct().size == media.size)
        require(items.all { link -> link.enrichment!!.imageKeys.toSet() == media.filter { it.linkId == link.id }.map { it.key }.toSet() })
        require(media.all { m -> items.any { it.id == m.linkId && m.key in it.enrichment!!.imageKeys } })
        return LibrarySyncPage(cursor, epoch, mode == "snapshot", json.getBoolean("has_more"), items, deleted, media,
            json.optJSONObject("taxonomy")?.let { decodeTaxonomy(it, topicGranularity = true) })
    }
}
