package com.alpenl.cairn.share

import android.content.Intent
import android.app.Activity
import android.app.Instrumentation
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
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
        compose.waitUntil(20_000) { runCatching { compose.onNodeWithTag("reader_curation_toggle").assertExists(); true }.getOrDefault(false) }
        compose.onNodeWithTag("reader_curation_toggle").performClick()
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
                    path == "/api/links/4" || path == "/api/bookmarks/4" -> response(link(4))
                    path == "/api/bookmarks/4/v2-selection" -> response(selection(3))
                    path == "/api/v2-taxonomy" -> response(taxonomy())
                    path == "/api/bookmarks/4/v2-override" -> {
                        override.set(JSONObject(request.body.readUtf8()))
                        response(JSONObject("""{"id":4,"field":"topics","term":"llm","action":"reject","revision":4,"replayed":false}"""))
                    }
                    else -> MockResponse().setResponseCode(404)
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
                    "/api/links/4", "/api/bookmarks/4" -> response(link(4))
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
                    else -> MockResponse().setResponseCode(404)
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

    private fun inspectEntityEvidence(stale: Boolean, linkedSource: Boolean = false) {
        val paths = java.util.concurrent.CopyOnWriteArrayList<String>()
        val expectedUrl = if (linkedSource) "https://example.com/article?reference=" + "x".repeat(160)
            else "https://example.com/a"
        val fixture = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
            .open("entity-observations-v1.json").bufferedReader().use { it.readText() }).put("id", 4)
        if (linkedSource) {
            val entities = fixture.getJSONObject("state").getJSONObject("entities")
            val first = entities.getJSONArray("observations").getJSONObject(0)
            first.getJSONObject("candidate").put("surface", expectedUrl).put("kind", "link")
                .put("block_id", "").put("start", 0).put("end", 0).put("source_url", expectedUrl)
            first.getJSONArray("canonical_evidence").getJSONObject(0).put("identifier", expectedUrl)
                .put("block_id", "").put("source", "stored_link")
            entities.getJSONArray("values").put(JSONObject().put("term", expectedUrl)
                .put("origin", "automatic").put("confirmed", false).put("revision", JSONObject.NULL))
        }
        if (stale) {
            fixture.getJSONObject("state").put("content_revision", 2).getJSONObject("entities")
                .put("status", "stale").put("values", JSONArray())
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                paths.add("${request.method} $path")
                return when (path) {
                    "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                    "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                    "/api/bookmarks/4/v2-selection" -> response(fixture)
                    "/api/v2-taxonomy" -> response(taxonomy())
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        val opened = java.util.concurrent.CopyOnWriteArrayList<String>()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                if (intent.action != Intent.ACTION_VIEW) return null
                assertNull("external evidence navigation must not carry private extras", intent.extras)
                opened.add(intent.dataString.orEmpty())
                return Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
            }
        }
        instrumentation.addMonitor(monitor)
        try {
            ActivityScenario.launch<LauncherActivity>(start()).use { scenario ->
                openDetailAndLoadTaxonomy()
                fun inspect() {
                    val previouslyOpened = opened.size
                    compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entities_observations"))
                    // The entire v2 section is one tall LazyColumn item. Finding
                    // its descendant composes it but does not bring it on screen.
                    compose.onNodeWithTag("v2_entities_observations").performScrollTo().assertIsDisplayed().performClick()
                    compose.waitUntil(20_000) { runCatching {
                        compose.onNodeWithTag("v2_entities_records").assertExists(); true
                    }.getOrDefault(false) }
                    compose.onNodeWithText("Acme（项目，acme-a）").performScrollTo().assertIsDisplayed()
                    compose.onNodeWithText(expectedUrl).assertExists()
                    assertEquals("inspecting saved evidence must not launch a browser", previouslyOpened, opened.size)
                    compose.onAllNodesWithTag("v2_entity_link_0_0").assertCountEquals(1)
                    compose.onNodeWithTag("v2_entity_link_0_1").assertDoesNotExist()
                    compose.onNodeWithTag("v2_entity_link_0_0").performScrollTo().assertHasClickAction()
                        .assertContentDescriptionEquals("在浏览器中打开依据：$expectedUrl").performClick()
                    compose.runOnIdle {
                        assertEquals(previouslyOpened + 1, opened.size)
                        assertEquals(expectedUrl, opened.last())
                    }
                    compose.onNodeWithText("Acme（项目，acme-b）").performScrollTo().assertIsDisplayed()
                    compose.onNodeWithText("身份未确定").performScrollTo().assertIsDisplayed()
                    compose.onAllNodesWithText(if (stale) "非当前有效结果" else "当前有效自动建议").assertCountEquals(3)
                    compose.onAllNodesWithText(if (stale) "当前有效自动建议" else "非当前有效结果").assertCountEquals(0)
                    compose.onNodeWithText("关闭").performClick()
                }
                inspect()
                scenario.recreate()
                compose.waitUntil(20_000) { runCatching {
                    compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entities_observations")); true
                }.getOrDefault(false) }
                inspect()
                assertTrue(paths.none { it.startsWith("POST ") || it.contains("/classifications/") })
            }
        } finally {
            instrumentation.removeMonitor(monitor)
        }
    }

    @Test fun showsSameNamedEntityIdentitiesAndUnknownWithoutNewInference() = inspectEntityEvidence(false)

    @Test fun staleEntityEvidenceRemainsReadableAfterActivityRecreation() = inspectEntityEvidence(true)

    @Test fun opensStoredSourceOnlyAfterTapAndDeduplicatesMatchingIdentityEvidence() = inspectEntityEvidence(false, linkedSource = true)

    @Test fun sourceExcerptIsExplicitlyLoadedAndBoundToItsStoredVersion() = inspectSourceExcerpt()

    @Test fun sourceExcerptDistinguishesUnsupportedMissingChangedAndInvalidResponses() = inspectSourceExcerpt(errors = true)

    private fun entityPayload(revision: Int, names: List<String>, manual: Set<String> = emptySet(),
                              status: String = "not_run", automatic: List<String> = emptyList(), explicitEmpty: Boolean = false): JSONObject {
        val payload = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
            .open("entity-observations-v1.json").bufferedReader().use { it.readText() }).put("id", 4).put("revision", revision)
        val state = payload.getJSONObject("state").put("personal_revision", revision)
        val entities = state.getJSONObject("entities").put("status", status).put("recorded_state", status)
            .put("automatic", JSONArray(automatic))
            .put("values", JSONArray(names.map { name -> JSONObject().put("term", name)
                .put("origin", if (name in manual) "human" else "automatic").put("confirmed", name in manual)
                .put("revision", if (name in manual) revision else JSONObject.NULL) }))
        entities.put("empty", if (explicitEmpty) JSONObject().put("term", "").put("origin", "human")
            .put("confirmed", true).put("revision", revision).put("human_action", "set_empty") else JSONObject.NULL)
        if (status == "not_run") entities.put("observations", JSONArray()).put("content_revision", JSONObject.NULL)
            .put("evidence_snapshot_id", JSONObject.NULL).put("revision", 0)
        return payload
    }

    @Test fun entityNameActionsKeepNotRunSeparateFromManualAndExplicitEmpty() {
        val payload = AtomicReference(entityPayload(0, emptyList()))
        val posts = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                "/api/bookmarks/4/v2-selection" -> response(payload.get())
                "/api/v2-taxonomy" -> response(taxonomy())
                "/api/bookmarks/4/v2-override" -> {
                    val body = JSONObject(request.body.readUtf8()); posts.add(body)
                    assertEquals("entities", body.getString("field"))
                    val next = posts.size
                    assertEquals(next - 1, body.getInt("expected_revision"))
                    assertEquals(listOf("accept", "reject", "set_empty")[next - 1], body.getString("action"))
                    assertEquals(if (next < 3) "Manual" else "", body.optString("term"))
                    payload.set(entityPayload(next, if (next == 1) listOf("Manual") else emptyList(),
                        manual = if (next == 1) setOf("Manual") else emptySet(), explicitEmpty = next == 3))
                    response(JSONObject(body.toString()).put("term", body.optString("term"))
                        .put("id", 4).put("revision", next).put("replayed", false))
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use {
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entity_name"))
            compose.onNodeWithTag("v2_entity_name").performTextInput("Manual")
            compose.onNodeWithTag("v2_entity_add").performScrollTo().performClick()
            compose.waitUntil(20_000) { runCatching {
                compose.onNodeWithText("Manual · 人工确认").assertExists(); true
            }.getOrDefault(false) }
            compose.onNodeWithTag("v2_entities_status").assertTextEquals("实体：尚未运行")
            compose.onNodeWithTag("v2_entity_remove_0").performScrollTo().performClick()
            compose.onNodeWithTag("v2_entities_confirm").assertExists()
            compose.onNodeWithTag("v2_entities_confirm_apply").performClick()
            compose.waitUntil(20_000) { posts.size == 2 && runBlocking { CurationActionStore(context).snapshot().isEmpty() } }
            compose.onNodeWithTag("v2_entities_clear").performScrollTo().performClick()
            compose.onNodeWithTag("v2_entities_confirm_apply").performClick()
            compose.waitUntil(20_000) { runCatching {
                compose.onNodeWithTag("v2_entities_empty").assertTextEquals("明确留空 · 人工确认"); true
            }.getOrDefault(false) }
            compose.onNodeWithTag("v2_entities_status").assertTextEquals("实体：尚未运行")
            assertEquals(3, posts.map { it.getString("operation_key") }.distinct().size)
        }
    }

    @Test fun entityInputSurvivesRotationButCannotCrossAccount() {
        val lastToken = AtomicReference<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                assertNotEquals("merely editing a draft must not send it", "POST", request.method)
                return when (request.requestUrl!!.encodedPath) {
                    "/api/links" -> { lastToken.set(request.getHeader("Authorization")); response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL)) }
                    "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                    "/api/bookmarks/4/v2-selection" -> response(entityPayload(0, emptyList()))
                    "/api/v2-taxonomy" -> response(taxonomy())
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use { scenario ->
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entity_name"))
            compose.onNodeWithTag("v2_entity_name").performTextInput("rotation draft")
            scenario.recreate()
            compose.waitUntil(20_000) { runCatching {
                compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entity_name")); true
            }.getOrDefault(false) }
            assertEquals("rotation draft", compose.onNodeWithTag("v2_entity_name").fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
            runBlocking { SharePreferencesStore(context).setApiToken("entity-other-account") }
            compose.waitUntil(20_000) { lastToken.get() == "Bearer entity-other-account" }
            // A new account deliberately collapses the old account's editor.
            compose.waitUntil(20_000) { runCatching {
                compose.onNodeWithTag("v2_entity_name").assertDoesNotExist()
                compose.onNodeWithTag("reader_curation_toggle").assertExists(); true
            }.getOrDefault(false) }
            compose.onNodeWithTag("reader_curation_toggle").performScrollTo().performClick()
            compose.waitUntil(20_000) { runCatching {
                compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entity_name"))
                compose.onNodeWithTag("v2_entity_name").fetchSemanticsNode().config[SemanticsProperties.EditableText].text.isEmpty()
            }.getOrDefault(false) }
            assertTrue(runBlocking { CurationActionStore(context).snapshot().isEmpty() })
        }
    }

    @Test fun unsupportedEntityWriteRemainsPendingAndReusesSameOperationAfterUpgrade() {
        val supported = java.util.concurrent.atomic.AtomicBoolean(false)
        val keys = java.util.concurrent.CopyOnWriteArrayList<String>()
        val payload = AtomicReference(entityPayload(0, listOf("Acme"), status = "completed_nonempty", automatic = listOf("Acme")))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                "/api/bookmarks/4/v2-selection" -> response(payload.get())
                "/api/v2-taxonomy" -> response(taxonomy())
                "/api/bookmarks/4/v2-override" -> {
                    val body = JSONObject(request.body.readUtf8()); keys.add(body.getString("operation_key"))
                    assertEquals("entities", body.getString("field")); assertEquals("Manual", body.getString("term"))
                    if (!supported.get()) MockResponse().setResponseCode(501)
                    else {
                        payload.set(entityPayload(1, listOf("Acme", "Manual"), setOf("Manual"), "completed_nonempty", listOf("Acme")))
                        response(JSONObject(body.toString()).put("id", 4).put("revision", 1).put("replayed", false))
                    }
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use {
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entity_name"))
            compose.onNodeWithTag("v2_entity_name").performTextInput("Manual")
            compose.onNodeWithTag("v2_entity_add").performScrollTo().performClick()
            compose.waitUntil(20_000) { runCatching {
                compose.onNodeWithText("当前服务不支持这项整理，动作已保留。").assertExists(); true
            }.getOrDefault(false) }
            val pending = runBlocking { CurationActionStore(context).snapshot().single() }
            assertEquals("entities", pending.field); assertEquals("accept", pending.action)
            supported.set(true)
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_flush"))
            compose.onNodeWithTag("v2_flush").performClick()
            compose.waitUntil(20_000) { runBlocking { CurationActionStore(context).snapshot().isEmpty() } }
            assertEquals(listOf(pending.operationKey), keys.distinct())
            assertTrue(keys.size >= 2)
            compose.onNodeWithTag("v2_entities_status").assertTextEquals("实体：已生成建议")
        }
    }

    private fun inspectSourceExcerpt(errors: Boolean = false) {
        val requests = java.util.concurrent.CopyOnWriteArrayList<String>()
        val reads = java.util.concurrent.atomic.AtomicInteger()
        fun asset(name: String) = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
            .open(name).bufferedReader().use { it.readText() })
        val selected = asset("entity-observations-v1.json").put("id", 4)
        selected.getJSONObject("state").put("content_revision", 2).getJSONObject("entities")
            .getJSONArray("observations").getJSONObject(0).getJSONObject("candidate").put("start", 2).put("end", 6)
        val excerpt = asset("entity-source-evidence-v1.json").put("bookmark_id", 4).put("current", false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                requests.add(request.method + " " + path)
                return when (path) {
                    "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                    "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                    "/api/bookmarks/4/v2-selection" -> response(selected)
                    "/api/v2-taxonomy" -> response(taxonomy())
                    "/api/bookmarks/4/entity-evidence" -> {
                        assertEquals("Bearer " + token, request.getHeader("Authorization"))
                        assertEquals(setOf("snapshot_id", "content_revision", "block_id", "start", "end"), request.requestUrl!!.queryParameterNames)
                        assertEquals("1", request.requestUrl!!.queryParameter("snapshot_id"))
                        assertEquals("1", request.requestUrl!!.queryParameter("content_revision"))
                        assertEquals("a", request.requestUrl!!.queryParameter("block_id"))
                        assertEquals("2", request.requestUrl!!.queryParameter("start"))
                        assertEquals("6", request.requestUrl!!.queryParameter("end"))
                        val attempt = reads.incrementAndGet()
                        if (!errors) response(excerpt).setHeader("X-Cairn-Entity-Evidence", "1")
                        else when (attempt) {
                            1 -> MockResponse().setResponseCode(404)
                            2 -> MockResponse().setResponseCode(404).setHeader("X-Cairn-Entity-Evidence", "1")
                            3 -> MockResponse().setResponseCode(409).setHeader("X-Cairn-Entity-Evidence", "1")
                            4 -> response(JSONObject(excerpt.toString()).put("quote", "foreign")).setHeader("X-Cairn-Entity-Evidence", "1")
                            5 -> response("x".repeat(32 * 1024 + 1)).setHeader("X-Cairn-Entity-Evidence", "1")
                            else -> response(excerpt).setHeader("X-Cairn-Entity-Evidence", "1")
                        }
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use {
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_entities_observations"))
            compose.onNodeWithTag("v2_entities_observations").performClick()
            compose.onNodeWithTag("v2_entity_source_0").performScrollTo().assertIsDisplayed()
            assertEquals("merely opening entity records must not fetch source material", 0, reads.get())
            val messages = if (errors) listOf("当前服务不支持来源片段定位。", "原始片段不可用，请刷新依据后重试。",
                "依据版本已变化，请刷新后重新选择。", "读取失败，请重试。", "读取失败，请重试。") else emptyList()
            for (message in messages) {
                compose.onNodeWithTag("v2_entity_source_0").performScrollTo().performClick()
                compose.waitUntil(20_000) { runCatching {
                    compose.onNodeWithTag("v2_entity_source_error").assertTextEquals(message); true
                }.getOrDefault(false) }
                compose.onNodeWithTag("v2_entity_source_text").assertDoesNotExist()
                compose.onNodeWithTag("v2_entity_source_close").performClick()
            }
            compose.onNodeWithTag("v2_entity_source_0").performScrollTo().performClick()
            compose.waitUntil(20_000) { runCatching {
                compose.onNodeWithTag("v2_entity_source_text").assertTextEquals("前🙂Acme 后𠮷"); true
            }.getOrDefault(false) }
            compose.onNodeWithTag("v2_entity_source_stale").assertExists()
            compose.onNodeWithTag("v2_entity_source_close").performClick()
            compose.onNodeWithText("关闭").performClick()
            assertTrue(requests.none { it.startsWith("POST ") || it.startsWith("DELETE ") || it.contains("/classifications/") })
            assertTrue(runBlocking { CurationActionStore(context).snapshot().isEmpty() })
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
                    path == "/api/links/4" || path == "/api/bookmarks/4" -> response(link(4))
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
                    else -> MockResponse().setResponseCode(404)
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
        val lastLibraryToken = AtomicReference<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> {
                    lastLibraryToken.set(request.getHeader("Authorization"))
                    response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                }
                "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                "/api/bookmarks/4/v2-selection" -> response(selection(3))
                "/api/v2-taxonomy" -> response(taxonomy())
                "/api/bookmarks/4/v2-override" -> {
                    val body = JSONObject(request.body.readUtf8())
                    received.set(body)
                    assertEquals("legacy-reviewed", body.getString("operation_key"))
                    assertEquals(3L, body.getLong("expected_revision"))
                    response(JSONObject("""{"id":4,"field":"topics","term":"llm","action":"reject","operation_key":"legacy-reviewed","revision":4,"replayed":false}"""))
                }
                else -> MockResponse().setResponseCode(404)
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
            compose.onNodeWithTag("v2_legacy_review").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.onNodeWithText("主题：移除 llm").assertExists()
            assertNull(received.get())
            compose.onNodeWithText("暂不恢复").performClick()
            assertEquals(1, runBlocking { CurationActionStore(context).snapshot().size })
            compose.onNodeWithTag("v2_legacy_review").performSemanticsAction(SemanticsActions.OnClick) { it() }
            // An open confirmation belongs to the account shown when opened.
            // Even an old suffix collision must dismiss it on account change.
            runBlocking { SharePreferencesStore(context).setApiToken("different-$token") }
            compose.waitUntil(20_000) { lastLibraryToken.get() == "Bearer different-$token" }
            compose.waitUntil(20_000) {
                runCatching { compose.onNodeWithTag("v2_legacy_confirm").assertDoesNotExist(); true }.getOrDefault(false)
            }
            assertNull(received.get())
            runBlocking { SharePreferencesStore(context).setApiToken(token) }
            compose.waitUntil(20_000) { lastLibraryToken.get() == "Bearer $token" }
            compose.waitUntil(20_000) { runCatching {
                compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("reader_curation_toggle"))
                compose.onNodeWithTag("reader_curation_toggle")
                    .assertContentDescriptionEquals("编辑标签与备注")
                    .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "已折叠"))
                true
            }.getOrDefault(false) }
            // Changing the active account resets the reader's editor to folded.
            compose.onNodeWithTag("reader_curation_toggle").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.waitUntil(20_000) {
                // Switching accounts temporarily removes this LazyColumn item.
                // Its restored position can be outside the composed viewport.
                runCatching {
                    compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("v2_legacy_review"))
                    compose.onNodeWithTag("v2_legacy_review").assertExists()
                    true
                }.getOrDefault(false)
            }
            compose.onNodeWithTag("v2_legacy_review").performSemanticsAction(SemanticsActions.OnClick) { it() }
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
                "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                "/api/bookmarks/4/v2-selection" -> response(selection(3)) // Old contract: no automatic baseline.
                "/api/v2-taxonomy" -> response(taxonomy())
                "/api/bookmarks/4/v2-override" -> {
                    received.set(JSONObject(request.body.readUtf8()))
                    MockResponse().setResponseCode(503)
                }
                else -> MockResponse().setResponseCode(404)
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

    @Test fun classificationHistoryLoadsOnlyOnRequestAndKeepsPartialUnknownAndPagedRecords() {
        val paths = java.util.concurrent.CopyOnWriteArrayList<String>()
        fun row(id: Int) = JSONObject().put("id", id).put("status", "partial")
            .put("resolved_model", JSONObject.NULL).put("requested_model", "recorded-request")
            .put("coverage", "partial").put("evidence_coverage", "partial").put("content_revision", 2)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                paths.add("${request.method} ${request.requestUrl!!.encodedPath}?${request.requestUrl!!.encodedQuery.orEmpty()}")
                return when (path) {
                    "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                    "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                    "/api/bookmarks/4/v2-selection" -> response(selection(3))
                    "/api/v2-taxonomy" -> response(taxonomy())
                    "/api/bookmarks/4/run-history" -> {
                        assertEquals("Bearer $token", request.getHeader("Authorization"))
                        assertEquals("1", request.getHeader("X-Cairn-App-Run-History"))
                        val older = request.requestUrl!!.queryParameter("after_id") == "8"
                        response(JSONObject().put("version", 1).put("bookmark_id", 4)
                            .put("runs", if (older) JSONArray().put(row(7).put("status", "failed"))
                                else JSONArray().put(row(9)).put(row(8)))
                            .put("next_after_id", if (older) JSONObject.NULL else 8))
                            .setHeader("X-Cairn-App-Run-History", "1")
                    }
                    "/api/bookmarks/4/run-history/9" -> response(JSONObject().put("version", 1).put("bookmark_id", 4)
                        .put("run", row(9).put("answers", JSONObject().put("topic", false))
                            .put("usage", JSONObject().put("input_tokens", 17))
                            .put("raw_judgments", JSONObject().put("source", "recorded-source").put("large", "x".repeat(17_000)))))
                        .setHeader("X-Cairn-App-Run-History", "1")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use {
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("run_history_open"))
            assertFalse(paths.any { it.contains("/run-history") })
            compose.onNodeWithTag("run_history_open").performClick()
            compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag("run_history_row_9").assertExists(); true }.getOrDefault(false) }
            assertFalse(paths.any { it.contains("/run-history/9") })
            compose.onNodeWithTag("run_history_row_9").performScrollTo().performClick()
            compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag("run_history_status").assertTextEquals("记录状态：部分完成"); true }.getOrDefault(false) }
            compose.onNodeWithTag("run_history_model").assertTextEquals("实际模型：未知")
            compose.onNodeWithTag("run_history_preview_toggle").performScrollTo().performClick()
            compose.onNodeWithTag("run_history_preview").assertTextContains("recorded-source", substring = true)
            val preview = compose.onNodeWithTag("run_history_preview").fetchSemanticsNode().config[SemanticsProperties.Text].joinToString("") { it.text }
            assertEquals(16_384, preview.length)
            compose.onNodeWithTag("run_history_preview_toggle").performScrollTo().performClick()
            compose.onNodeWithTag("run_history_export").performScrollTo().assertIsDisplayed()
            // Return a controlled file-picker result, then use the actual
            // ContentResolver writer. This does not claim to test system UI.
            val exported = java.io.File.createTempFile("cairn-history-", ".json", context.cacheDir)
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            var exportIntents = 0
            val monitor = object : Instrumentation.ActivityMonitor() {
                override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                    if (intent.action != Intent.ACTION_CREATE_DOCUMENT) return null
                    assertEquals("application/json", intent.type)
                    assertEquals("cairn-classification-4-9.json", intent.getStringExtra(Intent.EXTRA_TITLE))
                    exportIntents++
                    return Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(android.net.Uri.fromFile(exported)))
                }
            }
            instrumentation.addMonitor(monitor)
            try {
                compose.onNodeWithTag("run_history_export").performClick()
                compose.waitUntil(15_000) { runCatching {
                    compose.onNodeWithTag("run_history_export_status").assertTextEquals("已导出所选记录。"); true
                }.getOrDefault(false) }
                assertEquals(1, exportIntents)
                val saved = JSONObject(exported.readText()).getJSONObject("run")
                assertTrue(saved.has("resolved_model")); assertTrue(saved.isNull("resolved_model"))
                assertEquals(17_000, saved.getJSONObject("raw_judgments").getString("large").length)
                assertFalse(saved.getJSONObject("answers").getBoolean("topic"))
                assertEquals(17, saved.getJSONObject("usage").getInt("input_tokens"))
            } finally {
                instrumentation.removeMonitor(monitor)
                assertTrue("Remove only the owned synthetic export", exported.delete())
            }
            compose.onNodeWithTag("run_history_back").performClick()
            compose.onNodeWithTag("run_history_more").performScrollTo().performClick()
            compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag("run_history_row_7").assertExists(); true }.getOrDefault(false) }
            compose.onNodeWithTag("run_history_row_9").assertDoesNotExist()
            compose.onNodeWithTag("run_history_latest").performScrollTo().performClick()
            compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag("run_history_row_9").assertExists(); true }.getOrDefault(false) }
            compose.onNodeWithTag("run_history_close").performClick()
            assertTrue(paths.any { it.endsWith("/run-history?after_id=8") })
            assertTrue("History reads must never submit actions or invoke a model", paths.all { it.startsWith("GET ") })
        }
    }
}
