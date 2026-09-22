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
import com.alpenl.cairn.share.network.QueuedCurationAction
import java.util.concurrent.atomic.AtomicReference

/**
 * B07: the multidimensional section against a real local service contract
 * (MockWebServer). It requires a device/emulator; compilation alone is not a
 * device pass.
 */
@RunWith(AndroidJUnit4::class)
class V2CurationInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val server = MockWebServer()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val token = "v2-device-test"

    @Before fun setup() = runBlocking {
        SharePreferencesStore(context).setApiToken(token)
        SharePreferencesStore(context).setLastRoute("library")
        SharePreferencesStore(context).setLastFilter("all")
        SharePreferencesStore(context).setLastSearchQuery("")
        CurationActionStore(context).clear()
    }

    @After fun close() { server.shutdown() }

    private fun start(): Intent {
        server.start()
        return Intent(context, LauncherActivity::class.java)
            .putExtra(ShareActivity.EXTRA_API_BASE_URL, server.url("/").toString())
            .putExtra(ShareActivity.EXTRA_RELEASES_API_URL, server.url("/latest").toString())
    }

    private fun response(body: Any): MockResponse =
        MockResponse().setHeader("Content-Type", "application/json").setBody(body.toString())

    private fun link(id: Int): JSONObject = JSONObject(
        """{"id":$id,"url":"https://x.com/example/status/$id","note":"","created_at":"2026-09-12T00:00:00Z","learned":false,
        "enrichment":{"status":"completed","source":"x","ai_title":"多维整理设备测试标题","summary":"摘要","curation_status":"inbox",
        "content_loaded":true,"classification_reviewed":false,"classification":{"topics":["eng"],"form":"method","use":"quote","uncertainty":false},"why":""}}"""
    )

    private fun selection(revision: Long): JSONObject = JSONObject(
        """{"available":true,"revision":$revision,"selection":{"topics":["llm","eng","eval","design"],
        "content_functions":["method"],"carriers":["single"],"affordances":["practice"],"form":"method","use":"try"},
        "v1_projection":{"topics":["llm","eng","eval"],"form":"method","use":"try"}}"""
    )

    private fun taxonomy(): JSONObject = JSONObject(
        """{"version":"2026-09-20.1","definition_version":1,
        "topics":[{"id":"llm","label":"LLM","active":true},{"id":"eng","label":"工程","active":true},{"id":"eval","label":"评估","active":true},{"id":"design","label":"设计","active":true}],
        "forms":[{"id":"method","label":"方法","active":true}],"uses":[{"id":"try","label":"待试","active":true}],
        "content_functions":[{"id":"method","label":"方法","active":true}],"carriers":[{"id":"single","label":"单帖","active":true}],
        "affordances":[{"id":"practice","label":"可实践","active":true}]}"""
    )

    private fun openDetailAndLoadTaxonomy() {
        compose.waitUntil(20_000) {
            runCatching { compose.onNodeWithTag("link_4").assertExists(); true }.getOrDefault(false)
        }
        compose.onNodeWithTag("link_4").performClick()
        compose.waitUntil(20_000) {
            runCatching {
                compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_section"))
                true
            }.getOrDefault(false)
        }
        // The multidimensional vocabulary loads from its own endpoint.
        compose.waitUntil(20_000) {
            runCatching { compose.onNodeWithTag("v2_topics_chip_llm").assertExists(); true }.getOrDefault(false)
        }
    }

    @Test fun showsEffectiveDimensionsAndSubmitsAFieldAction() {
        val override = AtomicReference<JSONObject>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path == "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                    path == "/api/bookmarks/4" -> response(link(4))
                    path == "/api/bookmarks/4/v2-selection" -> response(selection(3))
                    path == "/api/v2-taxonomy" -> response(taxonomy())
                    path == "/api/bookmarks/4/v2-override" -> {
                        override.set(JSONObject(request.body.readUtf8()))
                        response(JSONObject("""{"id":4,"field":"topics","term":"llm","action":"reject","revision":4,"replayed":false}"""))
                    }
                    else -> response(JSONObject("""{"items":[],"counts":{}}"""))
                }
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use {
            openDetailAndLoadTaxonomy()
            // The fourth topic is shown; tapping a selected tag rejects it.
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_topics_chip_llm"))
            compose.onNodeWithTag("v2_topics_chip_llm").performClick()
            compose.waitUntil(20_000) { override.get() != null }
            val payload = override.get()!!
            assertEquals("topics", payload.getString("field"))
            assertEquals("llm", payload.getString("term"))
            assertEquals("reject", payload.getString("action"))
            assertTrue(payload.getString("operation_key").isNotBlank())
            assertEquals(3L, payload.getLong("expected_revision"))
        }
    }

    @Test fun displaysStoredOutcomesAndIndependentEntitiesWithoutAnInferenceRequest() {
        val paths = java.util.concurrent.CopyOnWriteArrayList<String>()
        val fixture = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
            .open("selection-state-v1.json").bufferedReader().use { it.readText() }).put("id", 4)
        fixture.getJSONObject("state").put("evidence", JSONObject("""{"id":1,"truncated":1,"completeness":"partial"}"""))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                paths.add("${request.method} $path")
                return when (path) {
                    "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                    "/api/bookmarks/4" -> response(link(4))
                    "/api/bookmarks/4/v2-selection" -> {
                        assertEquals("1", request.requestUrl!!.queryParameter("include_state"))
                        response(fixture)
                    }
                    "/api/v2-taxonomy" -> response(taxonomy().put("topics", JSONArray().apply {
                        for ((id, label) in listOf("llm" to "LLM", "eng" to "工程", "product" to "产品", "design" to "设计",
                            "writing" to "写作", "invest" to "投资", "health" to "健康", "psych" to "心理", "manage" to "管理",
                            "media" to "媒体", "law" to "法律", "edu" to "教育", "history" to "历史", "science" to "科学",
                            "city" to "城市", "life" to "生活", "eval" to "评估")) put(JSONObject().put("id", id).put("label", label).put("active", true))
                    }))
                    else -> response(JSONObject("""{"items":[],"counts":{}}"""))
                }
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use { scenario ->
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_topics_chip_eval"))
            compose.onNodeWithTag("v2_topics_chip_eval").assertIsDisplayed()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_topics_status"))
            compose.onNodeWithTag("v2_topics_status").assertTextEquals("自动判断：已生成建议")
            compose.onNodeWithText("LLM · 自动建议").assertExists()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_topics_candidates"))
            compose.onNodeWithTag("v2_topics_candidates").performClick()
            compose.onNodeWithText("评估 · 暂不判断 · 50%").assertExists()
            compose.onNodeWithText("设计 · 拒绝 · 0%").assertExists()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_form_status"))
            compose.onNodeWithTag("v2_form_status").assertTextEquals("自动判断：证据不足，暂不判断")
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_use_status"))
            compose.onNodeWithTag("v2_use_status").assertTextEquals("自动判断：已完成，无适用项")
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entities_status"))
            compose.onNodeWithTag("v2_entities_status").assertTextEquals("实体：尚未运行")
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_evidence_partial"))
            compose.onNodeWithTag("v2_evidence_partial").assertExists()
            scenario.recreate()
            compose.waitUntil(20_000) { runCatching {
                compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entities_status"))
                compose.onNodeWithTag("v2_entities_status").assertTextEquals("实体：尚未运行")
                true
            }.getOrDefault(false) }
            assertTrue(paths.none { it.startsWith("POST ") || it.contains("/classifications/") })
        }
    }

    @Test fun aConflictKeepsTheDraftAndOffersReapply() {
        val attempts = java.util.concurrent.atomic.AtomicInteger()
        val bodies = java.util.Collections.synchronizedList(mutableListOf<JSONObject>())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path == "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                    path == "/api/bookmarks/4" -> response(link(4))
                    path == "/api/bookmarks/4/v2-selection" -> response(selection(if (attempts.get() == 0) 3 else 9))
                    path == "/api/v2-taxonomy" -> response(taxonomy())
                    path == "/api/bookmarks/4/v2-override" -> {
                        val body = JSONObject(request.body.readUtf8())
                        bodies.add(body)
                        if (attempts.incrementAndGet() == 1) {
                            MockResponse().setResponseCode(409)
                                .setHeader("Content-Type", "application/json")
                                .setBody(JSONObject("""{"error":"revision_conflict","revision":9}""").toString())
                        } else {
                            response(JSONObject("""{"id":4,"field":"topics","term":"llm","action":"reject","revision":10,"replayed":false}"""))
                        }
                    }
                    else -> response(JSONObject("""{"items":[],"counts":{}}"""))
                }
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use {
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_topics_chip_llm"))
            compose.onNodeWithTag("v2_topics_chip_llm").performClick()
            compose.waitUntil(20_000) {
                runCatching { compose.onNodeWithTag("v2_conflict").assertExists(); true }.getOrDefault(false)
            }
            // The draft is preserved and an explicit re-apply is offered.
            compose.onNodeWithTag("v2_conflict_reapply").assertExists()
            compose.onNodeWithTag("v2_conflict_discard").assertExists()
            compose.onNodeWithTag("v2_conflict_reapply").performClick()
            compose.waitUntil(20_000) { bodies.size >= 2 }
            // The re-apply replays the original logical action with the same
            // operation key: the reject must not be rewritten into an accept and
            // the retry must be the same logical commit (R2-05).
            assertEquals("reject", bodies[1].getString("action"))
            assertEquals("llm", bodies[1].getString("term"))
            assertEquals(bodies[0].getString("operation_key"), bodies[1].getString("operation_key"))
            assertEquals(9L, bodies[1].getLong("expected_revision"))
            compose.waitUntil(20_000) {
                runCatching { compose.onNodeWithTag("v2_conflict").assertDoesNotExist(); true }.getOrDefault(false)
            }
        }
    }

    @Test fun legacyActionsNeedTheVisibleOwnershipConfirmation() {
        val received = AtomicReference<JSONObject>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                "/api/bookmarks/4" -> response(link(4))
                "/api/bookmarks/4/v2-selection" -> response(selection(3))
                "/api/v2-taxonomy" -> response(taxonomy())
                "/api/bookmarks/4/v2-override" -> {
                    val body = JSONObject(request.body.readUtf8())
                    received.set(body)
                    assertEquals("legacy-reviewed", body.getString("operation_key"))
                    assertEquals(3L, body.getLong("expected_revision"))
                    response(JSONObject("""{"id":4,"field":"topics","term":"llm","action":"reject","operation_key":"legacy-reviewed","revision":4,"replayed":false}"""))
                }
                else -> response(JSONObject("""{"items":[],"counts":{}}"""))
            }
        }
        val intent = start()
        runBlocking {
            CurationActionStore(context).enqueue(QueuedCurationAction(4, "legacy-reviewed", "topics", "llm", "reject", 3,
                legacyAccountKeyFor(server.url("/").toString(), token), queueVersion = 0))
        }
        ActivityScenario.launch<LauncherActivity>(intent).use {
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_legacy_review"))
            compose.onNodeWithTag("v2_legacy_review").performClick()
            compose.onNodeWithText("主题：移除 llm").assertExists()
            assertNull(received.get())
            compose.onNodeWithText("暂不恢复").performClick()
            assertEquals(1, runBlocking { CurationActionStore(context).snapshot().size })
            compose.onNodeWithTag("v2_legacy_review").performClick()
            // An open confirmation belongs to the account shown when opened.
            // Even an old suffix collision must dismiss it on account change.
            runBlocking { SharePreferencesStore(context).setApiToken("different-$token") }
            compose.waitUntil(20_000) {
                runCatching { compose.onNodeWithTag("v2_legacy_confirm").assertDoesNotExist(); true }.getOrDefault(false)
            }
            assertNull(received.get())
            runBlocking { SharePreferencesStore(context).setApiToken(token) }
            compose.waitUntil(20_000) {
                // Switching accounts temporarily removes this LazyColumn item.
                // Its restored position can be outside the composed viewport.
                runCatching {
                    compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_legacy_review"))
                    compose.onNodeWithTag("v2_legacy_review").assertIsDisplayed()
                    true
                }.getOrDefault(false)
            }
            compose.onNodeWithTag("v2_legacy_review").performClick()
            compose.onNodeWithTag("v2_legacy_confirm").performClick()
            compose.waitUntil(20_000) { received.get() != null }
            compose.waitUntil(20_000) { runBlocking { CurationActionStore(context).snapshot().isEmpty() } }
        }
    }

    @Test fun oldBackendResetShowsPendingInsteadOfTheHumanValues() {
        val received = AtomicReference<JSONObject>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                "/api/bookmarks/4" -> response(link(4))
                "/api/bookmarks/4/v2-selection" -> response(selection(3)) // Old contract: no automatic baseline.
                "/api/v2-taxonomy" -> response(taxonomy())
                "/api/bookmarks/4/v2-override" -> {
                    received.set(JSONObject(request.body.readUtf8()))
                    MockResponse().setResponseCode(503)
                }
                else -> response(JSONObject("""{"items":[],"counts":{}}"""))
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use {
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_topics_reset"))
            compose.onNodeWithTag("v2_topics_reset").performClick()
            compose.waitUntil(20_000) { received.get() != null }
            compose.onNodeWithTag("v2_topics_reset_pending").assertExists()
            compose.onNodeWithTag("v2_topics_chip_llm").assertDoesNotExist()
            assertEquals("reset", received.get()!!.getString("action"))
            assertEquals(1, runBlocking { CurationActionStore(context).snapshot().size })
        }
    }
}
