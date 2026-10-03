package com.alpenl.cairn.share

import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** Real Compose screens and optional PNG proof, using synthetic loopback data only. */
@RunWith(AndroidJUnit4::class)
class AndroidUiRedesignInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<String>()
    private val writes = CopyOnWriteArrayList<String>()
    private val token = "synthetic-ui-redesign-test"
    private lateinit var base: String
    private lateinit var account: String

    @Before fun setup() = runBlocking {
        server.start()
        base = server.url("/").toString()
        account = accountKeyFor(base, token)
        SharePreferencesStore(context).apply {
            setApiToken(token); setLastRoute("library"); setLastFilter("all"); setLastSearchQuery("")
        }
        CurationActionStore(context).clear()
        PendingUploadStore(context).clear()
        OfflineReadStore(context).clear(account)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!
                val path = url.encodedPath
                requests.add("${request.method} ${request.path}")
                if (request.method != "GET") writes.add("${request.method} $path")
                return when {
                    path == "/api/links" && request.method == "GET" -> {
                        val chosen = url.queryParameter("topics").orEmpty().split(',').filter(String::isNotBlank)
                        val refined = url.queryParameter("topic_refinements").orEmpty().split(',').filter(String::isNotBlank)
                        val ids = listOf(49, 48, 47).filter { id ->
                            val topics = if (id == 48) listOf("ai_coding") else listOf("image_creation", "portrait_photography")
                            (chosen.isEmpty() || chosen.any { it in topics }) && refined.all { it in topics }
                        }
                        json(JSONObject().put("items", JSONArray(ids.map { link(it, fullBody = false) }))
                            .put("next_before_id", JSONObject.NULL).put("filter_contract_version", 1))
                    }
                    path == "/api/v2-taxonomy" || path == "/api/taxonomy" -> json(taxonomy())
                    path == "/api/custom-tags" -> json(JSONObject().put("tags", JSONArray()))
                    path == "/api/tag-counts" -> json(JSONObject().put("total", 3).put("topics", JSONArray(listOf(
                        JSONObject().put("id", "image_creation").put("count", 2),
                        JSONObject().put("id", "portrait_photography").put("count", 2),
                        JSONObject().put("id", "ai_coding").put("count", 1),
                    ))))
                    Regex("/api/(links|bookmarks)/[0-9]+$").matches(path) && request.method == "GET" ->
                        json(link(path.substringAfterLast('/').toInt(), fullBody = true))
                    Regex("/api/bookmarks/[0-9]+/tags$").matches(path) -> {
                        val id = path.split('/')[3].toInt()
                        json(JSONObject().put("id", id).put("revision", 0).put("content_revision", 1)
                            .put("decision_id", 1).put("custom_tags", JSONArray()).put("selection", selection(id)))
                    }
                    Regex("/api/bookmarks/[0-9]+/v2-selection$").matches(path) -> {
                        val id = path.split('/')[3].toInt()
                        json(JSONObject().put("available", true).put("revision", 0)
                            .put("selection", selection(id)).put("automatic", selection(id)))
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    @After fun close() {
        runBlocking { OfflineReadStore(context).clear(account) }
        server.shutdown()
    }

    private fun json(value: JSONObject) = MockResponse().setHeader("Content-Type", "application/json")
        .setHeader("X-Cairn-Tag-System", "1").setHeader("X-Cairn-Topic-Granularity", "1")
        .setHeader("X-Cairn-Content-Functions", "1").setBody(value.toString())

    private fun selection(id: Int) = JSONObject().put("topics", JSONArray(
        if (id == 48) listOf("ai_coding") else listOf("portrait_photography", "image_creation")))
        .put("resource_kinds", JSONArray(listOf("skill"))).put("content_functions", JSONArray(listOf("method")))
        .put("carriers", JSONArray()).put("affordances", JSONArray()).put("form", "").put("use", "")

    private fun taxonomy() = JSONObject().put("version", "2026-10-02.1").put("definition_version", 3)
        .put("topics", JSONArray(listOf(
            JSONObject().put("id", "image_creation").put("label", "图像生成").put("active", true).put("granularity", "broad").put("navigation", true),
            JSONObject().put("id", "portrait_photography").put("label", "写真").put("active", true).put("granularity", "specific").put("navigation", false),
            JSONObject().put("id", "ai_coding").put("label", "AI 编程").put("active", true).put("granularity", "broad").put("navigation", true),
        )))
        .put("resource_kinds", JSONArray().put(JSONObject().put("id", "skill").put("label", "Skill").put("active", true)))
        .put("content_functions", JSONArray().put(JSONObject().put("id", "method").put("label", "方法").put("active", true)))
        .put("forms", JSONArray()).put("uses", JSONArray()).put("carriers", JSONArray()).put("affordances", JSONArray())

    private fun link(id: Int, fullBody: Boolean): JSONObject {
        val body = if (fullBody) (1..24).joinToString("\n\n") {
            "第${it}段 · 合成阅读内容。用明确的光线、构图与提示词描述人物，保留自然的细节和简洁的背景。这些文字仅用于本地界面验证。"
        } else ""
        val enrichment = JSONObject().put("status", "completed").put("source", "x")
            .put("ai_title", if (id == 48) "把灵感变成可复用的编程方法" else "用自然光记录日常的写真练习")
            .put("summary", "从光线与构图开始，把值得保留的思路整理成下一次可以实践的方法。")
            .put("content_loaded", fullBody).put("original_text", body).put("translated_text", "")
            .put("original_language", "zh").put("curation_status", "inbox").put("why", "下次实践时参考")
            .put("classification", selection(id)).put("images", JSONArray())
            .put("cache_identity", JSONObject().put("schema_version", 1).put("representation", "enrichment_detail")
                .put("content_revision", 1).put("personal_revision", 0).put("body_revision", 1)
                .put("latest_decision_id", 1).put("latest_entity_revision", 0))
        return JSONObject().put("id", id).put("url", "https://example.com/local-ui/$id")
            .put("note", "本地合成备注").put("created_at", "2026-10-03T00:00:00Z").put("learned", false)
            .put("enrichment", enrichment)
    }

    private fun launch() = ActivityScenario.launch<LauncherActivity>(Intent(context, LauncherActivity::class.java)
        .putExtra(ShareActivity.EXTRA_API_BASE_URL, base)
        .putExtra(ShareActivity.EXTRA_RELEASES_API_URL, server.url("/latest").toString()))

    private fun waitTag(tag: String) = compose.waitUntil(20_000) {
        runCatching { compose.onNodeWithTag(tag).assertExists(); true }.getOrDefault(false)
    }

    private fun waitBody() = compose.waitUntil(20_000) {
        runCatching {
            compose.onNodeWithTag("detail_content").performScrollToNode(hasText("第1段 · 合成阅读内容。", substring = true))
            compose.onNodeWithText("第1段 · 合成阅读内容。", substring = true).assertExists()
            true
        }.getOrDefault(false)
    }

    private fun systemBack() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        instrumentation.uiAutomation.waitForIdle(250, 5_000)
        compose.waitForIdle()
    }

    private fun screenshot(name: String, target: SemanticsNodeInteraction) {
        val arguments = InstrumentationRegistry.getArguments()
        if (arguments.getString("screenshots") != "true") return
        val prefix = arguments.getString("screenshotPrefix") ?: "ui"
        check(Regex("[A-Za-z0-9_-]{1,60}").matches(prefix))
        target.assertIsDisplayed()
        compose.waitForIdle()
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.waitForIdle(200, 5_000)
        // Compose idle precedes SurfaceFlinger/IME animation completion on API 26.
        SystemClock.sleep(800)
        target.assertIsDisplayed()
        val bitmap = checkNotNull(automation.takeScreenshot())
        try {
            val directory = File(checkNotNull(context.getExternalFilesDir(null)), "ui-proof").apply { mkdirs() }
            val destination = File(directory, "$prefix-$name.png")
            val pending = File(directory, "$prefix-$name.partial")
            pending.outputStream().use { output ->
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
            }
            check(pending.renameTo(destination))
            println("UI_SCREENSHOT ${destination.name} captured_at_ms=${System.currentTimeMillis()}")
        } finally { bitmap.recycle() }
    }

    @Test fun navigationUsesRealScreensAndSourceActionRemainsVisibleWhileReading() {
        launch().use {
            waitTag("link_49")
            screenshot("library", compose.onNodeWithTag("bookmark_filters"))
            compose.onNodeWithTag("bookmark_filters").performScrollTo().performClick()
            waitTag("filter_topics_image_creation")
            compose.onNodeWithTag("filter_topics_image_creation").performScrollTo().performClick()
            val selectedTopic = compose.onNodeWithTag("filter_topics_image_creation")
            selectedTopic.performScrollTo().assertIsDisplayed()
            screenshot("filters", selectedTopic)
            selectedTopic.assertIsDisplayed()
            compose.onNodeWithTag("view_filter_results").assertIsDisplayed().performClick()
            waitTag("link_49")
            compose.onNodeWithTag("link_49").performScrollTo().performClick()
            waitTag("open_original")
            waitBody()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasText("用自然光记录日常的写真练习"))
            compose.onNodeWithTag("open_original").assertIsDisplayed().assertIsEnabled()
                .assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
            compose.onNodeWithTag("reader_more").assertIsDisplayed().assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
            screenshot("reader", compose.onNodeWithTag("open_original"))
            repeat(3) { compose.onNodeWithTag("detail_content").performTouchInput { swipeUp() } }
            compose.onNodeWithTag("open_original").assertIsDisplayed().assertIsEnabled()
            compose.onNodeWithTag("reader_more").assertIsDisplayed()
            screenshot("reader-scrolled", compose.onNodeWithTag("open_original"))
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("reader_tag_overview"))
            compose.onNodeWithTag("tag_filter_system/topics/portrait_photography", useUnmergedTree = true).performClick()
            waitTag("nav_library")
            compose.waitUntil(15_000) { requests.any { it.startsWith("GET /api/links?") && it.contains("portrait_photography") } }
            compose.onNodeWithTag("open_original").assertDoesNotExist()
            systemBack()
            waitTag("open_original")
            compose.onNodeWithTag("open_original").assertIsDisplayed()
            systemBack()
            waitTag("nav_settings")
            compose.onNodeWithTag("nav_settings").performClick()
            screenshot("settings", compose.onNodeWithTag("settings_token"))
            compose.onNodeWithTag("nav_library").performClick()
            waitTag("add_link")
            compose.onNodeWithTag("add_link").performClick()
            waitTag("manual_url")
            screenshot("save-link", compose.onNodeWithTag("manual_url"))
            assertTrue("Read-only navigation must not write or invoke a source URL", writes.isEmpty())
        }
    }

    @Test fun moreMenuAndBothBackActionsProtectUnsavedEditsAndDeletionRequiresConfirmation() {
        launch().use {
            waitTag("link_49"); compose.onNodeWithTag("link_49").performClick()
            waitTag("reader_more"); compose.onNodeWithTag("reader_more").performClick()
            compose.onNodeWithText("编辑链接").performClick()
            waitTag("edit_note")
            compose.onNodeWithTag("edit_note").performScrollTo().performTextReplacement("未提交的本地草稿")
            screenshot("edit-keyboard", compose.onNodeWithTag("edit_note"))
            compose.onNodeWithContentDescription("返回").assertIsDisplayed().performClick()
            waitTag("discard_edit")
            compose.onNodeWithText("继续编辑").performClick()
            compose.onNodeWithTag("edit_note").assertTextContains("未提交的本地草稿")
            systemBack()
            // A first back may dismiss the IME; the next navigational back must still protect the draft.
            if (compose.onAllNodesWithTag("discard_edit").fetchSemanticsNodes().isEmpty()) systemBack()
            waitTag("discard_edit")
            screenshot("edit-discard", compose.onNodeWithTag("discard_edit"))
            compose.onNodeWithTag("discard_edit").performClick()
            waitTag("reader_more"); compose.onNodeWithTag("reader_more").performClick()
            compose.onNodeWithText("编辑链接").performClick()
            waitTag("edit_note")
            compose.onNodeWithTag("edit_note").assertTextContains("本地合成备注")
            compose.onNodeWithContentDescription("返回").performClick()
            waitTag("reader_more"); compose.onNodeWithTag("reader_more").performClick()
            compose.onNodeWithText("删除收藏").performClick()
            waitTag("confirm_delete")
            screenshot("delete-confirmation", compose.onNodeWithTag("confirm_delete"))
            assertTrue("Opening delete confirmation must not delete", writes.isEmpty())
            compose.onNodeWithText("取消").performClick()
            compose.onNodeWithTag("open_original").assertIsDisplayed()
            compose.onNodeWithContentDescription("返回").performClick()
            waitTag("link_49")
            assertTrue("Discarded edits and canceled deletion must not send mutations", writes.isEmpty())
        }
    }
}
