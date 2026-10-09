import { ext, $, send, renderQueue, status } from './ui.mjs';
import { STATE_KEY, errorText } from './config.mjs';
import { BATCH_KEY, BATCH_ORIGINS } from './batch.mjs';
let state={status:'idle',tasks:[]},visible=100,busy=false;
const labels={waiting:'等待采集',opening:'正在加载',capturing:'正在采集',captured:'已采集',failed:'需处理',skipped:'已跳过'};
function draw() {
  const tasks=state.tasks,done=tasks.filter(t=>['captured','failed','skipped'].includes(t.status)).length;
  const failures=tasks.filter(t=>t.status==='failed').length;
  $('phase').textContent=({idle:'准备就绪',running:state.listed?'采集中':'正在扫描收藏库',paused:'已暂停',done:tasks.length?'本轮采集结束':'没有待采集的正文'})[state.status];
  $('count').textContent=tasks.length?`${done} / ${tasks.length}`:'';
  $('progress').max=Math.max(1,tasks.length);$('progress').value=done;
  if(state.status==='running'&&!state.listed)$('progress').removeAttribute('value');
  const current=tasks.find(t=>['opening','capturing'].includes(t.status));
  const message=state.reason?errorText(state.reason):state.status==='running'?(current?.title||current?.url||'正在准备下一篇…'):state.status==='done'?(tasks.length?'本轮已处理完。上传会继续；需要处理的页面可以打开原链接后重试。':'手机新增收藏后，可以再次扫描。'):state.status==='paused'?'可随时继续。已采集的内容继续上传。':'点击开始，扫描所有缺少正文的收藏。';
  if($('detail').textContent!==message)$('detail').textContent=message;
  $('start').hidden=state.status==='running';$('start').textContent=state.status==='idle'?'一键采集所有待办':'重新扫描待采集';
  $('resume').hidden=state.status!=='paused';$('pause').hidden=state.status!=='running';
  $('retry-failed').hidden=!failures||state.status==='running';
  $('totals').textContent=`已采集 ${tasks.filter(t=>t.status==='captured').length} · 需处理 ${failures} · 跳过 ${tasks.filter(t=>t.status==='skipped').length}`;
  const rows=[];
  // Keep active/failed tasks visible even for a library with thousands of links.
  const ordered=[...tasks].sort((a,b)=>({opening:0,capturing:0,failed:1,waiting:2}[a.status]??3)-({opening:0,capturing:0,failed:1,waiting:2}[b.status]??3));
  for(const task of ordered.slice(0,visible)){
    const row=document.createElement('div');row.className='batch-task';
    const link=document.createElement('a');link.textContent=task.title||task.url;
    try {if(/^https?:$/.test(new URL(task.url).protocol))link.href=task.url;}catch{}
    link.target='_blank';link.rel='noopener noreferrer';
    const label=document.createElement('span');label.textContent=labels[task.status];label.dataset.status=task.status;
    const info=document.createElement('small');info.textContent=task.status==='skipped'?'原收藏已删除、已有正文或已变更，自动跳过。':task.error?errorText(task.error):task.title?task.url:'';
    row.append(link,label,info);rows.push(row);
  }
  $('tasks').replaceChildren(...rows);$('more').hidden=visible>=tasks.length;
}
async function refresh(){
  [state]=await Promise.all([send('batch-snapshot'),send('snapshot').then(s=>{
    renderQueue($('queue'),s.queue,refresh,e=>status($('status'),errorText(e.kind),'error'),'所有已采集内容均已同步。');
    $('pending-count').textContent=String(s.queue.length);$('retry-all').hidden=!s.queue.length;
  })]);draw();
}
async function retry(id){await send('retry',{client_id:id});await refresh();}
async function run(mode){
  if(busy)return;
  if(mode==='new' && state.status==='paused' && !confirm('重新扫描会替换本轮未采集的任务。已采集内容和收藏库中的链接会保留。继续吗？'))return;
  busy=true;
  try {
    // Must run directly inside the click gesture, before any awaited message.
    if(!await ext.permissions.request({origins:BATCH_ORIGINS}))throw {kind:'batch_permission'};
    state=await send('batch-start',{mode});status($('status'),'');draw();
  }catch(e){status($('status'),errorText(e.kind),'error');}finally{busy=false;}
}
$('start').onclick=()=>run('new');$('resume').onclick=()=>run('resume');$('retry-failed').onclick=()=>run('retry');
$('pause').onclick=async()=>{try {state=await send('batch-pause');draw();}catch(e){status($('status'),errorText(e.kind),'error');}};
$('more').onclick=()=>{visible+=100;draw();};
$('retry-all').onclick=()=>retry().catch(e=>status($('status'),errorText(e.kind),'error'));
ext.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes[BATCH_KEY]||changes[STATE_KEY]))void refresh().catch(()=>{});});
void refresh().catch(e=>status($('status'),errorText(e.kind),'error'));
