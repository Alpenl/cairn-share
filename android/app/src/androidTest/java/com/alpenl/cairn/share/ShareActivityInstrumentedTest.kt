package com.alpenl.cairn.share

import android.content.ClipData
import android.content.Intent
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ShareActivityInstrumentedTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private var server: MockWebServer? = null

    @Before
    fun setUp() = runBlocking {
        SharePreferencesStore(targetContext()).setApiToken(TEST_TOKEN)
        SharePreferencesStore(targetContext()).setCloseAfterSave(false)
        SharePreferencesStore(targetContext()).setLastRoute("library")
        SharePreferencesStore(targetContext()).setLastFilter("all")
        SharePreferencesStore(targetContext()).setLastSearchQuery("")
        PendingUploadStore(targetContext()).clear()
    }

    @After
    fun tearDown() {
        server?.shutdown()
    }

    @Test
    fun singleLinkIsNotSubmittedUntilUserAddsNoteAndSaves() {
        val api = startServer()
        server!!.enqueue(savedResponse())
        val sharedUrl = "https://example.com/a?x=1#fragment"

        ActivityScenario.launch<ShareActivity>(shareIntent(sharedUrl, api)).use {
            compose.onNodeWithTag("selected_label").assertTextContains("example.com/a")
            assertEquals(0, server!!.requestCount)

            compose.onNodeWithTag("note").performTextInput("later")
            waitForSaveEnabled()
            compose.onNodeWithTag("save").performClick()

            val request = takeRequest()
            assertEquals("/api/links", request.path)
            val body = JSONObject(request.body.readUtf8())
            assertEquals(sharedUrl, body.getString("url"))
            assertEquals("later", body.getString("note"))
        }
    }

    @Test
    fun multipleLinksRequireSelectionAndSubmitOnlyTheChosenCompleteUrl() {
        val api = startServer()
        server!!.enqueue(savedResponse())

        ActivityScenario.launch<ShareActivity>(
            shareIntent("https://example.com/a?v=1 https://example.com/a?v=2", api),
        ).use {
            compose.onNodeWithTag("candidate_1").performClick()
            compose.onNodeWithTag("selected_label").assertTextContains("example.com/a")

            compose.onNodeWithTag("note").performTextInput("second")
            waitForSaveEnabled()
            compose.onNodeWithTag("save").performClick()

            val body = JSONObject(takeRequest().body.readUtf8())
            assertEquals("https://example.com/a?v=2", body.getString("url"))
            assertEquals("second", body.getString("note"))
        }
    }

    @Test
    fun recreationPreservesSelectionAndNoteWithoutSubmitting() {
        val api = startServer()
        server!!.enqueue(savedResponse())
        val scenario = ActivityScenario.launch<ShareActivity>(
            shareIntent("https://example.com/a?x=1#fragment", api),
        )

        scenario.use {
            compose.onNodeWithTag("note").performTextInput("draft")
            scenario.recreate()
            compose.onNodeWithTag("note").assertTextContains("draft")
            assertEquals(0, server!!.requestCount)

            waitForSaveEnabled()
            compose.onNodeWithTag("save").performClick()
            val body = JSONObject(takeRequest().body.readUtf8())
            assertEquals("https://example.com/a?x=1#fragment", body.getString("url"))
            assertEquals("draft", body.getString("note"))
        }
    }

    @Test
    fun failedPostIsKeptLocallyWithoutASecondSubmission() {
        val api = startServer()
        server!!.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"server"}"""))

        ActivityScenario.launch<ShareActivity>(shareIntent("https://example.com/retry", api)).use {
            compose.onNodeWithTag("note").performTextInput("retry note")
            waitForSaveEnabled()
            compose.onNodeWithTag("save").performClick()
            takeRequest()

            compose.waitUntil(5_000) {
                runCatching {
                    compose.onNodeWithTag("status").assertTextContains("已保存到本地待上传队列", substring = true)
                    true
                }.getOrDefault(false)
            }
            compose.onNodeWithTag("save").assertIsNotEnabled()
            val queued = runBlocking { PendingUploadStore(targetContext()).uploads.first() }
            assertEquals(1, queued.size)
            assertEquals("https://example.com/retry", queued.single().url)
            assertEquals("retry note", queued.single().note)
            assertEquals(1, server!!.requestCount)
        }
    }

    @Test
    fun unsupportedShareShowsNoSaveableLink() {
        val api = startServer()
        val intent = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .setClass(targetContext(), ShareActivity::class.java)
            .putExtra(Intent.EXTRA_TEXT, "plain text only")
            .putExtra(ShareActivity.EXTRA_API_BASE_URL, api)

        ActivityScenario.launch<ShareActivity>(intent).use {
            compose.onNodeWithTag("status").assertTextContains("没有发现 HTTP 或 HTTPS", substring = true)
            assertEquals(0, server!!.requestCount)
        }
    }

    @Test
    fun launcherEntryShowsLibraryAndCanEditToggleAndDeleteLinks() {
        val api = startLibraryServer()
        val intent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(targetContext(), LauncherActivity::class.java)
            .putExtra(ShareActivity.EXTRA_API_BASE_URL, api)
            .putExtra(ShareActivity.EXTRA_RELEASES_API_URL, server!!.url("/latest").toString())

        ActivityScenario.launch<LauncherActivity>(intent).use {
            compose.waitUntil(5_000) {
                runCatching {
                    compose.onAllNodesWithTag("link_2").assertCountEquals(1)
                    true
                }.getOrDefault(false)
            }
            compose.onAllNodesWithTag("note").assertCountEquals(0)
            compose.onAllNodesWithTag("save").assertCountEquals(0)

            compose.onNodeWithTag("nav_settings").performClick()
            compose.onNodeWithText("检查更新").performClick()
            compose.waitUntil(5_000) {
                runCatching {
                    compose.onNodeWithTag("update_title").assertTextContains("发现新版本 9.9.9", substring = true)
                    true
                }.getOrDefault(false)
            }
            compose.onNodeWithTag("download_update").assertIsEnabled()
            compose.onNodeWithText("- 新增离线上传队列").assertExists()

            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithTag("nav_library").performClick()
            compose.onNodeWithTag("filter_unlearned").performClick()
            compose.waitUntil(5_000) {
                runCatching {
                    compose.onAllNodesWithTag("link_1").assertCountEquals(1)
                    true
                }.getOrDefault(false)
            }

            compose.onNodeWithTag("link_1").performClick()
            compose.onNodeWithTag("toggle_1").performClick()
            val toggleRequest = takeRequest("PATCH", "/api/links/1")
            assertEquals(true, JSONObject(toggleRequest.body.readUtf8()).getBoolean("learned"))

            compose.onNodeWithContentDescription("编辑").performClick()
            compose.onNodeWithTag("edit_note").performTextInput(" / 更新")
            compose.onNodeWithTag("save_edit").performClick()
            val editRequest = takeRequest("PATCH", "/api/links/1")
            val editBody = JSONObject(editRequest.body.readUtf8())
            assertEquals("https://example.com/unlearned", editBody.getString("url"))
            assertTrue(editBody.getString("note").contains("更新"))

            compose.waitUntil(5_000) {
                runCatching {
                    compose.onNodeWithContentDescription("编辑").assertIsEnabled()
                    true
                }.getOrDefault(false)
            }
            compose.onNodeWithContentDescription("编辑").performClick()
            compose.onNodeWithTag("delete_editing").performClick()
            compose.onNodeWithTag("confirm_delete").performClick()
            takeRequest("DELETE", "/api/links/1")
            compose.waitUntil(5_000) {
                runCatching {
                    compose.onAllNodesWithTag("link_1").assertCountEquals(0)
                    true
                }.getOrDefault(false)
            }
        }
    }

    @Test
    fun launcherAutomaticallyRetriesLocalQueueAndAllowsManualRetry() {
        val queued = runBlocking {
            PendingUploadStore(targetContext()).enqueue(
                url = "https://example.com/offline",
                note = "queued note",
            )
        }
        val api = startLibraryServer(uploadResponseCode = 500)
        val intent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(targetContext(), LauncherActivity::class.java)
            .putExtra(ShareActivity.EXTRA_API_BASE_URL, api)
            .putExtra(ShareActivity.EXTRA_RELEASES_API_URL, server!!.url("/latest").toString())

        ActivityScenario.launch<LauncherActivity>(intent).use {
            val automatic = takeRequest("POST", "/api/links")
            assertEquals(queued.id, JSONObject(automatic.body.readUtf8()).getString("client_id"))
            compose.waitUntil(5_000) {
                runBlocking {
                    PendingUploadStore(targetContext()).uploads.first().singleOrNull()?.attemptCount == 1
                }
            }

            compose.onNodeWithTag("nav_settings").performClick()
            compose.onNodeWithText("待上传队列").performClick()
            compose.waitUntil(5_000) {
                runCatching {
                    compose.onNodeWithTag("retry_upload_${queued.id}").assertIsEnabled()
                    true
                }.getOrDefault(false)
            }
            compose.onNodeWithTag("retry_upload_${queued.id}").performClick()

            val manual = takeRequest("POST", "/api/links")
            assertEquals(queued.id, JSONObject(manual.body.readUtf8()).getString("client_id"))
        }
    }

    private fun startServer(): String {
        val mockWebServer = MockWebServer()
        mockWebServer.start()
        server = mockWebServer
        return mockWebServer.url("/").toString()
    }

    private fun startLibraryServer(uploadResponseCode: Int = 201): String {
        val mockWebServer = MockWebServer()
        mockWebServer.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    path == "/latest" -> latestReleaseResponse()
                    path.startsWith("/api/links") && request.getHeader("Authorization") != "Bearer $TEST_TOKEN" ->
                        MockResponse().setResponseCode(401).setBody("""{"error":"invalid_token"}""")
                    request.method == "POST" && path == "/api/links" ->
                        if (uploadResponseCode == 201) queuedUploadResponse() else MockResponse().setResponseCode(uploadResponseCode)
                    request.method == "GET" && path.startsWith("/api/links") -> linksResponse(path)
                    request.method == "PATCH" && path == "/api/links/1" -> updatedLinkResponse()
                    request.method == "DELETE" && path == "/api/links/1" -> MockResponse().setResponseCode(204)
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":"not_found"}""")
                }
            }
        }
        mockWebServer.start()
        server = mockWebServer
        return mockWebServer.url("/").toString()
    }

    private fun shareIntent(text: String, apiBaseUrl: String): Intent =
        Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .setClass(targetContext(), ShareActivity::class.java)
            .putExtra(Intent.EXTRA_TEXT, text)
            .putExtra(ShareActivity.EXTRA_API_BASE_URL, apiBaseUrl)
            .also {
                it.clipData = ClipData.newPlainText("shared text", text)
            }

    private fun savedResponse(): MockResponse =
        MockResponse()
            .setResponseCode(201)
            .setBody("""{"id":1,"url":"https://example.com","note":"","created_at":"2026-08-26T00:00:00.000Z"}""")

    private fun latestReleaseResponse(): MockResponse =
        MockResponse()
            .setResponseCode(200)
            .setBody(
                """
                    {
                      "tag_name": "v9.9.9",
                      "html_url": "https://github.com/Alpenl/cairn-share/releases/tag/v9.9.9",
                      "body": "- 新增离线上传队列",
                      "assets": [
                        {
                          "name": "cairn-share-android-9.9.9.apk",
                          "browser_download_url": "https://github.com/Alpenl/cairn-share/releases/download/v9.9.9/cairn-share-android-9.9.9.apk"
                        }
                      ]
                    }
                """.trimIndent(),
            )

    private fun queuedUploadResponse(): MockResponse =
        MockResponse()
            .setResponseCode(201)
            .setBody(
                """
                    {
                      "id": 3,
                      "url": "https://example.com/offline",
                      "note": "queued note",
                      "created_at": "2026-08-30T00:00:00.000Z",
                      "learned": false,
                      "learned_at": null
                    }
                """.trimIndent(),
            )

    private fun linksResponse(path: String): MockResponse {
        val body = if (path.contains("learned=all")) {
            """
                {
                  "items": [
                    {
                      "id": 2,
                      "url": "https://example.com/learned",
                      "note": "已学资料",
                      "created_at": "2026-08-27T01:00:00.000Z",
                      "learned": true,
                      "learned_at": "2026-08-27T02:00:00.000Z"
                    },
                    {
                      "id": 1,
                      "url": "https://example.com/unlearned",
                      "note": "稍后学习",
                      "created_at": "2026-08-27T00:00:00.000Z",
                      "learned": false,
                      "learned_at": null
                    }
                  ],
                  "next_before_id": null
                }
            """.trimIndent()
        } else {
            """
                {
                  "items": [
                    {
                      "id": 1,
                      "url": "https://example.com/unlearned",
                      "note": "稍后学习",
                      "created_at": "2026-08-27T00:00:00.000Z",
                      "learned": false,
                      "learned_at": null
                    }
                  ],
                  "next_before_id": null
                }
            """.trimIndent()
        }
        return MockResponse().setResponseCode(200).setBody(body)
    }

    private fun updatedLinkResponse(): MockResponse =
        MockResponse()
            .setResponseCode(200)
            .setBody(
                """
                    {
                      "id": 1,
                      "url": "https://example.com/unlearned",
                      "note": "稍后学习 / 更新",
                      "created_at": "2026-08-27T00:00:00.000Z",
                      "learned": false,
                      "learned_at": null
                    }
                """.trimIndent(),
            )

    private fun takeRequest(): okhttp3.mockwebserver.RecordedRequest {
        val request = server!!.takeRequest(5, TimeUnit.SECONDS)
        assertNotNull(request)
        assertTrue(server!!.requestCount >= 1)
        assertAuthorizedApiRequest(request!!)
        return request!!
    }

    private fun takeRequest(method: String, path: String): RecordedRequest {
        repeat(20) {
            val request = takeRequest()
            if (request.method == method && request.path == path) {
                assertTrue(request.getHeader("User-Agent")!!.startsWith("CairnShareAndroid/"))
                return request
            }
        }
        error("No $method $path request was sent")
    }

    private fun waitForSaveEnabled() {
        compose.waitUntil(5_000) {
            runCatching {
                compose.onNodeWithTag("save").assertIsEnabled()
                true
            }.getOrDefault(false)
        }
    }

    private fun assertAuthorizedApiRequest(request: RecordedRequest) {
        if (request.path.orEmpty().startsWith("/api/links")) {
            assertEquals("Bearer $TEST_TOKEN", request.getHeader("Authorization"))
        }
    }

    private fun targetContext() = InstrumentationRegistry.getInstrumentation().targetContext

    private companion object {
        const val TEST_TOKEN = "instrumented-test-token"
    }
}
