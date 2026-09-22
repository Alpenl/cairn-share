package com.alpenl.cairn.share.network

import org.json.JSONObject

internal data class ValueOrigin(val term: String, val origin: String, val confirmed: Boolean, val revision: Long?) {
    val label: String get() = when {
        origin == "human" && confirmed -> "人工确认"
        origin == "automatic" -> "自动建议"
        origin == "legacy_unknown" -> "历史来源未确认"
        else -> "来源未知"
    }
}

internal data class PolicyCandidate(val term: String, val verdict: String, val probability: Double?, val reason: String)
internal data class SelectionFieldState(
    val status: String,
    val values: List<ValueOrigin>,
    val emptyOrigin: ValueOrigin?,
    val candidates: List<PolicyCandidate>,
) {
    val label: String get() = when (status) {
        "completed_nonempty" -> "已生成建议"
        "completed_empty" -> "已完成，无适用项"
        "abstained" -> "证据不足，暂不判断"
        "not_run" -> "尚未运行"
        "failed" -> "运行失败"
        "stale" -> "来源已更新，旧结果已过期"
        else -> "运行状态未知"
    }
}

internal data class SelectionState(
    val contentRevision: Long,
    val fields: Map<String, SelectionFieldState>,
    val entities: SelectionFieldState?,
    val evidencePartial: Boolean?,
    val answersPartial: Boolean = false,
)

internal fun JSONObject.nonnegativeRevision(key: String): Long? {
    val value = opt(key) as? Number ?: return null
    return value.toLong().takeIf { it >= 0 && it.toDouble() == value.toDouble() }
}

/** Unsupported versions stay unknown. Metadata never upgrades a legacy value to human gold. */
internal fun decodeSelectionState(json: JSONObject?, revision: Long): SelectionState? {
    if (json == null || json.opt("version") != 1 || json.nonnegativeRevision("personal_revision") != revision) return null
    val contentRevision = json.nonnegativeRevision("content_revision") ?: return null
    val fields = json.optJSONObject("fields") ?: return null
    fun origin(value: JSONObject?): ValueOrigin? {
        if (value == null) return null
        val source = value.optString("origin").takeIf { it in setOf("human", "automatic", "legacy_unknown") } ?: "unknown"
        val originRevision = value.nonnegativeRevision("revision")
        return ValueOrigin(value.optString("term"), source,
            source == "human" && value.opt("confirmed") == true && originRevision != null, originRevision)
    }
    fun field(value: JSONObject?): SelectionFieldState? {
        if (value == null) return null
        val values = value.optJSONArray("values") ?: return null
        val decoded = (0 until values.length()).map { origin(values.optJSONObject(it)) ?: return null }
        val candidates = value.optJSONArray("candidates")
        val decodedCandidates = (0 until (candidates?.length() ?: 0)).mapNotNull { index ->
            val candidate = candidates?.optJSONObject(index) ?: return@mapNotNull null
            val verdict = candidate.optString("verdict").takeIf { it in setOf("accepted", "rejected", "abstained") } ?: return@mapNotNull null
            val probability = (candidate.opt("probability") as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..1.0 }
            PolicyCandidate(candidate.optString("term_id").ifEmpty { candidate.optString("candidate").ifEmpty { candidate.optString("value") } },
                verdict, probability, candidate.optString("reason"))
        }
        return SelectionFieldState(value.optString("status"), decoded, origin(value.optJSONObject("empty")), decodedCandidates)
    }
    val decoded = listOf("topics", "content_functions", "carriers", "affordances", "form", "use").associateWith {
        field(fields.optJSONObject(it)) ?: return null
    }
    val evidence = json.optJSONObject("evidence")
    val partial = if (json.opt("decision_evidence_partial") == true) true else evidence?.let {
        when {
            it.opt("truncated") == 1 || it.optString("completeness") in setOf("partial", "truncated", "empty") -> true
            it.opt("truncated") == 0 && it.optString("completeness") == "complete" -> false
            else -> null
        }
    }
    return SelectionState(contentRevision, decoded, field(json.optJSONObject("entities")), partial, json.opt("decision_answers_partial") == true)
}
