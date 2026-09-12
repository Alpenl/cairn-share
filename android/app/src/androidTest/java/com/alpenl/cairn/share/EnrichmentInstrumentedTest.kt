package com.alpenl.cairn.share

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class EnrichmentInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val server = MockWebServer()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val token = "enrichment-device-test"

    @Before fun setup() = runBlocking {
        SharePreferencesStore(context).setApiToken(token)
        SharePreferencesStore(context).setLastRoute("library")
        SharePreferencesStore(context).setLastFilter("all")
        SharePreferencesStore(context).setLastSearchQuery("")
        PendingUploadStore(context).clear()
    }

    @After fun close() { server.shutdown() }

    private fun start(): Intent {
        server.start()
        return Intent(context, LauncherActivity::class.java)
            .putExtra(ShareActivity.EXTRA_API_BASE_URL, server.url("/").toString())
            .putExtra(ShareActivity.EXTRA_RELEASES_API_URL, server.url("/latest").toString())
    }

    private fun response(body: Any): MockResponse = MockResponse().setHeader("Content-Type", "application/json").setBody(body.toString())

    private fun link(id: Int, full: Boolean = false): JSONObject = JSONObject("""{
        "id":$id,"url":"https://x.com/example/status/$id","note":"收藏备注","created_at":"2026-09-12T00:00:00Z","learned":false,"learned_at":null,
        "enrichment":{"status":"completed","source":"x","ai_title":"同步验证中文标题 $id","summary":"同步摘要","curation_status":"inbox","content_loaded":$full,
        "classification_reviewed":false,"classification":{"topics":["eng"],"form":"method","use":"quote","uncertainty":false},"why":""}
    }""").apply {
        if (full) getJSONObject("enrichment").apply {
            put("original_text", "Original source text.")
            put("translated_text", "这是一段完整的中文译文。")
            put("original_language", "en")
            put("related_links", JSONArray().put("https://example.com/reference"))
            put("images", JSONArray().put(JSONObject().put("key", "enrichment/$id/${"a".repeat(64)}.png")))
        }
    }

    private fun waitForTag(tag: String) = compose.waitUntil(20_000) {
        runCatching { compose.onNodeWithTag(tag).assertExists(); true }.getOrDefault(false)
    }

    @Test fun readsBilingualContentImagesAndSavesCuration() {
        val detailRequests = AtomicInteger()
        val edit = AtomicReference<JSONObject>()
        val data = link(3, true)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                if (path.startsWith("/api/")) assertEquals("Bearer $token", request.getHeader("Authorization"))
                return when (path) {
                    "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(3))).put("next_before_id", JSONObject.NULL))
                    "/api/links/3" -> { detailRequests.incrementAndGet(); response(data) }
                    "/api/taxonomy" -> response("""{"topics":[{"id":"eng","label":"工程","active":true}],"forms":[{"id":"method","label":"方法","active":true}],"uses":[{"id":"quote","label":"引用","active":true}]}""")
                    "/api/links/3/curation" -> {
                        val update = JSONObject(request.body.readUtf8())
                        edit.set(update)
                        data.getJSONObject("enrichment").put("why", update.getString("why")).put("curation_status", update.getString("curation_status")).put("classification_reviewed", true)
                        response(data)
                    }
                    "/api/images/enrichment/3/${"a".repeat(64)}.png" -> MockResponse().setHeader("Content-Type", "image/png").setBody(okio.Buffer().write(android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", 0)))
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use {
            waitForTag("link_3")
            compose.onNodeWithText("同步验证中文标题 3").assertExists()
            assertEquals(0, detailRequests.get())
            compose.onNodeWithTag("link_3").performClick()
            compose.waitUntil(20_000) { detailRequests.get() > 0 }
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("toggle_original"))
            compose.onNodeWithText("这是一段完整的中文译文。").assertExists()
            compose.onNodeWithTag("toggle_original").performClick()
            compose.onNodeWithText("Original source text.").assertExists()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("bookmark_image"))
            compose.waitUntil(20_000) { compose.onAllNodesWithContentDescription("收藏图片").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("收藏图片").assertExists()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("edit_curation"))
            compose.onNodeWithTag("edit_curation").performClick()
            compose.onNodeWithTag("curation_why").performTextReplacement("用于项目评审")
            compose.onNodeWithTag("curation_status_kept").performClick()
            compose.onNodeWithTag("save_curation").performClick()
            compose.waitUntil(20_000) { edit.get() != null }
            assertEquals("用于项目评审", edit.get().getString("why"))
            assertEquals("kept", edit.get().getString("curation_status"))
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("save_curation").fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithText("用于项目评审").assertExists()
        }
    }

    @Test fun firstPageIsVisibleBeforeLaterPagesComplete() {
        val releaseSecondPage = CountDownLatch(1)
        val secondRequested = CountDownLatch(1)
        val secondReturned = AtomicBoolean(false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl!!.encodedPath != "/api/links") return MockResponse().setResponseCode(404)
                if (request.requestUrl!!.queryParameter("before_id") != null) {
                    secondRequested.countDown()
                    // Hold the response until the UI has been inspected. A fixed
                    // short delay makes this assertion race slow emulator rendering.
                    releaseSecondPage.await(30, TimeUnit.SECONDS)
                    secondReturned.set(true)
                    return response(JSONObject().put("items", JSONArray().put(link(1))).put("next_before_id", JSONObject.NULL))
                }
                return response(JSONObject().put("items", JSONArray().put(link(2))).put("next_before_id", 2))
            }
        }
        try {
            ActivityScenario.launch<LauncherActivity>(start()).use {
                assertTrue(secondRequested.await(20, TimeUnit.SECONDS))
                waitForTag("link_2")
                compose.onNodeWithTag("link_1").assertDoesNotExist()
                assertFalse(secondReturned.get())
                releaseSecondPage.countDown()
            }
        } finally {
            releaseSecondPage.countDown()
        }
    }
}
