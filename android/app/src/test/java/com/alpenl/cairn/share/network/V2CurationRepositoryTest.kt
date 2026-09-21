package com.alpenl.cairn.share.network

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B07: the shared action semantics and the offline replay path. These tests are
 * pure JVM tests: the transport is faked, so they prove the repository logic
 * without a device.
 */
class V2CurationRepositoryTest {

    private class FakeTransport(
        var loadResult: V2Result<MultidimensionalSelection> = V2Result.Failed(FailureKind.Network),
        var applyResults: MutableList<V2Result<JSONObject>> = mutableListOf(),
    ) : V2Transport {
        val overrides = mutableListOf<FieldOverride>()
        override fun loadSelection(id: Int, apiToken: String) = loadResult
        override fun applyOverride(id: Int, override: FieldOverride, apiToken: String): V2Result<JSONObject> {
            overrides.add(override)
            return if (applyResults.isEmpty()) V2Result.Loaded(JSONObject().put("revision", 5))
            else applyResults.removeAt(0)
        }
        override fun loadTaxonomy(apiToken: String) = V2Result.Unsupported
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
        val remaining = repository.flush(queued, "token")
        assertEquals(listOf("op-b"), remaining.map { it.operationKey })
        assertEquals(listOf("op-a", "op-b"), transport.overrides.map { it.operationKey })
        // A conflict is surfaced, never silently dropped.
        assertTrue(remaining.single().operationKey == "op-b")
    }

    @Test
    fun `a conflict exposes the server revision and keeps the caller's draft`() {
        val transport = FakeTransport(applyResults = mutableListOf(V2Result.Conflict(42)))
        val repository = V2CurationRepository(transport)
        val result = repository.submit(7, "topics", "llm", "accept", 3, "token")
        assertEquals(42L, (result as CurationSubmitResult.Conflict).revision)
    }
}
