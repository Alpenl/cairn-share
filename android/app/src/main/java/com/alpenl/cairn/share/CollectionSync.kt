package com.alpenl.cairn.share

import android.content.Context
import androidx.work.*
import com.alpenl.cairn.share.network.*
import java.io.IOException
import java.net.URLEncoder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal object CollectionSync {
    private val locks=mutableMapOf<String,Mutex>()
    suspend fun <T> exclusive(account:String,block:suspend()->T):T=synchronized(locks){locks.getOrPut(account){Mutex()}}.withLock{block()}
    suspend fun run(context:Context,base:String,token:String):Boolean {
        val account=accountKeyFor(base,token);if(token.isBlank())return true
        return exclusive(account){
            val store=CollectionStore(context);val client=CollectionsClient(base)
            suspend fun active(){if(SharePreferencesStore(context).preferences.first().apiToken.trim()!=token.trim())throw CancellationException()}
            suspend fun pull(){
                var resets=0
                repeat(2000){
                    active();val state=store.remote(account)
                    try {
                        val page=client.request(token,"/sync?after=${state.cursor}"+if(state.epoch.isNotBlank())"&epoch=${URLEncoder.encode(state.epoch,"UTF-8")}" else "")
                        active();if(!store.applyPage(account,state,page))return@repeat
                        if(!page.getBoolean("has_more"))return
                        if(page.getLong("cursor")<=state.cursor)throw IOException("合集更新进度异常")
                    }catch(e:CollectionApiError){if(e.code=="reset_required"&&resets++==0)store.reset(account) else throw e}
                }
                throw IOException("合集更新已保存进度，下次继续")
            }
            try {
                pull()
                val blocked=mutableSetOf<String>()
                for(op in store.remote(account).pending){
                    active();if(op.error.isNotEmpty()||op.collection in blocked){blocked.add(op.collection);continue}
                    try {
                        val result=client.request(token,"/${op.collection}/operations",op.body)
                        store.acknowledge(account,op,result)
                    }catch(e:CollectionApiError){
                        if(e.status in listOf(400,404,409)){
                            store.fail(account,op.id,when(e.code){"collection_deleted"->"合集已删除，修改尚未提交";"revision_conflict"->"其他设备已修改，请核对最新内容";else->"操作未提交：${e.code}"});blocked.add(op.collection)
                        }else throw e
                    }
                }
                pull();store.message(account,"");true
            }catch(e:CancellationException){throw e}
            catch(e:Exception){store.message(account,when{e is CollectionApiError&&e.status in listOf(401,403)->"连接凭证已失效";e is CollectionApiError&&e.status in listOf(404,405)->"服务尚未支持合集";else->"暂未连接，已保留本地合集和待同步修改"});false}
        }
    }
    fun schedule(context:Context,base:String,token:String){
        if(token.isBlank())return
        WorkManager.getInstance(context).enqueueUniqueWork("collections:${accountKeyFor(base,token)}",ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<CollectionSyncWorker>().setInputData(workDataOf("base" to base,"account" to accountKeyFor(base,token)))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
}
class CollectionSyncWorker(context:Context,parameters:WorkerParameters):CoroutineWorker(context,parameters){
 override suspend fun doWork():Result{
    val base=inputData.getString("base")?:return Result.failure()
    val prefs=SharePreferencesStore(applicationContext).preferences.first()
    if(accountKeyFor(base,prefs.apiToken)!=inputData.getString("account"))return Result.success()
    return if(CollectionSync.run(applicationContext,base,prefs.apiToken))Result.success() else Result.retry()
 }
}
