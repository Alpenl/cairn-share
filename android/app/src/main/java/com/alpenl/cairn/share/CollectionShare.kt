package com.alpenl.cairn.share

import android.content.Context
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** Link creation and membership each retain independent idempotent identities across process death. */
internal suspend fun attachPendingCollections(context:Context,base:String,token:String,pending:PendingUpload,linkId:Int):Boolean {
    if(pending.collectionIds.isEmpty())return true
    val account=accountKeyFor(base,token)
    if(account!=pending.collectionAccount)return false
    val store=CollectionStore(context)
    val known=store.snapshot(account).collections.map { it.id }.toSet()
    if(pending.collectionIds.any { it !in known })CollectionSync.run(context,base,token)
    for(id in pending.collectionIds){
        val key=UUID.nameUUIDFromBytes("collection-share/${pending.id}/$id".toByteArray(Charsets.UTF_8)).toString()
        store.enqueue(account,id,"add",JSONObject().put("link_ids",JSONArray(listOf(linkId))),key)
    }
    CollectionSync.schedule(context,base,token)
    return true
}
