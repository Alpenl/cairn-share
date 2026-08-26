package com.alpenl.cairn.share.contract

import java.util.Locale

object UrlDisplayLabel {
    private const val DEFAULT_HTTP_PORT = 80
    private const val DEFAULT_HTTPS_PORT = 443

    fun render(host: String, port: Int, scheme: String?, rawPath: String?): String = buildString {
        append(host.lowercase(Locale.ROOT))
        if (port != -1 && port != defaultPortFor(scheme)) {
            append(':').append(port)
        }
        append(if (rawPath.isNullOrEmpty()) "/" else rawPath)
    }

    private fun defaultPortFor(scheme: String?): Int =
        when (scheme?.lowercase(Locale.ROOT)) {
            "http" -> DEFAULT_HTTP_PORT
            "https" -> DEFAULT_HTTPS_PORT
            else -> -1
        }
}
