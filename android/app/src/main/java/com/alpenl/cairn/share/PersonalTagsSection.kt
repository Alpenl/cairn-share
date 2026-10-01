package com.alpenl.cairn.share

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.V2CurationClient
import com.alpenl.cairn.share.network.V2Result
import com.alpenl.cairn.share.network.cancellableRead
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal data class PersonalTagDefinition(
    val id: String,
    val tagRef: String,
    val label: String,
    val revision: Long,
    val active: Boolean,
    val linkCount: Int = 0,
)

internal data class PersonalTagSnapshot(
    val revision: Long,
    val decisionId: Long,
    val contentRevision: Long,
    val customTags: List<PersonalTagDefinition>,
)

internal data class PersonalTagHistoryEvent(
    val operationId: String,
    val revision: Long,
    val summary: String,
    val createdAt: String,
    val reversible: Boolean,
)

/** Kept by the reader while its editor is folded or a LazyColumn item is offscreen. */
internal class PersonalTagEditorDraft {
    val name = mutableStateOf("")
    val editing = mutableStateOf(false)
    val showingHistory = mutableStateOf(false)
    val rename = mutableStateOf("")
    companion object {
        val saver = Saver<PersonalTagEditorDraft, String>(
            save = { JSONObject().put("name", it.name.value).put("editing", it.editing.value).put("history", it.showingHistory.value).put("rename", it.rename.value).toString() },
            restore = { value -> runCatching { JSONObject(value).let { json -> PersonalTagEditorDraft().apply {
                name.value = json.optString("name"); editing.value = json.optBoolean("editing")
                showingHistory.value = json.optBoolean("history"); rename.value = json.optString("rename")
            } } }.getOrNull() },
        )
    }
}

private fun JSONObject.tagRevision(name: String): Long? {
    val value = opt(name) as? Number ?: return null
    val integer = value.toLong()
    return integer.takeIf { it >= 0 && value.toDouble() == it.toDouble() }
}

internal fun parsePersonalTags(array: JSONArray?): List<PersonalTagDefinition> =
    (0 until (array?.length() ?: 0)).mapNotNull { index ->
        val value = array?.optJSONObject(index) ?: return@mapNotNull null
        val id = value.optString("id")
        val tagRef = value.optString("tag_ref")
        val revision = value.tagRevision("revision") ?: return@mapNotNull null
        val label = value.optString("label")
        if (id.isBlank() || label.isBlank() || tagRef != "custom/default/$id") return@mapNotNull null
        PersonalTagDefinition(id, tagRef, label, revision, value.optString("status") == "active", value.optInt("link_count", 0))
    }

internal fun parsePersonalTagSnapshot(value: JSONObject): PersonalTagSnapshot? {
    val revision = value.tagRevision("revision") ?: return null
    val decision = value.tagRevision("decision_id") ?: return null
    val content = value.tagRevision("content_revision") ?: return null
    val tags = value.optJSONArray("custom_tags") ?: return null
    val parsed = parsePersonalTags(tags)
    if (parsed.size != tags.length()) return null
    return PersonalTagSnapshot(revision, decision, content, parsed)
}

internal fun personalTagActionPayload(
    snapshot: PersonalTagSnapshot,
    action: JSONObject,
    operationKey: String = UUID.randomUUID().toString(),
): JSONObject = JSONObject().apply {
    put("operation_key", operationKey)
    put("expected_revision", snapshot.revision)
    put("expected_decision_id", snapshot.decisionId)
    put("expected_content_revision", snapshot.contentRevision)
    put("actions", JSONArray().put(action))
}

internal fun personalTagUndoPayload(
    snapshot: PersonalTagSnapshot,
    event: PersonalTagHistoryEvent,
    operationKey: String = UUID.randomUUID().toString(),
): JSONObject? = if (!event.reversible || event.revision != snapshot.revision) null else
    personalTagActionPayload(snapshot, JSONObject().put("action", "undo").put("operation_id", event.operationId), operationKey)

internal fun parsePersonalTagHistory(array: JSONArray?): List<PersonalTagHistoryEvent> =
    (0 until (array?.length() ?: 0)).mapNotNull { index ->
        val event = array?.optJSONObject(index) ?: return@mapNotNull null
        val operation = event.optString("operation_id")
        val revision = event.tagRevision("revision") ?: return@mapNotNull null
        val actions = event.optJSONArray("actions") ?: return@mapNotNull null
        val context = event.optJSONObject("context")
        val definitions = context?.optJSONArray("tag_definitions")
        val labels = mutableMapOf<String, String>()
        for (j in 0 until (definitions?.length() ?: 0)) {
            val term = definitions?.optJSONObject(j) ?: continue
            val label = term.optString("label")
            if (label.isNotBlank()) labels["system/${term.optString("field")}/${term.optString("term")}"] = label
        }
        fun label(ref: String): String = labels[ref] ?: when {
            ref.startsWith("custom/") -> "自定义标记（${ref.substringAfterLast('/').takeLast(6)}）"
            ref.startsWith("system/") -> ref.substringAfterLast('/')
            else -> "本组标签"
        }
        val summaries = (0 until actions.length()).mapNotNull { j ->
            val action = actions.optJSONObject(j) ?: return@mapNotNull null
            val target = action.optString("tag_ref").ifBlank {
                "system/${action.optString("field")}/${action.optString("term")}".takeIf { action.optString("term").isNotBlank() }.orEmpty()
            }
            when (action.optString("action")) {
                "accept", "attach" -> "添加 ${label(target)}"
                "confirm" -> "确认 ${label(target)}"
                "reject", "detach" -> "移除 ${label(target)}"
                "replace" -> "${label(action.optString("from_tag_ref"))} → ${label(action.optString("to_tag_ref"))}"
                "reset" -> "恢复 ${label(target)} 自动判断"
                "reset_group" -> "恢复本组自动判断"
                "set_empty" -> "明确本组都不适用"
                "undo" -> "撤销上次修改"
                else -> "标签变更"
            }
        }
        PersonalTagHistoryEvent(operation, revision, summaries.joinToString("；"), event.optString("created_at"),
            event.opt("before") is JSONObject && event.opt("after") is JSONObject &&
                operation.isNotBlank() && (0 until actions.length()).none { actions.optJSONObject(it)?.optString("action") == "undo" })
    }

/** Optional personal labels and history are independent of source availability. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PersonalTagsSection(
    linkId: Int,
    baseUrl: String,
    apiToken: String,
    onChanged: () -> Unit,
    onFlush: () -> Unit = {},
    editorDraft: PersonalTagEditorDraft? = null,
) {
    val context = LocalContext.current.applicationContext
    val outbox = remember(context) { PersonalTagOutbox(context) }
    val account = remember(baseUrl, apiToken) { accountKeyFor(baseUrl, apiToken) }
    val draft = editorDraft ?: rememberSaveable(linkId, account, saver = PersonalTagEditorDraft.saver) { PersonalTagEditorDraft() }
    val client = remember(baseUrl, account) { V2CurationClient(baseUrl) }
    val parentScope = rememberCoroutineScope()
    val scope = remember(linkId, account) { CoroutineScope(parentScope.coroutineContext + SupervisorJob(parentScope.coroutineContext[Job])) }
    DisposableEffect(linkId, account) { onDispose { scope.cancel() } }
    var snapshot by remember(linkId, account) { mutableStateOf<PersonalTagSnapshot?>(null) }
    var catalog by remember(linkId, account) { mutableStateOf<List<PersonalTagDefinition>>(emptyList()) }
    var events by remember(linkId, account) { mutableStateOf<List<PersonalTagHistoryEvent>>(emptyList()) }
    var nextHistory by remember(linkId, account) { mutableStateOf<Long?>(null) }
    var editing by draft.editing
    var showingHistory by draft.showingHistory
    var name by draft.name
    var busy by remember(linkId, account) { mutableStateOf(false) }
    var error by remember(linkId, account) { mutableStateOf<String?>(null) }
    var unsupported by remember(linkId, account) { mutableStateOf(false) }
    var pendingRow by remember(linkId, account) { mutableStateOf<PendingPersonalTag?>(null) }
    val pending = pendingRow?.request
    var conflicting by rememberSaveable(linkId, account) { mutableStateOf(false) }
    var refreshedAfterConflict by remember(linkId, account) { mutableStateOf(false) }
    var managing by remember(linkId, account) { mutableStateOf<PersonalTagDefinition?>(null) }
    var rename by draft.rename
    var archiveConfirm by remember(linkId, account) { mutableStateOf(false) }

    suspend fun loadSnapshot(): Boolean = when (val result = cancellableRead { client.loadTagSnapshot(linkId, apiToken, it) }) {
        is V2Result.Loaded -> {
            val parsed = parsePersonalTagSnapshot(result.value)
            if (parsed == null) { error = "标签结果暂时无法读取，请重试。"; false }
            else { snapshot = parsed; unsupported = false; true }
        }
        V2Result.Unsupported -> { unsupported = true; false }
        else -> { error = "标签读取失败，已有输入已保留。"; false }
    }
    suspend fun loadCatalog() {
        when (val result = cancellableRead { client.tagRequest("/api/custom-tags", "GET", apiToken, cancellation = it) }) {
            is V2Result.Loaded -> catalog = parsePersonalTags(result.value.optJSONArray("tags"))
            else -> error = "自定义标记读取失败，请重试。"
        }
    }
    suspend fun loadHistory(append: Boolean = false) {
        val cursor = if (append) nextHistory?.let { "?before_id=$it" }.orEmpty() else ""
        when (val result = cancellableRead { client.tagRequest("/api/bookmarks/$linkId/tag-history$cursor", "GET", apiToken, cancellation = it) }) {
            is V2Result.Loaded -> {
                val incoming = parsePersonalTagHistory(result.value.optJSONArray("events"))
                events = if (append) events + incoming else incoming
                nextHistory = result.value.tagRevision("next_before_id")
            }
            else -> error = "变更记录读取失败，请重试。"
        }
    }
    suspend fun execute(request: PersonalTagRequest) {
        busy = true
        error = null
        try {
            val next = PendingPersonalTag(account, linkId, request)
            val previous = pendingRow
            if (previous != null && previous.request.operationKey != request.operationKey) {
                check(previous.conflictRevision != null) // Only explicit conflict reapply changes a logical operation.
                outbox.replace(previous, next)
            } else outbox.enqueue(next)
            pendingRow = next
            conflicting = false
            refreshedAfterConflict = false
            onFlush()
        } catch (_: Exception) {
            error = "本地操作保存失败，输入已保留；请检查存储后重试。"
        }
        busy = false
    }
    fun submit(path: String, method: String, payload: JSONObject, attachCreated: Boolean = false, clearsName: Boolean = false) {
        if (busy || pending != null) return
        scope.launch { execute(PersonalTagRequest(path, method, payload.toString(), attachCreated, clearsName,
            attachmentSnapshot = if (attachCreated) snapshot else null)) }
    }
    fun apply(action: String, tag: PersonalTagDefinition) {
        val current = snapshot ?: return
        submit("/api/bookmarks/$linkId/tags", "POST", personalTagActionPayload(current, JSONObject().put("action", action).put("tag_ref", tag.tagRef)))
    }

    fun rebasedRequest(): PersonalTagRequest? {
        val draft = pending ?: return null
        val current = snapshot ?: return null
        val body = JSONObject(draft.body)
        if (draft.path == "/api/bookmarks/$linkId/tags") {
            val action = body.optJSONArray("actions")?.optJSONObject(0)
            if (action?.optString("action") == "undo" && body.tagRevision("expected_revision") != current.revision) return null
            body.put("expected_revision", current.revision).put("expected_decision_id", current.decisionId)
                .put("expected_content_revision", current.contentRevision)
        } else if (draft.method == "PATCH" || draft.method == "DELETE") {
            val definition = catalog.firstOrNull { it.id == draft.path.substringAfterLast('/') } ?: return null
            if (!definition.active) return null
            body.put("expected_revision", definition.revision)
        } else return null
        body.put("operation_key", UUID.randomUUID().toString())
        return draft.copy(body = body.toString())
    }

    LaunchedEffect(linkId, account) { loadSnapshot(); if (editing) loadCatalog(); if (showingHistory) loadHistory() }
    LaunchedEffect(linkId, account, outbox) {
        try {
            outbox.actions.collect { rows ->
                val previous = pendingRow
                val current = rows.firstOrNull { it.account == account && it.linkId == linkId }
                pendingRow = current
                conflicting = current?.conflictRevision != null
                if (current != null) {
                    val body = JSONObject(current.request.body)
                    if (name.isBlank() && body.has("label")) name = body.getString("label")
                    error = when {
                        conflicting -> "标签已被其他操作更新。修改已保存在本地；请刷新后检查，再重新应用。"
                        current.failure != null -> "操作尚未确认，已保存在本地；重启和重试会使用同一次操作。"
                        else -> "修改已保存在本地，正在等待同步。"
                    }
                } else if (previous != null) {
                    if (previous.request.clearsName) name = ""
                    managing = null; archiveConfirm = false; error = null
                    loadSnapshot(); if (editing) loadCatalog(); if (showingHistory) loadHistory()
                    onChanged()
                }
            }
        } catch (_: java.io.IOException) { error = "本地标签队列暂时无法读取；请检查存储后重试。" }
    }
    Column(Modifier.fillMaxWidth().testTag("personal_tags"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (snapshot?.customTags?.isNotEmpty() == true) {
            Text("自定义标记", style = MaterialTheme.typography.labelLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                snapshot?.customTags.orEmpty().forEach { tag ->
                    AssistChip(onClick = { managing = tag; rename = tag.label }, enabled = !busy && pending == null,
                        label = { Text(tag.label) }, trailingIcon = {
                            IconButton(onClick = { apply("detach", tag) }, enabled = !busy && pending == null) {
                                Icon(Icons.Default.Close, contentDescription = "移除${tag.label}")
                            }
                        })
                }
            }
        }
        Row {
            TextButton(onClick = {
                editing = !editing
                if (editing) scope.launch { if (snapshot == null) loadSnapshot(); loadCatalog() }
            }, enabled = !busy && !unsupported, modifier = Modifier.testTag("personal_tags_edit")) {
                Text(if (editing) "收起自定义标记" else "添加自定义标记")
            }
            TextButton(onClick = { showingHistory = !showingHistory; if (showingHistory) scope.launch { loadHistory() } },
                enabled = !busy && !unsupported, modifier = Modifier.testTag("tag_history_toggle")) { Text(if (showingHistory) "收起历史" else "变更历史") }
        }
        if (unsupported) Text("此服务版本暂不支持自定义标记和历史。", style = MaterialTheme.typography.bodySmall)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        if (pending != null) FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (!conflicting) TextButton(onClick = onFlush, enabled = !busy) { Text("重试本次操作") }
            TextButton(onClick = {
                scope.launch {
                    busy = true
                    if (loadSnapshot()) {
                        loadCatalog()
                        refreshedAfterConflict = conflicting
                        error = if (conflicting) "已读取最新结果，修改草稿仍保留。确认后可以重新应用。" else "已读取最新结果，请检查本次操作是否已生效。"
                    }
                    busy = false
                }
            }, enabled = !busy) { Text("刷新并检查") }
            if (conflicting && refreshedAfterConflict && rebasedRequest() != null) TextButton(onClick = {
                val request = rebasedRequest() ?: return@TextButton
                scope.launch { execute(request) }
            }, enabled = !busy) { Text("重新应用草稿") }
            TextButton(onClick = { scope.launch { outbox.discard(account, linkId); conflicting = false; error = null } }, enabled = !busy) { Text("放弃重试并读取结果") }
        } else if (snapshot == null && !unsupported) TextButton(onClick = { scope.launch { loadSnapshot() } }, enabled = !busy) { Text("重新读取标签") }
        if (editing && !unsupported) {
            OutlinedTextField(value = name, onValueChange = { name = it.take(80) }, label = { Text("新标记名称") }, singleLine = true,
                modifier = Modifier.fillMaxWidth().testTag("personal_tag_name"), enabled = !busy && pending == null)
            TextButton(onClick = {
                val label = name.trim()
                if (label.isNotEmpty()) submit("/api/custom-tags", "POST", JSONObject().put("operation_key", UUID.randomUUID().toString()).put("label", label), attachCreated = true)
            }, enabled = name.isNotBlank() && snapshot != null && !busy && pending == null) { Text("创建并添加") }
            catalog.filter { it.active }.forEach { tag ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { managing = tag; rename = tag.label }, enabled = !busy && pending == null, modifier = Modifier.weight(1f)) { Text(tag.label) }
                    val selected = snapshot?.customTags?.any { it.id == tag.id } == true
                    TextButton(onClick = { apply(if (selected) "detach" else "attach", tag) }, enabled = !busy && pending == null && snapshot != null) {
                        Text(if (selected) "从本条移除" else "添加到本条")
                    }
                }
            }
        }
        if (showingHistory && !unsupported) {
            if (events.isEmpty()) Text("暂无可用变更记录。", style = MaterialTheme.typography.bodySmall)
            events.forEach { event ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(event.summary, style = MaterialTheme.typography.bodySmall)
                    Text(event.createdAt, style = MaterialTheme.typography.labelSmall)
                    val current = snapshot
                    if (current != null && personalTagUndoPayload(current, event, "inspect") != null) {
                        TextButton(onClick = {
                            val payload = personalTagUndoPayload(current, event) ?: return@TextButton
                            submit("/api/bookmarks/$linkId/tags", "POST", payload)
                        }, enabled = !busy && pending == null, modifier = Modifier.testTag("tag_history_undo")) { Text("撤销这次修改") }
                    }
                }
            }
            nextHistory?.let { TextButton(onClick = { scope.launch { loadHistory(append = true) } }, enabled = !busy) { Text("更早的记录") } }
        }
    }
    managing?.let { tag ->
        AlertDialog(onDismissRequest = { if (!busy) managing = null },
            title = { Text("管理自定义标记") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("改名会同步到使用这个标记的收藏。")
                    OutlinedTextField(value = rename, onValueChange = { rename = it.take(80) }, singleLine = true, label = { Text("名称") }, enabled = !busy && pending == null)
                    TextButton(onClick = { archiveConfirm = true }, enabled = !busy && pending == null) { Text("归档这个标记") }
                    if (archiveConfirm) {
                        Text("归档会从所有使用它的收藏移除归属，并保留已有变更记录。")
                        TextButton(onClick = {
                            submit("/api/custom-tags/${tag.id}", "DELETE", JSONObject().put("operation_key", UUID.randomUUID().toString()).put("expected_revision", tag.revision).put("detach_all", true))
                        }, enabled = !busy && pending == null) { Text("确认归档并移除所有归属") }
                    }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = { TextButton(onClick = {
                submit("/api/custom-tags/${tag.id}", "PATCH", JSONObject().put("operation_key", UUID.randomUUID().toString()).put("expected_revision", tag.revision).put("label", rename.trim()))
            }, enabled = rename.isNotBlank() && !busy && pending == null) { Text("保存名称") } },
            dismissButton = { TextButton(onClick = { managing = null; archiveConfirm = false }, enabled = !busy) { Text("关闭，保留输入") } })
    }
}
