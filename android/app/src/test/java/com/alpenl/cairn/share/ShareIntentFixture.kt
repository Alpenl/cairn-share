package com.alpenl.cairn.share

import com.alpenl.cairn.share.contract.SharePayload

internal data class ClipItem(val uri: String? = null, val text: String? = null)

internal fun sharePayload(
    intentDataUrl: String? = null,
    extraText: String? = null,
    clipItems: List<ClipItem> = emptyList(),
): SharePayload = NativeShareSources.payload(
    intentDataUrl = intentDataUrl,
    clipItemCount = clipItems.size,
    clipUriAt = { index -> clipItems[index].uri },
    extraText = extraText,
    clipTextAt = { index -> clipItems[index].text },
)
