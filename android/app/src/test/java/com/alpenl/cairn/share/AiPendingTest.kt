package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.AiPendingSuggestion
import com.alpenl.cairn.share.network.MultidimensionalSelection
import com.alpenl.cairn.share.network.V2CurationRepository
import com.alpenl.cairn.share.network.V2Result
import com.alpenl.cairn.share.network.V2Transport
import com.alpenl.cairn.share.network.FieldOverride
import com.alpenl.cairn.share.network.decodeAiPending
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class AiPendingTest {
    @Test fun decodesOnlyTagTypeSuggestions() {
        val state = JSONObject("""{"ai_pending":[{"field":"topics","term":"llm","reason":"confirm"},
            {"field":"carriers","term":"x","reason":"confirm"},{"field":"content_functions","term":"","reason":"confirm"},
            {"field":"resource_kinds","term":"tool","reason":"low_confidence","probability":0.82}]}""")
        assertEquals(
            listOf(AiPendingSuggestion("topics", "llm", "confirm"), AiPendingSuggestion("resource_kinds", "tool", "low_confidence")),
            decodeAiPending(state),
        )
        assertEquals(emptyList<AiPendingSuggestion>(), decodeAiPending(JSONObject("{}")))
        assertEquals(emptyList<AiPendingSuggestion>(), decodeAiPending(null))
    }

    @Test fun acceptingOrDismissingLeavesThePendingList() {
        val pending = listOf(AiPendingSuggestion("topics", "llm", "confirm"), AiPendingSuggestion("topics", "eng", "confirm"))
        val selection = MultidimensionalSelection(available = true, aiPending = pending)
        val repo = V2CurationRepository(object : V2Transport {
            override fun loadSelection(id: Int, apiToken: String) = V2Result.Unsupported
            override fun loadTaxonomy(apiToken: String) = V2Result.Unsupported
            override fun applyOverride(id: Int, override: FieldOverride, apiToken: String) = V2Result.Unsupported
        })
        val accepted = repo.applyLocal(selection, MultidimensionalSelection(topics = listOf("llm", "eng")), "topics", "llm", "accept")
        assertEquals(listOf("llm"), accepted.topics)
        assertEquals(listOf("eng"), accepted.aiPending.map { it.term })
        val dismissed = repo.applyLocal(accepted, MultidimensionalSelection(topics = listOf("llm", "eng")), "topics", "eng", "reject")
        assertEquals(listOf("llm"), dismissed.topics)
        assertEquals(emptyList<AiPendingSuggestion>(), dismissed.aiPending)
    }
}
