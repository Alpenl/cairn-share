package com.alpenl.cairn.share.network

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class V2CompatibilityTest {
    private fun base() = JSONObject("""{"id":1,"url":"https://x.com/example/status/1","note":"note","created_at":"2026-09-12T00:00:00Z","learned":false,"learned_at":null}""")

    // --- B07-T01 DTO coverage ----------------------------------------------

    @Test fun v2DimensionsDecodeAndAreMarkedMultidimensional() {
        val link = LinkJson.decodeLink(base().put("enrichment", JSONObject("""{
            "status":"completed","classification":{
              "topics":["llm","eng","eval","design"],
              "content_functions":["tool","method","data"],
              "carriers":["author_continuation"],
              "affordances":["practice"],
              "form":"method","use":"try","uncertainty":false,"entities":["Cairn"]
            }
        }""")))
        val labels = requireNotNull(link.enrichment?.classification)
        assertTrue(labels.multiDimensional)
        assertEquals(listOf("tool", "method", "data"), labels.contentFunctions)
        assertEquals(listOf("author_continuation"), labels.carriers)
        assertEquals(listOf("practice"), labels.affordances)
        // The fourth topic survives decoding; folding is a display concern.
        assertEquals(4, labels.topics.size)
    }

    @Test fun legacyPayloadWithoutV2FieldsIsNotMarkedMultidimensional() {
        val link = LinkJson.decodeLink(base().put("enrichment", JSONObject("""{
            "status":"completed","classification":{"topics":["eng"],"form":"method","use":"quote","uncertainty":false}
        }""")))
        val labels = requireNotNull(link.enrichment?.classification)
        assertFalse("a v1 payload must not claim v2 support", labels.multiDimensional)
        assertEquals(emptyList<String>(), labels.contentFunctions)
    }

    @Test fun unknownOptionalFieldsAreIgnoredWithoutCrashing() {
        val link = LinkJson.decodeLink(base().put("enrichment", JSONObject("""{
            "status":"completed","future_field":"x","classification":{"topics":["eng"],"form":"","use":"","uncertainty":true,"future":"y"}
        }""")))
        assertNotNull(link.enrichment)
    }

    @Test fun anEmptyUseIsLegalAndNotUncertainty() {
        val link = LinkJson.decodeLink(base().put("enrichment", JSONObject("""{
            "status":"completed","classification":{"topics":["eng"],"form":"method","use":"","uncertainty":false}
        }""")))
        assertEquals("", link.enrichment?.classification?.use)
    }

    // --- B07-T01/T03 entity and field status -------------------------------

    @Test fun entityStateDefaultsToNotRunAndIsNotConfusedWithEmpty() {
        val link = LinkJson.decodeLink(base().put("enrichment", JSONObject("""{"status":"completed"}""")))
        assertEquals("not_run", link.enrichment?.entityState)
        val empty = LinkJson.decodeLink(base().put("enrichment", JSONObject("""{"status":"completed","entity_state":"completed_empty"}""")))
        assertEquals("completed_empty", empty.enrichment?.entityState)
    }

    @Test fun fieldStatusValuesAreDistinct() {
        val values = FieldStatus.entries.map { it.apiValue }.toSet()
        assertEquals(setOf("accepted", "rejected", "abstained", "not_run", "not_applicable", "stale"), values)
    }

    // --- B07-T04 field override encoding -----------------------------------

    @Test fun fieldOverrideEncodesActionAndRevision() {
        val encoded = JSONObject(FieldOverride("topics", "eng", "reject", "op-1", expectedRevision = 3).encode())
        assertEquals("topics", encoded.getString("field"))
        assertEquals("eng", encoded.getString("term"))
        assertEquals("reject", encoded.getString("action"))
        assertEquals("op-1", encoded.getString("operation_key"))
        assertEquals(3L, encoded.getLong("expected_revision"))
    }

    @Test fun setEmptyAndResetEncodeDifferently() {
        val empty = JSONObject(FieldOverride("affordances", "", "set_empty", "op-a").encode())
        val reset = JSONObject(FieldOverride("affordances", "", "reset", "op-b").encode())
        assertNotEquals(empty.getString("action"), reset.getString("action"))
        assertNotEquals(empty.getString("operation_key"), reset.getString("operation_key"))
    }

    // --- B07-T05 offline action queue --------------------------------------

    @Test fun queuedActionRoundTripsAsAnActionNotASnapshot() {
        val action = QueuedCurationAction(7, "op-7", "topics", "llm", "accept", 4, "account-a")
        val decoded = QueuedCurationAction.decode(action.encode())
        assertEquals(action, decoded)
        // The encoded form carries no full link object.
        assertFalse(action.encode().has("enrichment"))
    }

    @Test fun queuedActionsForAnotherAccountAreNotSent() {
        val actions = listOf(
            QueuedCurationAction(1, "op-1", "topics", "llm", "accept", null, "account-a"),
            QueuedCurationAction(2, "op-2", "topics", "eng", "accept", null, "account-b"),
        )
        assertEquals(listOf("op-1"), pendingActionsFor(actions, "account-a").map { it.operationKey })
        assertTrue(pendingActionsFor(actions, "account-c").isEmpty())
    }

    // --- B07-T07 multidimensional filters ----------------------------------

    @Test fun filtersApplySameDimensionOrAndCrossDimensionAnd() {
        val link = LinkJson.decodeLink(base()).copy(enrichment = LinkEnrichment(
            classification = BookmarkClassification(
                topics = listOf("llm"), contentFunctions = listOf("tool"), carriers = listOf("single"),
                affordances = listOf("practice"), form = "method", use = "try", uncertainty = false,
            ),
            classificationReviewed = true, entityState = "completed_nonempty",
        ))
        assertTrue(BookmarkFilters(contentFunctions = listOf("tool", "data")).matches(link))
        assertTrue(BookmarkFilters(contentFunctions = listOf("tool"), carriers = listOf("single")).matches(link))
        assertFalse(BookmarkFilters(contentFunctions = listOf("tool"), carriers = listOf("author_continuation")).matches(link))
        assertFalse(BookmarkFilters(entityState = "failed").matches(link))
        assertTrue(BookmarkFilters(entityState = "completed_nonempty").matches(link))
    }

    @Test fun v2FilterParametersAreStable() {
        val parameters = BookmarkFilters(contentFunctions = listOf("tool", "data"), carriers = listOf("single")).parameters()
        assertEquals("tool,data", parameters["content_functions"])
        assertEquals("single", parameters["carriers"])
    }

    // --- B07-T09 taxonomy v2 decoding --------------------------------------

    @Test fun taxonomyDecodesV2DimensionsAndKeepsInactiveTerms() {
        val taxonomy = decodeTaxonomy(JSONObject("""{
          "version":"2026-09-20.1","definition_version":1,
          "topics":[{"id":"llm","label":"LLM","active":true,"description":"d"}],
          "forms":[],"uses":[],
          "content_functions":[{"id":"tool","label":"工具","active":true}],
          "carriers":[{"id":"single","label":"单帖","active":true},{"id":"old","label":"旧","active":false,"deprecated":true}],
          "affordances":[{"id":"practice","label":"可实践","active":true}]
        }"""))
        assertTrue(taxonomy.multiDimensional)
        assertEquals(listOf("tool"), taxonomy.contentFunctions.map { it.id })
        assertEquals(listOf("single", "old"), taxonomy.carriers.map { it.id })
        assertTrue(taxonomy.carriers.last().deprecated)
    }

    @Test fun taxonomyWithoutV2DimensionsIsNotMarkedMultidimensional() {
        val taxonomy = decodeTaxonomy(JSONObject("""{"version":"v1","topics":[],"forms":[],"uses":[]}"""))
        assertFalse(taxonomy.multiDimensional)
    }
}
