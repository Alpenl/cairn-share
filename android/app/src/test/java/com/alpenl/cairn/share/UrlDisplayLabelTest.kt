package com.alpenl.cairn.share

import com.alpenl.cairn.share.contract.UrlCandidateExtractor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class UrlDisplayLabelTest {
    @Test
    fun labelIsLowercasedHostWithNonDefaultPortAndRawPath() {
        val table = listOf(
            "https://example.com/article" to "example.com/article",
            "https://example.com" to "example.com/",
            "HTTPS://Example.COM/Keep%2FCase" to "example.com/Keep%2FCase",
            "https://example.com/%E6%B5%8B%E8%AF%95" to "example.com/%E6%B5%8B%E8%AF%95",
            "https://example.com:443/x" to "example.com/x",
            "http://example.com:80/x" to "example.com/x",
            "https://example.com:8443/x" to "example.com:8443/x",
            "http://192.168.1.10:8080/status" to "192.168.1.10:8080/status",
            "https://[2001:DB8::1]/v6" to "[2001:db8::1]/v6",
        )

        for ((url, expected) in table) {
            assertEquals(url, expected, labelOf(url))
        }
    }

    @Test
    fun labelNeverLeaksSchemeQueryOrFragment() {
        for (url in listOf(
            "https://example.com/search?q=secret&access_token=abc123#section",
            "HTTP://Example.com:8080/Path%20One?session=zzz#tail",
            "https://[2001:db8::1]:9443/v6?k=v#f",
        )) {
            val label = labelOf(url)
            assertFalse(url, label.contains("://"))
            assertFalse(url, label.contains("?"))
            assertFalse(url, label.contains("#"))
            assertFalse(url, label.contains("secret"))
            assertFalse(url, label.contains("session"))
        }
    }

    @Test
    fun urlsWithoutAUsableHostNeverBecomeCandidate() {
        for (url in listOf("http:///missing-host", "not a url", "https://exa mple.com/a")) {
            assertEquals(
                url,
                emptyList<String>(),
                UrlCandidateExtractor.extract(sharePayload(intentDataUrl = url)).map { it.displayLabel },
            )
        }
    }

    private fun labelOf(url: String): String =
        UrlCandidateExtractor.extract(sharePayload(intentDataUrl = url)).single().displayLabel
}
