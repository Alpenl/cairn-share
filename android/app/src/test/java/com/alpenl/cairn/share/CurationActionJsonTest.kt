package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.QueuedCurationAction
import com.alpenl.cairn.share.network.pendingActionsFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B07: the persisted offline queue round-trips and is scoped to the active
 * account/server, so a queued action for another account is never sent.
 */
class CurationActionJsonTest {

    @Test
    fun `queued actions round-trip through the persisted JSON`() {
        val actions = listOf(
            QueuedCurationAction(7, "op-1", "topics", "llm", "accept", 3, "https://share.example|abcd1234"),
            QueuedCurationAction(7, "op-2", "carriers", "single", "accept", 4, "https://share.example|abcd1234"),
            QueuedCurationAction(9, "op-3", "affordances", "", "set_empty", null, "https://other.example|zzzz9999"),
        )
        val decoded = CurationActionJson.decode(CurationActionJson.encode(actions))
        assertEquals(actions, decoded)
        assertEquals(listOf("op-1", "op-2"), pendingActionsFor(decoded, "https://share.example|abcd1234").map { it.operationKey })
        assertTrue(pendingActionsFor(decoded, "https://share.example|other").isEmpty())
    }

    @Test
    fun `a corrupt queue entry does not discard the rest`() {
        val encoded = """[{"link_id":7,"operation_key":"op-1","field":"topics","term":"llm","action":"accept"},{"bad":true}]"""
        val decoded = CurationActionJson.decode(encoded)
        assertEquals(1, decoded.size)
        assertEquals("op-1", decoded.single().operationKey)
        assertTrue(CurationActionJson.decode("not json").isEmpty())
    }

    @Test
    fun `the account key separates server and token`() {
        val first = accountKeyFor("https://share.example/", "token-aaaa")
        val second = accountKeyFor("https://share.example", "token-bbbb")
        assertEquals(first, accountKeyFor("https://share.example", "token-aaaa"))
        assertTrue(first != second)
        assertTrue(accountKeyFor("https://share.example", "first-12345678") != accountKeyFor("https://share.example", "second-12345678"))
        assertTrue(accountKeyFor("https://share.example", "first-12345678") != accountKeyFor("https://other.example", "first-12345678"))
        assertTrue(!accountKeyFor("https://share.example", "first-12345678").contains("12345678"))
        // Old records cannot distinguish these accounts; recovery must be explicit.
        assertEquals(legacyAccountKeyFor("https://share.example", "first-12345678"), legacyAccountKeyFor("https://share.example", "second-12345678"))
    }

    @Test
    fun `dependency acknowledgement and conflict survive JSON without upgrading legacy rows`() {
        val pending = QueuedCurationAction(7, "child", "topics", "llm", "reject", 4, "account",
            predecessorKey = "parent", predecessorRevision = 4, conflictRevision = 5)
        assertEquals(pending, CurationActionJson.decode(CurationActionJson.encode(listOf(pending))).single())
        val legacy = CurationActionJson.decode("""[{"link_id":7,"operation_key":"old","field":"topics","term":"llm","action":"accept","expected_revision":0,"account_key":"account"}]""").single()
        assertEquals(0, legacy.queueVersion)
        assertEquals(null, legacy.predecessorKey)
        assertEquals(null, legacy.predecessorRevision)
        assertEquals(0L, legacy.expectedRevision)
    }
}
