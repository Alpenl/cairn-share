package com.alpenl.cairn.share.network

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

/**
 * B07: the shared action semantics and the offline replay path. These tests are
 * pure JVM tests: the transport is faked, so they prove the repository logic
 * without a device.
 */
class V2CurationRepositoryTest {

    private class FakeTransport(
        var loadResult: V2Result<MultidimensionalSelection> = V2Result.Failed(FailureKind.Network),
        var applyResults: MutableList<V2Result<JSONObject>> = mutableListOf(),
        val identify: Boolean = true,
    ) : V2Transport {
        val overrides = mutableListOf<FieldOverride>()
        override fun loadSelection(id: Int, apiToken: String) = loadResult
        override fun applyOverride(id: Int, override: FieldOverride, apiToken: String): V2Result<JSONObject> {
            overrides.add(override)
            val result = if (applyResults.isEmpty()) V2Result.Loaded(JSONObject().put("revision", 5))
            else applyResults.removeAt(0)
            if (identify && result is V2Result.Loaded) result.value.put("id", id).put("field", override.field)
                .put("term", override.term).put("action", override.action).put("operation_key", override.operationKey).put("replayed", false)
            return result
        }
        override fun loadTaxonomy(apiToken: String) = V2Result.Unsupported
    }

    private class MemoryQueue(var actions: List<QueuedCurationAction>) : CurationQueue {
        override suspend fun snapshot() = actions
        override suspend fun acknowledge(action: QueuedCurationAction, revision: Long) {
            actions = actions.filterNot { it.operationKey == action.operationKey }.map {
                if (it.predecessorKey == action.operationKey) it.copy(expectedRevision = revision, predecessorRevision = revision) else it
            }
        }
        override suspend fun conflict(action: QueuedCurationAction, revision: Long) {
            actions = actions.map { if (it.operationKey == action.operationKey) it.copy(conflictRevision = revision) else it }
        }
    }

    @Test
    fun `a missing automatic baseline never previews human values as a confirmed reset`() {
        val repo = V2CurationRepository(FakeTransport())
        val human = selection(topics = listOf("eng"), carriers = listOf("single"))
        val pending = repo.applyLocal(human, null, "topics", "", "reset")
        assertEquals(setOf("topics"), pending.unknownResetFields)
        val uncertainAccept = repo.applyLocal(pending, null, "topics", "llm", "accept")
        assertTrue("topics" in uncertainAccept.unknownResetFields)
        val explicitEmpty = repo.applyLocal(pending, null, "topics", "", "set_empty")
        assertTrue(explicitEmpty.unknownResetFields.isEmpty())
        assertTrue(explicitEmpty.topics.isEmpty())
        val known = repo.applyLocal(human, selection(topics = listOf("llm")), "topics", "", "reset")
        assertEquals(listOf("llm"), known.topics)
        assertTrue(known.unknownResetFields.isEmpty())
    }

    private fun selection(
        topics: List<String> = emptyList(),
        contentFunctions: List<String> = emptyList(),
        carriers: List<String> = emptyList(),
        affordances: List<String> = emptyList(),
        form: String = "",
        use: String = "",
        revision: Long = 3,
    ) = MultidimensionalSelection(
        topics = topics, contentFunctions = contentFunctions, carriers = carriers,
        affordances = affordances, form = form, use = use, revision = revision, available = true,
    )

    @Test
    fun `single value accept replaces and per tag reset restores the automatic value`() {
        val repository = V2CurationRepository(FakeTransport())
        val automatic = selection(carriers = listOf("single"), form = "method", use = "try")
        val accepted = repository.applyLocal(automatic, automatic, "carriers", "author_continuation", "accept")
        assertEquals(listOf("author_continuation"), accepted.carriers)
        val reset = repository.applyLocal(accepted, automatic, "carriers", "author_continuation", "reset")
        assertEquals(listOf("single"), reset.carriers)
        val formAccepted = repository.applyLocal(automatic, automatic, "form", "case", "accept")
        assertEquals("case", formAccepted.form)
        assertEquals("method", repository.applyLocal(formAccepted, automatic, "form", "", "reset").form)
    }

    @Test
    fun `multi value accept accumulates and reject removes one tag`() {
        val repository = V2CurationRepository(FakeTransport())
        val automatic = selection(topics = listOf("llm"), contentFunctions = listOf("method"))
        val accepted = repository.applyLocal(automatic, automatic, "topics", "eng", "accept")
        assertEquals(listOf("llm", "eng"), accepted.topics)
        val rejected = repository.applyLocal(accepted, automatic, "topics", "llm", "reject")
        assertEquals(listOf("eng"), rejected.topics)
        // Per-tag reset restores only that tag.
        val restored = repository.applyLocal(rejected, automatic, "topics", "llm", "reset")
        assertEquals(listOf("eng", "llm"), restored.topics)
    }

    @Test
    fun `set empty and whole field reset differ`() {
        val repository = V2CurationRepository(FakeTransport())
        val automatic = selection(topics = listOf("llm", "eng"))
        assertEquals(emptyList<String>(), repository.applyLocal(automatic, automatic, "topics", "", "set_empty").topics)
        assertEquals(automatic.topics, repository.applyLocal(automatic, automatic, "topics", "", "reset").topics)
    }

    @Test
    fun `a network failure queues the action with its original key`() {
        val transport = FakeTransport(applyResults = mutableListOf(V2Result.Failed(FailureKind.Network)))
        val repository = V2CurationRepository(transport)
        val result = repository.submit(7, "topics", "llm", "accept", 3, "token", operationKey = "op-fixed")
        assertTrue(result is CurationSubmitResult.Queued)
        assertEquals("op-fixed", (result as CurationSubmitResult.Queued).operationKey)
        assertEquals("op-fixed", transport.overrides.single().operationKey)
    }

    @Test
    fun `a retry reuses the same operation key while a new action gets a new one`() {
        val transport = FakeTransport(applyResults = mutableListOf(
            V2Result.Failed(FailureKind.Timeout),
            V2Result.Loaded(JSONObject().put("revision", 9)),
        ))
        val repository = V2CurationRepository(transport)
        val queued = repository.submit(7, "topics", "llm", "accept", 3, "token", operationKey = "op-1")
        assertTrue(queued is CurationSubmitResult.Queued)
        val retried = repository.submit(7, "topics", "llm", "accept", 3, "token", operationKey = "op-1")
        assertTrue(retried is CurationSubmitResult.Applied)
        assertEquals(9L, (retried as CurationSubmitResult.Applied).revision)
        assertEquals(listOf("op-1", "op-1"), transport.overrides.map { it.operationKey })
        // A brand new action does not reuse the key.
        repository.submit(7, "topics", "eng", "accept", 9, "token")
        assertTrue(transport.overrides[2].operationKey != "op-1")
    }

    @Test
    fun `flush replays queued actions in order and stops at a conflict`() {
        val transport = FakeTransport(applyResults = mutableListOf(
            V2Result.Loaded(JSONObject().put("revision", 10)),
            V2Result.Conflict(11),
        ))
        val repository = V2CurationRepository(transport)
        val queued = listOf(
            QueuedCurationAction(7, "op-a", "topics", "llm", "accept", 9, "account"),
            QueuedCurationAction(7, "op-b", "topics", "eng", "accept", 10, "account"),
        )
        val remaining = runBlocking { repository.flush(MemoryQueue(queued), "account", "token") }.remaining
        assertEquals(listOf("op-b"), remaining.map { it.operationKey })
        assertEquals(listOf("op-a", "op-b"), transport.overrides.map { it.operationKey })
        // A conflict is surfaced, never silently dropped.
        assertTrue(remaining.single().operationKey == "op-b")
    }

    @Test
    fun `a still-offline flush keeps every action and its operation key (R2-04)`() {
        val transport = FakeTransport(applyResults = mutableListOf(
            V2Result.Failed(FailureKind.Network),
        ))
        val repository = V2CurationRepository(transport)
        val queued = listOf(
            QueuedCurationAction(7, "op-a", "topics", "llm", "reject", 9, "account"),
            QueuedCurationAction(7, "op-b", "content_functions", "data", "accept", 9, "account"),
        )
        val remaining = runBlocking { repository.flush(MemoryQueue(queued), "account", "token") }.remaining
        // Nothing was confirmed, so nothing may be reported as synced or
        // removed from the durable queue.
        assertEquals(queued, remaining)
        assertEquals("op-a", transport.overrides.single().operationKey)
        assertEquals("reject", transport.overrides.single().action)
    }

    @Test
    fun `a timeout keeps the action and stops the flush (R2-04)`() {
        val transport = FakeTransport(applyResults = mutableListOf(
            V2Result.Failed(FailureKind.Timeout),
        ))
        val repository = V2CurationRepository(transport)
        val queued = listOf(QueuedCurationAction(7, "op-a", "carriers", "single", "accept", 3, "account"))
        assertEquals(queued, runBlocking { repository.flush(MemoryQueue(queued), "account", "token") }.remaining)
    }

    @Test
    fun `a mixed flush removes only the confirmed action (R2-04)`() {
        val transport = FakeTransport(applyResults = mutableListOf(
            V2Result.Loaded(JSONObject().put("revision", 10)),
            V2Result.Failed(FailureKind.Network),
        ))
        val repository = V2CurationRepository(transport)
        val queued = listOf(
            QueuedCurationAction(7, "op-a", "topics", "llm", "accept", 9, "account"),
            QueuedCurationAction(7, "op-b", "topics", "eng", "accept", 10, "account"),
        )
        val remaining = runBlocking { repository.flush(MemoryQueue(queued), "account", "token") }.remaining
        assertEquals(listOf("op-b"), remaining.map { it.operationKey })
    }

    @Test
    fun `a multi-field draft keeps reject set_empty and single-value intent (R2-05)`() {
        val repository = V2CurationRepository(FakeTransport())
        val automatic = selection(
            topics = listOf("llm", "eng"), contentFunctions = listOf("method"),
            carriers = listOf("single"), form = "method", use = "try", revision = 3,
        )
        // The user deletes one topic, adds two functions, empties affordances and
        // changes the single-valued carrier.
        var draft = repository.applyLocal(automatic, automatic, "topics", "llm", "reject")
        draft = repository.applyLocal(draft, automatic, "content_functions", "data", "accept")
        draft = repository.applyLocal(draft, automatic, "content_functions", "case", "accept")
        draft = repository.applyLocal(draft, automatic, "affordances", "", "set_empty")
        draft = repository.applyLocal(draft, automatic, "carriers", "external_article", "accept")
        assertEquals(listOf("eng"), draft.topics)
        assertEquals(listOf("method", "data", "case"), draft.contentFunctions)
        assertEquals(emptyList<String>(), draft.affordances)
        assertEquals(listOf("external_article"), draft.carriers)
        // The original automatic baseline is unchanged, so a later reset restores
        // the real automatic values rather than the human-resolved cache.
        assertEquals(listOf("llm", "eng"), automatic.topics)
        val reset = repository.applyLocal(draft, automatic, "topics", "", "reset")
        assertEquals(listOf("llm", "eng"), reset.topics)
    }

    @Test
    fun `a conflict exposes the server revision and keeps the caller's draft`() {
        val transport = FakeTransport(applyResults = mutableListOf(V2Result.Conflict(42)))
        val repository = V2CurationRepository(transport)
        val result = repository.submit(7, "topics", "llm", "accept", 3, "token")
        assertEquals(42L, (result as CurationSubmitResult.Conflict).revision)
    }

    @Test
    fun `missing malformed and foreign acknowledgements keep the action`() {
        for (payload in listOf(
            JSONObject("{}"),
            JSONObject("""{"id":7,"field":"topics","term":"llm","action":"accept","revision":"1","replayed":true}"""),
            JSONObject("""{"id":8,"field":"topics","term":"llm","action":"accept","revision":1,"replayed":true}"""),
            JSONObject("""{"id":7,"field":"topics","term":"llm","action":"accept","revision":1,"replayed":true,"operation_key":"foreign"}"""),
        )) {
            val repo = V2CurationRepository(FakeTransport(applyResults = mutableListOf(V2Result.Loaded(payload)), identify = false))
            assertEquals(CurationSubmitResult.Failed(FailureKind.Server), repo.submit(7, "topics", "llm", "accept", 0, "token", "mine"))
        }
    }

    @Test
    fun `explicit legacy nested replay supplies confirmed revision without guessing`() {
        val receipt = JSONObject("""{"override":{"link_id":7,"field":"topics","term":"llm","action":"accept","revision":1},"replayed":true}""")
        val repo = V2CurationRepository(FakeTransport(applyResults = mutableListOf(V2Result.Loaded(receipt)), identify = false))
        assertEquals(1L, (repo.submit(7, "topics", "llm", "accept", 0, "token", "mine") as CurationSubmitResult.Applied).revision)
    }

    @Test
    fun `successor revision advances only from durable predecessor acknowledgement`() = runBlocking {
        val transport = FakeTransport(applyResults = mutableListOf(V2Result.Loaded(JSONObject().put("revision", 1)), V2Result.Conflict(2)))
        val queue = MemoryQueue(listOf(
            QueuedCurationAction(7, "a", "topics", "llm", "accept", 0, "account"),
            QueuedCurationAction(7, "b", "topics", "llm", "reject", null, "account", predecessorKey = "a"),
        ))
        val result = V2CurationRepository(transport).flush(queue, "account", "token")
        assertEquals(listOf(0L, 1L), transport.overrides.map { it.expectedRevision })
        assertEquals(1L, result.remaining.single().predecessorRevision)
        assertEquals(2L, result.remaining.single().conflictRevision)
        assertEquals(CurationSubmitResult.Conflict(2), result.outcomes.last().second)
        // Restart never silently adopts the unrelated revision 2.
        V2CurationRepository(transport).flush(queue, "account", "token")
        assertEquals(2, transport.overrides.size)
    }
}
