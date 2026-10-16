package com.alpenl.cairn.share.network

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EntityEvidenceTest {
    private val ref = EntityEvidenceReference(1, 1, "a", 2, 6, "Acme")
    private fun fixture() = JSONObject(javaClass.classLoader!!.getResource("entity-source-evidence-v1.json")!!.readText())
    private fun decode(json: JSONObject) = decodeEntityEvidence(json, 1, ref)

    @Test fun storedUnicodeExcerptDecodesWithItsExactSnapshotIdentity() {
        val value = (decode(fixture()) as EntityEvidenceResult.Loaded).value
        assertEquals("前🙂Acme 后𠮷", value.before + value.quote + value.after)
        assertEquals("quoted", value.role)
        assertTrue(value.current)
        assertFalse(value.partial)
        val selection = JSONObject(javaClass.classLoader!!.getResource("entity-observations-v1.json")!!.readText())
        val decoded = (V2CurationClient("https://unused.invalid").decodeSelection(selection) as V2Result.Loaded).value
        assertEquals(1L, decoded.state!!.entityObservations!!.first().evidenceSnapshotId)
        assertNotNull(decoded.state.entityObservations.first().evidenceReference())
    }

    @Test fun foreignMalformedOrInconsistentReferencesCannotBecomeDisplayedEvidence() {
        for ((key, value) in mapOf(
            "bookmark_id" to 2, "evidence_snapshot_id" to 2, "content_revision" to 2,
            "block_id" to "b", "span_start" to 1, "span_end" to 7, "quote" to "Other",
            "context_start" to 1, "before" to "前", "clipped_before" to true,
            "content_hash" to "unbound", "current" to "true", "role" to "unknown",
            "completeness" to "invented",
        )) assertEquals(key, EntityEvidenceResult.Failed(FailureKind.Server), decode(fixture().put(key, value)))
        for (key in listOf("version", "current", "truncated", "clipped_after", "before", "content_hash"))
            assertEquals(key, EntityEvidenceResult.Failed(FailureKind.Server), decode(fixture().apply { remove(key) }))
        assertEquals(EntityEvidenceResult.Unsupported, decode(fixture().put("version", 2)))
        assertEquals(EntityEvidenceResult.Failed(FailureKind.Server), decode(fixture().put("after", "🙂".repeat(481))))
    }

    @Test fun partialAndStaleSnapshotsStayExplicit() {
        val value = (decode(fixture().put("current", false).put("completeness", "partial")) as EntityEvidenceResult.Loaded).value
        assertFalse(value.current)
        assertTrue(value.partial)
    }

    @Test fun referenceBoundsUseUnicodeSpansAndDoNotSendSourceTextInQuery() {
        assertTrue(ref.valid())
        assertFalse(ref.query().contains("Acme"))
        assertTrue(ref.copy(blockId = "片段&🙂").query().contains("block_id=%"))
        assertTrue(ref.copy(blockId = "🙂".repeat(32)).valid())
        for (invalid in listOf(ref.copy(snapshotId = 0), ref.copy(snapshotId = 9_007_199_254_740_992L),
            ref.copy(sourceRevision = 0), ref.copy(blockId = "🙂".repeat(33)), ref.copy(start = -1),
            ref.copy(end = 100_001), ref.copy(surface = "Other"), ref.copy(start = 2, end = 2)))
            assertFalse(invalid.toString(), invalid.valid())
        assertTrue(ref.copy(start = 0, end = 2048, surface = "𠮷".repeat(2048)).valid())
        assertFalse(ref.copy(start = 0, end = 2049, surface = "𠮷".repeat(2049)).valid())
    }
}
