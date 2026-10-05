package com.alpenl.cairn.share

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
