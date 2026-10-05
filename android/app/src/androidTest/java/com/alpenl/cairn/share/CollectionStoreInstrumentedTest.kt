package com.alpenl.cairn.share

import android.content.Context
import android.content.ContextWrapper
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import java.io.File
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CollectionStoreInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun account() = accountKeyFor("https://collections.invalid", UUID.randomUUID().toString())
    private fun page(cursor: Int, vararg changes: JSONObject) = JSONObject().put("protocol_version",1)
        .put("epoch","fixture").put("cursor",cursor).put("has_more",false).put("changes",JSONArray(changes.toList()))
    private fun definition(seq: Int, record: CollectionRecord) = JSONObject().put("seq",seq)
        .put("collection_id",record.id).put("link_id",JSONObject.NULL).put("value",record.json())

    @Test fun offlineEditsSurviveStoreRecreationAndKeepAccountsAndArticleNotesSeparate() = runBlocking<Unit> {
        val a=account(); val other=account(); val id=UUID.randomUUID().toString(); val store=CollectionStore(context)
        store.enqueue(a,id,"create",JSONObject().put("name","网站改版"))
        store.enqueue(a,id,"add",JSONObject().put("link_ids",JSONArray(listOf(3,1,2))))
        store.enqueue(a,id,"note",JSONObject().put("link_id",1).put("note","导航参考"))
        store.enqueue(a,id,"move",JSONObject().put("link_id",2).put("before_id",3))
        val recreated=CollectionStore(context)
        val state=recreated.snapshot(a)
        assertEquals(listOf(2,3,1),state.members.sortedBy{it.position}.map{it.link})
        assertEquals("导航参考",state.members.single{it.link==1}.note)
        assertEquals(listOf(0L,1L,2L,3L),state.pending.map{JSONObject(it.body).getLong("expected_revision")})
        assertTrue(recreated.snapshot(other).collections.isEmpty())
        assertTrue(recreated.remote(a).collections.isEmpty())
        recreated.message(a,"离线") // Also exercises Android 8 SQLite compatibility.
        assertEquals("离线",recreated.snapshot(a).message)
        recreated.enqueue(a,id,"delete")
        assertTrue(recreated.snapshot(a).collections.single().deleted)
        try { recreated.enqueue(a,id,"edit",JSONObject().put("name","old")); fail("deleted collection accepted an edit") }
        catch (_: java.io.IOException) { }
        recreated.enqueue(a,id,"restore")
        assertEquals(3,recreated.snapshot(a).members.size)
    }

    @Test fun versionOneUpgradeRetainsCollectionsQueueAndIsolatesDurableOrganizingDrafts() = runBlocking<Unit> {
        val name="collection-upgrade-${UUID.randomUUID()}.db"
        val isolated=object:ContextWrapper(context) {
            override fun getApplicationContext():Context=this
            override fun getDatabasePath(n:String):File=super.getDatabasePath(name)
            override fun openOrCreateDatabase(n:String,mode:Int,factory:SQLiteDatabase.CursorFactory?):SQLiteDatabase=super.openOrCreateDatabase(name,mode,factory)
            override fun openOrCreateDatabase(n:String,mode:Int,factory:SQLiteDatabase.CursorFactory?,handler:DatabaseErrorHandler?):SQLiteDatabase=super.openOrCreateDatabase(name,mode,factory,handler)
        }
        val a=account();val other=account();val id=UUID.randomUUID().toString()
        val definition=CollectionRecord(id,"已有合集",revision=1)
        val pending=JSONObject().put("operation_key",UUID.randomUUID().toString()).put("type","edit").put("name","旧版未提交草稿").put("expected_revision",1)
        SQLiteDatabase.openOrCreateDatabase(isolated.getDatabasePath("collections.db"),null).use {db->
            db.execSQL("CREATE TABLE collection_defs(account TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,id))")
            db.execSQL("CREATE TABLE collection_members(account TEXT NOT NULL,collection_id TEXT NOT NULL,link_id INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,collection_id,link_id))")
            db.execSQL("CREATE TABLE collection_pending(seq INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,id TEXT NOT NULL,collection_id TEXT NOT NULL,body TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',UNIQUE(account,id))")
            db.execSQL("CREATE TABLE collection_done(account TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(account,id))")
            db.execSQL("CREATE TABLE collection_sync(account TEXT PRIMARY KEY,cursor INTEGER NOT NULL,epoch TEXT NOT NULL,message TEXT NOT NULL)")
            db.execSQL("INSERT INTO collection_defs VALUES(?,?,?)",arrayOf(a,id,definition.json().toString()))
            db.execSQL("INSERT INTO collection_pending(account,id,collection_id,body) VALUES(?,?,?,?)",arrayOf(a,pending.getString("operation_key"),id,pending.toString()))
            db.execSQL("INSERT INTO collection_sync VALUES(?,7,'old-epoch','')",arrayOf(a))
            db.version=1
        }
        val store=CollectionStore(isolated)
        val before=store.remote(a);assertEquals(7L,before.cursor);assertEquals("已有合集",before.collections.single().name);assertEquals(pending.toString(),before.pending.single().body)
        store.saveOrganizingDraft(a,"start",pending.toString())
        val recreated=CollectionStore(isolated)
        assertEquals(pending.toString(),recreated.organizingDraft(a,"start"));assertNull(recreated.organizingDraft(other,"start"))
        assertEquals("旧版未提交草稿",recreated.snapshot(a).collections.single().name)
        recreated.saveOrganizingDraft(a,"start",null);assertNull(recreated.organizingDraft(a,"start"))
    }

    @Test fun managedTagIntentAndRuleMetadataSurviveOfflineAndRequireExplicitConflictResolution()=runBlocking<Unit>{
        val a=account();val other=account();val store=CollectionStore(context);val operation=UUID.randomUUID().toString()
        val catalog=JSONObject().put("revision",2).put("catalog",JSONObject().put("version","managed-fixture").put("topics",JSONArray()))
        store.cacheTags(a,catalog)
        val body=JSONObject().put("operation_key",operation).put("expected_revision",2).put("type","create").put("dimension","topics").put("definition",JSONObject().put("label","LoRA").put("description","适配器").put("ai_enabled",true))
        store.enqueueTagManagement(a,body)
        val recreated=CollectionStore(context);assertEquals(body.toString(),recreated.tagManagement(a).pending.toString());assertNull(recreated.tagManagement(other).payload)
        try{recreated.resolveTags(a,true);fail("unknown response was rebased")}catch(_:java.io.IOException){}
        recreated.cacheTags(a,catalog.put("revision",3));recreated.tagManagementError(a,"rejected:revision_conflict");recreated.resolveTags(a,true)
        val next=recreated.tagManagement(a).pending!!;assertNotEquals(operation,next.getString("operation_key"));assertEquals(3L,next.getLong("expected_revision"))
        recreated.acknowledgeTags(a,operation,catalog);assertNotNull(recreated.tagManagement(a).pending)
        recreated.acknowledgeTags(a,next.getString("operation_key"),catalog.put("revision",4));assertNull(recreated.tagManagement(a).pending)
        val record=CollectionRecord(UUID.randomUUID().toString(),"AIGC",revision=1,ruleEnabled=true,ruleMode="all",ruleTags=listOf("system/topics/lora"),ruleAfterId=59,ruleRevision=2)
        assertEquals(record,CollectionRecord.decode(record.json()))
        val member=CollectionMember(record.id,60,0,origin="rule",matchedTags=record.ruleTags);assertEquals(member,CollectionMember.decode(member.json()))
        assertTrue(recreated.applyPage(a,recreated.remote(a),page(1,definition(1,record))))
        recreated.enqueue(a,record.id,"rule",JSONObject().put("enabled",false).put("mode","any").put("tag_refs",JSONArray(record.ruleTags)))
        assertFalse(CollectionStore(context).snapshot(a).collections.single().ruleEnabled)
        assertTrue(CollectionStore(context).remote(a).collections.single().ruleEnabled)
    }

    @Test fun syncPageAndCursorCommitAtomicallyWhilePendingDraftsRemainIndependent() = runBlocking<Unit> {
        val a=account(); val id=UUID.randomUUID().toString(); val store=CollectionStore(context)
        val original=CollectionRecord(id,"原名称",revision=1)
        val before=store.remote(a)
        val invalid=definition(2,original.copy(id=UUID.randomUUID().toString())).put("collection_id",id)
        try { store.applyPage(a,before,page(2,definition(1,original),invalid)); fail("invalid identity accepted") }
        catch (_: IllegalArgumentException) { }
        assertEquals(0L,store.remote(a).cursor)
        assertTrue(store.remote(a).collections.isEmpty())
        assertTrue(store.applyPage(a,before,page(1,definition(1,original))))
        assertFalse(store.applyPage(a,before,page(1,definition(1,original))))
        store.enqueue(a,id,"edit",JSONObject().put("name","本机草稿"))
        assertTrue(store.applyPage(a,store.remote(a),page(2,definition(2,original.copy(name="网页修改",revision=2)))))
        assertEquals("本机草稿",store.snapshot(a).collections.single().name)
        assertEquals("网页修改",store.remote(a).collections.single().name)
        val pending=store.remote(a).pending.single()
        store.fail(a,pending.id,"版本冲突")
        store.resolve(a,store.remote(a).pending.single(),true)
        val rebased=store.remote(a).pending.single()
        assertNotEquals(pending.id,rebased.id)
        assertEquals(2L,JSONObject(rebased.body).getLong("expected_revision"))
        store.acknowledge(a,rebased,JSONObject().put("revision",3))
        assertEquals("本机草稿",store.remote(a).collections.single().name)
        assertTrue(store.snapshot(a).pending.isEmpty())
        store.enqueue(a,id,"edit",JSONObject().put("name","duplicate"),rebased.id)
        assertTrue(store.snapshot(a).pending.isEmpty())
        store.enqueue(a,id,"edit",JSONObject().put("description","保留"))
        store.reset(a)
        assertTrue(store.remote(a).pending.single().error.isNotBlank())
        assertTrue(store.remote(a).collections.isEmpty())
    }
}
