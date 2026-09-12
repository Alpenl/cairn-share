package com.alpenl.cairn.share

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.BookmarkClassification
import com.alpenl.cairn.share.network.BookmarkFilters
import com.alpenl.cairn.share.network.BookmarkTaxonomy
import com.alpenl.cairn.share.network.CurationStatus
import com.alpenl.cairn.share.network.CurationUpdate
import com.alpenl.cairn.share.network.LinkEnrichment
import com.alpenl.cairn.share.network.LinksApiClient
import com.alpenl.cairn.share.network.TaxonomyTerm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal fun LinkEnrichment.statusLabel(): String = when (status) {
    "completed" -> "内容已归档"
    "processing" -> "正在整理内容"
    "failed" -> "读取失败，稍后重试"
    "exhausted" -> "暂时无法读取内容"
    "unsupported" -> "尚未归档正文"
    else -> "等待整理内容"
}

internal fun BookmarkClassification.label(taxonomy: BookmarkTaxonomy?): String {
    fun term(terms: List<TaxonomyTerm>?, id: String) = terms?.firstOrNull { it.id == id }?.label ?: id
    return (topics.map { term(taxonomy?.topics, it) } + term(taxonomy?.forms, form) + term(taxonomy?.uses, use))
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
                if (!enrichment.classificationReviewed && classification.uncertainty) Text("分类待确认", style = MaterialTheme.typography.labelSmall)
                if (classification.entities.isNotEmpty()) Text(classification.entities.joinToString(" / "), style = MaterialTheme.typography.bodySmall)
            }
            if (enrichment.why.isNotBlank()) SelectionContainer { Text(enrichment.why) }
            else if (enrichment.classification?.whySuggestion?.isNotBlank() == true) {
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
                if (enrichment.classification?.whySuggestion?.isNotBlank() == true) TextButton(
                    onClick = { why = enrichment.classification.whySuggestion }, enabled = !busy,
                ) { Text("使用用途建议") }
                if (taxonomy == null) {
                    TextButton(onClick = onLoadTaxonomy, enabled = !busy) { Text("重新读取标签词表") }
                } else {
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
                if (enrichment.classificationReviewed) TextButton(
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
                onSave(CurationUpdate(why, status, chosen.takeIf { taxonomy != null && (changed || !enrichment.classificationReviewed) }))
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

// Bound decoded pixels as well as response bytes. Including the token in the
// cache key prevents reuse across credential sessions.
private val imageCache = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.allocationByteCount
}

@Composable
internal fun BookmarkImage(baseUrl: String, apiToken: String, imageKey: String) {
    val cacheKey = "$baseUrl|$apiToken|$imageKey"
    var retry by remember(imageKey) { mutableStateOf(0) }
    var loading by remember(cacheKey) { mutableStateOf(true) }
    var bitmap by remember(cacheKey) { mutableStateOf(imageCache.get(cacheKey)) }
    LaunchedEffect(cacheKey, retry) {
        loading = true
        bitmap = imageCache.get(cacheKey) ?: withContext(Dispatchers.IO) {
            val bytes = LinksApiClient(baseUrl).image(imageKey, apiToken) ?: return@withContext null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
            val options = BitmapFactory.Options()
            while (maxOf(bounds.outWidth, bounds.outHeight) / options.inSampleSize.coerceAtLeast(1) > 2048) {
                options.inSampleSize = options.inSampleSize.coerceAtLeast(1) * 2
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.also { imageCache.put(cacheKey, it) }
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

private fun filterPanelLabel(filters: BookmarkFilters): String {
    if (filters == BookmarkFilters()) return "筛选"
    val parts = mutableListOf<String>()
    CurationStatus.entries.firstOrNull { it.apiValue == filters.curationStatus }?.let { parts += it.label }
    when (filters.source) {
        "x" -> parts += "X"
        "wechat" -> parts += "公众号"
        "other" -> parts += "其他来源"
    }
    if (filters.uncertain) parts += "待确认"
    if (filters.recentDays > 0) parts += "近 ${filters.recentDays} 天"
    if (filters.topic.isNotBlank()) parts += "主题"
    if (filters.form.isNotBlank()) parts += "形态"
    if (filters.use.isNotBlank()) parts += "用途"
    return "筛选 · " + parts.joinToString(" · ")
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun BookmarkFilterPanel(filters: BookmarkFilters, taxonomy: BookmarkTaxonomy?, onChange: (BookmarkFilters) -> Unit) {
    // 已激活筛选时保持展开，让用户随时看到当前筛选条件；默认收起，
    // 避免一堆标签把真正的链接列表挤到首屏之外。
    var expanded by rememberSaveable { mutableStateOf(filters != BookmarkFilters()) }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { expanded = !expanded }, modifier = Modifier.testTag("bookmark_filters")) {
                Text(if (expanded) "收起筛选" else filterPanelLabel(filters))
            }
            if (filters != BookmarkFilters()) TextButton(onClick = { onChange(BookmarkFilters()) }) { Text("清除筛选") }
        }
        if (expanded) Column(Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState())) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (status in CurationStatus.entries) FilterChip(
                    selected = filters.curationStatus == status.apiValue,
                    onClick = { onChange(filters.copy(curationStatus = if (filters.curationStatus == status.apiValue) "" else status.apiValue)) },
                    label = { Text(status.label) }, modifier = Modifier.testTag("filter_curation_${status.apiValue}"),
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((value, label) in listOf("x" to "X", "wechat" to "公众号", "other" to "其他来源")) FilterChip(
                    selected = filters.source == value, onClick = { onChange(filters.copy(source = if (filters.source == value) "" else value)) }, label = { Text(label) },
                )
                FilterChip(selected = filters.uncertain, onClick = { onChange(filters.copy(uncertain = !filters.uncertain)) }, label = { Text("分类待确认") })
                for (days in listOf(7, 30)) FilterChip(selected = filters.recentDays == days, onClick = { onChange(filters.copy(recentDays = if (filters.recentDays == days) 0 else days)) }, label = { Text("近 $days 天") })
            }
            if (taxonomy != null) FlowRow {
                TermSelector("主题", filters.topic, taxonomy.topics) { onChange(filters.copy(topic = it)) }
                TermSelector("形态", filters.form, taxonomy.forms) { onChange(filters.copy(form = it)) }
                TermSelector("用途", filters.use, taxonomy.uses) { onChange(filters.copy(use = it)) }
            }
        }
    }
}
