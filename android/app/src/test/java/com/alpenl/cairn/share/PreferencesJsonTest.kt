package com.alpenl.cairn.share

import com.alpenl.cairn.share.network.AiPreferences
import com.alpenl.cairn.share.network.PreferencesJson
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PreferencesJsonTest {
    @Test fun parsesServerValueAndFallsBackToDefaults() {
        val snap = PreferencesJson.parse(JSONObject("""{"value":{"ai_suggestion_limit":5,"ai_confirm_before_apply":true},"revision":7}"""))
        assertEquals(5, snap.value.suggestionLimit)
        assertTrue(snap.value.confirmBeforeApply)
        assertFalse(snap.value.lowConfidenceReview)
        assertEquals(7L, snap.revision)
        assertEquals(AiPreferences(), PreferencesJson.parse(JSONObject("{}")).value)
    }

    @Test fun clampsOutOfRangeLimit() {
        assertEquals(8, PreferencesJson.parse(JSONObject("""{"value":{"ai_suggestion_limit":99}}""")).value.suggestionLimit)
    }

    @Test fun patchCarriesOnlyChangedKeys() {
        val patch = PreferencesJson.patch(AiPreferences(), AiPreferences(confirmBeforeApply = true))
        assertEquals(setOf("ai_confirm_before_apply"), patch.keys().asSequence().toSet())
        assertTrue(patch.getBoolean("ai_confirm_before_apply"))
        assertEquals(0, PreferencesJson.patch(AiPreferences(), AiPreferences()).length())
    }

    @Test fun operationBodyMatchesWorkerContract() {
        val body = PreferencesJson.operation("k", 3, JSONObject().put("ai_suggestion_limit", 2))
        assertEquals(setOf("operation_key", "expected_revision", "patch"), body.keys().asSequence().toSet())
        assertEquals(3L, body.getLong("expected_revision"))
        assertFalse(body.getJSONObject("patch").has("ai_confirm_before_apply"))
    }
}
