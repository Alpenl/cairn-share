package com.alpenl.cairn.share.network

import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class QueryPageCacheTest {
    private val time = Instant.parse("2026-10-01T00:00:00Z")
    private fun key(account: String = "a", topic: String = "llm", query: String = "", before: Int? = null) =
        QueryPageKey.of(account, LinkFilter.All, query, before, BookmarkFilters(topics = listOf(topic)), time)
    private fun page(id: Int) = LinkPage(listOf(SavedLink(id, "https://example.com/$id", "", "now", false, null)), null)

    @Test fun `account query paging and every effective filter participate in key`() {
        val cache = QueryPageCache()
        cache.put(key(), page(1))
        assertEquals(1, cache.get(key())!!.items.single().id)
        for (other in listOf(key("b"), key(topic = "design"), key(query = "keyword"), key(before = 9))) assertNull(cache.get(other))
        val all = QueryPageKey.of("a", LinkFilter.All, "", null, BookmarkFilters(topics = listOf("llm"), topicsMode = "all"), time)
        assertNull(cache.get(all))
    }
    @Test fun `ttl expires exactly and access order bounds retained pages`() {
        var now = 0L
        val cache = QueryPageCache({ now }, capacity = 2)
        cache.put(key(topic = "one"), page(1)); cache.put(key(topic = "two"), page(2))
        assertNotNull(cache.get(key(topic = "one")))
        cache.put(key(topic = "three"), page(3))
        assertNull(cache.get(key(topic = "two")))
        now = 9_999; assertNotNull(cache.get(key(topic = "one")))
        now = 10_000; assertNull(cache.get(key(topic = "one")))
    }
    @Test fun `mutation invalidation prevents late reads from repopulating stale membership`() {
        val cache = QueryPageCache()
        val old = cache.version()
        cache.clear(); cache.put(key(), page(1), old)
        assertNull(cache.get(key()))
        cache.put(key(), page(2), cache.version())
        assertEquals(2, cache.get(key())!!.items.single().id)
    }
    @Test fun `relative time window remains frozen for pages and different windows cannot mix`() {
        val filter = BookmarkFilters(recentDays = 7)
        assertNotEquals(QueryPageKey.of("a", LinkFilter.All, "", null, filter, time),
            QueryPageKey.of("a", LinkFilter.All, "", null, filter, time.plusSeconds(1)))
    }
}
