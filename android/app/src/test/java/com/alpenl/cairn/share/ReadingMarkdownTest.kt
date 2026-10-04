package com.alpenl.cairn.share
import org.junit.Assert.*
import org.junit.Test
class ReadingMarkdownTest {
 @Test fun preservesCodeAndIdentifiesHeadingsImagesTables() {
  val text = "## 标题\n\n第一行\n第二行\n\n```kotlin\nval x = 123\n```\n\n![图](cairn-image:0)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"
  val parts = readingBlocks(text)
  assertEquals(listOf("heading", "paragraph", "code", "image", "table"), parts.map { it.kind })
  assertEquals("val x = 123", parts[2].text)
  assertEquals("第一行\n第二行", parts[1].text)
  assertEquals(0, parts[3].level)
 }
 @Test fun preservesLiteralHtmlAndInvalidLinksAsText() {
  assertEquals("<script>bad()</script>", readingInline("<script>bad()</script>").text)
  assertEquals("unsafe", readingInline("[unsafe](javascript:alert)").text)
 }
}
