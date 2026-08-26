package com.alpenl.cairn.share

import com.alpenl.cairn.share.contract.SharePayload

internal object NativeShareSources {
    fun payload(
        intentDataUrl: String?,
        clipItemCount: Int,
        clipUriAt: (Int) -> String?,
        extraText: String?,
        clipTextAt: (Int) -> String?,
    ): SharePayload = SharePayload(
        structuredUrls = buildList {
            intentDataUrl?.takeIf(::isHttpUrl)?.let(::add)
            for (index in 0 until clipItemCount) {
                clipUriAt(index)?.takeIf(::isHttpUrl)?.let(::add)
            }
        },
        texts = buildList {
            extraText?.let(::add)
            for (index in 0 until clipItemCount) {
                clipTextAt(index)?.takeIf(String::isNotBlank)?.let(::add)
            }
        },
    )

    private fun isHttpUrl(value: String): Boolean =
        value.startsWith("http://", ignoreCase = true) || value.startsWith("https://", ignoreCase = true)
}
