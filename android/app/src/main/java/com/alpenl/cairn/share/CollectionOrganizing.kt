package com.alpenl.cairn.share

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.alpenl.cairn.share.network.CollectionsClient
import com.alpenl.cairn.share.network.CollectionApiError
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

private fun JSONArray.objects()=List(length()){getJSONObject(it)}
@Composable internal fun CollectionOrganizingDialog(base:String,token:String,definitions:List<CollectionRecord>,onDismiss:()->Unit,onChanged:()->Unit){
 val app=LocalContext.current.applicationContext;val account=accountKeyFor(base,token);val store=remember(account){CollectionStore(app)};val client=remember(base){CollectionsClient(base)};val scope=rememberCoroutineScope()
 var runID by rememberSaveable(account){mutableStateOf<String?>(null)}
 var direct by rememberSaveable(account){mutableStateOf(false)}
 var selected by remember(account){mutableStateOf(definitions.filter{!it.deleted&&!it.archived}.take(32).map{it.id}.toSet())}
 var data by remember(account){mutableStateOf<JSONObject?>(null)};var history by remember(account){mutableStateOf(listOf<JSONObject>())}
 var error by remember{mutableStateOf("")};var busy by remember{mutableStateOf(false)}
 suspend fun active(){if(SharePreferencesStore(app).preferences.first().apiToken.trim()!=token.trim())throw CancellationException()}
 suspend fun refresh(){active();if(runID==null)history=client.request(token,"/organizing").getJSONArray("items").objects() else {val result=client.request(token,"/organizing/$runID");active();data=result;store.saveOrganizingDraft(account,"cache:$runID",result.toString())}}
 fun action(block:suspend()->Unit){scope.launch{busy=true;error="";try{active();block()}catch(e:Exception){if(e is CancellationException)throw e;error=when((e as? CollectionApiError)?.code){"preselection_stale"->"正文或合集定义已改变，请重新生成预选";"revision_conflict"->"合集已更新，请刷新核对后再次应用";"organizing_active"->"已有任务在进行，请查看整理记录";else->"暂未完成，操作已保留，可以重试"}}finally{busy=false}}}
 LaunchedEffect(account,runID){
  if(runID!=null){store.organizingDraft(account,"cache:$runID")?.let{data=JSONObject(it)}}
  do {try{refresh()}catch(e:Exception){if(e is CancellationException)throw e;error="暂时无法刷新，已保存的结果仍可查看"};if(runID==null||data?.let{result->result.getJSONArray("items").objects().none{it.getString("status") in listOf("queued","processing")}&&(result.getJSONObject("run").getString("mode")!="apply"||result.getJSONObject("run").getInt("auto_finished")==1)}==true)break;delay(5000)}while(true)
 }
 suspend fun applyItem(item:JSONObject,choices:Set<String>){
  val key="$runID:${item.getInt("link_id")}";val signature=choices.sorted().joinToString(",")
  val old=store.organizingDraft(account,key)?.let{JSONObject(it)}
  val intent=if(old?.optString("signature")==signature)old else {
   val current=client.request(token,"").getJSONArray("items").objects();val versions=JSONObject()
   choices.forEach{id->val c=current.find{it.getString("id")==id&&it.getInt("deleted")==0&&it.getInt("archived")==0}?:throw CollectionApiError("preselection_stale",409);versions.put(id,c.getLong("revision"))}
   JSONObject().put("signature",signature).put("body",JSONObject().put("operation_key",UUID.randomUUID().toString()).put("link_ids",JSONArray(listOf(item.getInt("link_id")))).put("collection_ids",JSONArray(choices.sorted())).put("expected_revisions",versions)).also{store.saveOrganizingDraft(account,key,it.toString())}
  }
  active()
  try{client.request(token,"/organizing/$runID/apply",intent.getJSONObject("body").toString());store.saveOrganizingDraft(account,key,null);onChanged()}
  catch(e:CollectionApiError){if(e.code=="revision_conflict")store.saveOrganizingDraft(account,key,null);throw e}
 }
 AlertDialog(onDismissRequest=onDismiss,title={Text(if(runID==null)"自动整理合集" else "核对整理结果")},text={Column(Modifier.fillMaxWidth().heightIn(max=520.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
  if(runID==null){
   Text("只判断所选已有合集，保留原有归属。",style=MaterialTheme.typography.bodySmall)
   Row(verticalAlignment=Alignment.CenterVertically){RadioButton(!direct,{direct=false},modifier=Modifier.testTag("organizing_review_mode"));Text("生成预选，审核后加入",style=MaterialTheme.typography.bodyMedium)}
   Row(verticalAlignment=Alignment.CenterVertically){RadioButton(direct,{direct=true},modifier=Modifier.testTag("organizing_direct_mode"));Text("直接应用预选，无需审核",style=MaterialTheme.typography.bodyMedium)}
   LazyColumn(Modifier.weight(1f,false)){
    items(definitions.filter{!it.archived&&!it.deleted},key={it.id}){c->Row(verticalAlignment=Alignment.CenterVertically){Checkbox(c.id in selected,{value->if(!value||selected.size<32)selected=if(value)selected+c.id else selected-c.id});Text(c.name,maxLines=2,overflow=TextOverflow.Ellipsis)}}
    item{Text("整理记录",style=MaterialTheme.typography.labelLarge)}
    items(history,key={it.getString("id")}){r->TextButton(onClick={runID=r.getString("id")}){Text(r.getString("created_at").take(16).replace("T"," ")+" · "+(if(r.getInt("pending")>0)"处理中" else if(r.getInt("review_count")>0)"待审核" else "已处理"))}}
   }
   Text("最多选择32个合集。预算不足会保留进度，次日继续。",style=MaterialTheme.typography.labelSmall)
  }else{
   val rows=data?.optJSONArray("items")?.objects().orEmpty();val targets=data?.getJSONObject("run")?.getJSONArray("definitions")?.objects().orEmpty()
   Text("共 ${rows.size} 条 · ${rows.count{it.getString("status") in listOf("queued","processing")}} 条处理中 · ${rows.count{it.getString("status")=="ready"}} 条待审核",style=MaterialTheme.typography.bodySmall)
   LazyColumn(Modifier.weight(1f,false)){
    items(rows.filter{it.getString("status")=="ready"}.take(30),key={it.getInt("link_id")}){item->
     var choices by remember(runID,item.getInt("link_id")){mutableStateOf(targets.filter{item.getJSONObject("probabilities").optDouble(it.getString("id"))>=0.8}.map{it.getString("id")}.toSet())}
     Column(Modifier.padding(vertical=12.dp)){
      Text(item.getString("title"),maxLines=3,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.titleSmall)
      if(item.optString("error").isNotBlank())Text(item.getString("error"),style=MaterialTheme.typography.bodySmall)
      targets.forEach{c->val id=c.getString("id");Row(verticalAlignment=Alignment.CenterVertically){Checkbox(id in choices,{value->choices=if(value)choices+id else choices-id},enabled=!busy);Text(c.getString("name")+" · "+(item.getJSONObject("probabilities").optDouble(id)*100).toInt()+"%",style=MaterialTheme.typography.bodySmall)}}
      Row{TextButton(onClick={action{applyItem(item,choices);refresh()}},enabled=!busy&&choices.isNotEmpty()){Text("确认加入")};TextButton(onClick={action{client.request(token,"/organizing/$runID/dismiss",JSONObject().put("link_ids",JSONArray(listOf(item.getInt("link_id")))).toString());refresh()}},enabled=!busy){Text("跳过")}}
      HorizontalDivider()
     }
    }
    items(rows.filter{it.getString("status")=="failed"}.take(10),key={"failed:"+it.getInt("link_id")}){item->Text(item.getString("title")+" · "+item.optString("error"),style=MaterialTheme.typography.bodySmall)}
    items(data?.optJSONArray("actions")?.objects()?.filter{it.getString("status")!="undone"}.orEmpty(),key={it.getString("id")}){a->Row(verticalAlignment=Alignment.CenterVertically){Text(if(a.getString("actor")=="direct")"已直接应用" else "已审核应用",Modifier.weight(1f),style=MaterialTheme.typography.bodySmall);TextButton(onClick={action{client.request(token,"/organizing/$runID/undo",JSONObject().put("action_id",a.getString("id")).toString());onChanged();refresh()}},enabled=!busy){Text("撤销加入")}}}
   }
   Text("撤销只移出这次新加入的收藏；后续修改会要求核对。",style=MaterialTheme.typography.labelSmall)
  }
 }},confirmButton={TextButton(onClick={action{
  if(runID==null){
   val key="start";val signature=selected.sorted().joinToString(",")+":"+direct;val old=store.organizingDraft(account,key)?.let{JSONObject(it)}
   val draft=if(old?.optString("signature")==signature)old else JSONObject().put("signature",signature).put("body",JSONObject().put("operation_key",UUID.randomUUID().toString()).put("collection_ids",JSONArray(selected.sorted())).put("mode",if(direct)"apply" else "review")).also{store.saveOrganizingDraft(account,key,it.toString())}
   val result=client.request(token,"/organizing",draft.getJSONObject("body").toString());active();runID=result.getJSONObject("run").getString("id");data=result;store.saveOrganizingDraft(account,key,null)
  }else refresh()
 }},enabled=!busy&&(runID!=null||selected.isNotEmpty()),modifier=Modifier.testTag("organizing_start")){Text(if(busy)"处理中…" else if(runID==null)"开始整理" else "刷新进度")}},dismissButton={TextButton(onClick={if(runID!=null){runID=null;data=null}else onDismiss()}){Text(if(runID!=null)"返回记录" else "关闭")}})
}
