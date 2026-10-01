package com.alpenl.cairn.share.network

import java.time.Instant

/** Exact, short-lived read cache. The credential is hashed outside this class. */
internal data class QueryPageKey(
    val account: String, val learned: LinkFilter, val query: String, val beforeId: Int?,
    val parameters: List<Pair<String, String>>,
) {
    companion object {
        fun of(account: String, learned: LinkFilter, query: String, beforeId: Int?, filters: BookmarkFilters, time: Instant) =
            QueryPageKey(account, learned, query.trim(), beforeId, filters.parameters(time).toList().sortedWith(compareBy({ it.first }, { it.second })))
    }
}

internal class QueryPageCache(private val now: () -> Long = { System.nanoTime() / 1_000_000 }, private val capacity: Int = 12, private val ttlMillis: Long = 10_000) {
    private data class Entry(val page: LinkPage, val time: Long)
    private val pages = LinkedHashMap<QueryPageKey, Entry>(16, 0.75f, true)
    private var generation = 0L
    @Synchronized fun version(): Long = generation
    @Synchronized fun get(key: QueryPageKey): LinkPage? {
        val entry = pages[key] ?: return null
        if (now() - entry.time >= ttlMillis) { pages.remove(key); return null }
        return entry.page
    }
    @Synchronized fun put(key: QueryPageKey, page: LinkPage, expectedVersion: Long = generation) {
        if (expectedVersion != generation) return
        // Legacy services may send full archives in a list. Do not retain
        // those unbounded bodies in this small query cache.
        if (page.items.any { it.enrichment?.contentLoaded == true }) return
        pages[key] = Entry(page, now())
        while (pages.size > capacity) pages.remove(pages.keys.first())
    }
    @Synchronized fun clear() { generation += 1; pages.clear() }
}
