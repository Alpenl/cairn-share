package com.alpenl.cairn.share

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import java.util.UUID
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

internal val tagDimensionLabels=linkedMapOf("topics" to "主题","resource_kinds" to "资源类型","content_functions" to "内容特征","carriers" to "载体","affordances" to "潜在用途","forms" to "旧版形态","uses" to "旧版用途","custom" to "个人标签")
internal fun JSONObject.stringList(key:String):List<String> = optJSONArray(key)?.let{a->List(a.length()){a.getString(it)}}?:emptyList()
internal data class ManagedTag(val dimension:String,val definition:JSONObject){val id:String get()=definition.getString("id");val ref:String get()=if(dimension=="custom")"custom/default/$id"else"system/$dimension/$id";val label:String get()=definition.getString("label");val active:Boolean get()=definition.optBoolean("active")&&!definition.optBoolean("deprecated")}
internal fun catalogTags(payload:JSONObject?):List<ManagedTag>{
 val catalog=payload?.optJSONObject("catalog")?:return emptyList()
 val system=tagDimensionLabels.keys.filter{it!="custom"}.flatMap{dimension->catalog.optJSONArray(dimension)?.let{a->List(a.length()){ManagedTag(dimension,a.getJSONObject(it))}}?:emptyList()}
 val custom=payload.optJSONArray("custom_tags")?.let{a->List(a.length()){val t=JSONObject(a.getJSONObject(it).toString());t.put("active",t.optString("status")=="active").put("ai_enabled",false).put("description","个人标签，由你手动使用");ManagedTag("custom",t)}}?:emptyList()
 return system+custom
}
@Composable internal fun TagManagerScreen(base:String,token:String,onBack:()->Unit,onChanged:()->Unit){
 val app=LocalContext.current.applicationContext;val account=remember(base,token){accountKeyFor(base,token)};val store=remember(app){CollectionStore(app)};val scope=rememberCoroutineScope()
 var state by remember(account){mutableStateOf(TagManagementState())};var busy by remember{mutableStateOf(false)};var message by remember{mutableStateOf("")}
 var query by rememberSaveable{mutableStateOf("")};var archived by rememberSaveable{mutableStateOf(false)};var dimension by rememberSaveable{mutableStateOf("all")};var menu by remember{mutableStateOf(false)}
 var editing by remember{mutableStateOf<Pair<String,JSONObject>?>(null)};var history by remember{mutableStateOf<JSONArray?>(null)}
 fun action(block:suspend()->Unit){scope.launch{try{block()}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;message=e.message?:"标签保存失败"}}}
 fun refresh(){if(busy)return;action{busy=true;try{TagManagementSync.run(app,base,token);val wasPending=state.pending!=null;val oldRevision=state.payload?.optLong("revision");state=store.tagManagement(account);if(state.payload?.optLong("revision")!=oldRevision||(wasPending&&state.pending==null))onChanged()}finally{busy=false}}}
 LaunchedEffect(account){state=store.tagManagement(account);refresh();CollectionStore.updates.collect{if(it==account)state=store.tagManagement(account)}}
 val tags=remember(state.payload){catalogTags(state.payload)}
 val counts=remember(state.payload){val a=state.payload?.optJSONArray("counts");buildMap<String,Int>{if(a!=null)for(i in 0 until a.length()){val c=a.getJSONObject(i);put(c.getString("field")+":"+c.getString("term"),c.getInt("n"))}}}
 Column(Modifier.fillMaxSize().padding(horizontal=20.dp)){
  Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){TextButton(onClick=onBack){Text("返回")};Text("标签管理",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick={editing="topics" to JSONObject()},enabled=state.payload!=null&&state.pending==null&&!busy){Text("新建")};TextButton(onClick=::refresh,enabled=!busy&&token.isNotBlank()){Text(if(busy)"同步中"else"刷新")}}
  OutlinedTextField(query,{query=it},placeholder={Text("查找名称、别名或含义")},singleLine=true,modifier=Modifier.fillMaxWidth().testTag("tag_manager_search"))
  Row(verticalAlignment=Alignment.CenterVertically){Box{TextButton(onClick={menu=true}){Text(tagDimensionLabels[dimension]?:"全部类别")};DropdownMenu(menu,{menu=false}){DropdownMenuItem(text={Text("全部类别")},onClick={dimension="all";menu=false});tagDimensionLabels.forEach{(key,label)->DropdownMenuItem(text={Text(label)},onClick={dimension=key;menu=false})}}};Checkbox(archived,{archived=it});Text("已停用",style=MaterialTheme.typography.bodySmall)}
  if(message.isNotBlank())Text(message,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodySmall)
  if(state.error.isNotBlank())Text(if(state.error.startsWith("rejected:"))tagManagementErrorLabel(state.error.removePrefix("rejected:"))else state.error,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
  if(state.pending!=null){val intent=state.pending!!.optJSONObject("body")?:state.pending!!;val draft=intent.optJSONObject("definition");Text((draft?.optString("label")?:intent.optString("label"))+" · "+(draft?.optString("description")?:"一项标签修改已保存在本机，等待确认。"),style=MaterialTheme.typography.bodySmall);if(state.error.startsWith("rejected:"))Row{TextButton(onClick={action{store.resolveTags(account,true);state=store.tagManagement(account);refresh()}}){Text("核对后重试")};TextButton(onClick={action{store.resolveTags(account,false);state=store.tagManagement(account)}}){Text("放弃本机修改")}}else TextButton(onClick=::refresh,enabled=!busy){Text("重试同步")}}
  if(state.payload==null)Text("联网后载入标签目录，之后可离线查看。",Modifier.padding(vertical=24.dp),color=MaterialTheme.colorScheme.onSurfaceVariant)
  LazyColumn(Modifier.weight(1f)){items(tags.filter{(dimension=="all"||it.dimension==dimension)&&it.active!=archived&&(it.label+it.definition.stringList("aliases").joinToString(" ")+it.definition.optString("description")).contains(query,true)},key={it.ref}){tag->
   Column(Modifier.fillMaxWidth().clickable(enabled=state.pending==null&&!busy){editing=tag.dimension to tag.definition}.padding(vertical=14.dp)){
    Text(tag.label,style=MaterialTheme.typography.titleMedium)
    val field=if(tag.dimension=="forms")"form"else if(tag.dimension=="uses")"use"else tag.dimension
    Text("${tagDimensionLabels[tag.dimension]} · ${if(tag.dimension=="custom")tag.definition.optInt("link_count")else counts["$field:${tag.id}"]?:0} 条 · "+if(tag.definition.optBoolean("ai_enabled",true)&&!(tag.dimension=="uses"&&tag.id=="contra"))"AI 自动打标"else"仅手动",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
    Text(tag.definition.optString("description"),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.padding(top=6.dp))
   };HorizontalDivider()
  }}
 }
 editing?.let{(dim,term)->if(dim=="custom")PersonalTagDefinitionEditor(term,{editing=null}){name,archived->action{
  val body=JSONObject().put("operation_key",UUID.randomUUID().toString()).put("expected_revision",term.getLong("revision")).put("label",name).put("archived",archived);val envelope=JSONObject().put("operation_key",body.getString("operation_key")).put("path","/api/custom-tags/${term.getString("id")}").put("method","PATCH").put("body",body);store.enqueueTagManagement(account,envelope);state=store.tagManagement(account);editing=null;TagManagementSync.schedule(app,base,token);refresh()
 }}else TagDefinitionEditor(dim,term,{editing=null},{type,definition->action{
  val payload=state.payload?:return@action;val body=JSONObject().put("operation_key",UUID.randomUUID().toString()).put("expected_revision",payload.getLong("revision")).put("dimension",dim).put("type",type)
  if(term.has("id"))body.put("id",term.getString("id"));if(definition!=null)body.put("definition",definition)
  store.enqueueTagManagement(account,body);state=store.tagManagement(account);editing=null;TagManagementSync.schedule(app,base,token);refresh()
 }},{action{val result=TagManagementApi(base).request(token,"/history?dimension=$dim&id=${term.getString("id")}");history=result.getJSONArray("items")}})}
 history?.let{rows->AlertDialog(onDismissRequest={history=null},title={Text("标签变更")},text={LazyColumn(Modifier.heightIn(max=400.dp)){items(rows.length()){i->val row=rows.getJSONObject(i);Text(row.getString("created_at")+" · "+mapOf("create" to "创建","edit" to "修改","archive" to "停用","restore" to "恢复")[row.getString("action")],Modifier.padding(vertical=8.dp))}}},confirmButton={TextButton(onClick={history=null}){Text("关闭")}})}
}
internal fun tagManagementErrorLabel(code:String):String=when(code){"revision_conflict"->"其他设备已修改目录，请核对当前内容后重试。";"tag_collision"->"名称或别名已被其他标签使用，请修改后重新提交。";"last_ai_tag"->"每个分类至少保留一个 AI 标签。";"invalid_tag_definition"->"标签名称和含义不能为空，请检查字段长度。";else->"修改尚未提交：$code"}
@Composable private fun TagDefinitionEditor(dimension:String,term:JSONObject,onDismiss:()->Unit,onSave:(String,JSONObject?)->Unit,onHistory:()->Unit){
 var name by rememberSaveable{mutableStateOf(term.optString("label"))};var aliases by rememberSaveable{mutableStateOf(term.stringList("aliases").joinToString("，"))};var description by rememberSaveable{mutableStateOf(term.optString("description"))};var include by rememberSaveable{mutableStateOf(term.stringList("includes").joinToString("\n"))};var exclude by rememberSaveable{mutableStateOf(term.stringList("excludes").joinToString("\n"))};var specific by rememberSaveable{mutableStateOf(term.optString("granularity","specific")=="specific")};val personal=dimension=="uses"&&term.optString("id")=="contra";var ai by rememberSaveable{mutableStateOf(term.optBoolean("ai_enabled",true)&&!personal)}
 fun split(value:String)=JSONArray(value.split(Regex("[\n,，]")).map{it.trim()}.filter{it.isNotEmpty()})
 fun lines(value:String)=JSONArray(value.lines().map{it.trim()}.filter{it.isNotEmpty()})
 AlertDialog(onDismissRequest=onDismiss,title={Text(if(term.has("id"))"管理标签"else"新建主题标签")},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(10.dp)){
  OutlinedTextField(name,{if(it.length<=80)name=it},label={Text("名称")},singleLine=true,modifier=Modifier.testTag("tag_manager_name"))
  OutlinedTextField(aliases,{aliases=it},label={Text("别名，逗号分隔")},maxLines=2)
  OutlinedTextField(description,{if(it.length<=1000)description=it},label={Text("含义：应该匹配什么")},minLines=2,maxLines=5,modifier=Modifier.testTag("tag_manager_definition"))
  OutlinedTextField(include,{include=it},label={Text("正例，每行一项")},maxLines=4);OutlinedTextField(exclude,{exclude=it},label={Text("反例，每行一项")},maxLines=4)
  if(dimension=="topics")Row(verticalAlignment=Alignment.CenterVertically){Switch(specific,{specific=it});Text(if(specific)"细分主题"else"宽主题")}
  Row(verticalAlignment=Alignment.CenterVertically){Switch(ai,{ai=it},enabled=!personal,modifier=Modifier.testTag("tag_manager_ai"));Text("参与 AI 自动打标")}
  Text("含义和 AI 开关作用于待处理与新收藏；停用后保留历史标签与合集成员。",style=MaterialTheme.typography.bodySmall)
  if(term.has("id"))Row{TextButton(onClick=onHistory){Text("变更记录")};TextButton(onClick={onSave(if(term.optBoolean("active")&&!term.optBoolean("deprecated"))"archive"else"restore",null)}){Text(if(term.optBoolean("active")&&!term.optBoolean("deprecated"))"停用"else"恢复")}}
 }},confirmButton={TextButton(onClick={val definition=JSONObject().put("label",name.trim()).put("aliases",split(aliases)).put("description",description.trim()).put("includes",lines(include)).put("excludes",lines(exclude)).put("ai_enabled",ai);if(dimension=="topics")definition.put("granularity",if(specific)"specific"else"broad");onSave(if(term.has("id"))"edit"else"create",definition)},enabled=name.isNotBlank()&&description.isNotBlank()){Text("保存")}},dismissButton={TextButton(onClick=onDismiss){Text("取消")}})
}

@Composable private fun PersonalTagDefinitionEditor(term:JSONObject,onDismiss:()->Unit,onSave:(String,Boolean)->Unit){
 var name by rememberSaveable{mutableStateOf(term.getString("label"))};var archived by rememberSaveable{mutableStateOf(!term.optBoolean("active"))}
 AlertDialog(onDismissRequest=onDismiss,title={Text("管理个人标签")},text={Column(verticalArrangement=Arrangement.spacedBy(12.dp)){OutlinedTextField(name,{if(it.length<=80)name=it},label={Text("名称")},singleLine=true);Row(verticalAlignment=Alignment.CenterVertically){Switch(archived,{archived=it});Text("停用")};Text("个人标签仅供人工使用。停用会保留已打标签与变更记录。",style=MaterialTheme.typography.bodySmall)}},confirmButton={TextButton(onClick={onSave(name.trim(),archived)},enabled=name.isNotBlank()){Text("保存")}},dismissButton={TextButton(onClick=onDismiss){Text("取消")}})
}
