package com.alpenl.cairn.share

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.IconButton
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.BookmarkClassification
import com.alpenl.cairn.share.network.BookmarkFilters
import com.alpenl.cairn.share.network.BookmarkTaxonomy
import com.alpenl.cairn.share.network.CurationStatus
import com.alpenl.cairn.share.network.CurationUpdate
import com.alpenl.cairn.share.network.LinkEnrichment
import com.alpenl.cairn.share.network.LinksApiClient
import com.alpenl.cairn.share.network.TaxonomyTerm
import com.alpenl.cairn.share.network.V2CurationClient
import com.alpenl.cairn.share.network.V2Result
import com.alpenl.cairn.share.network.cancellableRead
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal fun LinkEnrichment.statusLabel(): String = when (status) {
    "completed" -> "内容已归档"
    "processing" -> "正在整理内容"
    "failed" -> "读取失败，稍后重试"
    "exhausted" -> "暂时无法读取内容"
    "unsupported" -> if (originalText.isNotBlank()) "正文已归档" else "尚未归档正文"
    else -> "等待整理内容"
}

internal fun BookmarkClassification.label(taxonomy: BookmarkTaxonomy?): String {
    fun term(terms: List<TaxonomyTerm>?, id: String) = terms?.firstOrNull { it.id == id }?.label ?: id
    val main = orderedTopics(topics, taxonomy).map { term(taxonomy?.topics, it) }
    val other = if (taxonomy?.resourceKinds?.isNotEmpty() == true) resourceKinds.map { term(taxonomy.resourceKinds, it) }
        else listOf(term(taxonomy?.forms, form), term(taxonomy?.uses, use))
    return (main + other)
        .filter { it.isNotBlank() }.joinToString(" · ")
}

@Composable
internal fun BookmarkCuration(
    id: Int,
    enrichment: LinkEnrichment,
    taxonomy: BookmarkTaxonomy?,
    busy: Boolean,
    onLoadTaxonomy: () -> Unit,
    onSave: (CurationUpdate, () -> Unit) -> Unit,
) {
    var editing by rememberSaveable(id) { mutableStateOf(false) }
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(enrichment.curationStatus.label, style = MaterialTheme.typography.titleMedium)
                TextButton(onClick = { editing = true; onLoadTaxonomy() }, enabled = !busy, modifier = Modifier.testTag("edit_curation")) {
                    Text("整理")
                }
            }
            enrichment.classification?.let { classification ->
                Text(classification.label(taxonomy).ifBlank { "尚未分类" }, style = MaterialTheme.typography.bodyMedium)
                if (taxonomy?.resourceKinds.isNullOrEmpty() && !enrichment.classificationReviewed && classification.uncertainty) Text("分类待确认", style = MaterialTheme.typography.labelSmall)
                if (classification.entities.isNotEmpty()) Text(classification.entities.joinToString(" / "), style = MaterialTheme.typography.bodySmall)
            }
            if (enrichment.why.isNotBlank()) SelectionContainer { Text(enrichment.why) }
            else if (taxonomy?.resourceKinds.isNullOrEmpty() && enrichment.classification?.whySuggestion?.isNotBlank() == true) {
                Text("用途建议：${enrichment.classification.whySuggestion}", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
    if (editing) CurationDialog(
        enrichment, taxonomy, busy, onLoadTaxonomy,
        onDismiss = { editing = false },
        onSave = { onSave(it) { editing = false } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CurationDialog(
    enrichment: LinkEnrichment,
    taxonomy: BookmarkTaxonomy?,
    busy: Boolean,
    onLoadTaxonomy: () -> Unit,
    onDismiss: () -> Unit,
    onSave: (CurationUpdate) -> Unit,
) {
    var why by rememberSaveable { mutableStateOf(enrichment.why) }
    var status by rememberSaveable { mutableStateOf(enrichment.curationStatus) }
    var topics by rememberSaveable { mutableStateOf(enrichment.classification?.topics.orEmpty()) }
    var form by rememberSaveable { mutableStateOf(enrichment.classification?.form.orEmpty()) }
    var use by rememberSaveable { mutableStateOf(enrichment.classification?.use.orEmpty()) }
    val whyLength = why.codePointCount(0, why.length)
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("整理收藏") },
        text = {
            Column(Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (value in CurationStatus.entries) FilterChip(
                        selected = value == status, onClick = { status = value }, enabled = !busy,
                        label = { Text(value.label) }, modifier = Modifier.testTag("curation_status_${value.apiValue}"),
                    )
                }
                OutlinedTextField(
                    value = why, onValueChange = { why = it }, label = { Text("收藏原因") },
                    supportingText = { Text("$whyLength / 200") }, isError = whyLength > 200,
                    enabled = !busy, minLines = 2, modifier = Modifier.fillMaxWidth().testTag("curation_why"),
                )
                if (taxonomy?.resourceKinds.isNullOrEmpty() && enrichment.classification?.whySuggestion?.isNotBlank() == true) TextButton(
                    onClick = { why = enrichment.classification.whySuggestion }, enabled = !busy,
                ) { Text("使用用途建议") }
                if (taxonomy == null) {
                    TextButton(onClick = onLoadTaxonomy, enabled = !busy) { Text("重新读取标签词表") }
                } else if (taxonomy.resourceKinds.isEmpty()) {
                    Text("主题（${topics.size}/3）")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (term in taxonomy.topics.filter { it.active || it.id in topics }) FilterChip(
                            selected = term.id in topics,
                            onClick = { topics = if (term.id in topics) topics - term.id else topics + term.id },
                            enabled = !busy && (term.id in topics || (term.active && topics.size < 3)),
                            label = { Text(term.label) }, modifier = Modifier.testTag("topic_${term.id}"),
                        )
                    }
                    TermSelector("形态", form, taxonomy.forms, !busy) { form = it }
                    TermSelector("用途", use, taxonomy.uses, !busy) { use = it }
                }
                if (enrichment.classificationReviewed && taxonomy?.resourceKinds.isNullOrEmpty()) TextButton(
                    onClick = { onSave(CurationUpdate(why = why, status = status, resetClassification = true)) }, enabled = !busy && whyLength <= 200,
                    modifier = Modifier.testTag("reset_classification"),
                ) { Text("恢复自动分类") }
            }
        },
        confirmButton = {
            Button(onClick = {
                val chosen = BookmarkClassification(topics = topics, form = form, use = use)
                val previous = enrichment.classification
                val changed = topics.toSet() != previous?.topics.orEmpty().toSet() || form != previous?.form.orEmpty() || use != previous?.use.orEmpty()
                onSave(CurationUpdate(why, status, chosen.takeIf { taxonomy != null && taxonomy.resourceKinds.isEmpty() && changed }))
            }, enabled = !busy && whyLength <= 200, modifier = Modifier.testTag("save_curation")) {
                Text(if (busy) "保存中" else "保存")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("取消") } },
    )
}

@Composable
internal fun TermSelector(label: String, value: String, terms: List<TaxonomyTerm>, enabled: Boolean = true, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        TextButton(onClick = { expanded = true }, enabled = enabled) {
            Text("$label：${terms.firstOrNull { it.id == value }?.label ?: value.ifBlank { "未指定" }}")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(text = { Text("未指定") }, onClick = { expanded = false; onChange("") })
            for (term in terms.filter { it.active || it.id == value }) DropdownMenuItem(
                text = { Text(term.label) }, onClick = { expanded = false; onChange(term.id) }, enabled = term.active,
            )
        }
    }
}

// Only account fingerprints are retained; raw credentials are never cache keys.
internal object BookmarkImageCache {
    private data class Key(val account: String, val image: String, val version: String)
    private val cache = object : LruCache<Key, Bitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: Key, value: Bitmap): Int = value.allocationByteCount
    }
    private val deleted = mutableSetOf<Pair<String, Int>>()
    var revision by mutableStateOf(0L)
        private set

    private fun linkId(key: String): Int? = key.split('/').let {
        if (it.size == 3 && it[0] == "enrichment") it[1].toIntOrNull() else null
    }
    @Synchronized fun isDeleted(account: String, key: String): Boolean = account to linkId(key) in deleted
    @Synchronized fun get(account: String, key: String, version: String = ""): Bitmap? =
        if (isDeleted(account, key)) null else cache.get(Key(account, key, version))
    @Synchronized fun put(account: String, key: String, bitmap: Bitmap, version: String = "", expectedRevision: Long? = null): Bitmap? {
        if (isDeleted(account, key) || (expectedRevision != null && expectedRevision != revision)) return null
        cache.put(Key(account, key, version), bitmap)
        return bitmap
    }
    @Synchronized fun clear(account: String) {
        for (key in cache.snapshot().keys) if (key.account == account) cache.remove(key)
        revision += 1
    }
    @Synchronized fun forget(account: String, id: Int) {
        if (!deleted.add(account to id)) return
        for (key in cache.snapshot().keys) if (key.account == account && linkId(key.image) == id) cache.remove(key)
        revision += 1
    }
}

@Composable
internal fun BookmarkImage(baseUrl: String, apiToken: String, imageKey: String, version: String = "", expectedVersion: String? = null) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val media = remember(context) { LocalMediaStore(context) }
    val account = accountKeyFor(baseUrl, apiToken)
    val cacheKey = "$account|$imageKey|$version"
    val cacheRevision = BookmarkImageCache.revision
    if (BookmarkImageCache.isDeleted(account, imageKey)) return
    var retry by remember(imageKey) { mutableStateOf(0) }
    var loading by remember(cacheKey) { mutableStateOf(true) }
    var bitmap by remember(cacheKey, cacheRevision) { mutableStateOf(BookmarkImageCache.get(account, imageKey, version)) }
    LaunchedEffect(cacheKey, cacheRevision, retry) {
        loading = true
        bitmap = BookmarkImageCache.get(account, imageKey, version) ?: withContext(Dispatchers.IO) {
            val bytes = try { media.load(account, imageKey, version) { LinksApiClient(baseUrl).image(imageKey, apiToken, expectedVersion) } }
                catch (_: java.io.IOException) { null } ?: return@withContext null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
            val options = BitmapFactory.Options()
            while (maxOf(bounds.outWidth, bounds.outHeight) / options.inSampleSize.coerceAtLeast(1) > 2048) {
                options.inSampleSize = options.inSampleSize.coerceAtLeast(1) * 2
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.let { BookmarkImageCache.put(account, imageKey, it, version, cacheRevision) }
        }
        loading = false
    }
    Column(Modifier.fillMaxWidth().testTag("bookmark_image")) {
        when {
            bitmap != null -> Image(bitmap!!.asImageBitmap(), contentDescription = "收藏图片", contentScale = ContentScale.FillWidth, modifier = Modifier.fillMaxWidth())
            loading -> LinearProgressIndicator(Modifier.fillMaxWidth())
            else -> TextButton(onClick = { retry++ }) { Text("图片加载失败，点击重试") }
        }
    }
}

internal fun bookmarkFilterLabels(filters: BookmarkFilters, taxonomy: BookmarkTaxonomy?, customTags: List<PersonalTagDefinition> = emptyList()): List<String> {
    fun label(id: String, terms: List<TaxonomyTerm>?) = terms.orEmpty().firstOrNull { it.id == id }?.label ?: id
    return buildList {
        if (filters.curationStatus.isNotBlank()) add(CurationStatus.entries.firstOrNull { it.apiValue == filters.curationStatus }?.label ?: filters.curationStatus)
        for (id in (filters.topics + listOf(filters.topic).filter { it.isNotBlank() }).distinct()) add(label(id, taxonomy?.topics))
        for (id in filters.topicRefinements) add("进一步：${label(id, taxonomy?.topics)}")
        for (id in filters.resourceKinds) add(label(id, taxonomy?.resourceKinds))
        for (id in filters.customTags) add(customTags.firstOrNull { it.id == id }?.label ?: "自定义：$id")
        for (id in filters.contentFunctions) add(label(id, taxonomy?.contentFunctions))
        for (id in filters.carriers) add(label(id, taxonomy?.carriers))
        for (id in filters.affordances) add(label(id, taxonomy?.affordances))
        if (filters.form.isNotBlank()) add(label(filters.form, taxonomy?.forms))
        if (filters.use.isNotBlank()) add(label(filters.use, taxonomy?.uses))
        if (filters.source.isNotBlank()) add(mapOf("x" to "X", "wechat" to "公众号", "other" to "其他来源")[filters.source] ?: filters.source)
        if (filters.uncertain) add("分类待确认")
        if (filters.recentDays > 0) add("近 ${filters.recentDays} 天")
        for (id in filters.entityState.split(',').filter { it.isNotBlank() }) add(entityFilterLabels[id] ?: id)
    }
}

private val entityFilterLabels = linkedMapOf("not_run" to "未运行", "failed" to "失败", "completed_empty" to "完成，无实体", "completed_nonempty" to "完成，有实体", "stale" to "来源已变化")

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
internal fun BookmarkFilterPanel(filters: BookmarkFilters, taxonomy: BookmarkTaxonomy?, onChange: (BookmarkFilters) -> Unit,
    baseUrl: String = "", apiToken: String = "", query: String = "", learned: String = "all",
    leadingContent: (@Composable RowScope.() -> Unit)? = null) {
    val account = accountKeyFor(baseUrl, apiToken)
    var expanded by rememberSaveable(account) { mutableStateOf(false) }
    var advanced by rememberSaveable(account) { mutableStateOf(false) }
    var customCatalog by remember(account) { mutableStateOf(emptyList<PersonalTagDefinition>()) }
    var catalogError by remember(account) { mutableStateOf(false) }
    var catalogRetry by remember(account) { mutableStateOf(0) }
    LaunchedEffect(expanded, account, taxonomy?.resourceKinds?.isNotEmpty(), catalogRetry) {
        if (expanded && baseUrl.isNotBlank() && apiToken.isNotBlank() && taxonomy?.resourceKinds?.isNotEmpty() == true) {
            val result = cancellableRead { V2CurationClient(baseUrl).tagRequest("/api/custom-tags", "GET", apiToken, cancellation = it) }
            if (result is V2Result.Loaded) { customCatalog = parsePersonalTags(result.value.optJSONArray("tags")); catalogError = false }
            else catalogError = true
        }
    }
    val labels = bookmarkFilterLabels(filters, taxonomy, customCatalog)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        leadingContent?.invoke(this)
        if (leadingContent != null) {
            IconButton(onClick = { expanded = true }, modifier = Modifier.size(48.dp).testTag("bookmark_filters")
                .semantics { contentDescription = if (labels.isEmpty()) "筛选收藏" else "筛选收藏，已选：${labels.joinToString("，")}" }) {
                BadgedBox(badge = { if (labels.isNotEmpty()) Badge(containerColor = MaterialTheme.colorScheme.primary) }) {
                    Icon(CairnIcons.Filter, contentDescription = null, modifier = Modifier.size(20.dp),
                        tint = if (labels.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary)
                }
            }
        } else {
            TextButton(onClick = { expanded = true }, shape = RoundedCornerShape(6.dp),
                contentPadding = PaddingValues(horizontal = 2.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = if (labels.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("bookmark_filters")
                .semantics { contentDescription = if (labels.isEmpty()) "筛选收藏" else "筛选收藏，已选：${labels.joinToString("，")}" }) {
                Icon(CairnIcons.Filter, contentDescription = null, modifier = Modifier.size(17.dp))
                Text(if (labels.isEmpty()) "筛选" else labels.take(2).joinToString(" · ") + if (labels.size > 2) " +${labels.size - 2}" else "",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f).padding(start = 8.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(CairnIcons.Down, contentDescription = null, modifier = Modifier.size(14.dp))
            }
            if (filters != BookmarkFilters()) TextButton(onClick = { onChange(BookmarkFilters()) },
                modifier = Modifier.heightIn(min = 48.dp).testTag("clear_bookmark_filters")) {
                Text("清除筛选", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
    if (leadingContent != null && labels.isNotEmpty()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(labels.joinToString(" · "), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).testTag("active_filter_summary"))
            TextButton(onClick = { onChange(BookmarkFilters()) },
                modifier = Modifier.heightIn(min = 48.dp).testTag("clear_bookmark_filters")) {
                Text("清除筛选", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
    if (expanded) ModalBottomSheet(onDismissRequest = { expanded = false },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp,
        shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f).testTag("bookmark_filter_sheet")) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("筛选收藏", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { onChange(BookmarkFilters()) }, enabled = filters != BookmarkFilters(),
                    modifier = Modifier.heightIn(min = 48.dp).testTag("reset_filter_sheet")) {
                    Text("重置", style = MaterialTheme.typography.labelMedium)
                }
            }
            Text("点选即生效 · 分组间同时满足", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp).padding(bottom = 8.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Column(Modifier.padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                TopicNavigation(filters, taxonomy?.topics.orEmpty(), baseUrl, apiToken, query, learned, onChange)
                if (taxonomy == null) Text("标签词表暂未加载；已选条件保留，也可清除后重试。", style = MaterialTheme.typography.bodySmall)
                if (!taxonomy?.resourceKinds.isNullOrEmpty() || filters.resourceKinds.isNotEmpty()) {
                    if ((filters.topics + filters.topic).filter { it.isNotBlank() }.distinct().size >= 2) {
                        TagFilterMode("主题匹配", filters.topicsMode) { onChange(filters.copy(topicsMode = it)) }
                    }
                    FilterDimension("资源类型", "resource_kinds", filters.resourceKinds, taxonomy?.resourceKinds.orEmpty()) { onChange(filters.copy(resourceKinds = it)) }
                    if (filters.resourceKinds.filter { it.isNotBlank() }.distinct().size >= 2) {
                        TagFilterMode("资源类型匹配", filters.resourceMode) { onChange(filters.copy(resourceMode = it)) }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant, modifier = Modifier.padding(top = 8.dp))
                TextButton(onClick = { advanced = !advanced }, contentPadding = PaddingValues(horizontal = 0.dp),
                    modifier = Modifier.heightIn(min = 48.dp).testTag("advanced_bookmark_filters")
                    .semantics { stateDescription = if (advanced) "已展开" else "已折叠" }) {
                    Text(if (advanced) "收起更多条件" else "更多筛选条件", style = MaterialTheme.typography.labelMedium)
                    Icon(if (advanced) CairnIcons.Down else CairnIcons.Chevron, contentDescription = null,
                        modifier = Modifier.padding(start = 6.dp).size(14.dp))
                }
                if (advanced) {
                    Text("整理状态", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (status in CurationStatus.entries) QuietFilterTag(label = status.label,
                            selected = filters.curationStatus == status.apiValue,
                            onClick = { onChange(filters.copy(curationStatus = if (filters.curationStatus == status.apiValue) "" else status.apiValue)) },
                            modifier = Modifier.testTag("filter_curation_${status.apiValue}"),
                        )
                    }
                    Text("来源与时间", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((value, label) in listOf("x" to "X", "wechat" to "公众号", "other" to "其他来源")) QuietFilterTag(label = label,
                            selected = filters.source == value, onClick = { onChange(filters.copy(source = if (filters.source == value) "" else value)) },
                        )
                        QuietFilterTag(label = "分类待确认", selected = filters.uncertain, onClick = { onChange(filters.copy(uncertain = !filters.uncertain)) })
                        for (days in listOf(7, 30)) QuietFilterTag(label = "近 $days 天", selected = filters.recentDays == days, onClick = { onChange(filters.copy(recentDays = if (filters.recentDays == days) 0 else days)) })
                    }
                    if (customCatalog.isNotEmpty() || filters.customTags.isNotEmpty()) {
                        FilterDimension("自定义标记", "custom_tags", filters.customTags, customCatalog.map { TaxonomyTerm(it.id, it.label, it.active) }) { onChange(filters.copy(customTags = it)) }
                        if (filters.customTags.filter { it.isNotBlank() }.distinct().size >= 2) {
                            TagFilterMode("自定义标记匹配", filters.customMode) { onChange(filters.copy(customMode = it)) }
                        }
                    }
                    if (catalogError) {
                        Text("自定义标记暂时无法读取，已选条件保留。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { catalogRetry++ }) { Text("重试读取自定义标记") }
                    }
                    if (taxonomy?.multiDimensional == true || filters.contentFunctions.isNotEmpty()) {
                        FilterDimension("内容功能", "content_functions", filters.contentFunctions, taxonomy?.contentFunctions.orEmpty()) { onChange(filters.copy(contentFunctions = it)) }
                        if (!taxonomy?.resourceKinds.isNullOrEmpty() && filters.contentFunctions.filter { it.isNotBlank() }.distinct().size >= 2) {
                            TagFilterMode("内容功能匹配", filters.functionsMode) { onChange(filters.copy(functionsMode = it)) }
                        }
                    }
                    if (taxonomy?.multiDimensional == true || filters.carriers.isNotEmpty() || filters.affordances.isNotEmpty()) {
                        FilterDimension("载体（任一）", "carriers", filters.carriers, taxonomy?.carriers.orEmpty()) { onChange(filters.copy(carriers = it)) }
                        FilterDimension("潜在用途", "affordances", filters.affordances, taxonomy?.affordances.orEmpty()) { onChange(filters.copy(affordances = it)) }
                    }
                    FlowRow {
                        TermSelector("形态", filters.form, taxonomy?.forms.orEmpty()) { onChange(filters.copy(form = it)) }
                        TermSelector("用途", filters.use, taxonomy?.uses.orEmpty()) { onChange(filters.copy(use = it)) }
                    }
                    Text("实体处理状态（任一）", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        val selected = filters.entityState.split(',').filter { it.isNotEmpty() }
                        for ((value, label) in entityFilterLabels) QuietFilterTag(label = label, selected = value in selected,
                            onClick = { onChange(filters.copy(entityState = (if (value in selected) selected - value else selected + value).joinToString(","))) },
                            modifier = Modifier.testTag("filter_entity_state_$value"))
                    }
                }
            }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Button(onClick = { expanded = false }, shape = RoundedCornerShape(8.dp), elevation = null,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)
                    .heightIn(min = 48.dp).testTag("view_filter_results")) {
                Text("查看结果", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterDimension(label: String, key: String, selected: List<String>, terms: List<TaxonomyTerm>, onChange: (List<String>) -> Unit) {
    Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 8.dp))
    val choices = terms.filter { it.active || it.id in selected }.map { it.id to (it.label + if (it.active) "" else "（已停用）") } +
        selected.filter { id -> terms.none { it.id == id } }.map { it to "$it（词表不可用）" }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((id, text) in choices) QuietFilterTag(label = text, selected = id in selected,
            onClick = { onChange(if (id in selected) selected - id else selected + id) },
            modifier = Modifier.testTag("filter_${key}_$id"))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TagFilterMode(label: String, mode: String, onChange: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.CenterVertically))
        for ((value, label) in listOf("any" to "任一", "all" to "全部")) QuietFilterTag(label = label,
            selected = mode == value, onClick = { onChange(value) })
    }
}
