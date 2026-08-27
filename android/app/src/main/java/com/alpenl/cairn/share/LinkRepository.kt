package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.LinkCreateResult
import com.alpenl.cairn.share.network.LinkFilter
import com.alpenl.cairn.share.network.LinkGetResult
import com.alpenl.cairn.share.network.LinkListResult
import com.alpenl.cairn.share.network.LinkMutationResult
import com.alpenl.cairn.share.network.LinkPageResult
import com.alpenl.cairn.share.network.LinksApiClient

internal class LinkRepository(apiBaseUrl: String) {
    private val client = LinksApiClient(apiBaseUrl)

    fun loadAll(): LinkListResult =
        client.listAll(LinkFilter.All, "")

    fun searchPage(query: String, beforeId: Int? = null): LinkPageResult =
        client.listPage(LinkFilter.All, query, beforeId)

    fun get(id: Int): LinkGetResult =
        client.get(id)

    fun create(url: String, note: String): LinkCreateResult =
        client.create(url, note)

    fun update(
        id: Int,
        url: String? = null,
        note: String? = null,
        learned: Boolean? = null,
    ): LinkMutationResult =
        client.update(id = id, url = url, note = note, learned = learned)

    fun delete(id: Int): LinkMutationResult =
        client.delete(id)
}
