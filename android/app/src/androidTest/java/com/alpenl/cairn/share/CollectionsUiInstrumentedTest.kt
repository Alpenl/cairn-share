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
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CollectionsUiInstrumentedTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun createOfflineFromCompactHeaderThenArchiveAndRestore() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val server=MockWebServer()
        server.dispatcher=object:Dispatcher(){
            override fun dispatch(request:RecordedRequest)=if(request.path?.startsWith("/api/collections")==true)
                MockResponse().setResponseCode(503) else MockResponse().setHeader("Content-Type","application/json")
                    .setBody("""{"items":[],"next_before_id":null,"topics":[],"resource_kinds":[],"content_functions":[]}""")
        }
        server.start()
        try {
            runBlocking { SharePreferencesStore(context).apply { setApiToken("collections-ui");setAutomaticSync(false);setLastRoute("library");setLastSearchQuery("") } }
            ActivityScenario.launch<LauncherActivity>(Intent(context,LauncherActivity::class.java)
                .putExtra(ShareActivity.EXTRA_API_BASE_URL,server.url("/").toString())).use {
                compose.waitUntil(20000){compose.onAllNodesWithText("合集",useUnmergedTree=true).fetchSemanticsNodes().isNotEmpty()}
                compose.onNodeWithText("合集").performClick()
                compose.onNodeWithText("新建",useUnmergedTree=true).performClick()
                compose.onNodeWithTag("collection_name").performTextInput("我的设计项目")
                compose.onNodeWithText("保存").performClick()
                compose.waitUntil(20000){compose.onAllNodesWithText("我的设计项目").fetchSemanticsNodes().isNotEmpty()}
                compose.onNodeWithText("我的设计项目").performClick()
                compose.onNodeWithText("归档",useUnmergedTree=true).performClick()
                compose.waitUntil(20000){compose.onAllNodesWithText("取消归档").fetchSemanticsNodes().isNotEmpty()}
                compose.onNodeWithText("删除合集",useUnmergedTree=true).performClick()
                compose.onAllNodesWithText("删除合集",useUnmergedTree=true).onLast().performClick()
                compose.waitUntil(20000){compose.onAllNodesWithText("已删除",useUnmergedTree=true).fetchSemanticsNodes().isNotEmpty()}
                compose.onNodeWithText("已删除",useUnmergedTree=true).performClick()
                compose.onNodeWithText("我的设计项目").performClick()
                compose.onNodeWithText("恢复合集",useUnmergedTree=true).performClick()
                compose.waitUntil(20000){compose.onAllNodesWithText("取消归档",useUnmergedTree=true).fetchSemanticsNodes().isNotEmpty()}
                compose.onNodeWithText("取消归档",useUnmergedTree=true).performClick()
            }
        } finally { server.shutdown() }
    }
}
