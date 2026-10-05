package com.alpenl.cairn.share

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import com.alpenl.cairn.share.network.BookmarkFilters
import com.alpenl.cairn.share.network.BookmarkTaxonomy
import com.alpenl.cairn.share.network.SavedLink
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

internal class CollectionController(val context:Context,val base:String,val token:String,private val scope:CoroutineScope) {
    val account=accountKeyFor(base,token)
    val store=CollectionStore(context)
    var state by mutableStateOf(CollectionState()); private set
    var remote by mutableStateOf(CollectionState()); private set
    var working by mutableStateOf(false); private set
    var error by mutableStateOf("")
    suspend fun reload(){remote=store.remote(account);state=store.snapshot(account)}
    fun refresh(){if(working)return;scope.launch{working=true;try{CollectionSync.run(context,base,token);reload()}finally{working=false}}}
    suspend fun write(id:String,type:String,fields:JSONObject=JSONObject()) {
        store.enqueue(account,id,type,fields);reload();CollectionSync.schedule(context,base,token)
    }
    fun action(block:suspend()->Unit){scope.launch{try{error="";block()}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;error=e.message?:"合集保存失败"}}}
    suspend fun resolve(p:CollectionPending,retry:Boolean){CollectionSync.exclusive(account){store.resolve(account,p,retry)};reload();CollectionSync.schedule(context,base,token)}
}
@Composable internal fun rememberCollections(base:String,token:String,autoRefresh:Boolean=true):CollectionController {
    val app=LocalContext.current.applicationContext;val scope=rememberCoroutineScope()
    val controller=remember(base,token){CollectionController(app,base,token,scope)}
    LaunchedEffect(controller){controller.reload();if(autoRefresh)controller.refresh();CollectionStore.updates.collect{if(it==controller.account)controller.reload()}}
    return controller
}
@Composable private fun CollectionStatus(controller:CollectionController){
    val pending=controller.state.pending
    val message=controller.error.ifBlank{controller.state.message}.ifBlank{if(pending.isNotEmpty())"${pending.size} 项修改已保存在本机，等待同步" else ""}
    if(message.isNotBlank())Text(message,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.testTag("collection_status"))
}
@Composable private fun CollectionEditor(record:CollectionRecord?,onDismiss:()->Unit,onSave:(String,String)->Unit){
    var name by rememberSaveable(record?.id){mutableStateOf(record?.name.orEmpty())}
    var description by rememberSaveable(record?.id){mutableStateOf(record?.description.orEmpty())}
    AlertDialog(onDismissRequest=onDismiss,title={Text(if(record==null)"新建合集" else "编辑合集")},text={Column(verticalArrangement=Arrangement.spacedBy(12.dp)){
        OutlinedTextField(name,{if(it.length<=80)name=it},label={Text("名称")},singleLine=true,modifier=Modifier.testTag("collection_name"))
        OutlinedTextField(description,{if(it.length<=2000)description=it},label={Text("说明，可选")},maxLines=4)
    }},confirmButton={TextButton(onClick={onSave(name.trim(),description)},enabled=name.isNotBlank()){Text("保存")}},dismissButton={TextButton(onClick=onDismiss){Text("取消")}})
}
@Composable internal fun CollectionChooser(controller:CollectionController,initial:Set<String>,onDismiss:()->Unit,onDone:(Set<String>)->Unit){
    var selected by remember{mutableStateOf(initial)};var query by rememberSaveable{mutableStateOf("")};var creating by remember{mutableStateOf(false)}
    AlertDialog(onDismissRequest=onDismiss,title={Text("加入合集")},text={Column{
        OutlinedTextField(query,{query=it},placeholder={Text("查找合集")},singleLine=true)
        TextButton(onClick={creating=true}){Text("新建合集")}
        LazyColumn(Modifier.heightIn(max=320.dp)) {items(controller.state.collections.filter{!it.deleted&&!it.archived&&it.name.contains(query,true)},key={it.id}){c->
            Row(Modifier.fillMaxWidth().clickable{selected=if(c.id in selected)selected-c.id else selected+c.id}.padding(vertical=6.dp),verticalAlignment=Alignment.CenterVertically){
                Checkbox(c.id in selected,{checked->selected=if(checked)selected+c.id else selected-c.id});Text(c.name,Modifier.weight(1f))
            }
        }}
        CollectionStatus(controller)
    }},confirmButton={TextButton(onClick={onDone(selected)}){Text("确定")}},dismissButton={TextButton(onClick=onDismiss){Text("取消")}})
    if(creating)CollectionEditor(null,{creating=false}){name,desc->controller.action{val id=UUID.randomUUID().toString();controller.write(id,"create",JSONObject().put("name",name).put("description",desc));selected=selected+id;creating=false}}
}
@Composable internal fun CollectionMembershipButton(base:String,token:String,ids:List<Int>){
    val c=rememberCollections(base,token,autoRefresh=false);var open by remember{mutableStateOf(false)}
    TextButton(onClick={open=true;c.refresh()},enabled=token.isNotBlank(),modifier=Modifier.testTag("add_to_collection")){Text("加入合集")}
    if(open){
        val membership=remember(c.state.members){c.state.members.groupBy{it.collection}.mapValues{(_,values)->values.map{it.link}.toSet()}}
        val initial=c.state.collections.filter{definition->ids.all{id->membership[definition.id]?.contains(id)==true}}.map{it.id}.toSet()
        CollectionChooser(c,initial,{open=false}){selected->c.action{
            for(id in selected-initial)c.write(id,"add",JSONObject().put("link_ids",JSONArray(ids)))
            for(id in initial-selected)c.write(id,"remove",JSONObject().put("link_ids",JSONArray(ids)))
            open=false
        }}
    }
}
@Composable internal fun CollectionDraftSelector(base:String,token:String,selected:Set<String>,onSelected:(Set<String>)->Unit,enabled:Boolean=true){
    val c=rememberCollections(base,token,autoRefresh=false);var open by remember{mutableStateOf(false)}
    TextButton(onClick={open=true;c.refresh()},enabled=enabled&&token.isNotBlank(),contentPadding=PaddingValues(0.dp),modifier=Modifier.testTag("share_collections")){
        Text(if(selected.isEmpty())"加入合集，可选" else "合集 · "+c.state.collections.filter{it.id in selected}.joinToString("、"){it.name},maxLines=1,overflow=TextOverflow.Ellipsis)
    }
    if(open)CollectionChooser(c,selected,{open=false}){onSelected(it);open=false}
}

@Composable internal fun CollectionsScreen(base:String,token:String,links:List<SavedLink>,taxonomy:BookmarkTaxonomy?,onBack:()->Unit,onOpen:(Int)->Unit,onRefreshLibrary:()->Unit){
    val c=rememberCollections(base,token)
    var selected by rememberSaveable(c.account){mutableStateOf<String?>(null)}
    var query by rememberSaveable(selected,c.account){mutableStateOf("")}
    var mode by rememberSaveable(c.account){mutableStateOf("active")}
    var organizing by remember{mutableStateOf(false)}
    var tagRules by remember{mutableStateOf(false)}
    var editor by remember{mutableStateOf(false)};var creating by remember{mutableStateOf(false)}
    var showAdd by remember{mutableStateOf(false)};var note by remember{mutableStateOf<CollectionMember?>(null)}
    var deleting by remember{mutableStateOf(false)};var filters by remember{mutableStateOf(BookmarkFilters())};var showFilters by remember{mutableStateOf(false)}
    var reviewing by remember{mutableStateOf<CollectionPending?>(null)}
    var selecting by remember{mutableStateOf(false)};var checked by remember{mutableStateOf(setOf<Int>())}
    val record=c.state.collections.find{it.id==selected};val members=c.state.members.filter{it.collection==selected}.sortedBy{it.position}
    val catalog=remember(links){links.associateBy{it.id}}
    val counts=remember(c.state.members){c.state.members.groupingBy{it.collection}.eachCount()}
    ScreenColumn {
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){
            TextButton(onClick={if(selected!=null){selected=null;checked=emptySet();selecting=false}else onBack()}){Text("返回")}
            Text(record?.name?:"合集",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge,maxLines=1,overflow=TextOverflow.Ellipsis)
            TextButton(onClick={c.refresh();onRefreshLibrary()},enabled=!c.working){Text("刷新")}
            TextButton(onClick={if(record==null)creating=true else editor=true}){Text(if(record==null)"新建" else "编辑")}
        }
        if(record?.description?.isNotBlank()==true)Text(record.description,style=MaterialTheme.typography.bodySmall,maxLines=3,overflow=TextOverflow.Ellipsis)
        OutlinedTextField(query,{query=it},placeholder={Text(if(record==null)"查找合集" else "搜索合集内标题、正文或备注")},singleLine=true,modifier=Modifier.fillMaxWidth().testTag("collection_search"))
        CollectionStatus(c)
        if(record==null)TextButton(onClick={organizing=true},modifier=Modifier.testTag("organize_collections")){Text("自动整理")}
        if(record==null)Row {
            listOf("active" to "使用中","archived" to "已归档","deleted" to "已删除").forEach{(value,label)->TextButton(onClick={mode=value}){Text(if(mode==value)"· $label" else label)}}
        } else Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){
            Text("${members.size} 条",Modifier.weight(1f),style=MaterialTheme.typography.labelMedium)
            if(!record.deleted){TextButton(onClick={showAdd=true}){Text("添加")};TextButton(onClick={selecting=!selecting;checked=emptySet()}){Text(if(selecting)"完成" else "选择")};TextButton(onClick={showFilters=true}){Text("筛选")}}
        }
        if(record!=null&&!record.deleted)TextButton(onClick={tagRules=true},modifier=Modifier.testTag("collection_tag_rules")){Text(if(record.ruleEnabled)"自动收录 · 匹配"+(if(record.ruleMode=="all")"全部"else"任一")+"标签" else "设置自动收录标签")}
        if(checked.isNotEmpty())CollectionMembershipButton(base,token,checked.toList())
        val errors=c.state.pending.filter{it.error.isNotBlank()&&(selected==null||it.collection==selected)}
        errors.firstOrNull()?.let{p->
            Column{Text(p.error,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.error)
                val remoteName=c.state.collections.find{it.id==p.collection}?.name.orEmpty()
                Text("$remoteName · 本机修改已保留",style=MaterialTheme.typography.labelSmall)
                Row{TextButton(onClick={reviewing=p}){Text("核对并处理")}}
            }
        }
        LazyColumn(Modifier.weight(1f).testTag("collections_list"),contentPadding=PaddingValues(bottom=24.dp)){
            if(record==null)items(c.state.collections.filter{when(mode){"deleted"->it.deleted;"archived"->!it.deleted&&it.archived;else->!it.deleted&&!it.archived}}.filter{(it.name+it.description).contains(query,true)}.sortedWith(compareByDescending<CollectionRecord>{it.pinned}.thenBy{it.name}),key={it.id}){item->
                Row(Modifier.fillMaxWidth().clickable{selected=item.id}.padding(vertical=16.dp),verticalAlignment=Alignment.CenterVertically){
                    Column(Modifier.weight(1f)){Text((if(item.pinned)"☆ " else "")+item.name,style=MaterialTheme.typography.titleMedium);Text("${counts[item.id]?:0} 条"+(if(c.state.pending.any{it.collection==item.id})" · 待同步" else ""),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}
                    Text("›",color=MaterialTheme.colorScheme.onSurfaceVariant)
                };HorizontalDivider()
            } else items(members.filter{member->val link=catalog[member.link];val text=listOf(link?.displayTitle(),link?.note,link?.enrichment?.summary,link?.enrichment?.originalText,link?.enrichment?.translatedText,member.note).joinToString(" ");query.split(Regex("\\s+")).all{text.contains(it,true)}&&(link==null||filters.matches(link))},key={it.link}){member->
                var menu by remember{mutableStateOf(false)}
                Row(Modifier.fillMaxWidth().padding(vertical=14.dp),verticalAlignment=Alignment.CenterVertically){
                    if(selecting)Checkbox(member.link in checked,{value->if(!value||checked.size<100)checked=if(value)checked+member.link else checked-member.link})
                    Column(Modifier.weight(1f).clickable{onOpen(member.link)}){
                        Text(catalog[member.link]?.displayTitle()?:"收藏 #${member.link}（正文尚未下载）",style=MaterialTheme.typography.titleMedium,maxLines=2,overflow=TextOverflow.Ellipsis)
                        if(member.origin=="rule")Text("按标签自动收录",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                        if(member.note.isNotBlank())Text(member.note,style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Box{TextButton(onClick={menu=true}){Text("⋯")};DropdownMenu(menu,{menu=false}){
                        DropdownMenuItem(text={Text("合集内备注")},onClick={menu=false;note=member})
                        val index=members.indexOf(member)
                        if(index>0)DropdownMenuItem(text={Text("上移")},onClick={menu=false;c.action{c.write(record.id,"move",JSONObject().put("link_id",member.link).put("before_id",members[index-1].link))}})
                        if(index<members.lastIndex)DropdownMenuItem(text={Text("下移")},onClick={menu=false;c.action{c.write(record.id,"move",JSONObject().put("link_id",member.link).put("before_id",members.getOrNull(index+2)?.link?:JSONObject.NULL))}})
                        DropdownMenuItem(text={Text("移出合集")},onClick={menu=false;c.action{c.write(record.id,"remove",JSONObject().put("link_ids",JSONArray(listOf(member.link))))}})
                    }}
                };HorizontalDivider()
            }
            if(record!=null&&members.isEmpty())item{Text("还没有内容，点击“添加”选择收藏。",Modifier.padding(vertical=24.dp),color=MaterialTheme.colorScheme.onSurfaceVariant)}
        }
        if(record!=null)Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
            if(record.deleted)TextButton(onClick={c.action{c.write(record.id,"restore")}}){Text("恢复合集")}
            else {
                TextButton(onClick={c.action{c.write(record.id,"edit",JSONObject().put("pinned",!record.pinned))}}){Text(if(record.pinned)"取消置顶" else "置顶")}
                TextButton(onClick={c.action{c.write(record.id,"edit",JSONObject().put("archived",!record.archived))}}){Text(if(record.archived)"取消归档" else "归档")}
                TextButton(onClick={deleting=true}){Text("删除合集",color=MaterialTheme.colorScheme.error)}
            }
        }
    }
    if(tagRules&&record!=null)CollectionTagRulesDialog(c,record,{tagRules=false})
    if(organizing)CollectionOrganizingDialog(base,token,c.state.collections,{organizing=false}){c.refresh();onRefreshLibrary()}
    reviewing?.let { pending ->
        val latest=c.remote.collections.find{it.id==pending.collection}
        val body=JSONObject(pending.body)
        val action=mapOf("create" to "新建合集","edit" to "修改合集","add" to "加入收藏","remove" to "移出收藏","note" to "修改备注","move" to "调整顺序","delete" to "删除合集","restore" to "恢复合集","rule" to "修改自动收录规则","backfill" to "按规则补收收藏")[body.optString("type")].orEmpty()
        val member=c.remote.members.find{it.collection==pending.collection&&it.link==body.optInt("link_id")}
        AlertDialog(onDismissRequest={reviewing=null},title={Text("核对合集修改")},text={Column(verticalArrangement=Arrangement.spacedBy(12.dp)){
            Text("远端："+(latest?.name?:"尚不存在")+(if(latest?.deleted==true)"（已删除）" else ""))
            if(latest?.description?.isNotBlank()==true)Text(latest.description)
            if(body.has("note"))Text("远端备注："+(member?.note?.ifBlank{"无"}?:"收藏已移出"))
            Text("本机：$action")
            for(field in listOf("name","description","note"))if(body.has(field))Text(body.getString(field))
            Text("重试会把本机这次修改提交到当前版本，其他收藏和正文会保留。",style=MaterialTheme.typography.bodySmall)
        }},confirmButton={TextButton(onClick={c.action{c.resolve(pending,true);reviewing=null}}){Text("按最新版本重试")}},dismissButton={TextButton(onClick={c.action{c.resolve(pending,false);reviewing=null}}){Text("放弃这次修改")}})
    }
    if(creating||editor)CollectionEditor(if(creating)null else record,{creating=false;editor=false}){name,desc->c.action{
        val id=if(creating)UUID.randomUUID().toString() else record!!.id
        c.write(id,if(creating)"create" else "edit",JSONObject().put("name",name).put("description",desc));creating=false;editor=false
    }}
    if(deleting&&record!=null)AlertDialog(onDismissRequest={deleting=false},title={Text("删除这个合集？")},text={Text("收藏仍会保留，你可以在“已删除”中恢复合集。")},confirmButton={TextButton(onClick={c.action{c.write(record.id,"delete");deleting=false;selected=null}}){Text("删除合集")}},dismissButton={TextButton(onClick={deleting=false}){Text("取消")}})
    if(note!=null&&record!=null){var value by rememberSaveable(note?.link){mutableStateOf(note!!.note)};AlertDialog(onDismissRequest={note=null},title={Text("合集内备注")},text={OutlinedTextField(value,{if(it.length<=2000)value=it},minLines=3,maxLines=6)},confirmButton={TextButton(onClick={val member=note!!;c.action{c.write(record.id,"note",JSONObject().put("link_id",member.link).put("note",value));note=null}}){Text("保存")}},dismissButton={TextButton(onClick={note=null}){Text("取消")}})}
    if(showAdd&&record!=null)CollectionAddDialog(links,members.map{it.link}.toSet(),{showAdd=false}){ids->c.action{c.write(record.id,"add",JSONObject().put("link_ids",JSONArray(ids.toList())));showAdd=false}}
    if(showFilters)AlertDialog(onDismissRequest={showFilters=false},title={Text("合集内筛选")},text={BookmarkFilterPanel(filters,taxonomy,{filters=it},base,token)},confirmButton={TextButton(onClick={showFilters=false}){Text("完成")}},dismissButton={TextButton(onClick={filters=BookmarkFilters()}){Text("清除")}})
}
@Composable private fun CollectionAddDialog(links:List<SavedLink>,existing:Set<Int>,onDismiss:()->Unit,onDone:(Set<Int>)->Unit){
    var query by rememberSaveable{mutableStateOf("")};var selected by remember{mutableStateOf(setOf<Int>())}
    AlertDialog(onDismissRequest=onDismiss,title={Text("添加收藏")},text={Column{
        OutlinedTextField(query,{query=it},placeholder={Text("查找已保存的收藏")},singleLine=true)
        LazyColumn(Modifier.heightIn(max=360.dp)){items(links.filter{it.id !in existing&&(it.displayTitle()+it.note).contains(query,true)},key={it.id}){link->Row(verticalAlignment=Alignment.CenterVertically){Checkbox(link.id in selected,{value->if(!value||selected.size<100)selected=if(value)selected+link.id else selected-link.id});Text(link.displayTitle(),maxLines=2,overflow=TextOverflow.Ellipsis)}}}
        Text("一次最多选择 100 条；缺少内容可先更新本地资料库。",style=MaterialTheme.typography.labelSmall)
    }},confirmButton={TextButton(onClick={onDone(selected)},enabled=selected.isNotEmpty()){Text("加入 ${selected.size} 条")}},dismissButton={TextButton(onClick=onDismiss){Text("取消")}})
}

@Composable private fun CollectionTagRulesDialog(controller:CollectionController,record:CollectionRecord,onDismiss:()->Unit){
 val context=LocalContext.current.applicationContext;val scope=rememberCoroutineScope();val store=remember{CollectionStore(context)}
 var enabled by rememberSaveable(record.id){mutableStateOf(record.ruleEnabled)};var all by rememberSaveable(record.id){mutableStateOf(record.ruleMode=="all")};var selected by remember(record.id){mutableStateOf(record.ruleTags.toSet())};var query by rememberSaveable{mutableStateOf("")}
 var tags by remember{mutableStateOf(listOf<ManagedTag>())};var preview by remember{mutableStateOf<org.json.JSONObject?>(null)};var previewRevision by remember{mutableStateOf<Long?>(null)};var message by remember{mutableStateOf("")};var busy by remember{mutableStateOf(false)};var confirmFill by remember{mutableStateOf(false)}
 LaunchedEffect(record.id){tags=catalogTags(store.tagManagement(controller.account).payload);try{TagManagementSync.run(context,controller.base,controller.token);tags=catalogTags(store.tagManagement(controller.account).payload)}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;message="当前显示本地目录"}}
 fun previewExisting(){scope.launch{busy=true;try{val result=com.alpenl.cairn.share.network.CollectionsClient(controller.base).request(controller.token,"/${record.id}/rules/preview");preview=result;previewRevision=result.getLong("revision");message=if(result.getBoolean("rule_valid"))"已保存规则可补收 ${result.getJSONArray("items").length()}"+(if(result.getBoolean("has_more"))"+"else"")+" 条"else"规则标签尚未保存或已停用，请先保存。"}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;message="暂时无法预览，请联网重试。"}finally{busy=false}}}
 AlertDialog(onDismissRequest=onDismiss,title={Text("合集自动收录")},text={Column(Modifier.verticalScroll(rememberScrollState())){
  Row(verticalAlignment=Alignment.CenterVertically){Switch(enabled,{enabled=it});Text("自动加入新收藏")}
  Row(verticalAlignment=Alignment.CenterVertically){Switch(all,{all=it});Text(if(all)"匹配全部标签"else"匹配任一标签")}
  OutlinedTextField(query,{query=it},placeholder={Text("查找标签")},singleLine=true)
  LazyColumn(Modifier.heightIn(max=230.dp)){items(tags.filter{it.active&&(it.label+it.definition.stringList("aliases").joinToString()).contains(query,true)},key={it.ref}){tag->Row(Modifier.fillMaxWidth().clickable{selected=if(tag.ref in selected)selected-tag.ref else if(selected.size<20)selected+tag.ref else selected},verticalAlignment=Alignment.CenterVertically){Checkbox(tag.ref in selected,{checked->if(!checked||selected.size<20)selected=if(checked)selected+tag.ref else selected-tag.ref});Column{Text(tag.label);Text(tagDimensionLabels[tag.dimension].orEmpty(),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)}}}}
  val missing=selected-tags.filter{it.active}.map{it.ref}.toSet();if(missing.isNotEmpty())Column{Text("以下标签已停用或尚未加载：",style=MaterialTheme.typography.labelSmall);missing.forEach{ref->TextButton(onClick={selected=selected-ref}){Text("移除 $ref")}}}
  Text("保存后作用于新收藏。手动移出后不会再次自动加入；停用规则会保留已有成员。",style=MaterialTheme.typography.bodySmall)
  TextButton(onClick=::previewExisting,enabled=!busy&&controller.state.pending.none{it.collection==record.id}){Text("预览已保存规则的已有收藏")}
  if(message.isNotBlank())Text(message,style=MaterialTheme.typography.bodySmall)
  preview?.let{result->val rows=result.optJSONArray("items");if(rows!=null&&rows.length()>0){LazyColumn(Modifier.heightIn(max=120.dp)){items(rows.length()){i->Text(rows.getJSONObject(i).getString("title"),style=MaterialTheme.typography.bodySmall,modifier=Modifier.padding(vertical=4.dp))}};TextButton(onClick={confirmFill=true},enabled=!busy){Text("补收这 ${rows.length()} 条")}}}
 }},confirmButton={TextButton(onClick={controller.action{controller.write(record.id,"rule",JSONObject().put("enabled",enabled).put("mode",if(all)"all"else"any").put("tag_refs",JSONArray(selected.toList())));onDismiss()}},enabled=!enabled||selected.isNotEmpty()){Text("保存规则")}},dismissButton={TextButton(onClick=onDismiss){Text("取消")}})
 if(confirmFill)AlertDialog(onDismissRequest={confirmFill=false},title={Text("按已保存规则补收？")},text={Text("匹配的已有收藏会加入合集，手动排除的条目会跳过。")},confirmButton={TextButton(onClick={controller.action{
  controller.reload();val latest=controller.remote.collections.find{it.id==record.id};if(latest?.revision!=previewRevision){message="合集已变化，请重新预览。";confirmFill=false;return@action}
  controller.write(record.id,"backfill");confirmFill=false;onDismiss()
 }}){Text("补收")}},dismissButton={TextButton(onClick={confirmFill=false}){Text("取消")}})
}
