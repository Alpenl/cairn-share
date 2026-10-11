package com.alpenl.cairn.share

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.alpenl.cairn.share.ui.components.SegmentedToggle
import com.alpenl.cairn.share.ui.components.TagTone
import com.alpenl.cairn.share.ui.components.tagColor
import com.alpenl.cairn.share.ui.theme.CairnTheme
import java.util.UUID
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

internal val tagDimensionLabels=linkedMapOf("topics" to "主题","resource_kinds" to "资源类型","content_functions" to "内容特征","carriers" to "载体","affordances" to "潜在用途","forms" to "旧版形态","uses" to "旧版用途","custom" to "个人标签")
internal fun JSONObject.stringList(key:String):List<String> = optJSONArray(key)?.let{a->List(a.length()){a.getString(it)}}?:emptyList()
internal data class ManagedTag(val dimension:String,val definition:JSONObject){val id:String get()=definition.getString("id");val ref:String get()=if(dimension=="custom")"custom/default/$id"else"system/$dimension/$id";val label:String get()=definition.getString("label");val active:Boolean get()=definition.optBoolean("active")&&!definition.optBoolean("deprecated")}
internal fun catalogTags(payload:JSONObject?):List<ManagedTag>{
 val catalog=payload?.optJSONObject("catalog")?:return emptyList()
 val system=tagDimensionLabels.keys.filter{it!="custom"}.flatMap{dimension->catalog.optJSONArray(dimension)?.let{a->List(a.length()){ManagedTag(dimension,a.getJSONObject(it))}}?:emptyList()}
 val custom=payload.optJSONArray("custom_tags")?.let{a->List(a.length()){val t=JSONObject(a.getJSONObject(it).toString());t.put("active",t.optString("status")=="active").put("ai_enabled",false).put("description","个人标签，由你手动使用");ManagedTag("custom",t)}}?:emptyList()
 return system+custom
}

/** Types shown in 标签库 (decision: core types only; legacy 形态/用途/载体/潜在用途 stay readable via search "全部"). */
private val libraryTypes = listOf("topics", "resource_kinds", "content_functions", "custom")
private fun toneOf(dimension: String) = when (dimension) { "topics" -> TagTone.Topic; "resource_kinds" -> TagTone.Resource; "custom" -> TagTone.Personal; else -> TagTone.Feature }

/**
 * 设置 · 标签库 (prototype 80-tags): search, type filter, grouped list, and a
 * full-page detail editor. Writes go through the offline outbox
 * (TagManagementSync), so edits made without a connection apply later.
 */
@Composable internal fun TagManagerScreen(base: String, token: String, onBack: () -> Unit, onChanged: () -> Unit) {
    val app = LocalContext.current.applicationContext
    val account = remember(base, token) { accountKeyFor(base, token) }
    val store = remember(app) { CollectionStore(app) }
    val scope = rememberCoroutineScope()
    var state by remember(account) { mutableStateOf(TagManagementState()) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var query by rememberSaveable { mutableStateOf("") }
    var archived by rememberSaveable { mutableStateOf(false) }
    var dimension by rememberSaveable { mutableStateOf("all") }
    var editing by remember { mutableStateOf<Pair<String, JSONObject>?>(null) }
    var merging by remember { mutableStateOf<ManagedTag?>(null) }
    var history by remember { mutableStateOf<JSONArray?>(null) }
    fun action(block: suspend () -> Unit) { scope.launch { try { block() } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; message = e.message ?: "标签保存失败" } } }
    fun refresh() {
        if (busy) return
        action {
            busy = true
            try {
                TagManagementSync.run(app, base, token)
                val wasPending = state.pending != null
                val oldRevision = state.payload?.optLong("revision")
                state = store.tagManagement(account)
                if (state.payload?.optLong("revision") != oldRevision || (wasPending && state.pending == null)) onChanged()
            } finally { busy = false }
        }
    }
    fun enqueue(envelope: JSONObject) = action {
        store.enqueueTagManagement(account, envelope); state = store.tagManagement(account)
        editing = null; merging = null; TagManagementSync.schedule(app, base, token); refresh()
    }
    LaunchedEffect(account) { state = store.tagManagement(account); refresh(); CollectionStore.updates.collect { if (it == account) state = store.tagManagement(account) } }
    val tags = remember(state.payload) { catalogTags(state.payload) }
    val counts = remember(state.payload) {
        val a = state.payload?.optJSONArray("counts")
        buildMap<String, Int> { if (a != null) for (i in 0 until a.length()) { val c = a.getJSONObject(i); put(c.getString("field") + ":" + c.getString("term"), c.getInt("n")) } }
    }
    fun countOf(tag: ManagedTag): Int {
        val field = if (tag.dimension == "forms") "form" else if (tag.dimension == "uses") "use" else tag.dimension
        return if (tag.dimension == "custom") tag.definition.optInt("link_count") else counts["$field:${tag.id}"] ?: 0
    }
    val p = CairnTheme.palette
    val writable = state.payload != null && state.pending == null && !busy

    editing?.let { (dim, term) ->
        val tag = tags.firstOrNull { it.dimension == dim && term.has("id") && it.id == term.optString("id") }
        TagDetailPage(dim, term, tag?.let(::countOf) ?: 0, writable, tags.filter { it.dimension == "topics" && it.active },
            onBack = { editing = null },
            onSave = { type, definition ->
                if (dim == "custom") {
                    val body = JSONObject().put("operation_key", UUID.randomUUID().toString()).put("expected_revision", term.getLong("revision"))
                        .put("label", definition?.optString("label") ?: term.getString("label")).put("archived", type == "archive" || (type != "restore" && !term.optBoolean("active")))
                    enqueue(JSONObject().put("operation_key", body.getString("operation_key")).put("path", "/api/custom-tags/${term.getString("id")}").put("method", "PATCH").put("body", body))
                } else {
                    val payload = state.payload ?: return@TagDetailPage
                    val body = JSONObject().put("operation_key", UUID.randomUUID().toString()).put("expected_revision", payload.getLong("revision")).put("dimension", dim).put("type", type)
                    if (term.has("id")) body.put("id", term.getString("id"))
                    if (definition != null) body.put("definition", definition)
                    enqueue(body)
                }
            },
            onMerge = if (tag != null && tag.active && (dim == "topics" || dim == "custom")) ({ merging = tag }) else null,
            onHistory = if (dim != "custom" && term.has("id")) ({ action { history = TagManagementApi(base).request(token, "/history?dimension=$dim&id=${term.getString("id")}").getJSONArray("items") } }) else null,
        )
        merging?.let { from ->
            MergeDialog(from, tags.filter { it.dimension == from.dimension && it.active && it.ref != from.ref }, onDismiss = { merging = null }) { into ->
                val key = UUID.randomUUID().toString()
                val body = if (from.dimension == "custom") JSONObject().put("operation_key", key).put("kind", "custom").put("from", from.id).put("into", into.id)
                    else JSONObject().put("operation_key", key).put("expected_revision", state.payload?.getLong("revision") ?: 0).put("kind", "system").put("dimension", "topics").put("from", from.id).put("into", into.id)
                enqueue(JSONObject().put("operation_key", key).put("path", "/api/tag-catalog/merges").put("method", "POST").put("body", body))
            }
        }
        history?.let { rows -> HistoryDialog(rows) { history = null } }
        return
    }

    Column(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回") }
            Column(Modifier.weight(1f)) {
                Text("标签库", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                Text("${tags.count { it.active && it.dimension in libraryTypes }} 个标签 · 名称、含义、例子与 AI 开关", style = MaterialTheme.typography.labelSmall, color = p.tertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            TextButton(onClick = { editing = "topics" to JSONObject() }, enabled = writable) { Icon(Icons.Default.Add, null, Modifier.size(16.dp)); Text("新建") }
        }
        OutlinedTextField(query, { query = it }, placeholder = { Text("查找名称、别名或含义") }, singleLine = true,
            leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
            trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Default.Close, "清除") } },
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = p.hairlineSoft, focusedBorderColor = p.terracotta, unfocusedContainerColor = p.surface, focusedContainerColor = p.surface),
            modifier = Modifier.fillMaxWidth().testTag("tag_manager_search"))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TypePill("全部", dimension == "all") { dimension = "all" }
            for (d in libraryTypes) TypePill(tagDimensionLabels[d] ?: d, dimension == d, toneOf(d)) { dimension = d }
            TypePill("已归档", archived) { archived = !archived }
        }
        if (message.isNotBlank()) Text(message, color = p.danger, style = MaterialTheme.typography.bodySmall)
        if (state.error.isNotBlank()) Text(if (state.error.startsWith("rejected:")) tagManagementErrorLabel(state.error.removePrefix("rejected:")) else state.error,
            style = MaterialTheme.typography.bodySmall, color = p.muted)
        state.pending?.let { pending ->
            val intent = pending.optJSONObject("body") ?: pending
            val draft = intent.optJSONObject("definition")
            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).clip(RoundedCornerShape(10.dp)).background(p.manilla.copy(alpha = .45f)).padding(12.dp)) {
                Text((draft?.optString("label") ?: intent.optString("label")).ifBlank { "一项标签修改" } + " · 已保存在本机，等待同步", style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                if (state.error.startsWith("rejected:")) Row {
                    TextButton(onClick = { action { store.resolveTags(account, true); state = store.tagManagement(account); refresh() } }) { Text("核对后重试") }
                    TextButton(onClick = { action { store.resolveTags(account, false); state = store.tagManagement(account) } }) { Text("放弃本机修改") }
                } else TextButton(onClick = ::refresh, enabled = !busy) { Text("重试同步") }
            }
        }
        if (state.payload == null) Text(if (busy) "正在载入标签目录…" else "联网后载入标签目录，之后可离线查看。", Modifier.padding(vertical = 24.dp), color = p.tertiary)
        val shown = tags.filter {
            (if (dimension == "all") it.dimension in libraryTypes || query.isNotBlank() else it.dimension == dimension) && it.active != archived &&
                (it.label + " " + it.definition.stringList("aliases").joinToString(" ") + " " + it.definition.optString("description")).contains(query.trim(), true)
        }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (state.payload != null && shown.isEmpty()) item { Text(if (query.isBlank()) "这里还没有标签。" else "没有匹配「$query」的标签。", Modifier.padding(vertical = 24.dp), color = p.tertiary) }
            for ((d, group) in shown.groupBy { it.dimension }.toSortedMap(compareBy { (libraryTypes + tagDimensionLabels.keys).indexOf(it) })) {
                item(key = "h_$d") {
                    Row(Modifier.padding(top = 14.dp, bottom = 6.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(tagColor(toneOf(d))))
                        Text(tagDimensionLabels[d] ?: d, style = MaterialTheme.typography.labelMedium, color = p.muted, modifier = Modifier.padding(start = 6.dp))
                        Text(group.size.toString(), style = MaterialTheme.typography.labelSmall, color = p.faint, modifier = Modifier.padding(start = 6.dp))
                    }
                }
                items(group, key = { it.ref }) { tag ->
                    val ai = tag.dimension != "custom" && tag.definition.optBoolean("ai_enabled", true) && !(tag.dimension == "uses" && tag.id == "contra")
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { editing = tag.dimension to tag.definition }
                        .padding(horizontal = 6.dp, vertical = 12.dp).testTag("tag_row_${tag.ref}"), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (tag.dimension == "topics" && tag.definition.optString("granularity", "specific") == "specific") Text("· ", color = p.faint)
                                Text(tag.label, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium), color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (!ai && tag.dimension != "custom") Text("  AI 关", style = MaterialTheme.typography.labelSmall, color = p.tertiary)
                            }
                            val desc = tag.definition.optString("description")
                            if (desc.isNotBlank()) Text(desc, style = MaterialTheme.typography.bodySmall, color = p.tertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Text(countOf(tag).toString(), style = MaterialTheme.typography.labelMedium, color = p.tertiary)
                        Icon(CairnIcons.Chevron, null, Modifier.padding(start = 6.dp).size(14.dp), tint = p.faint)
                    }
                    HorizontalDivider(color = p.hairlineSoft)
                }
            }
        }
    }
}

@Composable private fun TypePill(label: String, selected: Boolean, tone: TagTone? = null, onClick: () -> Unit) {
    val p = CairnTheme.palette
    Row(Modifier.heightIn(min = 34.dp).clip(RoundedCornerShape(10.dp)).background(if (selected) p.ink else p.surface)
        .then(if (selected) Modifier else Modifier.border(1.dp, p.hairlineSoft, RoundedCornerShape(10.dp)))
        .clickable(onClick = onClick).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        if (tone != null) Box(Modifier.padding(end = 6.dp).size(6.dp).clip(CircleShape).background(tagColor(tone)))
        Text(label, style = MaterialTheme.typography.labelLarge, color = if (selected) p.canvas else p.inkSoft)
    }
}

/** 标签详情 (prototype and-tag-detail): settings card, 含义, 正例 / 反例, 别名; one 保存 per edit. */
@Composable private fun TagDetailPage(
    dimension: String, term: JSONObject, count: Int, writable: Boolean, parents: List<ManagedTag>,
    onBack: () -> Unit, onSave: (String, JSONObject?) -> Unit, onMerge: (() -> Unit)?, onHistory: (() -> Unit)?,
) {
    val p = CairnTheme.palette
    val creating = !term.has("id")
    val personalUse = dimension == "uses" && term.optString("id") == "contra"
    val custom = dimension == "custom"
    var name by rememberSaveable { mutableStateOf(term.optString("label")) }
    var description by rememberSaveable { mutableStateOf(term.optString("description")) }
    var aliases by rememberSaveable { mutableStateOf(term.stringList("aliases")) }
    var includes by rememberSaveable { mutableStateOf(term.stringList("includes")) }
    var excludes by rememberSaveable { mutableStateOf(term.stringList("excludes")) }
    var broad by rememberSaveable { mutableStateOf(term.optString("granularity", "specific") == "broad") }
    var ai by rememberSaveable { mutableStateOf(term.optBoolean("ai_enabled", true) && !personalUse && !custom) }
    var confirmArchive by remember { mutableStateOf(false) }
    val active = creating || (term.optBoolean("active") && !term.optBoolean("deprecated"))
    val dirty = creating || name.trim() != term.optString("label") || description.trim() != term.optString("description") ||
        aliases != term.stringList("aliases") || includes != term.stringList("includes") || excludes != term.stringList("excludes") ||
        broad != (term.optString("granularity", "specific") == "broad") || ai != (term.optBoolean("ai_enabled", true) && !personalUse && !custom)
    val valid = name.isNotBlank() && (custom || description.isNotBlank())
    fun definition(): JSONObject = if (custom) JSONObject().put("label", name.trim()) else JSONObject().put("label", name.trim()).put("aliases", JSONArray(aliases))
        .put("description", description.trim()).put("includes", JSONArray(includes)).put("excludes", JSONArray(excludes)).put("ai_enabled", ai)
        .apply { if (dimension == "topics") put("granularity", if (broad) "broad" else "specific") }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回") }
            Text(if (creating) "新建主题标签" else "标签详情", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Button(onClick = { onSave(if (creating) "create" else "edit", definition()) }, enabled = writable && dirty && valid,
                shape = RoundedCornerShape(10.dp), modifier = Modifier.padding(end = 8.dp).testTag("tag_detail_save")) { Text("保存") }
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(tagColor(toneOf(dimension))))
                Text("${tagDimensionLabels[dimension] ?: dimension}${if (creating) "" else " · $count 条收藏"}${if (active) "" else " · 已归档"}",
                    style = MaterialTheme.typography.labelMedium, color = p.tertiary, modifier = Modifier.padding(start = 6.dp))
            }
            androidx.compose.foundation.text.BasicTextField(name, { if (it.length <= 80) name = it }, singleLine = true, enabled = writable,
                textStyle = MaterialTheme.typography.headlineSmall.copy(color = p.ink),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(p.terracotta),
                decorationBox = { f -> Box { if (name.isEmpty()) Text("标签名称", style = MaterialTheme.typography.headlineSmall, color = p.faint); f() } },
                modifier = Modifier.fillMaxWidth().testTag("tag_manager_name"))
            Text("点按名称可以改名", style = MaterialTheme.typography.labelSmall, color = p.faint)
            if (!custom) Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.hairlineSoft, RoundedCornerShape(12.dp))) {
                DetailRow("参与 AI 自动打标", if (personalUse) "这是个人判断，只能由你手动添加。" else "AI 会按下面的含义判断是否建议这个标签") {
                    Switch(ai, { ai = it }, enabled = writable && !personalUse && active, modifier = Modifier.testTag("tag_manager_ai"),
                        colors = SwitchDefaults.colors(checkedTrackColor = p.terracotta, checkedBorderColor = p.terracotta, uncheckedTrackColor = p.hairline, uncheckedBorderColor = p.hairline, uncheckedThumbColor = p.surface))
                }
                if (dimension == "topics") {
                    HorizontalDivider(color = p.hairlineSoft)
                    DetailRow("粒度", "宽主题用于浏览，细分主题用于精确筛选") {
                        SegmentedToggle(listOf(true to "宽主题", false to "细分"), broad, { broad = it }, enabled = writable)
                    }
                    val parentIds = term.optJSONArray("relations")?.let { a -> List(a.length()) { a.getJSONObject(it) }.filter { it.optString("kind") == "broader" }.map { it.optString("id") } }.orEmpty()
                    if (parentIds.isNotEmpty()) {
                        HorizontalDivider(color = p.hairlineSoft)
                        DetailRow("上级主题", parentIds.joinToString("、") { id -> parents.firstOrNull { it.id == id }?.label ?: id }) {}
                    }
                }
            }
            if (!custom) {
                Text("含义", style = MaterialTheme.typography.labelLarge, color = p.ink)
                OutlinedTextField(description, { if (it.length <= 1000) description = it }, enabled = writable, minLines = 3, maxLines = 8,
                    placeholder = { Text("这个标签应该匹配什么内容") }, supportingText = { Text("AI 按这段话判断 · ${description.length} / 1000") },
                    shape = RoundedCornerShape(12.dp), colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = p.surface, focusedContainerColor = p.surface, unfocusedBorderColor = p.hairlineSoft, focusedBorderColor = p.terracotta),
                    modifier = Modifier.fillMaxWidth().testTag("tag_manager_definition"))
                ListEditor("正例", "应该打上这个标签的内容", includes, writable, "比如：设置页分组与间距规范") { includes = it }
                ListEditor("反例", "不该打这个标签的情况", excludes, writable, "比如：只提到名称，没有展开") { excludes = it }
                ListEditor("别名", "搜索和 AI 都会认这些叫法", aliases, writable, "加一个别名") { aliases = it }
            }
            if (!creating) Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.hairlineSoft, RoundedCornerShape(12.dp))) {
                onMerge?.let { DetailRow("合并到另一个标签", "这个标签的收藏和规则都会改用目标标签，可撤销", onClick = if (writable) it else null) { Icon(CairnIcons.Chevron, null, Modifier.size(14.dp), tint = p.faint) }; HorizontalDivider(color = p.hairlineSoft) }
                onHistory?.let { DetailRow("变更记录", "谁在什么时候改了它", onClick = it) { Icon(CairnIcons.Chevron, null, Modifier.size(14.dp), tint = p.faint) }; HorizontalDivider(color = p.hairlineSoft) }
                DetailRow(if (active) "归档" else "恢复", if (active) "不再出现在筛选和 AI 建议里；已有收藏上的标签保留" else "重新出现在筛选与 AI 建议中",
                    onClick = if (writable) ({ if (active) confirmArchive = true else onSave("restore", null) }) else null, danger = active) {}
            }
            Text("含义和 AI 开关只影响之后的新收藏；归档会保留历史标签与合集成员。", style = MaterialTheme.typography.bodySmall, color = p.tertiary, modifier = Modifier.padding(bottom = 24.dp))
        }
    }
    if (confirmArchive) AlertDialog(onDismissRequest = { confirmArchive = false }, title = { Text("归档「${term.optString("label")}」？") },
        text = { Text("归档后它不会再出现在筛选与 AI 建议里，已有收藏上的标签和合集成员保留，随时可以恢复。") },
        confirmButton = { TextButton(onClick = { confirmArchive = false; onSave("archive", null) }) { Text("归档", color = CairnTheme.palette.danger) } },
        dismissButton = { TextButton(onClick = { confirmArchive = false }) { Text("取消") } })
}

@Composable private fun DetailRow(title: String, subtitle: String, onClick: (() -> Unit)? = null, danger: Boolean = false, trailing: @Composable RowScope.() -> Unit) {
    val p = CairnTheme.palette
    Row(Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).heightIn(min = 56.dp).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium), color = if (danger) p.danger else p.ink)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = p.tertiary)
        }
        Spacer(Modifier.width(10.dp))
        trailing()
    }
}

@Composable private fun ListEditor(title: String, hint: String, values: List<String>, enabled: Boolean, placeholder: String, onChange: (List<String>) -> Unit) {
    val p = CairnTheme.palette
    var draft by rememberSaveable(title) { mutableStateOf("") }
    fun add() { val v = draft.trim(); if (v.isNotEmpty() && v !in values) onChange(values + v); draft = "" }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(title, style = MaterialTheme.typography.labelLarge, color = p.ink, modifier = Modifier.weight(1f))
            Text(hint, style = MaterialTheme.typography.labelSmall, color = p.faint)
        }
        for (v in values) Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.surface).border(1.dp, p.hairlineSoft, RoundedCornerShape(10.dp)).padding(start = 12.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(v, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, modifier = Modifier.weight(1f).padding(vertical = 10.dp))
            IconButton(onClick = { onChange(values - v) }, enabled = enabled) { Icon(Icons.Default.Close, "删除「$v」", Modifier.size(16.dp), tint = p.tertiary) }
        }
        OutlinedTextField(draft, { draft = it }, enabled = enabled, singleLine = true, placeholder = { Text(placeholder) },
            trailingIcon = { IconButton(onClick = ::add, enabled = enabled && draft.isNotBlank()) { Icon(Icons.Default.Add, "添加") } },
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { add() }),
            shape = RoundedCornerShape(10.dp), colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = p.surface, focusedContainerColor = p.surface, unfocusedBorderColor = p.hairlineSoft, focusedBorderColor = p.terracotta),
            modifier = Modifier.fillMaxWidth())
    }
}

@Composable private fun MergeDialog(from: ManagedTag, targets: List<ManagedTag>, onDismiss: () -> Unit, onMerge: (ManagedTag) -> Unit) {
    var q by rememberSaveable { mutableStateOf("") }
    var chosen by remember { mutableStateOf<ManagedTag?>(null) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("把「${from.label}」合并到…") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("查找目标标签") }, modifier = Modifier.fillMaxWidth())
            LazyColumn(Modifier.heightIn(max = 300.dp)) {
                items(targets.filter { (it.label + it.definition.stringList("aliases").joinToString(" ")).contains(q.trim(), true) }, key = { it.ref }) { t ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { chosen = t }
                        .background(if (chosen?.ref == t.ref) CairnTheme.palette.manilla.copy(alpha = .5f) else androidx.compose.ui.graphics.Color.Transparent)
                        .padding(horizontal = 10.dp, vertical = 12.dp)) { Text(t.label) }
                }
            }
            Text("合并后，原标签的收藏与合集规则改用目标标签；可以在网页设置里撤销。", style = MaterialTheme.typography.bodySmall, color = CairnTheme.palette.tertiary)
        }
    }, confirmButton = { TextButton(onClick = { chosen?.let(onMerge) }, enabled = chosen != null) { Text("合并") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

@Composable private fun HistoryDialog(rows: JSONArray, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("变更记录") }, text = {
        LazyColumn(Modifier.heightIn(max = 400.dp)) {
            items(rows.length()) { i ->
                val row = rows.getJSONObject(i)
                Text(row.getString("created_at").shortDateTime() + " · " + (mapOf("create" to "创建", "edit" to "修改", "archive" to "归档", "restore" to "恢复", "merge" to "合并", "unmerge" to "撤销合并")[row.getString("action")] ?: row.getString("action")),
                    Modifier.padding(vertical = 8.dp))
            }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}

internal fun tagManagementErrorLabel(code:String):String=when(code){"revision_conflict"->"其他设备已修改目录，请核对当前内容后重试。";"tag_collision"->"名称或别名已被其他标签使用，请修改后重新提交。";"last_ai_tag"->"每个分类至少保留一个 AI 标签。";"invalid_tag_definition"->"标签名称和含义不能为空，请检查字段长度。";else->"修改尚未提交：$code"}
