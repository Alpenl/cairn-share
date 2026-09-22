package com.alpenl.cairn.share.network

import java.util.UUID

/**
 * A transport seam so the curation repository can be exercised without a
 * socket. The production implementation is [V2CurationClient].
 */
internal interface V2Transport {
    fun loadSelection(id: Int, apiToken: String): V2Result<MultidimensionalSelection>
    fun applyOverride(id: Int, override: FieldOverride, apiToken: String): V2Result<org.json.JSONObject>
    fun loadTaxonomy(apiToken: String): V2Result<BookmarkTaxonomy>
}

internal class V2ClientTransport(private val client: V2CurationClient) : V2Transport {
    override fun loadSelection(id: Int, apiToken: String) = client.loadSelection(id, apiToken)
    override fun applyOverride(id: Int, override: FieldOverride, apiToken: String) = client.applyOverride(id, override, apiToken)
    override fun loadTaxonomy(apiToken: String) = client.loadTaxonomy(apiToken)
}

/**
 * The outcome of one user action.
 */
internal sealed interface CurationSubmitResult {
    /** The server accepted the action and returned the new revision. */
    data class Applied(val revision: Long, val payload: org.json.JSONObject) : CurationSubmitResult
    /** The action is queued offline; it keeps its operation key for replay. */
    data class Queued(val operationKey: String) : CurationSubmitResult
    /** The server rejected the action; [revision] is the current revision. */
    data class Conflict(val revision: Long) : CurationSubmitResult
    data class Failed(val kind: FailureKind) : CurationSubmitResult
}

/**
 * The multidimensional curation repository.
 *
 * It owns the only write path for field actions: each new logical action gets
 * its own operation UUID (a retry reuses it), the local draft is updated with
 * the same semantics the Worker uses, and a network failure queues the action
 * instead of dropping the user's intent.
 */
internal class V2CurationRepository(private val transport: V2Transport) {

    fun load(id: Int, apiToken: String): V2Result<MultidimensionalSelection> = transport.loadSelection(id, apiToken)

    /** Loads the multidimensional vocabulary the section renders. */
    fun loadTaxonomy(apiToken: String): V2Result<BookmarkTaxonomy> = transport.loadTaxonomy(apiToken)

    /**
     * Applies one action to the local draft with the shared semantics:
     * single-valued fields replace, multi-valued fields accumulate, reject
     * removes one tag and a per-tag reset restores that tag from the automatic
     * value.
     */
    fun applyLocal(
        selection: MultidimensionalSelection,
        automatic: MultidimensionalSelection?,
        field: String,
        term: String,
        action: String,
    ): MultidimensionalSelection {
        if (action == "reset" && automatic == null) {
            return selection.copy(unknownResetFields = selection.unknownResetFields + field, pendingFields = selection.pendingFields + field)
        }
        // Non-reset actions never consult this fallback; unknown automatic
        // state remains unknown rather than being copied from human values.
        val baseline = automatic ?: MultidimensionalSelection()
        val result = when (field) {
            "topics" -> selection.copy(topics = resolveMulti(selection.topics, baseline.topics, term, action))
            "content_functions" -> selection.copy(contentFunctions = resolveMulti(selection.contentFunctions, baseline.contentFunctions, term, action))
            "affordances" -> selection.copy(affordances = resolveMulti(selection.affordances, baseline.affordances, term, action))
            "carriers" -> selection.copy(carriers = resolveSingle(selection.carriers, baseline.carriers, term, action))
            "form" -> selection.copy(form = resolveSingleValue(selection.form, baseline.form, term, action))
            "use" -> selection.copy(use = resolveSingleValue(selection.use, baseline.use, term, action))
            else -> selection
        }
        val replacesUnknown = action == "set_empty" || (action == "reset" && term.isEmpty()) ||
            (field in setOf("carriers", "form", "use") && action == "accept")
        return result.copy(unknownResetFields = if (replacesUnknown) result.unknownResetFields - field else result.unknownResetFields,
            pendingFields = result.pendingFields + field)
    }

    /**
     * Submits one action. A new action gets a fresh UUID; a retry passes the
     * original [operationKey] so the server replays instead of applying twice.
     */
    fun submit(
        id: Int,
        field: String,
        term: String,
        action: String,
        expectedRevision: Long,
        apiToken: String,
        operationKey: String = UUID.randomUUID().toString(),
    ): CurationSubmitResult {
        val override = FieldOverride(
            field = field,
            term = term,
            action = action,
            operationKey = operationKey,
            expectedRevision = expectedRevision,
        )
        return when (val result = transport.applyOverride(id, override, apiToken)) {
            is V2Result.Loaded -> confirmed(result.value, id, override)
            is V2Result.Conflict -> CurationSubmitResult.Conflict(result.revision)
            is V2Result.Unsupported -> CurationSubmitResult.Failed(FailureKind.Server)
            is V2Result.Failed -> when (result.kind) {
                FailureKind.Network, FailureKind.Timeout -> CurationSubmitResult.Queued(operationKey)
                else -> CurationSubmitResult.Failed(result.kind)
            }
        }
    }

    private fun confirmed(payload: org.json.JSONObject, id: Int, sent: FieldOverride): CurationSubmitResult {
        // Older Workers used a nested override on replay. Accept that explicit
        // shape only if the receipt still identifies this exact logical action.
        val receipt = payload.optJSONObject("override") ?: payload
        val revision = receipt.opt("revision")
        val link = if (receipt.has("link_id")) receipt.opt("link_id") else receipt.opt("id")
        val key = payload.opt("operation_key")
        val valid = revision is Number && revision.toLong() > 0 && revision.toDouble() == revision.toLong().toDouble() &&
            link is Number && link.toLong() == id.toLong() &&
            receipt.opt("field") == sent.field && receipt.opt("term") == sent.term && receipt.opt("action") == sent.action &&
            (key == null || key == sent.operationKey) && payload.opt("replayed") is Boolean &&
            (!payload.has("revision") || payload.opt("revision") == revision)
        return if (valid) CurationSubmitResult.Applied((revision as Number).toLong(), payload)
        else CurationSubmitResult.Failed(FailureKind.Server)
    }

    /** Each acknowledgement is durable before the next request is sent. */
    suspend fun flush(
        queue: CurationQueue,
        accountKey: String,
        apiToken: String,
        active: () -> Boolean = { true },
        onResult: suspend (QueuedCurationAction, CurationSubmitResult) -> Unit = { _, _ -> },
    ): CurationFlushResult {
        val outcomes = mutableListOf<Pair<QueuedCurationAction, CurationSubmitResult>>()
        while (active()) {
            val action = queue.snapshot().firstOrNull { it.accountKey == accountKey } ?: break
            val result = when {
                action.conflictRevision != null -> CurationSubmitResult.Conflict(action.conflictRevision)
                !action.ready -> CurationSubmitResult.Failed(FailureKind.Server)
                else -> kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    submit(action.linkId, action.field, action.term, action.action,
                        action.expectedRevision!!, apiToken, action.operationKey)
                }
            }
            when (result) {
                is CurationSubmitResult.Applied -> queue.acknowledge(action, result.revision)
                is CurationSubmitResult.Conflict -> queue.conflict(action, result.revision)
                else -> Unit
            }
            outcomes += action to result
            onResult(action, result)
            if (result !is CurationSubmitResult.Applied) break
        }
        return CurationFlushResult(queue.snapshot().filter { it.accountKey == accountKey }, outcomes)
    }

    private fun resolveMulti(current: List<String>, automatic: List<String>, term: String, action: String): List<String> = when (action) {
        "accept" -> if (current.contains(term)) current else current + term
        "reject" -> current.filterNot { it == term }
        "set_empty" -> emptyList()
        // A per-tag reset restores exactly that tag from the automatic value;
        // a whole-field reset restores the full automatic list.
        "reset" -> if (term.isEmpty()) automatic else (current.filterNot { it == term } + automatic.filter { it == term }).distinct()
        else -> current
    }

    private fun resolveSingle(current: List<String>, automatic: List<String>, term: String, action: String): List<String> = when (action) {
        "accept" -> if (term.isEmpty()) emptyList() else listOf(term)
        "reject" -> if (current.contains(term)) emptyList() else current
        "set_empty" -> emptyList()
        "reset" -> if (term.isEmpty()) automatic.take(1) else automatic.take(1)
        else -> current
    }

    private fun resolveSingleValue(current: String, automatic: String, term: String, action: String): String = when (action) {
        "accept" -> term
        "reject" -> if (current == term) "" else current
        "set_empty" -> ""
        "reset" -> automatic
        else -> current
    }
}


internal interface CurationQueue {
    suspend fun snapshot(): List<QueuedCurationAction>
    suspend fun acknowledge(action: QueuedCurationAction, revision: Long)
    suspend fun conflict(action: QueuedCurationAction, revision: Long)
}

internal data class CurationFlushResult(
    val remaining: List<QueuedCurationAction>,
    val outcomes: List<Pair<QueuedCurationAction, CurationSubmitResult>>,
)
