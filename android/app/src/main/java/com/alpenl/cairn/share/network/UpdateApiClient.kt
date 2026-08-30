package com.alpenl.cairn.share.network

import com.alpenl.cairn.share.BuildConfig
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import org.json.JSONException
import org.json.JSONObject

internal data class AppUpdateInfo(
    val versionName: String,
    val releaseUrl: String,
    val downloadUrl: String,
    val releaseNotes: String,
)

internal sealed interface UpdateCheckResult {
    data class Available(val update: AppUpdateInfo) : UpdateCheckResult
    data object UpToDate : UpdateCheckResult
    data object Failed : UpdateCheckResult
}

internal class UpdateApiClient(
    private val releasesApiUrl: String = DEFAULT_RELEASES_API_URL,
    private val currentVersionName: String = BuildConfig.VERSION_NAME,
    private val connectTimeoutMillis: Int = 10_000,
    private val readTimeoutMillis: Int = 10_000,
    private val userAgent: String = AppUserAgent.value(),
) {
    companion object {
        const val DEFAULT_RELEASES_API_URL = "https://api.github.com/repos/Alpenl/cairn-share/releases/latest"
    }

    fun check(): UpdateCheckResult {
        val connection = URL(releasesApiUrl).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            connection.connectTimeout = connectTimeoutMillis
            connection.readTimeout = readTimeoutMillis
            connection.setRequestProperty("Accept", "application/vnd.github+json")
            connection.setRequestProperty("User-Agent", userAgent)

            val status = connection.responseCode
            val body = responseBody(connection)
            if (status != HttpURLConnection.HTTP_OK) {
                UpdateCheckResult.Failed
            } else {
                ReleaseUpdateParser.parse(currentVersionName, body)
            }
        } catch (_: SocketTimeoutException) {
            UpdateCheckResult.Failed
        } catch (_: IOException) {
            UpdateCheckResult.Failed
        } finally {
            connection.disconnect()
        }
    }

    private fun responseBody(connection: HttpURLConnection): String {
        val stream = runCatching {
            if (connection.responseCode >= 400) connection.errorStream else connection.inputStream
        }.getOrNull()
        return stream?.use { it.reader(Charsets.UTF_8).readText() }.orEmpty()
    }
}

internal object ReleaseUpdateParser {
    fun parse(currentVersionName: String, json: String): UpdateCheckResult =
        try {
            val release = JSONObject(json)
            val latestVersionName = release.optString("tag_name")
                .trim()
                .removePrefix("v")
                .removePrefix("V")
            val releaseUrl = release.optString("html_url").trim()
            val downloadUrl = apkDownloadUrl(release).ifBlank { releaseUrl }
            val releaseNotes = (release.opt("body") as? String).orEmpty()
                .replace("\r\n", "\n")
                .trim()
                .take(MAX_RELEASE_NOTES_LENGTH)
                .ifBlank { "此版本未提供更新说明。" }

            if (releaseUrl.isBlank() || downloadUrl.isBlank() || SemVer.compare(latestVersionName, currentVersionName) <= 0) {
                UpdateCheckResult.UpToDate
            } else {
                UpdateCheckResult.Available(
                    AppUpdateInfo(
                        versionName = latestVersionName,
                        releaseUrl = releaseUrl,
                        downloadUrl = downloadUrl,
                        releaseNotes = releaseNotes,
                    ),
                )
            }
        } catch (_: JSONException) {
            UpdateCheckResult.Failed
        } catch (_: IllegalArgumentException) {
            UpdateCheckResult.Failed
        }

    private fun apkDownloadUrl(release: JSONObject): String {
        val assets = release.optJSONArray("assets") ?: return ""
        for (index in 0 until assets.length()) {
            val asset = assets.optJSONObject(index) ?: continue
            val name = asset.optString("name")
            if (name.endsWith(".apk", ignoreCase = true)) {
                return asset.optString("browser_download_url").trim()
            }
        }
        return ""
    }

    private const val MAX_RELEASE_NOTES_LENGTH = 20_000
}

internal object SemVer {
    private val pattern = Regex("""^(\d+)\.(\d+)\.(\d+)$""")

    fun compare(left: String, right: String): Int {
        val leftParts = parts(left)
        val rightParts = parts(right)
        for (index in 0..2) {
            val diff = leftParts[index] - rightParts[index]
            if (diff != 0) return diff
        }
        return 0
    }

    private fun parts(versionName: String): List<Int> {
        val match = pattern.matchEntire(versionName.trim())
            ?: throw IllegalArgumentException("versionName must match X.Y.Z")
        return match.destructured.toList().map(String::toInt)
    }
}
