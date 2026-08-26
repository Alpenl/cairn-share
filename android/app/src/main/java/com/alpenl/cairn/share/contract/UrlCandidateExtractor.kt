package com.alpenl.cairn.share.contract

import java.net.URI
import java.util.Locale

object UrlCandidateExtractor {
    private val urlRegex = Regex("(?i)https?://[^\\s<>\\\"'\\u2018-\\u201f\\u3000-\\u303f\\uff00-\\uffef\\u4e00-\\u9fff]+")
    private val leadingWrappers = setOf('(', '[', '{', '<', '\u3008', '\u300a', '\u300c', '\u300e')
    private val trailingWrappers = setOf(')', ']', '}', '>', '\u3009', '\u300b', '\u300d', '\u300f')
    private val sentencePunctuation = setOf(
        '.', ',', '!', '?', ';', ':', '#',
        '\u3002', '\uff0c', '\u3001', '\uff01', '\uff1f', '\u061f',
        '\u2026', '*', '`',
    )
    private val httpSchemes = setOf("http", "https")

    fun extract(payload: SharePayload): List<UrlCandidate> {
        val values = buildList {
            payload.structuredUrls.forEach { add(it) }
            payload.texts.forEach { text ->
                urlRegex.findAll(text).forEach { add(it.value) }
            }
        }
        val candidates = ArrayList<UrlCandidate>()
        val seen = HashSet<String>()
        values.forEach { raw ->
            val candidate = normalizeCandidate(raw) ?: return@forEach
            if (seen.add(deduplicationKey(candidate.submissionValue))) {
                candidates += candidate
            }
        }
        return candidates
    }

    private fun normalizeCandidate(raw: String): UrlCandidate? {
        var value = raw.trim()
        while (value.isNotEmpty() && value.first() in leadingWrappers) {
            value = value.drop(1)
        }
        while (value.isNotEmpty() && value.last() in trailingWrappers) {
            value = value.dropLast(1)
        }
        while (value.isNotEmpty() && value.last() in sentencePunctuation) {
            value = value.dropLast(1)
            while (value.isNotEmpty() && value.last() in trailingWrappers) {
                value = value.dropLast(1)
            }
        }
        if (!value.startsWith("http://", ignoreCase = true) &&
            !value.startsWith("https://", ignoreCase = true)
        ) {
            return null
        }
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (uri.userInfo != null) return null
        if (uri.scheme?.lowercase(Locale.ROOT) !in httpSchemes) return null
        val host = uri.host ?: return null
        return UrlCandidate(
            submissionValue = value,
            displayLabel = UrlDisplayLabel.render(host, uri.port, uri.scheme, uri.rawPath),
        )
    }

    private fun deduplicationKey(value: String): String {
        val uri = URI(value)
        val scheme = uri.scheme.lowercase(Locale.ROOT)
        val host = uri.host.lowercase(Locale.ROOT)
        val authority = buildString {
            append(host)
            if (uri.port != -1) append(':').append(uri.port)
        }
        return buildString {
            append(scheme).append("://").append(authority)
            uri.rawPath?.let(::append)
            uri.rawQuery?.let { append('?').append(it) }
            uri.rawFragment?.let { append('#').append(it) }
        }
    }
}
