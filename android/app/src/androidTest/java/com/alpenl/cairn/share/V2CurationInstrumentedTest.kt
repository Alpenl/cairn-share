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

    @Test fun savedHistoryReadsOriginalSourceEntityAndLegacyLogsAndExportsCompleteSource() {
        val paths = java.util.concurrent.CopyOnWriteArrayList<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!
                paths.add("${request.method} ${url.encodedPath}")
                val kind = url.encodedPath.substringAfterLast('/')
                if (url.encodedPath.startsWith("/api/bookmarks/4/saved-records/")) {
                    assertEquals("1", request.getHeader("X-Cairn-App-Saved-Records"))
                    assertEquals("Bearer $token", request.getHeader("Authorization"))
                    val source = if (kind == "entities") 2 else JSONObject.NULL
                    if (kind == "entities") assertEquals("2", url.queryParameter("source_revision"))
                    val row = JSONObject().put("key", if (kind == "entities") "opaque-entity" else "2")
                    when (kind) {
                        "sources" -> row.put("content_revision", 2).put("completeness", "partial")
                        "entities" -> row.put("state", "failed").put("outcome", "ignored_stale")
                        "overrides" -> row.put("source", "legacy_unknown").put("confirmed", 0).put("action", "reject")
                        "events" -> row.put("action", "why")
                    }
                    val result = JSONObject().put("version", 1).put("bookmark_id", 4).put("kind", kind).put("source_revision", source)
                    if (url.queryParameter("record_key") != null) {
                        assertEquals(row.getString("key"), url.queryParameter("record_key"))
                        row.put("payload", JSONObject().put("original", "原文" + "x".repeat(17_000)).put("unknown", JSONObject.NULL).put("truncated", false))
                        result.put("record", row)
                    } else result.put("records", JSONArray().put(row)).put("next_after", JSONObject.NULL)
                    return response(result).setHeader("X-Cairn-App-Saved-Records", "1")
                }
                return when (url.encodedPath) {
                    "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                    "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                    "/api/bookmarks/4/v2-selection" -> response(selection(3))
                    "/api/v2-taxonomy" -> response(taxonomy())
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use { scenario ->
            openDetailAndLoadTaxonomy()
            assertFalse(paths.any { it.contains("saved-records") })
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("saved_history_open"))
            compose.onNodeWithTag("saved_history_open").performClick()
            fun choose(key: String) {
                compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag("saved_history_row_$key").assertExists(); true }.getOrDefault(false) }
                compose.onNodeWithTag("saved_history_row_$key").performScrollTo().performClick()
                compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag("saved_history_export").assertExists(); true }.getOrDefault(false) }
            }
            choose("2")
            val file = java.io.File.createTempFile("cairn-source-", ".json", context.cacheDir)
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val monitor = object : Instrumentation.ActivityMonitor() {
                override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                    if (intent.action != Intent.ACTION_CREATE_DOCUMENT) return null
                    assertEquals("cairn-sources-4.json", intent.getStringExtra(Intent.EXTRA_TITLE))
                    return Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(android.net.Uri.fromFile(file)))
                }
            }
            instrumentation.addMonitor(monitor)
            try {
                compose.onNodeWithTag("saved_history_export").performScrollTo().performClick()
                compose.waitUntil(15_000) { runCatching { compose.onNodeWithTag("saved_history_export_status").assertTextEquals("已导出所选记录。"); true }.getOrDefault(false) }
                val payload = JSONObject(file.readText()).getJSONObject("record").getJSONObject("payload")
                assertEquals(17_002, payload.getString("original").length)
                assertTrue(payload.isNull("unknown")); assertFalse(payload.getBoolean("truncated"))
            } finally {
                instrumentation.removeMonitor(monitor)
                assertTrue(file.delete())
            }
            compose.onNodeWithTag("saved_history_source_entities").performScrollTo().performClick()
            choose("opaque-entity")
            compose.onNodeWithText("记录状态：失败").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("处理结果：已忽略旧结果").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("saved_history_kind_overrides").performScrollTo().performClick()
            choose("2")
            compose.onNodeWithText("决定来源：旧记录，来源不明").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("确认情况：未确认").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("saved_history_kind_events").performScrollTo().performClick()
            choose("2")
            compose.onNodeWithText("动作：修改收藏原因").performScrollTo().assertIsDisplayed()
            scenario.recreate()
            compose.onNodeWithTag("saved_history_dialog").assertDoesNotExist()
            assertTrue("All history navigation is read-only", paths.all { it.startsWith("GET ") })
        }
    }

    @Test fun manualMaterialKeepsUnknownIntentAcrossActivityRecreationAndConfirmsSameReceipt() {
        val bodies = java.util.concurrent.CopyOnWriteArrayList<String>()
        val reads = java.util.concurrent.atomic.AtomicInteger(0)
        val committed = AtomicReference<String?>(null)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return when (request.requestUrl!!.encodedPath) {
                    "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                    "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                    "/api/bookmarks/4/v2-selection" -> response(selection(3))
                    "/api/v2-taxonomy" -> response(taxonomy())
                    "/api/bookmarks/4/manual-material" -> {
                        assertEquals("1", request.getHeader("X-Cairn-App-Manual-Material"))
                        assertEquals("Bearer $token", request.getHeader("Authorization"))
                        if (request.method == "GET") {
                            reads.incrementAndGet()
                            response(JSONObject().put("version", 1).put("id", 4).put("source", JSONObject().put("content_revision", 3)
                                .put("evidence_snapshot_id", 8).put("source_hash", "a".repeat(64)).put("target_generation", 2))
                                .put("can_submit", true).put("blocked_reason", JSONObject.NULL).put("max_text_bytes", 100000)
                                .put("options", JSONArray().put(JSONObject().put("kind", "image_text").put("source_ref", "image").put("role", "legacy_unknown"))))
                                .setHeader("X-Cairn-App-Manual-Material", "1")
                        } else {
                            val body = request.body.readUtf8(); bodies.add(body)
                            val journal = runBlocking { ManualMaterialStore(context).load(accountKeyFor(server.url("/").toString(), token), 4) }
                            assertNotNull("Intent must be durable before the first network byte", journal)
                            assertEquals(journal!!.intent.encode().toString(), body)
                            assertEquals("Human image transcription 🙂", JSONObject(body).getString("text"))
                            if (committed.compareAndSet(null, body)) MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST)
                            else {
                                assertEquals(committed.get(), body)
                                response(JSONObject().put("version", 1).put("id", 4).put("operation_key", JSONObject(body).getString("operation_key"))
                                    .put("request_id", "same-receipt").put("status", "material_saved").put("content_revision", 4).put("evidence_snapshot_id", 9)
                                    .put("source_hash", "b".repeat(64)).put("changed", true).put("classification_queued", true).put("model_calls", 0).put("replayed", true))
                                    .setHeader("X-Cairn-App-Manual-Material", "1")
                            }
                        }
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use { activity ->
            openDetailAndLoadTaxonomy()
            assertEquals(0, reads.get()); assertTrue(bodies.isEmpty())
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("manual_material_toggle"))
            compose.onNodeWithTag("manual_material_toggle").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("manual_material_text").assertIsEnabled(); true }.getOrDefault(false) }
            compose.onNodeWithTag("manual_material_text").performScrollTo().performTextInput("Human image transcription 🙂")
            activity.onActivity { host ->
                host.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                    .hideSoftInputFromWindow(host.window.decorView.windowToken, 0)
            }
            compose.waitUntil(5000) {
                var hidden = false
                activity.onActivity { host -> hidden = androidx.core.view.ViewCompat.getRootWindowInsets(host.window.decorView)
                    ?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == false }
                hidden
            }
            compose.onNodeWithTag("manual_material_submit").performScrollTo().performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("manual_material_message").assertTextContains("结果尚未确认", substring=true); true }.getOrDefault(false) }
            assertEquals(1, bodies.size)
            activity.recreate()
            compose.waitUntil(20000) { runCatching { compose.onNodeWithTag("reader_curation_toggle").assertExists(); true }.getOrDefault(false) ||
                runCatching { compose.onNodeWithTag("link_4").assertExists(); true }.getOrDefault(false) }
            if (runCatching { compose.onNodeWithTag("link_4").assertExists(); true }.getOrDefault(false)) compose.onNodeWithTag("link_4").performClick()
            compose.waitUntil(20000) { runCatching { compose.onNodeWithTag("reader_curation_toggle").assertExists(); true }.getOrDefault(false) }
            if (!runCatching { compose.onNodeWithTag("manual_material_toggle").assertExists(); true }.getOrDefault(false)) compose.onNodeWithTag("reader_curation_toggle").performClick()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("manual_material_toggle"))
            compose.onNodeWithTag("manual_material_toggle").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("manual_material_draft_status").assertTextContains("上次保存结果未确认", substring=true); true }.getOrDefault(false) }
            compose.onNodeWithTag("manual_material_text").assertIsNotEnabled().assertTextContains("Human image transcription 🙂", substring=true)
            assertEquals(1, bodies.size)
            compose.onNodeWithTag("manual_material_submit").performScrollTo().performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("manual_material_message").assertTextEquals("材料已保存，分类已排队。"); true }.getOrDefault(false) }
            assertEquals(2, bodies.size); assertEquals(bodies[0], bodies[1])
            assertNull(runBlocking { ManualMaterialStore(context).load(accountKeyFor(server.url("/").toString(), token), 4) })
        }
    }

    @Test fun manualMaterialReloadKeepsEditedTextReferenceAndRequiresExplicitCurrentSourceAfterRotation() {
        val reads = java.util.concurrent.atomic.AtomicInteger(0)
        val bodies = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
                "/api/links/4", "/api/bookmarks/4" -> response(link(4))
                "/api/bookmarks/4/v2-selection" -> response(selection(3))
                "/api/v2-taxonomy" -> response(taxonomy())
                "/api/bookmarks/4/manual-material" -> if (request.method == "GET") {
                    val revision = (reads.incrementAndGet()+2).coerceAtMost(5)
                    val names = if (revision == 4) listOf("image-b", "image-a") else listOf("image-a", "image-b")
                    response(JSONObject().put("version", 1).put("id", 4).put("source", JSONObject().put("content_revision", revision)
                        .put("evidence_snapshot_id", revision+5).put("source_hash", ('a'+revision-3).toString().repeat(64)).put("target_generation", 2))
                        .put("can_submit", true).put("blocked_reason", JSONObject.NULL).put("max_text_bytes", 100000)
                        .put("options", JSONArray().also { rows -> names.forEach { name -> rows.put(JSONObject().put("kind", "image_text").put("source_ref", name).put("role", "legacy_unknown")) } }))
                        .setHeader("X-Cairn-App-Manual-Material", "1")
                } else {
                    val body = JSONObject(request.body.readUtf8()); bodies.add(body)
                    if (bodies.size == 1) MockResponse().setResponseCode(409).setHeader("X-Cairn-App-Manual-Material", "1").setBody("{\"error\":\"source_conflict\"}")
                    else response(JSONObject().put("version", 1).put("id", 4).put("operation_key", body.getString("operation_key")).put("request_id", "edited-save")
                        .put("status", "material_saved").put("content_revision", 6).put("evidence_snapshot_id", 11).put("source_hash", "d".repeat(64))
                        .put("changed", true).put("classification_queued", true).put("model_calls", 0).put("replayed", false)).setHeader("X-Cairn-App-Manual-Material", "1")
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use { activity ->
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("manual_material_toggle"))
            compose.onNodeWithTag("manual_material_toggle").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("manual_material_option_1").assertIsEnabled(); true }.getOrDefault(false) }
            compose.onNodeWithTag("manual_material_option_1").performScrollTo().performClick()
            compose.onNodeWithTag("manual_material_text").performScrollTo().performTextInput("original draft")
            activity.onActivity { it.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(it.window.decorView.windowToken, 0) }
            compose.onNodeWithTag("manual_material_submit").performScrollTo().performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("manual_material_reprepare").assertExists(); true }.getOrDefault(false) }
            compose.onNodeWithTag("manual_material_reprepare").performScrollTo().performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("manual_material_text").assertIsEnabled(); true }.getOrDefault(false) }
            compose.onNodeWithTag("manual_material_text").performScrollTo().performTextReplacement("edited draft must survive")
            activity.onActivity { it.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(it.window.decorView.windowToken, 0) }
            compose.onNodeWithTag("manual_material_reload").performScrollTo().performClick()
            compose.waitUntil(15000) { reads.get() >= 3 && runCatching { compose.onNodeWithTag("manual_material_busy").assertDoesNotExist(); true }.getOrDefault(false) }
            compose.onNodeWithTag("manual_material_text").assertTextContains("edited draft must survive", substring=true)
            compose.onNodeWithTag("manual_material_option_1").assertTextContains("✓ 图片文字：image-b", substring=true)
            compose.onNodeWithTag("manual_material_submit").assertIsNotEnabled()
            assertEquals(1, bodies.size)
            activity.recreate()
            compose.waitUntil(20000) { runCatching { compose.onNodeWithTag("reader_curation_toggle").assertExists(); true }.getOrDefault(false) || runCatching { compose.onNodeWithTag("link_4").assertExists(); true }.getOrDefault(false) }
            if (runCatching { compose.onNodeWithTag("link_4").assertExists(); true }.getOrDefault(false)) compose.onNodeWithTag("link_4").performClick()
            compose.waitUntil(20000) { runCatching { compose.onNodeWithTag("reader_curation_toggle").assertExists(); true }.getOrDefault(false) }
            if (!runCatching { compose.onNodeWithTag("manual_material_toggle").assertExists(); true }.getOrDefault(false)) compose.onNodeWithTag("reader_curation_toggle").performClick()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("manual_material_toggle"))
            compose.onNodeWithTag("manual_material_toggle").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("manual_material_source_changed").assertExists(); true }.getOrDefault(false) }
            compose.onNodeWithTag("manual_material_text").assertTextContains("edited draft must survive", substring=true)
            compose.onNodeWithTag("manual_material_option_1").assertTextContains("✓ 图片文字：image-b", substring=true)
            compose.onNodeWithTag("manual_material_submit").assertIsNotEnabled()
            compose.onNodeWithTag("manual_material_use_current_source").performScrollTo().performClick()
            compose.onNodeWithTag("manual_material_submit").performScrollTo().assertIsEnabled().performClick()
            compose.waitUntil(15000) { bodies.size == 2 && runCatching { compose.onNodeWithTag("manual_material_message").assertTextEquals("材料已保存，分类已排队。"); true }.getOrDefault(false) }
            assertEquals("image-b", bodies[0].getString("source_ref")); assertEquals("image-b", bodies[1].getString("source_ref"))
            assertEquals("edited draft must survive", bodies[1].getString("text")); assertEquals(5, bodies[1].getInt("expected_content_revision"))
            assertNotEquals(bodies[0].getString("operation_key"), bodies[1].getString("operation_key"))
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

    @Test fun processingDiscardCasFailureKeepsTheNewUnknownIntentAndDisplaysItsActualText() {
        val bodies = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
        val current = AtomicReference(ProcessingFixture.status())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl!!.encodedPath != "/api/bookmarks/4/processing") return processingFallback(request)
                if (request.method == "GET") return ProcessingFixture.response(current.get())
                val body = JSONObject(request.body.readUtf8()); bodies += body
                if (bodies.size == 1) return ProcessingFixture.response(JSONObject().put("error", "state_conflict"), 409)
                assertEquals("another-instance", body.getString("operation_key"))
                assertEquals("Another instance original", body.getString("text"))
                current.set(ProcessingFixture.status(4, "b".repeat(64), missing = false))
                return ProcessingFixture.response(ProcessingFixture.receipt(body))
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use { activity ->
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("processing_toggle"))
            compose.onNodeWithTag("processing_toggle").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_primary_text").assertExists(); true }.getOrDefault(false) }
            compose.onNodeWithTag("processing_primary_text").performScrollTo().performTextInput("UI owned draft")
            hideProcessingKeyboard(activity)
            compose.onNodeWithTag("processing_action_save_primary").performScrollTo().performClick()
            compose.onNodeWithTag("processing_confirm").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_discard").assertExists(); true }.getOrDefault(false) }
            val account = accountKeyFor(server.url("/").toString(), token)
            val store = ProcessingStore(context)
            val old = runBlocking { store.load(account, 4)!! }
            val replacement = old.copy(intent = old.intent.copy(operationKey = "another-instance", text = "Another instance original"), rejected = null)
            runBlocking { store.prepare(replacement, old) }
            compose.onNodeWithTag("processing_discard").performScrollTo().performClick()
            compose.onNodeWithTag("processing_discard_confirm").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_message").assertTextContains("本地草稿未能清理", substring = true); true }.getOrDefault(false) }
            assertEquals(replacement, runBlocking { store.load(account, 4) })
            compose.onNodeWithTag("processing_saved_text").assertTextContains("UI owned draft", substring = true)
            compose.onNodeWithTag("processing_refresh").performScrollTo().performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_saved_text").assertTextContains("Another instance original", substring = true); true }.getOrDefault(false) }
            compose.onNodeWithTag("processing_discard").assertDoesNotExist()
            assertEquals(1, bodies.size)
            compose.onNodeWithTag("processing_recover").performScrollTo().performClick()
            compose.onNodeWithTag("processing_confirm").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_message").assertTextContains("请求已保存", substring = true); true }.getOrDefault(false) }
            assertEquals(2, bodies.size)
            assertNull(runBlocking { store.load(account, 4) })
        }
    }

    private fun processingFallback(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
        "/api/links" -> response(JSONObject().put("items", JSONArray().put(link(4))).put("next_before_id", JSONObject.NULL))
        "/api/links/4", "/api/bookmarks/4" -> response(link(4))
        "/api/bookmarks/4/v2-selection" -> response(selection(3))
        "/api/v2-taxonomy" -> response(taxonomy())
        else -> MockResponse().setResponseCode(404)
    }
    private fun openProcessingAfterRecreation() {
        compose.waitUntil(20000) { runCatching { compose.onNodeWithTag("reader_curation_toggle").assertExists(); true }.getOrDefault(false) ||
            runCatching { compose.onNodeWithTag("link_4").assertExists(); true }.getOrDefault(false) }
        if (runCatching { compose.onNodeWithTag("link_4").assertExists(); true }.getOrDefault(false)) compose.onNodeWithTag("link_4").performClick()
        compose.waitUntil(20000) { runCatching { compose.onNodeWithTag("reader_curation_toggle").assertExists(); true }.getOrDefault(false) }
        if (!runCatching { compose.onNodeWithTag("processing_toggle").assertExists(); true }.getOrDefault(false)) compose.onNodeWithTag("reader_curation_toggle").performClick()
        compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("processing_toggle"))
        if (!runCatching { compose.onNodeWithTag("processing_refresh").assertExists(); true }.getOrDefault(false)) compose.onNodeWithTag("processing_toggle").performClick()
        compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_stage_source").assertExists(); true }.getOrDefault(false) }
    }
    private fun hideProcessingKeyboard(activity: ActivityScenario<LauncherActivity>) {
        activity.onActivity { host -> host.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
            .hideSoftInputFromWindow(host.window.decorView.windowToken, 0) }
        compose.waitUntil(5000) {
            var hidden = false
            activity.onActivity { host -> hidden = androidx.core.view.ViewCompat.getRootWindowInsets(host.window.decorView)
                ?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == false }
            hidden
        }
    }

    @Test fun processingStatusIsExplicitAndUnknownIntentRecreationOnlyConfirmsSamePersistedRequest() {
        val bodies = java.util.concurrent.CopyOnWriteArrayList<String>()
        val reads = java.util.concurrent.atomic.AtomicInteger()
        val committed = AtomicReference<String?>(null)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl!!.encodedPath != "/api/bookmarks/4/processing") return processingFallback(request)
                assertEquals("Bearer $token", request.getHeader("Authorization"))
                assertEquals("1", request.getHeader("X-Cairn-App-Processing"))
                if (request.method == "GET") {
                    reads.incrementAndGet()
                    return ProcessingFixture.response(if (committed.get() == null) ProcessingFixture.status() else ProcessingFixture.status(4, "b".repeat(64), missing = false))
                }
                val body = request.body.readUtf8(); bodies += body
                val journal = runBlocking { ProcessingStore(context).load(accountKeyFor(server.url("/").toString(), token), 4) }
                assertNotNull("Actual journal is durable before HTTP", journal)
                assertEquals(body, journal!!.intent.encode().toString())
                if (committed.compareAndSet(null, body)) return MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST)
                assertEquals(committed.get(), body)
                return ProcessingFixture.response(ProcessingFixture.receipt(JSONObject(body), replayed = true))
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use { activity ->
            openDetailAndLoadTaxonomy()
            assertEquals(0, reads.get()); assertTrue(bodies.isEmpty())
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("processing_toggle"))
            compose.onNodeWithTag("processing_toggle").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_primary_text").assertExists(); true }.getOrDefault(false) }
            compose.onNodeWithTag("processing_primary_text").performScrollTo().performTextInput("Keep exact primary 🙂")
            hideProcessingKeyboard(activity)
            compose.onNodeWithTag("processing_action_save_primary").performScrollTo().performClick()
            compose.onNodeWithTag("processing_confirm").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_pending").assertTextContains("上次请求结果未确认", substring = true); true }.getOrDefault(false) }
            assertEquals(1, bodies.size)
            activity.recreate()
            openProcessingAfterRecreation()
            compose.onNodeWithTag("processing_saved_text").assertTextContains("Keep exact primary 🙂", substring = true)
            assertEquals(1, bodies.size)
            compose.onNodeWithTag("processing_recover").performScrollTo().performClick()
            compose.onNodeWithTag("processing_confirm").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_message").assertTextContains("已确认上次请求", substring = true); true }.getOrDefault(false) }
            assertEquals(2, bodies.size); assertEquals(bodies[0], bodies[1])
            assertNull(runBlocking { ProcessingStore(context).load(accountKeyFor(server.url("/").toString(), token), 4) })
        }
    }

    @Test fun processingRefusedPrimaryEditsSurviveRefreshAndRecreationUntilExplicitlyAdoptingNewState() {
        val bodies = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
        val current = AtomicReference(ProcessingFixture.status())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl!!.encodedPath != "/api/bookmarks/4/processing") return processingFallback(request)
                if (request.method == "GET") return ProcessingFixture.response(current.get())
                val body = JSONObject(request.body.readUtf8()); bodies += body
                if (bodies.size == 1) {
                    current.set(ProcessingFixture.status(4, "b".repeat(64)))
                    return ProcessingFixture.response(JSONObject().put("error", "state_conflict"), 409)
                }
                assertEquals("edited primary must survive", body.getString("text"))
                assertEquals(5, body.getLong("expected_content_revision"))
                assertNotEquals(bodies[0].getString("operation_key"), body.getString("operation_key"))
                current.set(ProcessingFixture.status(6, "d".repeat(64), missing = false))
                return ProcessingFixture.response(ProcessingFixture.receipt(body))
            }
        }
        ActivityScenario.launch<LauncherActivity>(start()).use { activity ->
            openDetailAndLoadTaxonomy()
            compose.onNodeWithTag("detail_content").performScrollToNode(hasTestTag("processing_toggle"))
            compose.onNodeWithTag("processing_toggle").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_primary_text").assertExists(); true }.getOrDefault(false) }
            compose.onNodeWithTag("processing_primary_text").performScrollTo().performTextInput("original primary")
            hideProcessingKeyboard(activity)
            compose.onNodeWithTag("processing_action_save_primary").performScrollTo().performClick()
            compose.onNodeWithTag("processing_confirm").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_reprepare").assertExists(); true }.getOrDefault(false) }
            compose.onNodeWithTag("processing_refresh").performScrollTo().performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_reprepare").assertIsEnabled(); true }.getOrDefault(false) }
            compose.onNodeWithTag("processing_reprepare").performScrollTo().performClick()
            compose.onNodeWithTag("processing_primary_text").performScrollTo().performTextReplacement("edited primary must survive")
            hideProcessingKeyboard(activity)
            current.set(ProcessingFixture.status(5, "c".repeat(64)))
            compose.onNodeWithTag("processing_refresh").performScrollTo().performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_changed").assertExists(); true }.getOrDefault(false) }
            compose.onNodeWithTag("processing_primary_text").assertTextContains("edited primary must survive", substring = true)
            compose.onNodeWithTag("processing_action_save_primary").assertIsNotEnabled()
            activity.recreate()
            openProcessingAfterRecreation()
            compose.onNodeWithTag("processing_primary_text").assertTextContains("edited primary must survive", substring = true)
            compose.onNodeWithTag("processing_action_save_primary").assertIsNotEnabled()
            assertEquals(1, bodies.size)
            compose.onNodeWithTag("processing_adopt").performScrollTo().performClick()
            compose.onNodeWithTag("processing_action_save_primary").performScrollTo().performClick()
            compose.onNodeWithTag("processing_confirm").performClick()
            compose.waitUntil(15000) { runCatching { compose.onNodeWithTag("processing_message").assertTextContains("请求已保存", substring = true); true }.getOrDefault(false) }
            assertEquals(2, bodies.size)
        }
    }
}
