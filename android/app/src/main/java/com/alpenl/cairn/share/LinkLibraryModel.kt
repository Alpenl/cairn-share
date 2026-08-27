package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.LinkFilter
import com.alpenl.cairn.share.network.SavedLink

internal data class LinkLibraryModel(
    val filter: LinkFilter,
    val searchQuery: String,
    val items: List<SavedLink>,
    val loading: Boolean,
    val statusText: String,
    val editing: LinkEditModel?,
)

internal data class LinkEditModel(
    val link: SavedLink,
    val url: String,
    val note: String,
    val saving: Boolean,
)
