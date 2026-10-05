package com.alpenl.cairn.share

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.alpenl.cairn.share.network.CollectionsClient
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The shell harness force-stops the app between these phases. */
@RunWith(AndroidJUnit4::class)
class CollectionsWorkerIntegrationTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val base get() = InstrumentationRegistry.getArguments().getString("cairnWorkerUrl").orEmpty()
    private val token = "test-a-12345678"
    private val account get() = accountKeyFor(base,token)
    private fun call(path:String,method:String="GET",body:JSONObject?=null):JSONObject {
        val c=URL(base+path).openConnection() as HttpURLConnection
        try {
            c.requestMethod=method;c.connectTimeout=10000;c.readTimeout=10000
            c.setRequestProperty("Authorization","Bearer $token");c.setRequestProperty("X-Cairn-Collections","1")
            if(body!=null){c.doOutput=true;c.setRequestProperty("Content-Type","application/json");c.outputStream.use{it.write(body.toString().toByteArray())}}
            assertTrue("HTTP ${c.responseCode}",c.responseCode in 200..299)
            val text=c.inputStream.bufferedReader().use{it.readText()}
            return if(text.isBlank())JSONObject() else JSONObject(text)
        }finally{c.disconnect()}
    }
    private fun mode(mode:String){call("/__test/control","POST",JSONObject().put("mode",mode))}

    @Test fun persistOfflineCollectionAndLoseCommittedCreateResponse() = runBlocking<Unit> {
        assumeTrue(base.isNotBlank())
        SharePreferencesStore(context).apply{setApiToken(token);setAutomaticSync(false)}
        mode("online")
        val link=call("/api/links","POST",JSONObject().put("url","https://example.com/collection-recovery").put("note","original note")).getInt("id")
        val id=UUID.randomUUID().toString();val store=CollectionStore(context)
        store.enqueue(account,id,"create",JSONObject().put("name","离线项目"))
        store.enqueue(account,id,"add",JSONObject().put("link_ids",JSONArray(listOf(link))))
        val keys=store.remote(account).pending.map{it.id}
        context.getSharedPreferences("collections-harness",0).edit().putString("id",id).putInt("link",link).putString("keys",JSONArray(keys).toString()).commit()
        mode("lose_first")
        assertFalse(CollectionSync.run(context,base,token))
        assertEquals(keys,store.remote(account).pending.map{it.id})
        assertEquals(1,call("/__test/direct/api/collections/$id").getJSONObject("collection").getInt("revision"))
        assertEquals(listOf(link),store.snapshot(account).members.filter{it.collection==id}.map{it.link})
    }

    @Test fun recoverAfterProcessDeathAndExplicitlyResolveRemoteConflict() = runBlocking<Unit> {
        assumeTrue(base.isNotBlank())
        val saved=context.getSharedPreferences("collections-harness",0)
        val id=saved.getString("id",null)!!;val link=saved.getInt("link",0);val store=CollectionStore(context)
        val keys=JSONArray(saved.getString("keys","[]"))
        assertEquals(List(keys.length()){keys.getString(it)},store.remote(account).pending.map{it.id})
        mode("online");assertTrue(CollectionSync.run(context,base,token))
        assertTrue(store.remote(account).pending.isEmpty())
        assertEquals(2,call("/api/collections/$id").getJSONObject("collection").getInt("revision"))
        store.enqueue(account,id,"note",JSONObject().put("link_id",link).put("note","本机说明"))
        CollectionsClient(base).request(token,"/$id/operations",JSONObject().put("type","edit").put("expected_revision",2).put("operation_key",UUID.randomUUID()).put("name","网页改名").toString())
        assertTrue(CollectionSync.run(context,base,token))
        val conflict=store.remote(account).pending.single()
        assertTrue(conflict.error.isNotBlank())
        assertEquals("网页改名",store.remote(account).collections.single{it.id==id}.name)
        assertEquals("本机说明",store.snapshot(account).members.single{it.collection==id}.note)
        CollectionSync.exclusive(account){store.resolve(account,conflict,true)}
        assertTrue(CollectionSync.run(context,base,token))
        assertEquals("本机说明",call("/api/collections/$id").getJSONArray("items").getJSONObject(0).getString("note"))
        assertEquals("original note",call("/api/links/$link").getString("note"))
        assertTrue(store.snapshot(accountKeyFor(base,"other account")).collections.isEmpty())
        store.enqueue(account,id,"delete");assertTrue(CollectionSync.run(context,base,token))
        store.enqueue(account,id,"restore");assertTrue(CollectionSync.run(context,base,token))
        assertEquals(1,call("/api/collections/$id").getJSONArray("items").length())
        call("/api/links/$link","DELETE");assertTrue(CollectionSync.run(context,base,token))
        assertTrue(store.snapshot(account).members.none{it.collection==id})
    }
}
