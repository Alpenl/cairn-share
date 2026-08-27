package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.AppUserAgent
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

internal sealed interface UpdateDownloadResult {
    data class Downloaded(val file: File) : UpdateDownloadResult
    data object Failed : UpdateDownloadResult
}

internal class UpdateApkDownloader(
    private val connectTimeoutMillis: Int = 10_000,
    private val readTimeoutMillis: Int = 60_000,
    private val userAgent: String = AppUserAgent.value(),
) {
    fun download(downloadUrl: String, versionName: String, updateDir: File): UpdateDownloadResult {
        val connection = URL(downloadUrl).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            connection.connectTimeout = connectTimeoutMillis
            connection.readTimeout = readTimeoutMillis
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive, application/octet-stream")
            connection.setRequestProperty("User-Agent", userAgent)

            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                return UpdateDownloadResult.Failed
            }

            if (!updateDir.exists() && !updateDir.mkdirs()) {
                return UpdateDownloadResult.Failed
            }

            val apkFile = File(updateDir, "cairn-share-android-${safeName(versionName)}.apk")
            val tempFile = File(updateDir, "${apkFile.name}.tmp")
            connection.inputStream.use { input ->
                tempFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            if (tempFile.length() <= 0L) {
                tempFile.delete()
                return UpdateDownloadResult.Failed
            }
            if (apkFile.exists() && !apkFile.delete()) {
                tempFile.delete()
                return UpdateDownloadResult.Failed
            }
            if (!tempFile.renameTo(apkFile)) {
                tempFile.delete()
                return UpdateDownloadResult.Failed
            }
            UpdateDownloadResult.Downloaded(apkFile)
        } catch (_: SocketTimeoutException) {
            UpdateDownloadResult.Failed
        } catch (_: IOException) {
            UpdateDownloadResult.Failed
        } finally {
            connection.disconnect()
        }
    }

    private fun safeName(value: String): String =
        value.replace(Regex("""[^A-Za-z0-9._-]"""), "_").ifBlank { "update" }
}
