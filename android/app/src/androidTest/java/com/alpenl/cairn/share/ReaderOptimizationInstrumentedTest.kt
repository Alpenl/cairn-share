package com.alpenl.cairn.share

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.LinkJson
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class ReaderOptimizationInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun json(value: JSONObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(value.toString())
    private fun archive(id: Int) = JSONObject("""{"id":$id,"url":"https://example.com/$id","note":"","created_at":"2020-01-01T00:00:00Z","learned":false,
        "enrichment":{"ai_title":"本地阅读测试 $id","summary":"简短摘要","status":"completed","content_loaded":true,"original_text":"只属于隔离测试的归档正文 $id","why":"已有收藏原因",
        "classification":{"topics":["llm"],"resource_kinds":["prompt"],"content_functions":["method"]},
        "cache_identity":{"schema_version":1,"representation":"enrichment_detail","content_revision":1,"personal_revision":0,"body_revision":1,"latest_decision_id":1,"latest_entity_revision":0}}}""")
    private fun taxonomy() = JSONObject("""{"topics":[{"id":"llm","label":"LLM","active":true}],"resource_kinds":[{"id":"prompt","label":"提示词","active":true}],"content_functions":[{"id":"method","label":"方法","active":true}],"carriers":[],"affordances":[],"forms":[],"uses":[]}""")
    private fun tags(id: Int) = JSONObject("""{"id":$id,"revision":0,"decision_id":1,"content_revision":1,"custom_tags":[],"selection":{"topics":["llm"],"resource_kinds":["prompt"],"content_functions":["method"],"carriers":[],"affordances":[],"form":"","use":""}}""")
    private fun intent(server: MockWebServer) = Intent(context, LauncherActivity::class.java)
        .putExtra(ShareActivity.EXTRA_API_BASE_URL, server.url("/").toString())
        .putExtra(ShareActivity.EXTRA_RELEASES_API_URL, server.url("/latest").toString())
    private fun waitTag(tag: String) = compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag(tag).assertExists(); true }.getOrDefault(false) }
    private fun scroll(tag: String) { compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag(tag)) }

    @Test fun readerStartsFoldedIncludesFunctionsAndPreservesEditorDraftAcrossCollapseAndSave() {
        val server = MockWebServer(); server.start()
        val token = "reader-isolated-test"
        val account = accountKeyFor(server.url("/").toString(), token)
        val changed = AtomicInteger()
        val link = archive(28)
        runBlocking {
            SharePreferencesStore(context).apply { setApiToken(token); setLastRoute("library"); setLastFilter("all"); setLastSearchQuery("") }
            CurationActionStore(context).clear(); PersonalTagOutbox(context).discard(account, 28); OfflineReadStore(context).clear(account)
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> json(JSONObject().put("items", JSONArray().put(link).put(archive(27))).put("next_before_id", JSONObject.NULL))
                "/api/links/28" -> json(link)
                "/api/links/27" -> json(archive(27))
                "/api/v2-taxonomy", "/api/taxonomy" -> json(taxonomy())
                "/api/bookmarks/28/tags" -> json(tags(28))
                "/api/bookmarks/27/tags" -> json(tags(27))
                "/api/custom-tags" -> json(JSONObject().put("tags", JSONArray()))
                "/api/links/28/curation" -> {
                    changed.incrementAndGet()
                    val body = JSONObject(request.body.readUtf8())
                    link.getJSONObject("enrichment").put("why", body.getString("why"))
                    json(link)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        try {
            ActivityScenario.launch<LauncherActivity>(intent(server)).use {
                waitTag("link_28"); compose.onNodeWithTag("link_28").performScrollTo().assertIsDisplayed().performClick()
                waitTag("reader_tag_overview")
                compose.onNodeWithTag("reader_tag_overview").onChildren().filter(hasText("LLM")).assertCountEquals(1)
                compose.onNodeWithTag("reader_tag_overview").onChildren().filter(hasText("提示词")).assertCountEquals(1)
                compose.onNodeWithTag("reader_tag_overview").onChildren().filter(hasText("方法")).assertCountEquals(1)
                compose.onNodeWithTag("v2_section").assertDoesNotExist()
                compose.onNodeWithTag("personal_tags").assertDoesNotExist()
                compose.onNodeWithTag("reader_curation_toggle").performClick()
                scroll("personal_tags_edit")
                compose.onNodeWithTag("personal_tags_edit").assertIsEnabled()
                    .performSemanticsAction(SemanticsActions.OnClick) { it() }
                waitTag("personal_tag_name")
                scroll("personal_tag_name"); compose.onNodeWithTag("personal_tag_name").performTextInput("保留未提交名称")
                scroll("reader_curation_toggle"); compose.onNodeWithTag("reader_curation_toggle").performSemanticsAction(SemanticsActions.OnClick) { it() }
                compose.onNodeWithTag("reader_curation_toggle").assertContentDescriptionEquals("编辑标签与备注")
                    .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "已折叠"))
                compose.onNodeWithTag("reader_curation_toggle").performSemanticsAction(SemanticsActions.OnClick) { it() }
                scroll("reader_curation_toggle")
                compose.onNodeWithTag("reader_curation_toggle").assertTextContains("收起标签与备注")
                scroll("personal_tag_name"); compose.onNodeWithTag("personal_tag_name").assertTextContains("保留未提交名称")
                scroll("edit_curation")
                compose.onNodeWithTag("edit_curation").assertIsEnabled()
                    .performSemanticsAction(SemanticsActions.OnClick) { it() }
                waitTag("curation_why"); scroll("curation_why")
                compose.onNodeWithTag("curation_why").assertIsDisplayed().performTextReplacement("已编辑的收藏原因")
                scroll("save_curation"); compose.onNodeWithTag("save_curation").assertIsDisplayed().performClick()
                compose.waitUntil(10_000) { changed.get() == 1 }
                scroll("reader_curation_toggle"); compose.onNodeWithTag("reader_curation_toggle").assertTextContains("收起标签与备注")
                compose.onNodeWithContentDescription("返回").performClick()
                waitTag("link_27"); compose.onNodeWithTag("link_27").performScrollTo().assertIsDisplayed().performClick()
                waitTag("reader_tag_overview"); compose.onNodeWithTag("v2_section").assertDoesNotExist()
            }
        } finally { runBlocking { OfflineReadStore(context).clear(account); PersonalTagOutbox(context).discard(account, 28) }; server.shutdown() }
    }

    @Test fun coldOfflineRestartReadsSavedBodyAndDisplaysUnverifiedExpiredTimestamp() {
        val server = MockWebServer(); server.start()
        val token = "offline-reader-test"
        val account = accountKeyFor(server.url("/").toString(), token)
        runBlocking {
            SharePreferencesStore(context).apply { setApiToken(token); setLastRoute("library"); setLastFilter("all"); setLastSearchQuery("") }
            CurationActionStore(context).clear()
            OfflineReadStore(context).clear(account)
            OfflineReadStore(context).save(account, LinkJson.decodeLink(archive(28)), pinned = true, now = 1,
                labels = listOf(ReaderTag("system/topics/llm", "LLM"), ReaderTag("system/resource_kinds/prompt", "提示词"), ReaderTag("system/content_functions/method", "方法")))
        }
        server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(503) }
        try {
            ActivityScenario.launch<LauncherActivity>(intent(server)).use {
                waitTag("open_offline_reading"); compose.onNodeWithTag("open_offline_reading").performClick()
                waitTag("link_28"); compose.onNodeWithTag("link_28").performClick()
                waitTag("offline_read_status")
                compose.onNodeWithTag("offline_read_status").assertTextContains("云端版本尚未确认", substring = true).assertTextContains("超过 7 天", substring = true)
                compose.onNodeWithTag("reader_tag_overview").onChildren().filter(hasText("提示词")).assertCountEquals(1)
                compose.onNodeWithTag("detail_content").performScrollToNode(hasText("只属于隔离测试的归档正文 28"))
                compose.onNodeWithText("只属于隔离测试的归档正文 28").assertExists()
            }
        } finally { runBlocking { OfflineReadStore(context).clear(account) }; server.shutdown() }
    }
}
