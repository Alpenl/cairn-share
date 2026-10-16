package com.alpenl.cairn.share.network

import com.alpenl.cairn.share.v2ExportMarkdown
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EntityCurationTest {
    private class Transport : V2Transport {
        val sent = mutableListOf<FieldOverride>()
        override fun loadSelection(id: Int, apiToken: String) = V2Result.Unsupported
        override fun loadTaxonomy(apiToken: String) = V2Result.Unsupported
        override fun applyOverride(id: Int, override: FieldOverride, apiToken: String): V2Result<JSONObject> {
            sent.add(override)
            return V2Result.Unsupported
        }
    }
    private val transport = Transport()
    private val repo = V2CurationRepository(transport)
    private fun fixture() = JSONObject(javaClass.classLoader!!.getResource("entity-observations-v1.json")!!.readText())
    private fun decode(json: JSONObject = fixture()) =
        (V2CurationClient("https://unused.invalid").decodeSelection(json) as V2Result.Loaded).value
    private fun link() = LinkJson.decodeLink(JSONObject("""{"id":1,"url":"https://example.com/item","note":"","created_at":"now","learned":false}"""))

    @Test fun entityValuesAndAutomaticBaselineComeFromIndependentStoredState() {
        val value = decode()
        assertEquals(listOf("Acme"), value.entityNames)
        assertEquals(listOf("Acme"), value.state!!.entityAutomatic)
        val missing = fixture().apply { getJSONObject("state").getJSONObject("entities").remove("automatic") }
        assertNull(decode(missing).state!!.entityAutomatic)
        for (bad in listOf(JSONArray().put(7), JSONArray().put("Acme").put("Acme"), JSONArray().put("x".repeat(121)))) {
            val payload = fixture()
            payload.getJSONObject("state").getJSONObject("entities").put("automatic", bad)
            assertNull(decode(payload).state!!.entityAutomatic)
            assertEquals(listOf("Acme"), decode(payload).entityNames)
        }
    }

    @Test fun localNameEditsNeverManufactureConfirmedOriginsIdentitiesOrAiLifecycle() {
        val original = decode()
        val added = repo.applyLocal(original, original.automatic, "entities", "Manual", "accept")
        assertEquals(listOf("Acme", "Manual"), added.entityNames)
        assertEquals(setOf("entities"), added.pendingFields)
        assertSame(original.state, added.state)
        val removed = repo.applyLocal(added, original.automatic, "entities", "Acme", "reject")
        assertEquals(listOf("Manual"), removed.entityNames)
        assertSame(original.state!!.entityObservations, removed.state!!.entityObservations)
        val exported = v2ExportMarkdown(link(), removed, null)
        assertTrue(exported.contains("Manual（本地修改，待同步）"))
        assertFalse(exported.contains("acme-a"))
        assertFalse(exported.contains("https://example.com/a"))
        assertFalse(exported.contains("Manual（人工确认）"))
        assertEquals("completed_nonempty", removed.state.entities!!.status)
    }

    @Test fun emptyAndPerNameResetUseEntityBaselineEvenWithoutDimensionBaseline() {
        val original = decode().copy(automatic = null)
        val added = repo.applyLocal(original, null, "entities", "Manual", "accept")
        val empty = repo.applyLocal(added, null, "entities", "", "set_empty")
        assertEquals(emptyList<String>(), empty.entityNames)
        val restored = repo.applyLocal(empty, null, "entities", "Acme", "reset")
        assertEquals(listOf("Acme"), restored.entityNames)
        assertTrue(restored.unknownResetFields.isEmpty())
        val resetManual = repo.applyLocal(added, null, "entities", "Manual", "reset")
        assertEquals(listOf("Acme"), resetManual.entityNames)
        assertEquals(listOf("Acme"), repo.applyLocal(added, null, "entities", "", "reset").entityNames)
    }

    @Test fun unknownEntityBaselineCannotBeInventedFromHumanValues() {
        val json = fixture()
        json.getJSONObject("state").getJSONObject("entities").remove("automatic")
        val value = decode(json)
        val pending = repo.applyLocal(value, value.automatic, "entities", "", "reset")
        assertEquals(setOf("entities"), pending.unknownResetFields)
        assertTrue(v2ExportMarkdown(link(), pending, null).contains("实体结果待服务端确认"))
        val explicitEmpty = repo.applyLocal(pending, value.automatic, "entities", "", "set_empty")
        assertEquals(emptyList<String>(), explicitEmpty.entityNames)
        assertTrue(explicitEmpty.unknownResetFields.isEmpty())
    }

    @Test fun manualNamesDoNotTurnNotRunFailedOrStaleIntoAiSuccess() {
        for (status in listOf("not_run", "failed", "stale", "completed_empty")) {
            val json = fixture()
            json.getJSONObject("state").getJSONObject("entities").put("status", status)
                .put("values", JSONArray()).put("automatic", JSONArray())
            val original = decode(json)
            val added = repo.applyLocal(original, original.automatic, "entities", "Manual", "accept")
            assertEquals(status, added.state!!.entities!!.status)
            assertEquals(listOf("Manual"), added.entityNames)
            assertSame(original.state, added.state)
            assertFalse(v2ExportMarkdown(link(), added, null).contains("实体自动依据"))
        }
    }

    @Test fun unsupportedWriteKeepsDurableEntityIntentAndItsOriginalIdentity() = runBlocking {
        val action = QueuedCurationAction(1, "entity-operation", "entities", "Acme", "reject", 0, "account",
            expectedDecisionId = 1, expectedContentRevision = 1, legacyEndpoint = false)
        assertEquals(action, QueuedCurationAction.decode(action.encode()))
        var acknowledgements = 0
        val queue = object : CurationQueue {
            override suspend fun snapshot() = listOf(action)
            override suspend fun acknowledge(action: QueuedCurationAction, revision: Long) { acknowledgements++ }
            override suspend fun conflict(action: QueuedCurationAction, revision: Long) { error("unexpected conflict") }
        }
        val result = repo.flush(queue, "account", "token")
        assertEquals(listOf(action), result.remaining)
        assertEquals(CurationSubmitResult.Unsupported, result.outcomes.single().second)
        assertEquals("entity-operation", transport.sent.single().operationKey)
        assertEquals(0, acknowledgements)
    }

    @Test fun nameLimitMatchesStoredEntityUtf16Boundary() {
        assertTrue(validEntityName("x".repeat(120)))
        assertFalse(validEntityName("x".repeat(121)))
        assertTrue(validEntityName("🙂".repeat(60)))
        assertFalse(validEntityName("🙂".repeat(61)))
        assertFalse(validEntityName(" \n"))
    }
}
