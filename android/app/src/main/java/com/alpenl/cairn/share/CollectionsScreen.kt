package com.alpenl.cairn.share

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
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
    // System back leaves a collection before it leaves the page, matching the 返回 button.
    androidx.activity.compose.BackHandler(enabled=selected!=null){selected=null;checked=emptySet();selecting=false}
    val record=c.state.collections.find{it.id==selected};val members=c.state.members.filter{it.collection==selected}.sortedBy{it.position}
    val catalog=remember(links){links.associateBy{it.id}}
    val counts=remember(c.state.members){c.state.members.groupingBy{it.collection}.eachCount()}
    val p=com.alpenl.cairn.share.ui.theme.CairnTheme.palette
    ScreenColumn {
        // Prototype page header: back arrow, serif title, quiet icon refresh, accent 新建/编辑.
        Row(Modifier.fillMaxWidth().heightIn(min=56.dp),verticalAlignment=Alignment.CenterVertically){
            IconButton(onClick={if(selected!=null){selected=null;checked=emptySet();selecting=false}else onBack()}){Icon(Icons.AutoMirrored.Filled.ArrowBack,contentDescription="返回")}
            Column(Modifier.weight(1f)){
                Text(record?.name?:"合集",style=MaterialTheme.typography.headlineSmall,maxLines=1,overflow=TextOverflow.Ellipsis)
                val sub=if(record==null)"${c.state.collections.count{!it.deleted&&!it.archived}} 个合集 · 手动整理或按标签自动收录" else "${members.size} 条收藏"+(if(record.archived)" · 已归档" else "")
                Text(sub,style=MaterialTheme.typography.labelSmall,color=p.tertiary,maxLines=1,overflow=TextOverflow.Ellipsis)
            }
            IconButton(onClick={c.refresh();onRefreshLibrary()},enabled=!c.working){Icon(Icons.Default.Refresh,contentDescription="刷新",Modifier.size(20.dp))}
            TextButton(onClick={if(record==null)creating=true else editor=true}){if(record==null)Icon(Icons.Default.Add,null,Modifier.size(16.dp));Text(if(record==null)"新建" else "编辑")}
        }
        if(record?.description?.isNotBlank()==true)Text(record.description,style=MaterialTheme.typography.bodyMedium,color=p.inkSoft,maxLines=3,overflow=TextOverflow.Ellipsis,modifier=Modifier.padding(horizontal=4.dp))
        OutlinedTextField(query,{query=it},placeholder={Text(if(record==null)"查找合集" else "搜索合集内标题、正文或备注")},singleLine=true,
            leadingIcon={Icon(Icons.Default.Search,null,Modifier.size(18.dp))},
            trailingIcon={if(query.isNotEmpty())IconButton(onClick={query=""}){Icon(Icons.Default.Close,"清除")}},
            shape=RoundedCornerShape(10.dp),
            colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=p.hairlineSoft,focusedBorderColor=p.terracotta,unfocusedContainerColor=p.surface,focusedContainerColor=p.surface),
            modifier=Modifier.fillMaxWidth().testTag("collection_search"))
        CollectionStatus(c)
        if(record==null)Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(6.dp),verticalAlignment=Alignment.CenterVertically){
            listOf("active" to "使用中","archived" to "已归档","deleted" to "已删除").forEach{(value,label)->TypePill(label,mode==value){mode=value}}
            Spacer(Modifier.width(4.dp))
            TextButton(onClick={organizing=true},modifier=Modifier.testTag("organize_collections")){Icon(CairnIcons.Library,null,Modifier.size(16.dp));Spacer(Modifier.width(6.dp));Text("自动整理")}
        } else Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){
            Text("${members.size} 条",Modifier.weight(1f).padding(start=4.dp),style=MaterialTheme.typography.labelMedium,color=p.muted)
            if(!record.deleted){TextButton(onClick={showAdd=true}){Text("添加")};TextButton(onClick={selecting=!selecting;checked=emptySet()}){Text(if(selecting)"完成" else "选择")};TextButton(onClick={showFilters=true}){Text("筛选")}}
        }
        // Rule entry as a settings-style card; the full page summarises the rule in one sentence.
        if(record!=null&&!record.deleted)Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp,p.hairlineSoft,RoundedCornerShape(12.dp))
            .clickable{tagRules=true}.padding(horizontal=14.dp,vertical=12.dp).testTag("collection_tag_rules"),verticalAlignment=Alignment.CenterVertically){
            Column(Modifier.weight(1f)){
                Text(if(record.ruleEnabled)"自动收录 · 匹配"+(if(record.ruleMode=="all")"全部"else"任一")+"标签" else "设置自动收录标签",style=MaterialTheme.typography.bodyMedium,fontWeight=FontWeight.Medium)
                Text(if(record.ruleEnabled)"${record.ruleTags.size} 个标签"+(if(record.ruleExclude.isNotEmpty())" · 排除 ${record.ruleExclude.size} 个" else "")+(if(record.ruleAdmission=="review")" · 审核后加入" else " · 直接加入") else "按标签把收藏自动放进这个合集",
                    style=MaterialTheme.typography.labelSmall,color=p.muted)
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight,null,tint=p.muted)
        }
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
                Row(Modifier.fillMaxWidth().clickable{selected=item.id}.padding(horizontal=4.dp,vertical=14.dp),verticalAlignment=Alignment.CenterVertically){
                    Column(Modifier.weight(1f)){
                        Text((if(item.pinned)"☆ " else "")+item.name,style=MaterialTheme.typography.titleMedium)
                        if(item.description.isNotBlank())Text(item.description,style=MaterialTheme.typography.bodySmall,color=p.muted,maxLines=1,overflow=TextOverflow.Ellipsis)
                        Text("${counts[item.id]?:0} 条"+(if(item.ruleEnabled)" · 自动收录" else "")+(if(c.state.pending.any{it.collection==item.id})" · 待同步" else ""),style=MaterialTheme.typography.labelSmall,color=p.tertiary)
                    }
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight,null,tint=p.muted)
                };HorizontalDivider(color=p.hairlineSoft)
            } else items(members.filter{member->val link=catalog[member.link];val text=listOf(link?.displayTitle(),link?.note,link?.enrichment?.summary,link?.enrichment?.originalText,link?.enrichment?.translatedText,member.note).joinToString(" ");query.split(Regex("\\s+")).all{text.contains(it,true)}&&(link==null||filters.matches(link))},key={it.link}){member->
                var menu by remember{mutableStateOf(false)}
                Row(Modifier.fillMaxWidth().padding(vertical=14.dp),verticalAlignment=Alignment.CenterVertically){
                    if(selecting)Checkbox(member.link in checked,{value->if(!value||checked.size<100)checked=if(value)checked+member.link else checked-member.link})
                    Column(Modifier.weight(1f).clickable{onOpen(member.link)}.padding(start=4.dp)){
                        Text(catalog[member.link]?.displayTitle()?:"收藏 #${member.link}（正文尚未下载）",style=MaterialTheme.typography.titleMedium,maxLines=2,overflow=TextOverflow.Ellipsis)
                        if(member.origin=="rule")Text("按标签自动收录",style=MaterialTheme.typography.labelSmall,color=p.terracotta)
                        if(member.note.isNotBlank())Text(member.note,style=MaterialTheme.typography.bodySmall,color=p.inkSoft)
                    }
                    Box{IconButton(onClick={menu=true}){Icon(CairnIcons.More,contentDescription="更多",tint=p.muted)};DropdownMenu(menu,{menu=false}){
                        DropdownMenuItem(text={Text("合集内备注")},onClick={menu=false;note=member})
                        val index=members.indexOf(member)
                        if(index>0)DropdownMenuItem(text={Text("上移")},onClick={menu=false;c.action{c.write(record.id,"move",JSONObject().put("link_id",member.link).put("before_id",members[index-1].link))}})
                        if(index<members.lastIndex)DropdownMenuItem(text={Text("下移")},onClick={menu=false;c.action{c.write(record.id,"move",JSONObject().put("link_id",member.link).put("before_id",members.getOrNull(index+2)?.link?:JSONObject.NULL))}})
                        DropdownMenuItem(text={Text("移出合集")},onClick={menu=false;c.action{c.write(record.id,"remove",JSONObject().put("link_ids",JSONArray(listOf(member.link))))}})
                    }}
                };HorizontalDivider(color=p.hairlineSoft)
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

/** Sentence describing a rule, as on the prototype's olive summary card. */
internal fun ruleSentence(tags: List<String>, exclude: List<String>, mode: String, admission: String, confirmedOnly: Boolean, enabled: Boolean, label: (String) -> String): String {
    if (tags.isEmpty()) return "还没有命中标签。添加标签后，带这些标签的收藏会自动归入这个合集。"
    val hit = tags.joinToString(if (mode == "all") "」和「" else "」或「", "「", "」") { label(it) }
    val without = if (exclude.isEmpty()) "" else "，且没有" + exclude.joinToString("」「", "「", "」") { label(it) }
    val head = if (confirmedOnly) "已确认标签里有" else "标签里有"
    val verb = if (admission == "review") "审核后加入" else "直接加入"
    return "$head$hit${without}的收藏，$verb。" + if (enabled) "" else "（规则已暂停）"
}

/** 合集规则 (prototype and-collection-rule). Full screen; one 保存 queues one rule write. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable private fun CollectionTagRulesDialog(controller:CollectionController,record:CollectionRecord,onDismiss:()->Unit){
    val context=LocalContext.current.applicationContext;val scope=rememberCoroutineScope();val store=remember{CollectionStore(context)}
    val p=com.alpenl.cairn.share.ui.theme.CairnTheme.palette
    val v2=com.alpenl.cairn.share.network.CollectionsClient.version(controller.base)>=2
    var enabled by rememberSaveable(record.id){mutableStateOf(record.ruleEnabled)}
    var mode by rememberSaveable(record.id){mutableStateOf(record.ruleMode)}
    var selected by rememberSaveable(record.id){mutableStateOf(record.ruleTags)}
    var exclude by rememberSaveable(record.id){mutableStateOf(record.ruleExclude)}
    var admission by rememberSaveable(record.id){mutableStateOf(record.ruleAdmission)}
    var confirmedOnly by rememberSaveable(record.id){mutableStateOf(record.ruleConfirmedOnly)}
    var picking by remember{mutableStateOf<String?>(null)}
    var tags by remember{mutableStateOf(listOf<ManagedTag>())};var preview by remember{mutableStateOf<JSONObject?>(null)};var previewRevision by remember{mutableStateOf<Long?>(null)}
    var queue by remember{mutableStateOf<List<JSONObject>?>(null)}
    var message by remember{mutableStateOf("")};var busy by remember{mutableStateOf(false)};var confirmFill by remember{mutableStateOf(false)}
    LaunchedEffect(record.id){tags=catalogTags(store.tagManagement(controller.account).payload);try{TagManagementSync.run(context,controller.base,controller.token);tags=catalogTags(store.tagManagement(controller.account).payload)}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;message="当前显示本地目录"}}
    fun label(ref:String)=tags.firstOrNull{it.ref==ref}?.label?:"已停用的标签"
    fun loadQueue(){if(!v2||record.ruleAdmission!="review")return;scope.launch{try{val r=com.alpenl.cairn.share.network.CollectionsClient(controller.base).request(controller.token,"/${record.id}/rules/candidates?status=pending&limit=100");val a=r.getJSONArray("items");queue=List(a.length()){a.getJSONObject(it)}}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;queue=null}}}
    LaunchedEffect(record.id,record.revision){loadQueue()}
    fun previewExisting(){scope.launch{busy=true;try{val result=com.alpenl.cairn.share.network.CollectionsClient(controller.base).request(controller.token,"/${record.id}/rules/preview");preview=result;previewRevision=result.getLong("revision");message=if(result.getBoolean("rule_valid"))"已保存的规则匹配 ${result.getJSONArray("items").length()}"+(if(result.getBoolean("has_more"))"+"else"")+" 条已有收藏"else"规则标签尚未保存或已停用，请先保存。"}catch(e:Exception){if(e is kotlinx.coroutines.CancellationException)throw e;message="暂时无法预览，请联网重试。"}finally{busy=false}}}
    val dirty=enabled!=record.ruleEnabled||mode!=record.ruleMode||selected!=record.ruleTags||exclude!=record.ruleExclude||admission!=record.ruleAdmission||confirmedOnly!=record.ruleConfirmedOnly
    val pendingWrite=controller.state.pending.any{it.collection==record.id}
    fun save(){controller.action{
        val body=JSONObject().put("enabled",enabled&&selected.isNotEmpty()).put("mode",mode).put("tag_refs",JSONArray(selected))
        if(v2)body.put("exclude_tag_refs",JSONArray(exclude.filter{it !in selected})).put("admission",admission).put("confirmed_only",confirmedOnly)
        controller.write(record.id,"rule",body);onDismiss()
    }}
    androidx.compose.ui.window.Dialog(onDismissRequest=onDismiss,properties=androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth=false)){
    Surface(Modifier.fillMaxSize(),color=p.canvas){Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()){
        Row(Modifier.fillMaxWidth().heightIn(min=56.dp).padding(horizontal=4.dp),verticalAlignment=Alignment.CenterVertically){
            IconButton(onClick=onDismiss){Icon(androidx.compose.material.icons.Icons.AutoMirrored.Filled.ArrowBack,"返回")}
            Column(Modifier.weight(1f)){Text("合集规则",style=MaterialTheme.typography.titleMedium);Text(record.name,style=MaterialTheme.typography.labelSmall,color=p.tertiary,maxLines=1,overflow=TextOverflow.Ellipsis)}
            Button(onClick=::save,enabled=dirty&&!busy,shape=androidx.compose.foundation.shape.RoundedCornerShape(10.dp),modifier=Modifier.padding(end=8.dp).testTag("save_collection_rule")){Text("保存规则")}
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal=16.dp),verticalArrangement=Arrangement.spacedBy(14.dp)){
            RuleCard{RuleSwitchRow("按标签自动收录","作用于新收藏和标签变化后的收藏",enabled&&selected.isNotEmpty(),selected.isNotEmpty()){enabled=it}}
            Text(ruleSentence(selected,if(v2)exclude else emptyList(),mode,if(v2)admission else "direct",v2&&confirmedOnly,enabled&&selected.isNotEmpty(),::label),
                style=MaterialTheme.typography.bodyMedium.copy(fontFamily=com.alpenl.cairn.share.ui.theme.CairnSerif),color=p.inkSoft,
                modifier=Modifier.fillMaxWidth().clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp)).background(p.cactus.copy(alpha=.35f)).padding(14.dp).testTag("rule_sentence"))
            Row(verticalAlignment=Alignment.CenterVertically){Text("包含标签",style=MaterialTheme.typography.labelLarge,modifier=Modifier.weight(1f));Text("${selected.size} / 20",style=MaterialTheme.typography.labelSmall,color=p.faint)}
            com.alpenl.cairn.share.ui.components.SegmentedToggle(listOf("any" to "任一标签","all" to "全部标签"),mode,{mode=it})
            androidx.compose.foundation.layout.FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
                for(ref in selected)RuleChip(label(ref),false){selected=selected-ref}
                AddChip("添加标签",selected.size<20){picking="tags"}
            }
            Row(verticalAlignment=Alignment.CenterVertically){Text("排除标签",style=MaterialTheme.typography.labelLarge,modifier=Modifier.weight(1f));Text("带有这些标签的收藏不会加入",style=MaterialTheme.typography.labelSmall,color=p.faint)}
            if(v2)androidx.compose.foundation.layout.FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
                for(ref in exclude)RuleChip(label(ref),true){exclude=exclude-ref}
                AddChip("排除标签",exclude.size<20){picking="exclude"}
            } else Unsupported()
            RuleCard{RuleSwitchRow("只按已确认的标签","关闭后，AI 建议的虚线标签也会参与匹配",v2&&confirmedOnly,v2){confirmedOnly=it}}
            Text("收录方式",style=MaterialTheme.typography.labelLarge)
            AdmissionOption("审核后再加入","匹配的收藏先进入待审核，你确认后才加入",admission=="review",v2){admission="review"}
            AdmissionOption("直接加入","匹配后立即加入，可以随时手动移出",admission!="review",true){admission="direct"}
            if(!v2)Unsupported()
            queue?.takeIf{it.isNotEmpty()&&record.ruleAdmission=="review"}?.let{rows->
                Row(verticalAlignment=Alignment.CenterVertically){Text("待审核",style=MaterialTheme.typography.labelLarge,modifier=Modifier.weight(1f));com.alpenl.cairn.share.ui.components.CountBadge(rows.size)}
                RuleCard{rows.forEachIndexed{i,row->
                    val id=row.getInt("link_id")
                    Row(Modifier.fillMaxWidth().padding(start=14.dp,end=6.dp,top=8.dp,bottom=8.dp),verticalAlignment=Alignment.CenterVertically){
                        Text(row.optString("title"),style=MaterialTheme.typography.bodyMedium,maxLines=2,overflow=TextOverflow.Ellipsis,modifier=Modifier.weight(1f))
                        TextButton(onClick={controller.action{controller.write(record.id,"review_ignore",JSONObject().put("link_ids",JSONArray(listOf(id))));queue=rows-row}},enabled=!pendingWrite){Text("忽略",color=p.tertiary)}
                        TextButton(onClick={controller.action{controller.write(record.id,"review_accept",JSONObject().put("link_ids",JSONArray(listOf(id))));queue=rows-row}},enabled=!pendingWrite,modifier=Modifier.testTag("review_accept_$id")){Text("加入")}
                    }
                    if(i<rows.lastIndex)HorizontalDivider(color=p.hairlineSoft)
                }}
            }
            Text("匹配预览",style=MaterialTheme.typography.labelLarge)
            Text("规则保存后作用于新收藏；手动移出的收藏不会再被自动加入，暂停规则会保留已有成员。",style=MaterialTheme.typography.bodySmall,color=p.tertiary)
            TextButton(onClick=::previewExisting,enabled=!busy&&!pendingWrite&&!dirty){Text(if(dirty)"先保存规则再预览已有收藏" else "预览已有收藏")}
            if(message.isNotBlank())Text(message,style=MaterialTheme.typography.bodySmall,color=p.muted)
            preview?.let{result->val rows=result.optJSONArray("items");if(rows!=null&&rows.length()>0){
                RuleCard{for(i in 0 until minOf(rows.length(),20)){Text(rows.getJSONObject(i).getString("title"),style=MaterialTheme.typography.bodySmall,maxLines=1,overflow=TextOverflow.Ellipsis,modifier=Modifier.padding(horizontal=14.dp,vertical=8.dp))}}
                OutlinedButton(onClick={confirmFill=true},enabled=!busy){Text(if(record.ruleAdmission=="review"&&v2)"把这 ${rows.length()} 条放进待审核" else "补收这 ${rows.length()} 条")}
            }}
            Spacer(Modifier.height(24.dp))
        }
    }}}
    picking?.let{list->
        val taken=if(list=="tags")selected else exclude
        val blocked=if(list=="tags")exclude else selected
        RuleTagPicker(if(list=="tags")"添加命中标签" else "添加排除标签",tags.filter{it.active&&it.dimension in listOf("topics","resource_kinds","content_functions","custom")&&it.ref !in blocked},taken,
            onToggle={ref->if(list=="tags")selected=if(ref in selected)selected-ref else if(selected.size<20)selected+ref else selected else exclude=if(ref in exclude)exclude-ref else if(exclude.size<20)exclude+ref else exclude},
            onDismiss={picking=null})
    }
    if(confirmFill)AlertDialog(onDismissRequest={confirmFill=false},title={Text("按已保存规则补收？")},text={Text("匹配的已有收藏会"+(if(record.ruleAdmission=="review"&&v2)"进入待审核" else "加入合集")+"，手动排除的条目会跳过。")},confirmButton={TextButton(onClick={controller.action{
        controller.reload();val latest=controller.remote.collections.find{it.id==record.id};if(latest?.revision!=previewRevision){message="合集已变化，请重新预览。";confirmFill=false;return@action}
        controller.write(record.id,"backfill");confirmFill=false;onDismiss()
    }}){Text("补收")}},dismissButton={TextButton(onClick={confirmFill=false}){Text("取消")}})
}

@Composable private fun RuleCard(content:@Composable ColumnScope.()->Unit){
    val p=com.alpenl.cairn.share.ui.theme.CairnTheme.palette
    Column(Modifier.fillMaxWidth().clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp)).background(p.surface).border(1.dp,p.hairlineSoft,androidx.compose.foundation.shape.RoundedCornerShape(12.dp)),content=content)
}
@Composable private fun RuleSwitchRow(title:String,subtitle:String,checked:Boolean,enabled:Boolean,onChange:(Boolean)->Unit){
    val p=com.alpenl.cairn.share.ui.theme.CairnTheme.palette
    Row(Modifier.fillMaxWidth().padding(horizontal=14.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically){
        Column(Modifier.weight(1f)){Text(title,style=MaterialTheme.typography.bodyMedium.copy(fontWeight=FontWeight.Medium));Text(if(enabled)subtitle else "服务尚未支持，或先添加命中标签",style=MaterialTheme.typography.bodySmall,color=p.tertiary)}
        Switch(checked,onChange,enabled=enabled,colors=SwitchDefaults.colors(checkedTrackColor=p.terracotta,checkedBorderColor=p.terracotta,uncheckedTrackColor=p.hairline,uncheckedBorderColor=p.hairline,uncheckedThumbColor=p.surface))
    }
}
@Composable private fun RuleChip(label:String,excluded:Boolean,onRemove:()->Unit){
    val p=com.alpenl.cairn.share.ui.theme.CairnTheme.palette
    val shape=androidx.compose.foundation.shape.RoundedCornerShape(999.dp)
    Row(Modifier.heightIn(min=32.dp).clip(shape).background(if(excluded)p.fig.copy(alpha=.08f) else p.olive.copy(alpha=.14f)).then(if(excluded)Modifier.border(1.dp,p.fig.copy(alpha=.5f),shape) else Modifier)
        .clickable(onClick=onRemove).padding(start=12.dp,end=8.dp),verticalAlignment=Alignment.CenterVertically){
        Text((if(excluded)"− " else "")+label,style=MaterialTheme.typography.labelMedium,color=if(excluded)p.fig else p.oliveInk)
        Icon(androidx.compose.material.icons.Icons.Default.Close,"移除「$label」",Modifier.padding(start=4.dp).size(14.dp),tint=if(excluded)p.fig else p.oliveInk)
    }
}
@Composable private fun AddChip(label:String,enabled:Boolean,onClick:()->Unit){
    val p=com.alpenl.cairn.share.ui.theme.CairnTheme.palette
    val shape=androidx.compose.foundation.shape.RoundedCornerShape(999.dp)
    Row(Modifier.heightIn(min=32.dp).clip(shape).border(1.dp,p.hairline,shape).clickable(enabled=enabled,onClick=onClick).padding(horizontal=12.dp),verticalAlignment=Alignment.CenterVertically){
        Icon(androidx.compose.material.icons.Icons.Default.Add,null,Modifier.size(14.dp),tint=p.inkSoft);Text(label,style=MaterialTheme.typography.labelMedium,color=p.inkSoft,modifier=Modifier.padding(start=4.dp))
    }
}
@Composable private fun AdmissionOption(title:String,subtitle:String,selected:Boolean,enabled:Boolean,onClick:()->Unit){
    val p=com.alpenl.cairn.share.ui.theme.CairnTheme.palette
    val shape=androidx.compose.foundation.shape.RoundedCornerShape(12.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(if(selected)p.terracotta.copy(alpha=.06f) else p.surface).border(1.dp,if(selected)p.terracotta.copy(alpha=.6f) else p.hairlineSoft,shape)
        .selectable(selected,enabled=enabled,role=androidx.compose.ui.semantics.Role.RadioButton,onClick=onClick).padding(horizontal=12.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically){
        RadioButton(selected,null,enabled=enabled,colors=RadioButtonDefaults.colors(selectedColor=p.terracotta))
        Column(Modifier.padding(start=10.dp)){Text(title,style=MaterialTheme.typography.bodyMedium.copy(fontWeight=FontWeight.Medium),color=if(enabled)p.ink else p.faint);Text(subtitle,style=MaterialTheme.typography.bodySmall,color=p.tertiary)}
    }
}
@Composable private fun Unsupported(){Text("服务尚未支持：更新服务端后可用",style=MaterialTheme.typography.bodySmall,color=com.alpenl.cairn.share.ui.theme.CairnTheme.palette.tertiary)}
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable private fun RuleTagPicker(title:String,tags:List<ManagedTag>,selected:List<String>,onToggle:(String)->Unit,onDismiss:()->Unit){
    var q by rememberSaveable{mutableStateOf("")}
    AlertDialog(onDismissRequest=onDismiss,title={Text(title)},text={Column(verticalArrangement=Arrangement.spacedBy(10.dp)){
        OutlinedTextField(q,{q=it},singleLine=true,placeholder={Text("搜索标签或别名")},modifier=Modifier.fillMaxWidth())
        Column(Modifier.heightIn(max=360.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
            for((d,group) in tags.filter{(it.label+" "+it.definition.stringList("aliases").joinToString(" ")).contains(q.trim(),true)}.groupBy{it.dimension}){
                Text(tagDimensionLabels[d]?:d,style=MaterialTheme.typography.labelMedium,color=com.alpenl.cairn.share.ui.theme.CairnTheme.palette.muted)
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
                    for(t in group)com.alpenl.cairn.share.ui.components.TagChip(t.label,tone=when(d){"topics"->com.alpenl.cairn.share.ui.components.TagTone.Topic;"resource_kinds"->com.alpenl.cairn.share.ui.components.TagTone.Resource;"custom"->com.alpenl.cairn.share.ui.components.TagTone.Personal;else->com.alpenl.cairn.share.ui.components.TagTone.Feature},
                        state=com.alpenl.cairn.share.ui.components.TagState.Automatic,selected=t.ref in selected,onClick={onToggle(t.ref)},modifier=Modifier.testTag("rule_pick_${t.ref}"))
                }
            }
        }
        Text("已选 ${selected.size} 个，可以多选",style=MaterialTheme.typography.labelSmall,color=com.alpenl.cairn.share.ui.theme.CairnTheme.palette.tertiary)
    }},confirmButton={TextButton(onClick=onDismiss){Text("完成")}})
}
