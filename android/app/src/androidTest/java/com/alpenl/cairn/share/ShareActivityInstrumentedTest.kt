package com.alpenl.cairn.share

import android.content.ClipData
import android.content.Intent
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ShareActivityInstrumentedTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private var server: MockWebServer? = null

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
            compose.onNodeWithTag("save").assertIsEnabled().performClick()

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
            compose.onAllNodesWithTag("note").assertCountEquals(0)
            compose.onNodeWithTag("candidate_1").performClick()
            compose.onNodeWithTag("selected_label").assertTextContains("example.com/a")

            compose.onNodeWithTag("note").performTextInput("second")
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

            compose.onNodeWithTag("save").performClick()
            val body = JSONObject(takeRequest().body.readUtf8())
            assertEquals("https://example.com/a?x=1#fragment", body.getString("url"))
            assertEquals("draft", body.getString("note"))
        }
    }

    @Test
    fun failedPostLeavesScreenOpenAndAllowsRetry() {
        val api = startServer()
        server!!.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"server"}"""))
        server!!.enqueue(savedResponse())

        ActivityScenario.launch<ShareActivity>(shareIntent("https://example.com/retry", api)).use {
            compose.onNodeWithTag("note").performTextInput("retry note")
            compose.onNodeWithTag("save").performClick()
            takeRequest()

            compose.waitUntil(5_000) {
                runCatching {
                    compose.onNodeWithTag("status").assertTextContains("保存失败", substring = true)
                    true
                }.getOrDefault(false)
            }
            compose.onNodeWithTag("save").assertIsEnabled().performClick()

            val body = JSONObject(takeRequest().body.readUtf8())
            assertEquals("https://example.com/retry", body.getString("url"))
            assertEquals("retry note", body.getString("note"))
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
    fun launcherEntryShowsInstalledGuidanceWithoutSubmitting() {
        val intent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(targetContext(), ShareActivity::class.java)

        ActivityScenario.launch<ShareActivity>(intent).use {
            compose.onNodeWithTag("status").assertTextContains("链接收集已安装", substring = true)
            compose.onNodeWithTag("status").assertTextContains("公开、无鉴权接口", substring = true)
            compose.onAllNodesWithTag("note").assertCountEquals(0)
            compose.onAllNodesWithTag("save").assertCountEquals(0)
        }
    }

    private fun startServer(): String {
        val mockWebServer = MockWebServer()
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

    private fun takeRequest(): okhttp3.mockwebserver.RecordedRequest {
        val request = server!!.takeRequest(5, TimeUnit.SECONDS)
        assertNotNull(request)
        assertTrue(server!!.requestCount >= 1)
        return request!!
    }

    private fun targetContext() = InstrumentationRegistry.getInstrumentation().targetContext
}
