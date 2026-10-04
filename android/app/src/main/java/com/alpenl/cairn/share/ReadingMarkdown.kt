package com.alpenl.cairn.share

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal data class ReadingPart(val kind: String, val text: String, val level: Int = 0)
internal fun readingBlocks(text: String): List<ReadingPart> {
    val result = mutableListOf<ReadingPart>()
    val paragraph = mutableListOf<String>()
    var code: MutableList<String>? = null
    fun flush() { if(paragraph.isNotEmpty()) { result += ReadingPart("paragraph", paragraph.joinToString("\n")); paragraph.clear() } }
    for(line in text.replace("\r", "").split("\n")) {
        if(line.trimStart().startsWith("```")) { flush(); if(code == null) code = mutableListOf() else { result += ReadingPart("code", code!!.joinToString("\n")); code = null }; continue }
        if(code != null) { code!!.add(line); continue }
        if(line.isBlank()) { flush(); continue }
        val heading = Regex("^(#{1,6})\\s+(.+)$").find(line)
        val image = Regex("^!\\[([^]]*)]\\(cairn-image:(\\d+)\\)$").find(line.trim())
        when {
            heading != null -> { flush(); result += ReadingPart("heading", heading.groupValues[2], heading.groupValues[1].length) }
            image != null -> { flush(); result += ReadingPart("image", image.groupValues[1], image.groupValues[2].toInt()) }
            line.startsWith(">") -> { flush(); result += ReadingPart("quote", line.removePrefix(">").trimStart()) }
            Regex("^\\s*([-*+•]|[0-9]+[.)])\\s+").containsMatchIn(line) -> { flush(); result += ReadingPart("list", line.replace(Regex("^\\s*[-*+]\\s+"), "• ")) }
            else -> paragraph += line
        }
    }
    flush(); code?.let { result += ReadingPart("code", it.joinToString("\n")) }
    return result.map { part ->
        if (part.kind == "paragraph" && part.text.lines().getOrNull(1)?.trim()?.matches(Regex("[| :\\-]+")) == true && part.text.contains('|')) part.copy(kind = "table") else part
    }
}
internal fun readingInline(text: String): AnnotatedString = buildAnnotatedString {
    val pattern = Regex("!?\\[([^]\\n]*)]\\(([^\\s]+)\\)|\\*\\*([^*]+)\\*\\*|`([^`]+)`")
    var last = 0
    for(m in pattern.findAll(text)) {
        append(text.substring(last, m.range.first))
        when {
            m.groupValues[3].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(m.groupValues[3]) }
            m.groupValues[4].isNotEmpty() -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(m.groupValues[4]) }
            validateHttpUrl(m.groupValues[2]) -> withLink(LinkAnnotation.Url(m.groupValues[2])) { append(m.groupValues[1].ifBlank { m.groupValues[2] }) }
            else -> append(m.groupValues[1])
        }
        last = m.range.last + 1
    }
    append(text.substring(last))
}
@Composable
internal fun ReadingBlock(part: ReadingPart, images: List<String>, apiBase: String, token: String, versions: Map<String, String> = emptyMap(), fallbackVersion: String = "") {
    if (part.kind == "table") {
        val rows = remember(part) { part.text.lines().filterIndexed { index, _ -> index != 1 }.map { it.trim().trim('|').split('|') } }
        Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            rows.forEachIndexed { index, cells ->
                Row(Modifier.background(if (index == 0) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface)) {
                    cells.forEach { cell -> SelectionContainer { Text(readingInline(cell.trim()), modifier = Modifier.width(180.dp).padding(12.dp), fontWeight = if (index == 0) FontWeight.SemiBold else FontWeight.Normal) } }
                }
            }
        }
        return
    }
    if(part.kind == "image") {
        images.getOrNull(part.level)?.let { BookmarkImage(apiBase, token, it, versions[it] ?: fallbackVersion, versions[it]) }
        if(part.text.isNotBlank()) Text(part.text, style = MaterialTheme.typography.labelSmall)
        return
    }
    val style = when(part.kind) {
        "heading" -> when(part.level) { 1 -> MaterialTheme.typography.headlineSmall; 2 -> MaterialTheme.typography.titleLarge; else -> MaterialTheme.typography.titleMedium }
        "code" -> MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, lineHeight = 23.sp)
        else -> MaterialTheme.typography.bodyLarge.copy(lineHeight = 29.sp)
    }
    val modifier = when(part.kind) {
        "code" -> Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.medium).horizontalScroll(rememberScrollState()).padding(16.dp)
        "quote" -> Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.small).padding(14.dp)
        "heading" -> Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 4.dp)
        "list" -> Modifier.fillMaxWidth().padding(start = 8.dp)
        else -> Modifier.fillMaxWidth()
    }
    val content = remember(part) { if(part.kind == "code") AnnotatedString(part.text) else readingInline(part.text) }
    SelectionContainer { Text(content, modifier = modifier, style = style) }
}
