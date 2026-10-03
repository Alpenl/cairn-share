package com.alpenl.cairn.share

import android.content.Intent
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
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(AndroidJUnit4::class)
class TopicNavigationInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun waitTag(tag: String) = compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag(tag).assertExists(); true }.getOrDefault(false) }
    private fun json(value: JSONObject) = MockResponse().setHeader("Content-Type", "application/json")
        .setHeader("X-Cairn-Tag-System", "1").setHeader("X-Cairn-Topic-Granularity", "1").setBody(value.toString())

    @Test fun specificCardTapFiltersWithoutOpeningReaderAndPinnedTopicRefinesAnAnyGroup() {
        val server = MockWebServer(); server.start()
        val token = "topic-navigation-isolated"
        val base = server.url("/").toString()
        val account = accountKeyFor(base, token)
        val requests = CopyOnWriteArrayList<String>()
        val writes = CopyOnWriteArrayList<String>()
        val topics = listOf(listOf("image_creation", "portrait"), listOf("design", "portrait"), listOf("image_creation", "avatar"))
        val links = topics.mapIndexed { index, values -> JSONObject("""{"id":${9-index},"url":"https://example.com/${9-index}","note":"","created_at":"2026-10-02T00:00:00Z","learned":false,
          "enrichment":{"ai_title":"写真与图像示例 ${9-index}","summary":"独立设备测试内容","status":"completed","content_loaded":false,
            "classification":{"topics":${JSONArray(values)},"resource_kinds":["skill"]}}}""") }
        val taxonomy = JSONObject("""{"topics":[
          {"id":"image_creation","label":"图像生成","active":true,"granularity":"broad","navigation":true},
          {"id":"design","label":"设计","active":true,"granularity":"broad","navigation":true},
          {"id":"portrait","label":"写真","active":true,"granularity":"specific","navigation":false,"aliases":["个人写真"]},
          {"id":"avatar","label":"头像","active":true,"granularity":"specific","navigation":false}],
          "resource_kinds":[{"id":"skill","label":"Skill","active":true}],"forms":[],"uses":[],"content_functions":[],"carriers":[],"affordances":[]}""")
        fun filtered(request: RecordedRequest): List<JSONObject> {
            val params = request.requestUrl!!
            val selected = params.queryParameter("topics").orEmpty().split(',').filter { it.isNotBlank() }
            val refined = params.queryParameter("topic_refinements").orEmpty().split(',').filter { it.isNotBlank() }
            return links.filter { link ->
                val values = link.getJSONObject("enrichment").getJSONObject("classification").getJSONArray("topics")
                val ids = (0 until values.length()).map(values::getString)
                (selected.isEmpty() || selected.any { it in ids }) && refined.all { it in ids }
            }
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request.path.orEmpty())
                if (request.method != "GET") writes.add(request.path.orEmpty())
                return when (request.requestUrl!!.encodedPath) {
                    "/api/links" -> json(JSONObject().put("items", JSONArray(filtered(request))).put("next_before_id", JSONObject.NULL).put("filter_contract_version", 1))
                    "/api/v2-taxonomy", "/api/taxonomy" -> json(taxonomy)
                    "/api/custom-tags" -> json(JSONObject().put("tags", JSONArray()))
                    "/api/tag-counts" -> {
                        val values = filtered(request)
                        json(JSONObject().put("total", values.size).put("topics", JSONArray(listOf("image_creation", "design", "portrait", "avatar").map { id ->
                            JSONObject().put("id", id).put("count", values.count { it.getJSONObject("enrichment").getJSONObject("classification").getJSONArray("topics").toString().contains("\"$id\"") })
                        })))
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        runBlocking {
            SharePreferencesStore(context).apply { setApiToken(token); setLastRoute("library"); setLastFilter("all"); setLastSearchQuery("") }
            CurationActionStore(context).clear()
        }
        val pins = context.getSharedPreferences("topic-navigation", android.content.Context.MODE_PRIVATE)
        pins.edit().remove("pins:$account").remove("pins:${accountKeyFor(base, "another-account")}").commit()
        val intent = Intent(context, LauncherActivity::class.java).putExtra(ShareActivity.EXTRA_API_BASE_URL, base)
            .putExtra(ShareActivity.EXTRA_RELEASES_API_URL, server.url("/latest").toString())
        try {
            ActivityScenario.launch<LauncherActivity>(intent).use {
                waitTag("link_9")
                compose.waitUntil(15_000) { runCatching {
                    compose.onNodeWithTag("link_tags_9", useUnmergedTree = true).onChildren().onFirst()
                        .assert(hasTestTag("tag_filter_system/topics/portrait")); true
                }.getOrDefault(false) }
                compose.onNodeWithTag("link_tags_9", useUnmergedTree = true).onChildren().onFirst().performClick()
                compose.waitUntil(15_000) { requests.any { it.startsWith("/api/links?") && it.contains("topics=portrait") } }
                compose.onNodeWithTag("detail_content").assertDoesNotExist()
                compose.onNodeWithText("清除筛选").performClick()
                compose.onNodeWithTag("bookmark_filters").performClick()
                waitTag("topic_search")
                compose.onNodeWithTag("bookmark_filter_sheet").assertIsDisplayed()
                compose.onNodeWithTag("pin_topic_portrait").assertDoesNotExist()
                compose.onNodeWithTag("manage_topic_pins").performScrollTo().performClick()
                compose.onNodeWithTag("topic_search").performScrollTo().performTextInput("个人写真")
                compose.onNodeWithTag("pin_topic_portrait").performScrollTo().performClick()
                compose.waitUntil(5_000) { "portrait" in pins.getStringSet("pins:$account", emptySet()).orEmpty() }
                assertTrue(pins.getStringSet("pins:${accountKeyFor(base, "another-account")}", emptySet()).orEmpty().isEmpty())
                compose.onNodeWithTag("manage_topic_pins").performScrollTo().performClick()
                compose.onNodeWithTag("topic_search").performScrollTo().performTextClearance()
                compose.onNodeWithTag("filter_topics_image_creation").performScrollTo().performClick()
                compose.onNodeWithTag("filter_topics_design").performScrollTo().performClick()
                compose.onNodeWithTag("filter_topic_refinements_portrait").performScrollTo().performClick()
                compose.waitUntil(15_000) { requests.any { it.startsWith("/api/links?") && it.contains("topics=image_creation%2Cdesign") && it.contains("topic_refinements=portrait") } }
                assertFalse(requests.last { it.startsWith("/api/links?") }.contains("topics_mode=all"))
                compose.onNodeWithTag("view_filter_results").assertIsDisplayed().performClick()
                compose.onNodeWithTag("bookmark_filter_sheet").assertDoesNotExist()
                compose.onNodeWithTag("link_9").assertExists()
                compose.onNodeWithTag("link_8").assertExists()
                compose.onNodeWithTag("link_7").assertDoesNotExist()
                compose.onNodeWithTag("link_tags_9", useUnmergedTree = true).onChildren().onFirst()
                    .assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
                assertTrue(writes.isEmpty())
            }
        } finally { server.shutdown() }
    }
}
