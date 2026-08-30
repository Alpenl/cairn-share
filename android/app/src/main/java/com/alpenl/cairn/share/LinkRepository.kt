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

    fun loadAll(apiToken: String): LinkListResult =
        client.listAll(LinkFilter.All, "", apiToken)

    fun searchPage(query: String, apiToken: String, beforeId: Int? = null): LinkPageResult =
        client.listPage(LinkFilter.All, query, apiToken, beforeId)

    fun get(id: Int, apiToken: String): LinkGetResult =
        client.get(id, apiToken)

    fun create(url: String, note: String, apiToken: String, clientId: String? = null): LinkCreateResult =
        client.create(url, note, apiToken, clientId)

    fun update(
        id: Int,
        url: String? = null,
        note: String? = null,
        learned: Boolean? = null,
        apiToken: String,
    ): LinkMutationResult =
        client.update(id = id, url = url, note = note, learned = learned, apiToken = apiToken)

    fun delete(id: Int, apiToken: String): LinkMutationResult =
        client.delete(id, apiToken)
}
