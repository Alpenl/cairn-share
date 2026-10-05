package com.alpenl.cairn.share

import android.content.Context
import androidx.work.*
import com.alpenl.cairn.share.network.*
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONObject

internal data class TagManagementState(val payload:JSONObject?=null,val pending:JSONObject?=null,val error:String="")
internal class TagManagementApi(private val base:String){
 suspend fun request(token:String,path:String="",body:JSONObject?=null,method:String="POST"):JSONObject=withContext(Dispatchers.IO){
  val endpoint=if(path.startsWith("/api/"))path else "/api/tag-catalog$path"
  val c=URL("${base.trimEnd('/')}$endpoint").openConnection() as HttpURLConnection
  try{c.instanceFollowRedirects=false;c.connectTimeout=10000;c.readTimeout=20000;c.setRequestProperty("Authorization","Bearer ${token.trim()}");c.setRequestProperty("X-Cairn-Tag-System","1");c.setRequestProperty("User-Agent",AppUserAgent.value())
   if(body!=null){c.requestMethod=method;c.doOutput=true;c.setRequestProperty("Content-Type","application/json");val bytes=body.toString().toByteArray(Charsets.UTF_8);c.setFixedLengthStreamingMode(bytes.size);c.outputStream.use{it.write(bytes)}}
   val status=c.responseCode;val text=(if(status in 200..299)c.inputStream else c.errorStream)?.use{stream->val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192);while(true){val n=stream.read(buffer);if(n<0)break;if(output.size()+n>2*1024*1024)throw IOException("标签目录响应过大");output.write(buffer,0,n)};output.toString("UTF-8")}.orEmpty()
   val result=JSONObject(text);if(status !in 200..299)throw CollectionApiError(result.optString("error","server_error"),status)
   if(c.getHeaderField("X-Cairn-Tag-System")!="1")throw CollectionApiError("tag_management_unsupported",409)
   result
  }finally{c.disconnect()}
 }
}
internal object TagManagementSync{
 suspend fun run(context:Context,base:String,token:String):Boolean{
  if(token.isBlank())return true
  val account=accountKeyFor(base,token)
  return CollectionSync.exclusive(account){
   val store=CollectionStore(context);val api=TagManagementApi(base)
   suspend fun active(){if(SharePreferencesStore(context).preferences.first().apiToken.trim()!=token.trim())throw CancellationException()}
   try{
    active();val catalog=api.request(token);active();store.cacheTags(account,catalog)
    val state=store.tagManagement(account)
    if(state.pending!=null&&!state.error.startsWith("rejected:"))try{
      active();val body=state.pending.optJSONObject("body")?:state.pending;api.request(token,state.pending.optString("path","/operations"),body,state.pending.optString("method","POST"));active();val refreshed=api.request(token);active();store.acknowledgeTags(account,state.pending.getString("operation_key"),refreshed)
    }catch(e:CollectionApiError){if(e.status in listOf(400,404,409)){store.tagManagementError(account,"rejected:"+e.code)}else throw e}
    true
   }catch(e:CancellationException){throw e}catch(e:Exception){
    // A later offline refresh cannot turn an acknowledged rejection into an
    // uncertain write eligible for automatic replay.
    if(!store.tagManagement(account).error.startsWith("rejected:"))store.tagManagementError(account,"暂未连接，目录和待同步修改已保存在本机")
    false
   }
  }.also{CollectionStore.updates.tryEmit(account)}
 }
 fun schedule(context:Context,base:String,token:String){if(token.isBlank())return;WorkManager.getInstance(context).enqueueUniqueWork("tag-management:${accountKeyFor(base,token)}",ExistingWorkPolicy.APPEND_OR_REPLACE,OneTimeWorkRequestBuilder<TagManagementSyncWorker>().setInputData(workDataOf("base" to base,"account" to accountKeyFor(base,token))).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())}
}
class TagManagementSyncWorker(context:Context,parameters:WorkerParameters):CoroutineWorker(context,parameters){
 override suspend fun doWork():Result{val base=inputData.getString("base")?:return Result.failure();val token=SharePreferencesStore(applicationContext).preferences.first().apiToken;if(accountKeyFor(base,token)!=inputData.getString("account"))return Result.success();return if(TagManagementSync.run(applicationContext,base,token))Result.success()else Result.retry()}
}
