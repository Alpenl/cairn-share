package com.alpenl.cairn.share.network

import org.json.JSONObject
import java.net.URI

/** Stored automatic judgments, separate from effective, possibly human-curated values. */
internal data class EntityObservation(
    val surface: String,
    val blockId: String,
    val start: Long,
    val end: Long,
    val sourceUrl: String?,
    val decision: String,
    val canonicalState: String,
    val canonicalId: String?,
    val canonicalLabel: String?,
    val canonicalKind: String?,
    val identifiers: List<String>,
    val catalogVersion: String,
    val sourceRevision: Long,
    val effective: Boolean,
) {
    val decisionLabel: String get() = when (decision) {
        "relevant" -> "与内容相关"
        "incidental" -> "仅顺带提及"
        "none" -> "不适用"
        else -> "证据不足，暂不判断"
    }
    val identityLabel: String get() = when (canonicalState) {
        "matched" -> "$canonicalLabel（${kindLabel(canonicalKind)}，$canonicalId）"
        "none" -> "无适用身份"
        else -> "身份未确定"
    }
    val sourceLabel: String get() = sourceUrl ?: "片段 $blockId · 字符 $start–$end"
    val effectiveLabel: String get() = if (effective) "当前有效自动建议" else "非当前有效结果"
}

private fun kindLabel(kind: String?): String = when (kind) {
    "person" -> "人物"
    "organization" -> "组织"
    "product" -> "产品"
    "project" -> "项目"
    "place" -> "地点"
    else -> "类型未知"
}

private fun JSONObject.boundedString(key: String, max: Int): String? =
    (opt(key) as? String)?.takeIf { it.isNotBlank() && it.length <= max }

private fun safeIdentityUrl(value: String): Boolean = runCatching {
    val uri = URI(value)
    value.length <= 2048 && value.none { it.isWhitespace() || it == '\\' } &&
        uri.scheme in setOf("http", "https") && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null
}.getOrDefault(false)

/** Invalid/unsupported provenance stays unavailable without losing the saved selection. */
internal fun decodeEntityObservations(
    json: JSONObject?,
    currentRevision: Long,
    entities: SelectionFieldState?,
): List<EntityObservation>? {
    if (json == null || json.opt("observations_version") != 1) return null
    val rows = json.optJSONArray("observations") ?: return null
    if (rows.length() > 40) return null
    if (rows.length() == 0) return emptyList()
    val sourceRevision = json.nonnegativeRevision("content_revision") ?: return null
    if ((json.nonnegativeRevision("evidence_snapshot_id") ?: 0) <= 0) return null
    val seen = mutableSetOf<List<Any>>()
    return (0 until rows.length()).map { index ->
        val row = rows.optJSONObject(index) ?: return null
        val candidate = row.optJSONObject("candidate") ?: return null
        val surface = candidate.boundedString("surface", 120) ?: return null
        val block = candidate.opt("block_id") as? String ?: return null
        val start = candidate.nonnegativeRevision("start") ?: return null
        val end = candidate.nonnegativeRevision("end") ?: return null
        val url = candidate.opt("source_url") as? String
        when (candidate.optString("kind")) {
            "surface" -> if (block.isBlank() || end <= start || end - start != surface.codePointCount(0, surface.length).toLong() || url != null) return null
            "link" -> if (block.isNotEmpty() || start != 0L || end != 0L || url != surface || !safeIdentityUrl(url)) return null
            else -> return null
        }
        if (!seen.add(listOf(block, start, end, surface))) return null
        val decision = row.optString("decision").takeIf { it in setOf("relevant", "incidental", "none", "unknown") } ?: return null
        val identityState = row.optString("canonical_state").takeIf { it in setOf("matched", "none", "unknown") } ?: return null
        val id = row.boundedString("canonical_id", 64)
        val label = row.boundedString("canonical_label", 240)
        val kind = row.opt("canonical_kind") as? String
        if (identityState == "matched") {
            if (id == null || !id.matches(Regex("[a-z][a-z0-9._-]{0,63}")) || label == null ||
                kind !in setOf("person", "organization", "product", "project", "place") || decision in setOf("none", "unknown")) return null
        } else if (id != null || label != null || kind != null) return null
        val evidence = row.optJSONArray("canonical_evidence") ?: return null
        if (evidence.length() > 32 || (identityState == "matched") != (evidence.length() > 0)) return null
        val identifiers = (0 until evidence.length()).map { i ->
            val item = evidence.optJSONObject(i) ?: return null
            val identifier = item.boundedString("identifier", 2048)?.takeIf(::safeIdentityUrl) ?: return null
            val source = item.optString("source")
            if (item.opt("block_id") != block || source !in (if (url == null) setOf("block_url", "block_text") else setOf("stored_link"))) return null
            identifier
        }.distinct()
        val version = row.boundedString("catalog_version", 160) ?: return null
        val serverEffective = row.opt("effective") as? Boolean ?: return null
        // A stale or human-excluded observation can be inspected, never exported
        // as effective even if a malformed server response says otherwise.
        val effective = serverEffective && sourceRevision == currentRevision && entities?.status == "completed_nonempty" &&
            decision == "relevant" && entities.values.any { it.term == surface }
        EntityObservation(surface, block, start, end, url, decision, identityState, id, label, kind,
            identifiers, version, sourceRevision, effective)
    }
}
