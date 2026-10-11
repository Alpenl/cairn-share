package com.alpenl.cairn.share

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CollectionRuleV2Test {
    @Test fun decodesProtocolTwoRuleFieldsFromTextColumns() {
        val r = CollectionRecord.decode(JSONObject("""{"id":"c","name":"AIGC","revision":3,"rule_enabled":1,"rule_mode":"all","rule_tags":"[\"system/topics/a\"]",
            "rule_exclude_tags":"[\"system/topics/b\"]","rule_admission":"review","rule_confirmed_only":1}"""))
        assertEquals(listOf("system/topics/b"), r.ruleExclude)
        assertEquals("review", r.ruleAdmission)
        assertTrue(r.ruleConfirmedOnly)
    }

    @Test fun protocolOneRecordsKeepSafeDefaultsAndRoundTrip() {
        val r = CollectionRecord.decode(JSONObject("""{"id":"c","name":"x","revision":1,"rule_tags":"[]"}"""))
        assertEquals(emptyList<String>(), r.ruleExclude)
        assertEquals("direct", r.ruleAdmission)
        assertFalse(r.ruleConfirmedOnly)
        val v2 = r.copy(ruleExclude = listOf("custom/default/z"), ruleAdmission = "review", ruleConfirmedOnly = true)
        assertEquals(v2, CollectionRecord.decode(v2.json()))
    }

    @Test fun sentenceReadsLikeThePrototype() {
        val names = mapOf("t/a" to "图像生成", "t/b" to "视频制作", "t/x" to "观点"); val label = { ref: String -> names.getValue(ref) }
        assertEquals("已确认标签里有「图像生成」或「视频制作」，且没有「观点」的收藏，审核后加入。",
            ruleSentence(listOf("t/a", "t/b"), listOf("t/x"), "any", "review", true, true, label))
        assertTrue(ruleSentence(listOf("t/a", "t/b"), emptyList(), "all", "direct", false, false, label).contains("」和「"))
        assertTrue(ruleSentence(listOf("t/a"), emptyList(), "any", "direct", false, false, label).endsWith("（规则已暂停）"))
        assertTrue(ruleSentence(emptyList(), emptyList(), "any", "direct", false, true, label).startsWith("还没有命中标签"))
    }
}
