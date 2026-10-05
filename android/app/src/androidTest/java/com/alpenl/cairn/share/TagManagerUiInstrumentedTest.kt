package com.alpenl.cairn.share

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class TagManagerUiInstrumentedTest {
 @get:Rule val compose=createEmptyComposeRule()
 @Test fun rejectedEditStaysRejectedAcrossOfflineRefreshAndReconnect()=runBlocking<Unit>{
  val app=InstrumentationRegistry.getInstrumentation().targetContext;val server=MockWebServer();server.start()
  try{
   val token="tag-conflict-"+UUID.randomUUID();SharePreferencesStore(app).setApiToken(token)
   val base=server.url("/").toString();val account=accountKeyFor(base,token);val store=CollectionStore(app)
   val payload=JSONObject().put("revision",3).put("catalog",JSONObject().put("topics",JSONArray()))
   store.cacheTags(account,payload);store.enqueueTagManagement(account,JSONObject().put("operation_key",UUID.randomUUID().toString()).put("expected_revision",2).put("type","edit"));store.tagManagementError(account,"rejected:revision_conflict")
   server.enqueue(MockResponse().setResponseCode(503).setBody("{\"error\":\"unavailable\"}"))
   assertFalse(TagManagementSync.run(app,base,token));assertEquals("rejected:revision_conflict",store.tagManagement(account).error)
   server.enqueue(response(payload));assertTrue(TagManagementSync.run(app,base,token));assertNotNull(store.tagManagement(account).pending)
   assertEquals(2,server.requestCount);repeat(2){assertEquals("GET",server.takeRequest().method)}
  }finally{server.shutdown()}
 }
 @Test fun createAITagThroughActualSettingsAndRetainUncertainOperation() {
  val app=InstrumentationRegistry.getInstrumentation().targetContext;val server=MockWebServer();val token="tag-ui-"+UUID.randomUUID();val catalog=JSONObject().put("version","fixture").put("topics",JSONArray()).put("resource_kinds",JSONArray()).put("content_functions",JSONArray()).put("carriers",JSONArray()).put("affordances",JSONArray()).put("forms",JSONArray()).put("uses",JSONArray())
  val payload=JSONObject().put("revision",0).put("catalog",catalog).put("counts",JSONArray()).put("custom_tags",JSONArray());val keys=mutableListOf<String>();var first=true
  server.dispatcher=object:Dispatcher(){override fun dispatch(r:RecordedRequest):MockResponse=synchronized(payload){
   val path=r.path.orEmpty();if(path=="/api/tag-catalog/operations"){
    val body=JSONObject(r.body.readUtf8());keys.add(body.getString("operation_key"));if(first){first=false;val definition=body.getJSONObject("definition");definition.put("id","tag_0123456789abcdef0123456789abcdef").put("active",true);catalog.getJSONArray("topics").put(definition);payload.put("revision",1);return@synchronized MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)}
    return@synchronized response(payload)
   }
   if(path=="/api/tag-catalog")return@synchronized response(payload)
   if(path.startsWith("/api/collections/sync"))return@synchronized MockResponse().setHeader("X-Cairn-Collections","1").setBody("{\"protocol_version\":1,\"epoch\":\"fixture\",\"cursor\":0,\"has_more\":false,\"changes\":[]}")
   if(path.startsWith("/api/collections"))return@synchronized MockResponse().setHeader("X-Cairn-Collections","1").setBody("{\"items\":[]}")
   MockResponse().setResponseCode(404).setBody("{\"error\":\"not_found\"}")
  }}
  server.start();runBlocking{SharePreferencesStore(app).apply{setApiToken(token);setAutomaticSync(false);setLastRoute("library");setLastSearchQuery("")}}
  try{
   ActivityScenario.launch<LauncherActivity>(Intent(app,LauncherActivity::class.java).putExtra(ShareActivity.EXTRA_API_BASE_URL,server.url("/").toString())).use{
    compose.waitUntil(20000){compose.onAllNodesWithText("设置",useUnmergedTree=true).fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("设置",useUnmergedTree=true).performClick();compose.onNodeWithTag("settings_tag_manager").performScrollTo();compose.waitForIdle();compose.onNodeWithTag("settings_tag_manager").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick){it()}
    try{compose.waitUntil(20000){compose.onAllNodesWithTag("tag_manager_search").fetchSemanticsNodes().isNotEmpty()}}catch(e:Throwable){throw AssertionError(compose.onRoot(useUnmergedTree=true).printToString(),e)};compose.onNodeWithText("新建").performClick();compose.onNodeWithTag("tag_manager_ai").assertIsOn();compose.onNodeWithTag("tag_manager_name").performTextInput("LoRA");compose.onNodeWithTag("tag_manager_definition").performTextInput("LoRA 适配器训练与使用");compose.onNodeWithText("保存",useUnmergedTree=true).performClick()
    compose.waitUntil(30000){compose.onAllNodesWithText("LoRA",substring=true,useUnmergedTree=true).fetchSemanticsNodes().isNotEmpty()}
    compose.waitUntil(30000){compose.onAllNodesWithText("重试同步",useUnmergedTree=true).fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("重试同步",useUnmergedTree=true).performClick()
    val account=accountKeyFor(server.url("/").toString(),token);compose.waitUntil(30000){runBlocking{CollectionStore(app).tagManagement(account).pending==null}}
    synchronized(payload){assertEquals(1,catalog.getJSONArray("topics").length());assertTrue(catalog.getJSONArray("topics").getJSONObject(0).getBoolean("ai_enabled"));assertEquals(1,keys.distinct().size);assertTrue(keys.size>=2)}
   }
  }finally{server.shutdown()}
 }
 private fun response(body:JSONObject)=MockResponse().setHeader("X-Cairn-Tag-System","1").setHeader("Content-Type","application/json").setBody(body.toString())
}
