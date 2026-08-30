package com.alpenl.cairn.share

import com.alpenl.cairn.share.contract.UrlDisplayLabel
import com.alpenl.cairn.share.network.SavedLink
import java.net.URI
import java.net.URL
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

internal const val MAX_URL_LENGTH = 8192
internal const val MAX_NOTE_LENGTH = 2000

private val ShortDateTimeFormatter: DateTimeFormatter =
    DateTimeFormatter.ofPattern("MM-dd HH:mm", Locale.ROOT)

internal fun SavedLink.displayTitle(): String =
    runCatching {
        val parsed = URL(url)
        UrlDisplayLabel.render(
            host = parsed.host,
            port = parsed.port,
            scheme = parsed.protocol,
            rawPath = parsed.path,
        )
    }.getOrDefault(url)

internal fun SavedLink.hostLabel(): String = url.hostLabel()

internal fun String.hostLabel(): String =
    runCatching {
        URL(this).host.removePrefix("www.").ifBlank { this }
    }.getOrDefault(this)

internal fun String.shortDateTime(): String =
    parseInstantOrNull(this)
        ?.atZone(ZoneId.systemDefault())
        ?.format(ShortDateTimeFormatter)
        ?: if (length >= 16 && this[10] == 'T') {
            "${substring(5, 10)} ${substring(11, 16)}"
        } else {
            this
        }

internal fun Long.shortDateTime(): String =
    runCatching {
        Instant.ofEpochMilli(this)
            .atZone(ZoneId.systemDefault())
            .format(ShortDateTimeFormatter)
    }.getOrDefault("未知时间")

internal fun parseInstantOrNull(value: String): Instant? =
    runCatching { Instant.parse(value) }.getOrNull()

internal fun validateHttpUrl(value: String): Boolean {
    if (value.isBlank() || value.length > MAX_URL_LENGTH) return false
    return runCatching {
        val uri = URI(value.trim())
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        scheme in setOf("http", "https") &&
            uri.host?.isNotBlank() == true &&
            uri.userInfo == null
    }.getOrDefault(false)
}

internal fun removeQueryAndFragment(value: String): String =
    runCatching {
        val uri = URI(value.trim())
        buildString {
            append(uri.scheme.lowercase(Locale.ROOT)).append("://").append(uri.rawAuthority)
            append(uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/")
        }
    }.getOrDefault(value.trim())
