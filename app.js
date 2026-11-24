'use strict';
const $ = (id) => document.getElementById(id);
let state = {abilities: {}, tasks: [], schedules: [], events: []};
let editingAbility = null;
let refreshActive;
let lastSnapshot = '';
let providerOptions = null;
const settingsDirty = new Set();
const settingsEditCount = {};
const settingsScopes = ['device','voice','model','search','privacy'];
let settingsSaving = false;
let settingsRevision = 0;
let savedSettings;
let serverStatus = null;
let consoleView = 'home';
let practiceAvailable = false;
let roomAudio;
let roomAudioDirty = false;
let roomAudioPending = false;
let roomAudioRead = 0;
let lastActivityPage;
const titles = {
  home: ['系统总览', '配置服务、管理能力，了解喜悦的运行情况。'],
  system: ['系统配置', '选择语音与模型服务，配置外部 Agent 和基础设置。'],
  abilities: ['能力中心', '查看和配置音箱提供的能力。'],
  'device-status': ['设备状态', '查看语音助手当前状态和服务最近一次调用结果。'],
  usage: ['用量', '查看第三方服务调用和费用估算。'],
  dialogues: ['对话记录', '按日期范围查看语音对话。'],
  tasks: ['待办', '记录和完成要做的事。'],
  timers: ['倒计时', '开始倒计时、查看剩余时间或停止响铃。'],
  alarms: ['闹钟', '管理响铃时间、重复方式和稍后提醒。'],
  automation: ['自动化', '设置触发条件和动作，查看执行结果。']
};
const statusNames = {waiting: '等待确认', timer: '计时中', paused: '已暂停', done: '已完成', cancelled: '已取消', running: '进行中'};
function el(tag, text, className) {const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e;}
function button(text, handler, cls = '') {const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', () => handle(handler, b)); return b;}
function toast(text) {$('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => {$('toast').hidden = true;}, 4500);}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {method, headers: {'Content-Type': 'application/json', 'X-Xiyue-Request': 'console'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === '/api/settings/verify' ? 50000 : 10000)});
  if (!response.ok) {let message = '操作失败，请重试'; try {message = (await response.json()).error || message;} catch {} throw new Error(message);}
  return response.json();
}
async function handle(fn, b) {if (b) b.disabled = true; try {await fn();} catch (e) {toast(e.message);} finally {if (b) b.disabled = false;}}
function page(name) {
  let settingsTab = name.startsWith('settings/') ? name.slice(9) : 'device';
  if (settingsTab === 'dialogue') settingsTab = 'voice';
  if (!settingsScopes.includes(settingsTab)) settingsTab = 'device';
  if (name.startsWith('settings/')) name = 'system';
  if (name === 'schedules') {
    name = 'automation';
    showAutomation('rules');
  }
  const custom = name.startsWith('capability/') && state.abilities[name.slice('capability/'.length)];
  const customPage = name.startsWith('capability/');
  const target = customPage ? 'capability' : titles[name] ? name : 'home';
  consoleView = target;
  if ((target === 'timers' || target === 'alarms') && state.features?.[target] === false) {
    location.hash = 'abilities';
    return;
  }
  const title = customPage ? [custom?.manifest.name || '能力', custom?.manifest.description || ''] : titles[target];
  document.querySelectorAll('.page').forEach(p => {p.hidden = p.id !== target;});
  document.querySelectorAll('[data-page]').forEach(button=>{
    const active=button.dataset.page===name;
    button.classList.toggle('selected',active);
    if(active)button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  $('page-title').textContent = title[0]; $('page-subtitle').textContent = title[1];
  if (target === 'alarms' && state.settings) initializeAlarmTime();
  if (target === 'capability') renderCustomCapability(custom);
  if (target === 'system') {
    for (const panel of document.querySelectorAll('[data-settings-scope]')) panel.hidden = panel.dataset.settingsScope !== settingsTab;
    for (const link of document.querySelectorAll('[data-settings-tab]')) {
      if (link.dataset.settingsTab === settingsTab) link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    }
  }
  $('new-task').hidden = target !== 'tasks';
  $('http-open').hidden = target !== 'abilities';
}
function showAutomation(group) {
  for (const b of document.querySelectorAll('[data-automation]')) {
    const selected = b.dataset.automation === group;
    b.setAttribute('aria-pressed', String(selected));
    $(b.getAttribute('aria-controls')).hidden = !selected;
  }
  if (group === 'runs' && state.settings) handle(loadExternalTasks);
}
const voiceStageLabels = {configuration:'配置不完整', capture:'收音失败', cancelled:'语音已取消', local_task:'本地任务创建失败', confirmed_on_device:'已处理登录指令', conversation_ended:'对话已结束', alarm_stopped:'已停止响铃', asr:'识别失败', model:'模型回复失败', playback:'播报失败', completed:'已处理'};
function when(iso, timeZone = state.settings?.timezone) {
  return new Date(iso).toLocaleString('zh-CN', {timeZone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
function active(t) {return !['done', 'cancelled'].includes(t.status);}
function empty(text) {return el('div', text, 'empty');}
function renderTasks() {
  const tasks = [...state.tasks].reverse().filter(task => task.ability_id === 'todo');
  const rows = tasks.map(task => {
    const act = action => async () => {
      await api(`/api/tasks/${task.id}/${action}`, 'POST', {index:task.index,status:task.status});
      await refresh();
    };
    const controls = [];
    if (task.status === 'waiting') controls.push(button('标记完成',act('confirm'),'secondary'));
    if (task.status === 'paused') controls.push(button('继续',act('resume'),'secondary'));
    if (active(task)) controls.push(button('取消',act('cancel'),'secondary'));
    const content = task.steps[0]?.text.replace(/^待办：|。完成后请确认。$/g,'') || task.title;
    return [content,when(task.created_at),task.status === 'waiting' ? '待完成' : statusNames[task.status],controls];
  });
  tableContent('task-list',['事项','创建时间','状态','操作'],rows,'还没有待办。');
}
// These device-owned manifests predate the flow library. Imported manifests
// contain only declarative steps and belong to the flow list.
const builtinAbilityIDs = new Set(['todo', 'reminder', 'quick-timer']);
const clockCapabilities = {
  timers: ['倒计时','按时长倒数，到点响铃。'],
  alarms: ['闹钟','按时间响铃，支持重复与稍后提醒。']
};
function tableContent(id, headings, rows, emptyText, className = '') {
  if (!rows.length) {$(id).replaceChildren(empty(emptyText));return;}
  const wrap = el('div',undefined,'desktop-table');
  const table = el('table',undefined,className);
  const head = table.createTHead().insertRow();
  for (const name of headings) {
    const col = el('th',name);
    col.scope = 'col';
    head.append(col);
  }
  const body = table.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) {
      const cell = row.insertCell();
      if (Array.isArray(value)) {
        const actions = el('div',undefined,'table-actions');
        actions.append(...value);
        cell.append(actions);
      } else if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? '—';
    }
  }
  wrap.append(table);
  $(id).replaceChildren(wrap);
}
function capabilityRow(name, description, status, actions) {
  const info = el('div', undefined, 'capability-info');
  info.append(el('strong', name), el('p', description));
  for (const action of actions) action.classList.replace('secondary','table-link');
  return [info, status, actions];
}
function renderCapabilityTable(id, rows, emptyText) {
  tableContent(id,['名称','状态','操作'],rows,emptyText,'capability-table');
}
function savedAbilityRow(a) {
  const m = a.manifest;
  const status = el('span', a.enabled ? '已启用' : '未启用', a.enabled ? 'badge' : 'badge paused');
  const description = m.id === 'quick-timer' ? '设置倒计时，到点响铃。' : m.description;
  const detail = button('详情', () => openConfig(m.id), 'secondary');
  detail.setAttribute('aria-label', `查看${m.name}详情`);
  return capabilityRow(m.name, description, status, [detail]);
}
function renderAbilities() {
  const abilities = Object.values(state.abilities).sort((a,b) => a.manifest.id.localeCompare(b.manifest.id));
  const custom = abilities.filter(a => a.manifest.menu && !builtinAbilityIDs.has(a.manifest.id));
  const flows = abilities.filter(a => !a.manifest.menu && !builtinAbilityIDs.has(a.manifest.id));
  const roomBadge = el('span', '', 'badge');
  roomBadge.id = 'room-audio-badge';
  const detail = button('配置与控制', openRoomAudio, 'secondary');
  detail.setAttribute('aria-label', '远程听音配置与控制');
  const roomRow = capabilityRow('远程听音', '在音箱播放局域网收音设备的实时声音。', roomBadge, [detail]);
  const clockRows = Object.entries(clockCapabilities).map(([id,[name,description]]) => {
    const enabled = state.features?.[id] !== false;
    const toggle = button(enabled ? '停用' : '启用',async () => {
      await api('/api/features/'+id,'PUT',{enabled:!enabled});
      await refresh();
    },'secondary');
    const actions = enabled ? [button('管理',() => {location.hash=id;},'secondary'),toggle] : [toggle];
    return capabilityRow(name,description,el('span',enabled?'已启用':'未启用',enabled?'badge':'badge paused'),actions);
  });
  const practice = state.settings?.practice_enabled;
  const practiceStatus = practice ? (practiceAvailable ? '已启用' : '待配置') : '未启用';
  const practiceRow = capabilityRow('外语陪练', '用选定语言练习口语和情景对话。', el('span', practiceStatus,practiceStatus==='已启用'?'badge':practiceStatus==='待配置'?'badge waiting':'badge paused'),
    [button('配置', openPractice, 'secondary')]);
  const haConnected = networkConfig?.home_assistant && networkConfig?.ha_key;
  const haRow = capabilityRow('Home Assistant', '读取已选择的设备状态，将灯和开关接入自动化。',
    el('span', !networkConfig ? '读取中' : haConnected ? '已配置' : '未连接',haConnected?'badge info':'badge paused'),
    [button('配置', () => openHA(), 'secondary')]);
  const tools = (networkConfig?.tools || []).filter(tool=>tool.kind==='http').map(tool=>
    capabilityRow(tool.name,tool.description,el('span',toolChannels(tool),'badge info'),
      [button('配置',()=>openHTTP(tool),'secondary'),button('移除',()=>removeNetworkTool(tool),'secondary')]));
  const example = capabilityRow('HTTP 测试工具', '发出示例 GET 请求并查看返回结果。',
    el('span','手动试运行','badge info'), [button('打开', () => {
      $('http-example-result').hidden = true;
      $('http-example-dialog').showModal();
    }, 'secondary')]);
  renderCapabilityTable('ability-list',[roomRow,...clockRows,practiceRow,haRow,...custom.map(savedAbilityRow),example,...tools],'暂无能力。');
  renderCapabilityTable('flow-list',flows.map(savedAbilityRow),'还没有手动流程。');
  renderCapabilityMenus(custom);
  renderRoomAudioBadge();
}
function navIcon(name) {
  const ns='http://www.w3.org/2000/svg';
  const icon=document.createElementNS(ns,'svg');
  const use=document.createElementNS(ns,'use');
  icon.setAttribute('class','nav-icon');
  icon.setAttribute('aria-hidden','true');
  use.setAttribute('href','#icon-'+name);
  icon.append(use);
  return icon;
}
function renderCapabilityMenus(custom) {
  const routes = Object.entries(clockCapabilities).filter(([id])=>state.features?.[id]!==false)
    .map(([id,[name]])=>[id,name]);
  for (const {manifest,enabled} of custom) {
    if (enabled) routes.push(['capability/'+manifest.id,manifest.name]);
  }
  const links = routes.map(([route,name]) => {
    const link = button('',()=>{location.hash=route;});
    const icon = navIcon({timers:'timer', alarms:'alarm'}[route] || 'abilities');
    link.append(icon, document.createTextNode(' ' + name));
    link.dataset.page=route;
    const selected=location.hash==='#'+route;
    link.classList.toggle('selected',selected);
    if(selected)link.setAttribute('aria-current','page');
    return link;
  });
  $('capability-menu').replaceChildren(...links);
}
function renderCustomCapability(ability) {
  if (!ability?.manifest.menu || !ability.enabled) {
    $('custom-capability-actions').replaceChildren();
    $('custom-capability-runs').replaceChildren(empty('此能力未启用。'));
    return;
  }
  const id=ability.manifest.id;
  $('custom-capability-actions').replaceChildren(button('运行',()=>openTask(id,'flow'),'primary'),
    button('配置',()=>openConfig(id),'secondary'));
  renderFlowRuns('custom-capability-runs',state.tasks.filter(task=>task.ability_id===id));
}
function renderRoomAudioBadge(unavailable = false) {
  const badge = $('room-audio-badge');
  if (badge) {
    const stages = {stopped:'已停止', connecting:'连接中', connected:'等待音频', playing:'听音中',
      reconnecting:'重连中', paused:'暂时让行', stopping:'停止中'};
    const label = unavailable ? '状态暂不可用' : !roomAudio ? '读取中' : !roomAudio.available ? '不可用'
      : !roomAudio.config.source && !roomAudio.status.running ? '待配置' : stages[roomAudio.status.stage] || '状态暂不可用';
    badge.textContent = label;
    badge.classList.toggle('paused', unavailable || !roomAudio?.status.running);
  }
  $('stat-abilities').textContent = Object.values(state.abilities)
    .filter(a => a.manifest.menu && a.enabled).length +
    Object.keys(clockCapabilities).filter(id=>state.features?.[id]!==false).length +
    Number(Boolean(roomAudio?.available && roomAudio.config.source)) + Number(Boolean(state.settings?.practice_enabled && practiceAvailable));
}
async function openRoomAudio() {
  $('room-audio-dialog').showModal();
  try {await loadRoomAudio();}
  catch (error) {$('room-audio-status').textContent = error.message;}
}
function roomAudioDraft() {
  return {name: $('room-audio-name').value.trim(), source: $('room-audio-source').value.trim(),
    volume: $('room-audio-volume').valueAsNumber, username: $('room-audio-username').value.trim(),
    password: $('room-audio-password').value};
}
function renderRoomAudio() {
  renderRoomAudioBadge();
  if (!roomAudio) return;
  const {available, config, status} = roomAudio;
  if (!roomAudioDirty) {
    $('room-audio-name').value = config.name || '';
    $('room-audio-source').value = config.source;
    $('room-audio-volume').value = config.volume;
    $('room-audio-username').value = config.username || '';
    $('room-audio-password').value = '';
  }
  for (const field of ['name','source','volume','username','password']) $('room-audio-'+field).disabled = status.running || roomAudioPending;
  const draft = roomAudioDraft();
  const savedPassword = roomAudio.password_configured && draft.source === config.source && draft.username === config.username;
  $('room-audio-password').placeholder = savedPassword ? '已保存，留空沿用' : '';
  $('room-audio-auth-note').textContent = savedPassword
    ? '留空沿用已保存的密码。清空用户名并保存可取消登录。'
    : '按 IP Webcam 中设置的用户名和密码填写。更换地址或用户名后，请重新输入密码。';
  $('room-audio-save').disabled = roomAudioPending || status.running || !roomAudioDirty;
  $('room-audio-verify').disabled = roomAudioPending || status.running || !roomAudioDraft().source;
  $('room-audio-play').disabled = roomAudioPending || status.stage === 'stopping' ||
    (!status.running && (!available || !draft.source));
  $('room-audio-play').textContent = status.running ? '停止听音' : '开始听音';
  const labels = {stopped: '已停止', connecting: '正在连接收音设备', connected: '已连接，等待音频数据',
    playing: '正在向音箱送音', reconnecting: '音频流中断或不可用，正在重连',
    paused: '已让行，等待音箱空闲', stopping: '正在停止'};
  const label = available ? [status.running ? status.name : config.name, labels[status.stage] || '状态暂不可用', status.problem].filter(Boolean).join(' · ')
    : '此设备没有可用的本地播放入口';
  if ($('room-audio-status').textContent !== label) $('room-audio-status').textContent = label;
  $('room-audio-last').textContent = status.last_audio_at
    ? '最近收到音频数据 ' + new Date(status.last_audio_at).toLocaleTimeString('zh-CN', {timeZone: state.settings?.timezone}) : '';
}
async function loadRoomAudio() {
  const read = ++roomAudioRead;
  const next = await api('/api/room-audio');
  if (read !== roomAudioRead) return;
  roomAudio = next;
  renderRoomAudio();
}
async function roomAudioAction(action) {
  if (roomAudioPending) return;
  roomAudioPending = true;
  roomAudioRead++;
  renderRoomAudio();
  try {await action();}
  finally {roomAudioPending = false; renderRoomAudio();}
}
$('room-audio-form').addEventListener('input', () => {
  roomAudioDirty = true;
  $('room-audio-check').hidden = true;
  renderRoomAudio();
});
$('room-audio-form').addEventListener('submit', event => {
  event.preventDefault();
  handle(() => roomAudioAction(async () => {
    const submitted = roomAudioDraft();
    await api('/api/room-audio', 'PUT', submitted);
    roomAudioDirty = false;
    await loadRoomAudio();
    toast('远程听音设置已保存');
  }));
});
$('room-audio-verify').addEventListener('click', () => handle(() => roomAudioAction(async () => {
  if (!$('room-audio-form').reportValidity()) return;
  const check = $('room-audio-check');
  check.hidden = false;
  check.textContent = '正在检查音频格式和数据';
  try {
    const result = await api('/api/room-audio/verify', 'POST', roomAudioDraft());
    check.textContent = `已收到音频数据 · ${result.sample_rate} Hz · ${result.channels} 声道`;
  } catch (e) {
    check.textContent = e.message;
  }
})));
$('room-audio-play').addEventListener('click', () => handle(() => {
  const action = roomAudio.status.running ? 'stop' : 'start';
  if (action === 'start' && !$('room-audio-form').reportValidity()) return;
  const body = action === 'start' ? {config: roomAudioDraft()} : {};
  return roomAudioAction(async () => {
    roomAudio.status = await api(`/api/room-audio/${action}`, 'POST', body);
  });
}));
function renderSchedules() {
  const existing=state.schedules.filter(sc=>!sc.alarm_name && sc.ability_id!=='quick-timer');
  $('legacy-schedules').hidden=!existing.length;
  const rows=existing.map(sc => {
    const waitingRetry = sc.enabled && sc.repeat === 'once' && sc.failure;
    const label = waitingRetry ? '执行失败' : sc.enabled ? '已启用' : '任务已创建';
    const name = state.abilities[sc.ability_id]?.manifest.name || sc.ability_id;
    const frequency = {once:'一次',daily:'每天',weekdays:'工作日'}[sc.repeat];
    const actions = [];
    if (waitingRetry) actions.push(button('重试', async () => {
      await api(`/api/schedules/${sc.id}/retry`, 'POST', {});
      await refresh();
    }, 'secondary'));
    actions.push(button('删除', async () => {await api(`/api/schedules/${sc.id}`, 'DELETE'); await refresh();}, 'secondary'));
    const description = [`${when(sc.next_at, sc.timezone)} · ${frequency} · ${sc.timezone}`, sc.inputs.content, sc.failure]
      .filter(Boolean).join(' · ');
    return capabilityRow(name, description, el('span', label, sc.enabled && !sc.failure ? 'badge' : 'badge paused'), actions);
  });
  renderCapabilityTable('schedule-list',rows,'还没有定时规则。');
}
function localTimeValue(date, timeZone = state.settings?.timezone) {
  const fields = new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(date);
  const t=Object.fromEntries(fields.map(field=>[field.type,field.value]));
  return `${t.year}-${t.month}-${t.day}T${t.hour}:${t.minute}`;
}
function futureLocalTime() {return localTimeValue(new Date(Date.now()+3600000));}
function initializeAlarmTime() {
  const date=$('alarm-form').elements.local_time;
  if (!date.value) date.value=futureLocalTime();
}
let editingAlarm = '';
function editAlarm(alarm) {
  const form=$('alarm-form');
  form.reset();
  editingAlarm=alarm?.id||'';
  if(alarm) {
    form.elements.name.value=alarm.alarm_name;
    form.elements.repeat.value=alarm.repeat;
    const next=new Date(alarm.next_at);
    form.elements.local_time.value=next.getTime()>Date.now()?localTimeValue(next):futureLocalTime();
    form.elements.name.focus();
  } else initializeAlarmTime();
  $('alarm-save').textContent=alarm?'保存闹钟':'添加闹钟';
  $('alarm-edit-cancel').hidden=!alarm;
}
function renderClocks() {
  const alertIDs = new Set(state.events.filter(e=>e.clock_id&&e.delivery==='playing').map(e=>e.clock_id));
  const clockAction = (id,action)=>async()=>{await api(`/api/clocks/${id}/${action}`,'POST',{});await refresh();};
  for (const kind of ['timer','alarm']) {
    const rows=[...state.schedules].reverse()
      .filter(sc=>kind==='alarm'?sc.alarm_name:sc.ability_id==='quick-timer')
      .map(sc=>{
        const ringing=alertIDs.has(sc.id);
        let status=ringing?'响铃中':sc.snooze_at?'稍后提醒':sc.enabled?
          (kind==='timer'?'计时中':'已启用'):sc.repeat==='once'&&new Date(sc.next_at)<Date.now()?'已结束':'已停用';
        if (sc.failure) status=sc.failure;
        const actions=[];
        if (ringing) {
          actions.push(button('停止响铃',clockAction(sc.id,'dismiss'),'secondary'));
          if (kind==='alarm') actions.push(button('稍后 5 分钟',clockAction(sc.id,'snooze'),'secondary'));
        }
        if (kind==='alarm'&&!ringing&&status!=='已结束') {
          actions.push(button(sc.enabled?'停用':'启用',clockAction(sc.id,sc.enabled?'disable':'enable'),'secondary'));
        }
        if (kind==='alarm'&&!ringing) actions.push(button('编辑',()=>editAlarm(sc),'secondary'));
        actions.push(button(kind==='timer'&&sc.enabled?'取消':'删除',clockAction(sc.id,'remove'),'secondary'));
        const due = sc.snooze_at || sc.next_at;
        const details = kind==='alarm' ? repeatNames[sc.repeat] : sc.enabled && !ringing ? el('span','') : '—';
        if (details instanceof Node) details.dataset.due=due;
        const name=sc.alarm_name||sc.inputs?.content?.replace(/，?计时结束。$/,'')||'倒计时';
        return [name,when(due,sc.timezone),details,status,actions];
      });
    tableContent(kind+'-list',['名称',kind==='alarm'?'响铃时间':'预计结束',kind==='alarm'?'重复':'剩余','状态','操作'],rows,
      kind==='alarm'?'还没有闹钟。':'还没有倒计时。');
  }
}
$('timer-form').addEventListener('submit',event=>{
  event.preventDefault();
  handle(async()=>{
    const form=$('timer-form').elements;
    const seconds=form.hours.valueAsNumber*3600+form.minutes.valueAsNumber*60+form.seconds.valueAsNumber;
    await api('/api/clocks/timer','POST',{name:form.name.value,seconds});
    await refresh();
  },event.submitter);
});
$('alarm-form').addEventListener('submit',event=>{
  event.preventDefault();
  handle(async()=>{
    const form=$('alarm-form').elements;
    await api('/api/clocks/alarm'+(editingAlarm?'/'+editingAlarm:''),editingAlarm?'PUT':'POST',
      {name:form.name.value,local_time:form.local_time.value,repeat:form.repeat.value});
    editAlarm();
    await refresh();
  },event.submitter);
});
$('alarm-edit-cancel').addEventListener('click',()=>editAlarm());

const repeatNames={once:'一次',daily:'每天',weekdays:'工作日'};
const ruleActions={room_start:'开始远程听音',room_stop:'停止远程听音',speak:'播报文字',timer:'启动倒计时',flow:'运行已启用的流程',http_tool:'调用连接工具'};
const ruleResults={running:'运行中',completed:'已执行',failed:'失败',skipped:'已跳过',interrupted:'已中断'};
function renderAutomation() {
  const rules=state.rules||[];
  const rows=rules.map(rule=>{
    const schedule=rule.schedule;
    const invoke=action=>async()=>{await api('/api/automation/'+rule.id+'/'+action,'POST',{});await refresh();};
    const actions=[button('编辑',()=>openRule(rule),'secondary'),button('立即运行',invoke('run'),'secondary'),
      button(schedule.enabled?'停用':'启用',invoke(schedule.enabled?'disable':'enable'),'secondary'),
      button('删除',async()=>{if(window.confirm('删除这条规则？'))await invoke('remove')();},'secondary')];
    if (rule.runs?.[0]?.status==='running') for (const item of actions) item.disabled=true;
    const conditions={room_on:'听音开启时',room_off:'听音停止时'};
    return [rule.name,repeatNames[schedule.repeat]+' · '+when(schedule.next_at,schedule.timezone),
      conditions[rule.condition]||'无条件',rule.actions.map(step=>ruleActions[step.action]).join(' → '),schedule.enabled?'已启用':'已停用',
      ruleResults[rule.runs?.[0]?.status],actions];
  });
  tableContent('rule-list',['规则','下次执行','条件','动作','状态','上次执行','操作'],rows,'还没有自动化规则。');
  const runs=rules.flatMap(rule=>(rule.runs||[]).map(run=>({run,name:rule.name})))
    .sort((a,b)=>b.run.at.localeCompare(a.run.at));
  tableContent('rule-runs',['时间','规则','来源','结果','详情'],runs.map(({run,name})=>[
    when(run.at),name,run.source==='manual'?'手动':'定时',ruleResults[run.status],
    [run.step?'动作 '+run.step:'',run.error].filter(Boolean).join(' · ')||'—'
  ]),'还没有规则运行记录。');
  renderFlowRuns('flow-runs',state.tasks.filter(t=>t.ability_id!=='todo'&&t.ability_id!=='quick-timer'&&!state.abilities[t.ability_id]?.manifest.menu));
}
function renderFlowRuns(id,tasks) {
  const rows=[...tasks].reverse().map(task=>{
    const invoke=action=>async()=>{
      await api('/api/tasks/'+task.id+'/'+action,'POST',{index:task.index,status:task.status});
      await refresh();
    };
    const actions=[];
    if (task.status==='waiting') actions.push(button('确认并继续',invoke('confirm'),'secondary'));
    if (task.status==='paused') actions.push(button('继续',invoke('resume'),'secondary'));
    if (task.status==='waiting'||task.status==='timer') actions.push(button('暂停',invoke('pause'),'secondary'));
    if (active(task)) actions.push(button('取消',invoke('cancel'),'secondary'));
    return [task.title,when(task.created_at),statusNames[task.status],task.steps[task.index]?.text,actions];
  });
  tableContent(id,['流程','开始时间','状态','当前步骤','操作'],rows,'还没有流程运行记录。');
}
function appendRuleAction(step) {
  const container=$('rule-actions');
  if(container.children.length>=8)return;
  const row=el('div',undefined,'rule-action-row');
  const choice=el('select');
  choice.setAttribute('aria-label','动作');
  for(const [key,label] of Object.entries(ruleActions)) {
    const option=el('option',label);
    option.value=key;
    choice.append(option);
  }
  const params=el('div',undefined,'rule-params');
  const remove=button('移除',()=>{row.remove();updateRuleActions();},'secondary');
  function showParams() {
    params.replaceChildren();
    if(choice.value==='speak'||choice.value==='timer') {
      const value=el('input');
      value.name='value';
      value.required=choice.value==='speak';
      value.maxLength=choice.value==='speak'?330:40;
      params.append(inputLabel(choice.value==='speak'?'播报内容':'名称（可选）',value));
    }
    if(choice.value==='timer') {
      const seconds=el('input');
      seconds.name='seconds';seconds.type='number';seconds.min=1;seconds.max=86400;seconds.value=60;seconds.required=true;
      params.append(inputLabel('倒计时秒数',seconds));
    }
    if(choice.value==='http_tool') {
      const selection=el('select');
      selection.name='value';selection.required=true;
      const tools=(networkConfig?.tools || []).filter(tool=>tool.automation || tool.id===step?.value);
      selection.append(new Option('选择已授权的工具',''),...tools.map(tool=>new Option(tool.name,tool.id)));
      selection.value=step?.value || '';
      const inputs=el('div',undefined,'field-grid');
      const render=()=>{
        const tool=tools.find(item=>item.id===selection.value);
        inputs.replaceChildren(...(tool?.parameters || []).map(param=>{
          const input=param.type==='boolean'?el('select'):el('input');
          if(param.type==='boolean')input.append(new Option('真','true'),new Option('假','false'));
          if(param.type==='number'){input.type='number';input.step='any';}
          input.dataset.networkArgument=param.name;
          input.required=true;
          if(tool.id===step?.value && step.parameters?.[param.name]!==undefined)input.value=step.parameters[param.name];
          return inputLabel(param.name,input);
        }));
      };
      selection.onchange=render;
      params.append(inputLabel('工具',selection),inputs);
      render();
    }
    if(choice.value==='flow') {
      const selection=el('select');
      selection.name='value';selection.required=true;
      const blank=el('option','选择已有流程');blank.value='';selection.append(blank);
      for(const a of Object.values(state.abilities)) {
        if(!a.enabled||builtinAbilityIDs.has(a.manifest.id)||a.manifest.fields.some(f=>f.required&&!a.config?.[f.key]&&!f.default))continue;
        const option=el('option',a.manifest.name);option.value=a.manifest.id;selection.append(option);
      }
      params.append(inputLabel('流程',selection));
    }
    updateRuleActions();
  }
  choice.onchange=showParams;
  row.append(choice,params,remove);
  container.append(row);
  if(step) choice.value=step.action;
  showParams();
  if(step) {
    const value=params.querySelector('[name=value]');
    if(value) value.value=step.value||'';
    const seconds=params.querySelector('[name=seconds]');
    if (seconds) seconds.value=step.seconds;
  }
}
function updateRuleActions() {
  const rows=[...$('rule-actions').children];
  $('rule-add-action').disabled=rows.length>=8;
  $('rule-privacy-note').hidden=!rows.some(row=>row.firstElementChild.value==='room_start');
  for(const row of rows) row.lastElementChild.disabled=rows.length<=1;
}
let editingRule = '';
async function openRule(rule) {
  await loadNetworkConfig();
  const form=$('rule-form');
  form.reset();
  editingRule=rule?.id||'';
  $('rule-title').textContent=rule?'编辑自动化规则':'新建自动化规则';
  const next=new Date(rule?.schedule.next_at||0);
  form.elements.local_time.value=next.getTime()>Date.now()?localTimeValue(next):futureLocalTime();
  if(rule) {
    form.elements.name.value=rule.name;
    form.elements.repeat.value=rule.schedule.repeat;
    form.elements.condition.value=rule.condition||'';
  }
  form.querySelector('.form-error').textContent='';
  $('rule-actions').replaceChildren();
  if(rule) rule.actions.forEach(appendRuleAction);
  else appendRuleAction();
  $('rule-dialog').showModal();
}
$('rule-add-action').addEventListener('click',()=>appendRuleAction());
$('rule-form').addEventListener('submit',event=>submitForm(event,async()=>{
  const form=$('rule-form');
  const payload=Object.fromEntries(new FormData(form));
  delete payload.value;
  delete payload.seconds;
  payload.actions=[...$('rule-actions').children].map(row=>{
    const step={action:row.firstElementChild.value};
    const value=row.querySelector('[name=value]');
    if(value)step.value=value.value;
    const seconds=row.querySelector('[name=seconds]');
    if(seconds)step.seconds=seconds.valueAsNumber;
    if(step.action==='http_tool')step.parameters=Object.fromEntries([...row.querySelectorAll('[data-network-argument]')].map(input=>[input.dataset.networkArgument,input.value]));
    return step;
  });
  await api(editingRule?'/api/automation/'+editingRule:'/api/automation',editingRule?'PUT':'POST',payload);
}));
function renderEvents() {
  const events = [...state.events].reverse().slice(0, 15);
  $('home-events').replaceChildren(...(events.length ? events.map(event => {
    const box = el('div', undefined, 'event'); const time = el('time', when(event.at)); time.dateTime = event.at;
    box.append(time, el('p', event.text));
    const delivery = {
      pending:'待播报', playing:'正在播报', delivered:'已播报', failed:'播报失败',
      interrupted:'播报被中断', alarm_stopped:'响铃已停止', expired:'提醒已过期', skipped:'任务已暂停或取消',
      queue_full:'播报队列已满', unavailable:'播报服务未就绪'
    }[event.delivery];
    if (delivery) box.append(el('small', delivery, 'muted'));
    return box;
  }) : [empty('任务开始后，喜悦的提示会出现在这里。')]));
}
function updateCountdowns() {document.querySelectorAll('[data-due]').forEach(e => {const remaining = Math.max(0, Math.ceil((new Date(e.dataset.due) - Date.now()) / 1000)); e.textContent = remaining ? `剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒` : '计时到期，正在更新…';});}
function refresh(afterLogin = false) {
  if (refreshActive) return afterLogin ? refreshActive.then(() => refresh()) : refreshActive;
  refreshActive = refreshConsole().finally(() => { refreshActive = null; });
  return refreshActive;
}
async function refreshConsole() {
  try {
    const view=consoleView, hash=location.hash;
    const query=new URLSearchParams({view});
    if (view==='system' && (!providerOptions || !dialogueCatalog)) query.set('catalog','1');
    const frame=await api('/api/console?'+query);
    const session=frame.session;
    const paired = session.authenticated;
    $('connection-error').hidden = true;
    $('owner-logout').hidden = $('owner-management').hidden = !session.required || !paired;
    document.querySelector('body > main').hidden = !paired;
    document.querySelector('body > aside').hidden = !paired;
    if (!paired) {
      serverStatus=null;
      lastActivityPage=undefined;
      lastSnapshot='';
      roomAudioRead++;
      roomAudio = undefined;
      roomAudioDirty = false;
      $('room-audio-source').value = '';
      $('room-audio-name').value = '';
      $('room-audio-username').value = $('room-audio-password').value = '';
      $('room-audio-check').hidden = true;
      if ($('room-audio-dialog').open) $('room-audio-dialog').close();
      $('device-login').hidden = !session.device_voice && !session.device_button;
      $('device-voice').hidden = !session.device_voice;
      $('device-button').hidden = !session.device_button;
      const setup = !session.configured && session.setup_available;
      $('pair-title').textContent = session.configured ? '登录喜悦 Voice' : '设置管理员';
      $('pair-form').hidden = !session.configured && !setup;
      $('owner-install-needed').hidden = session.configured || setup;
      $('pair-form').dataset.mode = setup ? 'setup' : 'login';
      $('setup-repeat-field').hidden = !setup;
      $('setup-repeat-password').required = setup;
      $('owner-password').autocomplete = setup ? 'new-password' : 'current-password';
      $('pair-submit').textContent = setup ? '保存并登录' : '登录';
      if (!setup) $('setup-strength').hidden = true;
      if (!$('pair-dialog').open) $('pair-dialog').showModal();
      return;
    }
    if ($('pair-dialog').open) $('pair-dialog').close();
    if (frame.providers) providerOptions=frame.providers;
    if (frame.languages) dialogueCatalog=frame.languages;
    const next=frame.state;
    serverStatus=frame.status;
    practiceAvailable=frame.practice_available;
    if (view==='home' && consoleView==='home') displayOverviewUsage(frame.usage);
    const snapshot = JSON.stringify(next);
    // Preserve button focus and click targets while polling unchanged state.
    if (snapshot !== lastSnapshot) {state = next; lastSnapshot = snapshot; renderTasks(); renderAbilities(); renderSchedules(); renderClocks(); renderAutomation(); renderEvents(); if (!$("capability").hidden) page(location.hash.slice(1));}
    renderManagement(); updateCountdowns();
    if (hash === location.hash && lastActivityPage !== hash) {lastActivityPage=hash;loadViewData();}
    if (!$("alarms").hidden) initializeAlarmTime();
    if (consoleView==='abilities' && !roomAudioPending) {
      loadRoomAudio().catch(()=>{
        renderRoomAudioBadge(true);
        $('room-audio-status').textContent = '暂时无法获取听音状态';
      });
    }
    if (consoleView==='automation' && !$('automation-runs').hidden)
      handle(loadExternalTasks);
  }
  catch {
    $('connection-error').hidden = false;
    $('runtime-state').textContent = '状态暂不可用';
    $('runtime-uptime').textContent = '';
    $('status-uptime').textContent = '—';
    $('status-memory').textContent = '—';
  }
}
function fieldsFor(ability, container, mode) {
  container.replaceChildren();
  for (const f of ability.manifest.fields) {
    if (mode === 'task' && ['credential_ref', 'secret'].includes(f.kind)) continue;
    const label = el('label', f.label + (f.required ? ' *' : ''));
    const input = el('input'); input.name = f.key; input.type = f.kind === 'number' ? 'number' : f.kind === 'secret' ? 'password' : 'text'; input.dataset.kind = f.kind; input.maxLength = 2000;
    if (input.type === 'number') input.step = 'any';
    input.value = ability.config[f.key] ?? f.default ?? ''; input.required = mode === 'task' && f.required;
    if (f.kind === 'credential_ref') {input.placeholder = 'bitwarden:item:条目UUID'; input.pattern = 'bitwarden:item:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';}
    if (f.kind === 'secret') {input.value = ''; input.autocomplete = 'new-password'; input.placeholder = ability.config[f.key] ? '已配置，留空保留' : '请输入密钥';}
    label.append(input);
    if (f.kind === 'secret' && ability.config[f.key]) {const clear=el('input');clear.type='checkbox';clear.dataset.clearSecret=f.key;const clearLabel=el('label','清除此密钥','check-label');clearLabel.append(clear);container.append(clearLabel);}
    if (f.kind === 'credential_ref') label.append(el('small', '首版只保存 Bitwarden 条目引用，不读取凭证、不接受明文密钥。', 'muted'));
    container.append(label);
  }
}
function fieldValues(container) {return Object.fromEntries([...container.querySelectorAll('input:not([data-kind=secret]):not([data-clear-secret])')].map(i => [i.name, i.value]));}
function openTask(abilityID = 'todo', context = 'task') {
  const flow = context === 'flow';
  const choices = Object.values(state.abilities).filter(a => a.enabled && a.manifest.id === abilityID);
  if (!choices.length) {toast('请先启用所选能力'); return;}
  $('task-ability').value = abilityID;
  $('task-form').querySelector('.form-error').textContent = '';
  $('task-title').textContent = flow ? '运行流程' : '添加待办';
  fieldsFor(choices[0], $('task-fields'), 'task');
  $('task-dialog').showModal();
}
function openConfig(id) {
  editingAbility = id; const a = state.abilities[id];
  const flow = !builtinAbilityIDs.has(id);
  $('config-title').textContent = a.manifest.name;
  $('config-description').textContent = id === 'quick-timer' ? '设置倒计时，到点响铃。' : a.manifest.description;
  $('config-enable-label').textContent = flow ? '启用此流程' : '启用此能力';
  $('flow-steps').hidden = !flow;
  const kinds = {say:'播报',ask:'提问并等待确认',confirm:'等待确认',tone:'提示音',timer:'计时'};
  $('flow-steps').replaceChildren(...(flow ? a.manifest.steps.map(step =>
    el('li', [kinds[step.kind], step.seconds ? formatDuration(step.seconds) : '', step.text].filter(Boolean).join(' · '))) : []));
  $('config-run').hidden = !a.enabled;
  $('config-run').disabled = false;
  $('config-run').textContent = flow ? '运行流程' : '创建任务';
  $('config-enabled').checked = a.enabled; fieldsFor(a, $('config-fields'), 'config');
  $('config-form').querySelector('.form-error').textContent = ''; $('config-dialog').showModal();
}
async function submitForm(event, fn) {
  event.preventDefault(); const form = event.currentTarget; const b = form.querySelector('[type=submit]'); b.disabled = true;
  try {await fn(); form.closest('dialog').close(); await refresh(); toast('已保存');}
  catch (e) {form.querySelector('.form-error').textContent = e.message;}
  finally {b.disabled = false;}
}
$('task-form').addEventListener('submit', e => submitForm(e, () => api('/api/tasks','POST',{
  ability_id:$('task-ability').value,inputs:fieldValues($('task-fields'))
})));
$('config-form').addEventListener('submit', e => submitForm(e, () => api(`/api/abilities/${editingAbility}`, 'PUT', {enabled: $('config-enabled').checked, config: fieldValues($('config-fields')), secrets: Object.fromEntries([...$('config-fields').querySelectorAll('input[data-kind=secret]')].filter(i => i.value).map(i => [i.name,i.value])), clear_secrets: [...$('config-fields').querySelectorAll('input[data-clear-secret]:checked')].map(i=>i.dataset.clearSecret)})));
$('config-run').addEventListener('click', () => {
  $('config-dialog').close();
  openTask(editingAbility, builtinAbilityIDs.has(editingAbility) ? 'task' : 'flow');
});
$('config-form').addEventListener('input', () => {$('config-run').disabled = true;});
$('new-task').addEventListener('click', () => openTask());
$('new-schedule').addEventListener('click', event => handle(() => openRule(),event.currentTarget));
$('import-ability').addEventListener('click', () => $('ability-file').click());
$('ability-file').addEventListener('change', () => handle(async () => {
  const file = $('ability-file').files[0]; if (!file) return;
  try {
    if (file.size > 128 * 1024) throw new Error('流程文件不能超过 128 KB');
    const manifest = JSON.parse(await file.text());
    if (builtinAbilityIDs.has(manifest?.id)) throw new Error('此流程使用了系统保留的 ID');
    const {id} = await api('/api/abilities', 'POST', manifest);
    await refresh();
    showAutomation('flows');
    if (state.abilities[id]) openConfig(id);
    toast('流程已导入');
  }
  finally {$('ability-file').value = '';}
}));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => {location.hash = b.dataset.page;}));
document.querySelectorAll('[data-automation]').forEach(b => b.addEventListener('click', () => showAutomation(b.dataset.automation)));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {location.hash = b.dataset.go;}));
const mobileNav=$('mobile-nav-toggle');
function setMobileNav(expanded) {
  mobileNav.setAttribute('aria-expanded',String(expanded));
  $('console-nav').classList.toggle('is-expanded',expanded);
}
mobileNav.addEventListener('click',()=>setMobileNav(mobileNav.getAttribute('aria-expanded')!=='true'));
$('console-nav').addEventListener('click',event=>{
  if(event.target.closest('[data-page]'))setMobileNav(false);
});
window.addEventListener('hashchange', () => {page(location.hash.slice(1));refresh(true);});

const serviceNames = {asr:'语音识别 ASR',llm:'大模型 LLM',tts:'语音合成 TTS',external:'外部 Agent'};
function formatDuration(seconds) {return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;}
function setupStep(config) {
  const llmReady = config.llm.endpoint && config.llm.model;
  const externalReady = config.external.endpoint;
  const modeReady = config.mode === 'external' ? externalReady :
    llmReady && (config.mode !== 'hybrid' || externalReady);
  if (serverStatus?.voice?.available) {
    if (config.device_setup_complete) return null;
    const asrReady = config.asr.provider === 'doubao'
      ? config.asr.key_configured && !config.asr.endpoint
      : config.asr.provider === 'sensevoice' && config.asr.endpoint;
    if (!asrReady) return 'configure_asr';
    if (['doubao','deepseek'].includes(config.tts.provider) && (!serverStatus.voice.cloud_tts_available || !config.tts.key_configured || !config.tts.model)) return 'configure_tts';
    if (modeReady) return 'verify_device';
    return 'configure';
  }
  if (config.setup_complete) return null;
  if (modeReady && (config.mode === 'external' || (config.updated_at &&
      (config.llm.key_configured || config.llm.provider.startsWith('custom'))))) return 'verify';
  return 'configure';
}
function renderManagement() {
  const config = state.settings; if (!config) return;
  const device = serverStatus.device;
  $('device-name').textContent = device?.name || device?.model || '喜悦音箱';
  $('setting-device').textContent = [device?.name, device?.model, device?.firmware].filter(Boolean).join(' · ') || '型号待确认';
  $('asr-unavailable').textContent = serverStatus.voice?.available ? '' : '自动唤醒尚未接通，可单独验证识别。';
  $('tts-system-summary').textContent = serverStatus.voice?.available ? '' : '自动唤醒尚未接通，可单独验证播报。';
  $('runtime-version').textContent = `版本 ${serverStatus.version}`;
  $('runtime-state').textContent = '运行中';
  $('runtime-uptime').textContent = `已运行 ${formatDuration(serverStatus.uptime_seconds)}`;
  $('status-uptime').textContent = formatDuration(serverStatus.uptime_seconds);
  if (serverStatus.memory_bytes!==undefined)
    $('status-memory').textContent = `${(serverStatus.memory_bytes / 1024 / 1024).toFixed(1)} MiB（非进程总内存 / 整机内存）`;
  const services = serverStatus.services || {};
  const rows = ['asr','llm','tts','external'].filter(name => services[name]).map(name => {
    const value = services[name];
    const use = value.last_use;
    const configured = value.state === 'disabled' ? '设备未启用语音'
      : value.state === 'not_configured' ? '未配置' : '已配置';
    const outcome = !use ? '无使用记录'
      : use.success ? (name === 'tts' && value.provider === 'system' ? '已交给系统播报' : '成功') : '失败';
    return [serviceNames[name], configured, use ? outcome + (use.current_config ? '' : '（配置变更前）') : outcome,
      use ? when(use.at) : '—'];
  });
  tableContent('service-status',['服务','配置','最近实际调用','时间'],rows,'暂无服务状态。');
  const voice = serverStatus.voice;
  $('voice-monitor').hidden = !voice?.available;
  if (voice?.available) {
    const last = voice.last_turn?.revision === config.revision ? voice.last_turn : null;
    const stage = voiceStageLabels;
    const current = voice.alarm_ringing ? '正在响铃' : voice.listening_followup ? '等待你继续说话' : voice.busy
      ? '正在处理语音' : voice.wake_detector_ready ? '待唤醒 · 说「' + config.wake_word + '」' : '唤醒检测未就绪';
    $('voice-state').textContent = current;
    $('voice-timing').textContent = last
      ? '最近一轮：' + (stage[last.stage] || '已结束') + ' · ' + (last.capture_ms ? '收音 ' + last.capture_ms + ' ms · ' : '') + '识别 ' + last.asr_ms + ' ms · 模型 ' + last.model_ms + ' ms · 播报 ' + last.playback_ms + ' ms'
      : '本次启动后暂无当前配置的语音记录。';
  }
  const step = setupStep(config);
  $('first-setup').hidden = !step;
  const service = config.mode === 'external' ? '外部助手' : '大模型';
  const instructions = {
    verify: '已保存配置。点击验证，确认' + service + '能正常回复。',
    verify_device: '对音箱喊「' + config.wake_word + '」并说一句话。成功播报后引导会收起。',
    configure_asr: '选择豆包语音或自建 SenseVoice，再用音箱完成首次语音验证。',
    configure_tts: '补全语音合成配置，或选用音箱系统语音。',
    configure: '选择大模型厂商，填写模型 ID 和 API Key，然后保存。'
  };
  $('setup-next').textContent = instructions[step] || '';
  $('setup-action').hidden = step === 'verify_device';
  $('setup-action').textContent = {verify:'验证服务',configure_asr:'配置语音识别',configure_tts:'配置语音合成',configure:'配置大模型'}[step] || '';
  if (providerOptions && dialogueCatalog && !settingsSaving && settingsDirty.size===0 && settingsRevision!==config.revision) fillSettings(config);
}
function inputLabel(title,input) {const label=el('label',title);label.append(input);return label;}
function updateASRFields() {
  const cloud = $('asr-provider').value === 'doubao';
  $('asr-endpoint-field').hidden = cloud;
  $('asr-endpoint').disabled = cloud;
  $('asr-key-title').textContent = cloud ? '豆包语音 API Key' : '访问凭证（可选）';
  $('asr-cloud-note').hidden = !cloud;
  $('asr-guide').href = '/help.html#' + (cloud ? 'asr-doubao' : 'asr-sensevoice');
}
$('asr-provider').addEventListener('change', updateASRFields);
let dialogueCatalog;
let previousTTSProvider = '';
function draftTTSVoice() {
  const provider = $('tts-provider').value;
  if (provider === 'doubao') return $('tts-voice').value.trim();
  if (provider === 'deepseek') return $('tts-deepseek-voice').value;
  return '';
}
function updateTTSFields() {
  const provider = $('tts-provider').value;
  const cloud = provider !== 'system';
  const switched = previousTTSProvider && previousTTSProvider !== provider;
  previousTTSProvider = provider;
  if (switched) $('tts-key').value = '';
  $('tts-voice-field').hidden = provider !== 'doubao';
  $('tts-deepseek-field').hidden = provider !== 'deepseek';
  $('tts-key-field').hidden = !cloud;
  $('tts-cloud-note').hidden = !cloud;
  $('tts-clear-label').hidden = !savedSettings.tts.key_configured;
  if (switched) $('tts-clear').checked = false;
  $('tts-key-configured').textContent = savedSettings.tts.key_configured
    ? (provider === savedSettings.tts.provider ? '已保存，留空则保留。' : '更换服务时请填写新密钥，或清除原有密钥。') : '';
  $('tts-key-title').textContent = (provider === 'deepseek' ? 'DeepSeek' : '豆包语音')+' API Key';
  $('tts-cloud-note').textContent = cloud ? '回复和提醒的文字会发送给' + (provider === 'deepseek' ? ' DeepSeek。' : '豆包语音。') : '';
  if (provider === 'doubao' && !$('tts-voice').value) $('tts-voice').value = providerOptions.tts.find(item => item.id === 'doubao')?.model || '';
  updateDialogueOptions();
}
function setLanguageOptions(select, languages, selected, reset = '') {
  select.replaceChildren(...dialogueCatalog.languages.filter(item=>languages.includes(item.id)).map(item=>new Option(item.name,item.id)));
  if (languages.includes(selected)) select.value = selected;
  else if (reset) select.value = reset;
  else {select.prepend(new Option('请重新选择回答语言','')); select.value = '';}
}
function updateDialogueOptions() {
  if (!dialogueCatalog || !savedSettings) return;
  const provider = $('tts-provider').value;
  const languages = dialogueCatalog.voices[provider]?.[draftTTSVoice()] || dialogueCatalog.tts[provider] || ['zh'];
  const replies = $('reply-language');
  setLanguageOptions(replies, languages, replies.value);
  const missing = dialogueCatalog.languages.filter(item => !languages.includes(item.id)).map(item => item.name);
  const note = provider === 'system' ? '音箱系统语音当前仅开放普通话。切换到支持目标语言的语音合成服务和音色后即可选择。' :
    missing.length ? '当前语音合成服务或音色不支持：'+missing.join('、')+'。更换支持目标语言的服务和音色后即可选择。' : '';
  $('reply-language-note').textContent = savedSettings.mode === 'external' ?
    '当前为仅外部 Agent 模式。默认回答语言适用于直连大模型和混合模式。 '+note : note;
  const preview = $('tts-preview-language');
  setLanguageOptions(preview, provider === 'system' ? ['zh','en','ja','ko'] : languages, preview.value, 'zh');
  updatePreviewNote();
}
function updatePreviewNote() {
  const experiment = $('tts-provider').value === 'system' && $('tts-preview-language').value !== 'zh';
  $('tts-preview-note').textContent = experiment ? '系统语音的外语能力待验证。这次会把外语原文交给音箱播报。' : '';
}
$('tts-provider').addEventListener('change', updateTTSFields);
$('tts-preview-language').addEventListener('change', updatePreviewNote);
for (const id of ['tts-voice','tts-deepseek-voice']) {
  $(id).addEventListener('input', updateDialogueOptions);
  $(id).addEventListener('change', updateDialogueOptions);
}
const timezoneLabels = {'Asia/Shanghai':'中国 · 北京、上海','Asia/Hong_Kong':'香港','Asia/Taipei':'台北',
  'Asia/Tokyo':'东京','Asia/Singapore':'新加坡','Europe/London':'伦敦','America/New_York':'纽约',
  'America/Los_Angeles':'洛杉矶','UTC':'协调世界时'};
const timezoneInput = $('setting-timezone');
const timezoneList = $('timezone-list');
let chosenTimezone = '';
let matchedTimezones = [];
let highlightedTimezone = -1;

function timezoneText(zone) {
  return timezoneLabels[zone] ? `${timezoneLabels[zone]} · ${zone}` : zone;
}
function closeTimezoneList() {
  timezoneList.hidden = true;
  timezoneInput.setAttribute('aria-expanded', 'false');
  timezoneInput.removeAttribute('aria-activedescendant');
  timezoneInput.value = timezoneText(chosenTimezone);
}
function highlightTimezone(index) {
  if (!matchedTimezones.length) return;
  highlightedTimezone = Math.max(0, Math.min(index, matchedTimezones.length - 1));
  const option = timezoneList.children[highlightedTimezone];
  timezoneInput.setAttribute('aria-activedescendant', option.id);
  for (const [i, row] of Array.from(timezoneList.children).entries()) {
    row.setAttribute('aria-selected', String(i === highlightedTimezone));
  }
  option.scrollIntoView({block:'nearest', inline:'nearest'});
}
function showTimezoneList(query = '') {
  const zones = new Set([...Object.keys(timezoneLabels), ...(Intl.supportedValuesOf?.('timeZone') || []), chosenTimezone].filter(Boolean));
  const term = query.trim().toLowerCase().replaceAll('_', ' ');
  matchedTimezones = [...zones].filter(zone => timezoneText(zone).toLowerCase().replaceAll('_', ' ').includes(term));
  timezoneList.replaceChildren(...matchedTimezones.map((zone, index) => {
    const row = el('li', timezoneText(zone));
    row.id = 'timezone-option-' + index;
    row.setAttribute('role', 'option');
    row.dataset.index = index;
    return row;
  }));
  timezoneList.hidden = false;
  timezoneInput.setAttribute('aria-expanded', 'true');
  timezoneInput.removeAttribute('aria-activedescendant');
  highlightedTimezone = -1;
  if (matchedTimezones.length) highlightTimezone(query ? 0 : matchedTimezones.indexOf(chosenTimezone));
  else timezoneList.append(el('li', '没有匹配的时区', 'timezone-empty'));
}
function chooseTimezone(index) {
  const zone = matchedTimezones[index];
  if (!zone) return;
  const changed = chosenTimezone !== zone;
  chosenTimezone = zone;
  closeTimezoneList();
  if (changed) timezoneInput.dispatchEvent(new Event('change', {bubbles:true}));
}
timezoneInput.addEventListener('focus', () => {
  timezoneInput.select();
  showTimezoneList();
});
timezoneInput.addEventListener('pointerdown', event => {
  if (document.activeElement !== timezoneInput) {
    event.preventDefault();
    timezoneInput.focus();
  }
});
timezoneInput.addEventListener('click', () => {
  if (timezoneList.hidden) {
    timezoneInput.select();
    showTimezoneList();
  }
});
timezoneInput.addEventListener('input', event => {
  if (!event.isComposing) showTimezoneList(timezoneInput.value);
});
timezoneInput.addEventListener('compositionend', () => showTimezoneList(timezoneInput.value));
timezoneInput.addEventListener('blur', closeTimezoneList);
timezoneInput.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (timezoneList.hidden) showTimezoneList();
    else highlightTimezone(highlightedTimezone + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Enter' && !timezoneList.hidden) {
    event.preventDefault();
    chooseTimezone(highlightedTimezone);
  } else if (event.key === 'Escape' && !timezoneList.hidden) {
    event.preventDefault();
    closeTimezoneList();
  }
});
timezoneList.addEventListener('pointerdown', event => {
  if (event.target.closest('[role="option"]')) event.preventDefault();
});
timezoneList.addEventListener('click', event => {
  const row = event.target.closest('[role="option"]');
  if (row) chooseTimezone(Number(row.dataset.index));
});
$('timezone-toggle').addEventListener('pointerdown', event => event.preventDefault());
$('timezone-toggle').addEventListener('click', () => {
  if (!timezoneList.hidden) closeTimezoneList();
  else if (document.activeElement !== timezoneInput) timezoneInput.focus();
  else {
    timezoneInput.select();
    showTimezoneList();
  }
});
function fillSettings(config, scope) {
  settingsRevision=config.revision;
  savedSettings=config;
  if (!scope || scope === 'voice') {
    $('device-asr-fields').hidden = false;
    $('device-tts-fields').hidden = false;
    $('tts-provider').value = ['doubao','deepseek'].includes(config.tts.provider) ? config.tts.provider : 'system';
    previousTTSProvider = $('tts-provider').value;
    $('tts-deepseek-voice').value = config.tts.model === 'tide' ? 'tide' : 'stella';
    $('tts-voice').value = config.tts.provider === 'doubao' ? config.tts.model : '';
    $('tts-key').value = '';
    $('tts-clear').checked = false;
    $('tts-key-configured').textContent = config.tts.key_configured ? '已保存，留空则保留。' : '';
    $('asr-provider').value = config.asr.provider === 'sensevoice' ? 'sensevoice' : 'doubao';
    $('asr-endpoint').value = config.asr.provider === 'sensevoice' ? config.asr.endpoint : '';
    updateASRFields();
    $('asr-key').value = '';
    $('asr-clear').checked = false;
    $('asr-clear-label').hidden = !config.asr.key_configured;
    $('asr-key-configured').textContent = config.asr.key_configured ? '已保存凭证，留空则保留。' : '';
    $('reply-language').replaceChildren(new Option('', config.reply_language || 'zh'));
    updateTTSFields();
  }
  if (!scope || scope === 'device') {
    $('setting-wake').value = config.wake_word;
    chosenTimezone = config.timezone;
    closeTimezoneList();
  }
  updateSettingsSaveBars();
  if (scope && scope !== 'model') return;
  $('setting-mode').value = config.mode;
  if (config.mode !== 'direct') $('advanced-settings').open = true;
  for (const name of ['llm', 'external']) {
    const current = config[name];
    const isModel = name === 'llm';
    const panel = el('section', undefined, isModel ? 'settings-panel' : '');
    panel.id = `settings-${name}`;
    if (isModel) panel.append(el('h2', '大模型 LLM'));
    const grid = el('div', undefined, 'field-grid');

    const provider = el('select');
    provider.id = `${name}-provider`;
    for (const option of providerOptions[name]) {
      const opt = el('option', option.name);
      opt.value = option.id;
      provider.append(opt);
    }
    provider.value = current.provider;

    const endpoint = el('input');
    endpoint.id = `${name}-endpoint`;
    endpoint.type = 'url';
    endpoint.value = current.endpoint;
    endpoint.maxLength = 2000;
    endpoint.placeholder = isModel ? 'https://服务地址/版本前缀' : 'https://连接器地址/v1/chat';

    const model = el('input');
    model.id = `${name}-model`;
    model.value = current.model;
    model.maxLength = 200;
    model.placeholder = '选择预设或输入服务商提供的模型 ID';
    const preset = el('select');
    preset.id = 'llm-model-preset';
    const presetLabel = inputLabel('模型预设', preset);
    function selectMatchingPreset() {
      preset.value = [...preset.options].some(option => option.value === model.value) ? model.value : '';
    }
    preset.addEventListener('change', () => {
      if (preset.value) model.value = preset.value;
      else model.focus();
    });
    model.addEventListener('input', selectMatchingPreset);

    const key = el('input');
    key.id = `${name}-key`;
    key.type = 'password';
    key.autocomplete = 'new-password';
    key.maxLength = 8192;
    key.placeholder = current.key_configured ? '已保存，留空保留' : '';
    const clear = el('input');
    clear.type = 'checkbox';
    clear.id = `${name}-clear`;
    const clearLabel = inputLabel('清除已保存的密钥', clear);
    clearLabel.className = 'check-label';
    clearLabel.hidden = !current.key_configured;

    const note = el('p', undefined, 'muted');
    const help = el('a', '查看配置指南', 'text-button');
    function update() {
      const selected = providerOptions[name].find(option => option.id === provider.value);
      if (isModel) {
        const manual = el('option', '请选择预设，或手动填写模型 ID');
        manual.value = '';
        const options = selected?.models || [];
        preset.replaceChildren(manual, ...options.map(value => {
          const option = el('option', value);
          option.value = value;
          return option;
        }));
        presetLabel.hidden = !options.length;
        selectMatchingPreset();
        help.href = `/help.html#${selected?.id || 'llm'}`;
        note.textContent = selected?.note || '';
      }
    }
    provider.addEventListener('change', () => {
      const selected = providerOptions[name].find(option => option.id === provider.value);
      endpoint.value = selected?.endpoint || '';
      model.value = selected?.model || '';
      key.value = '';
      update();
    });
    if (isModel) {
      grid.append(inputLabel('大模型厂商', provider), presetLabel, inputLabel('模型 ID', model));
    } else {
      provider.hidden = true;
      model.hidden = true;
      grid.append(provider, model);
    }
    grid.append(inputLabel(isModel ? '服务地址（Base URL）' : '连接器调用地址', endpoint),
      inputLabel(isModel ? 'API Key' : '连接器凭证', key));
    const result = el('p', '', 'muted');
    result.setAttribute('role', 'status');
    const verify = button('验证', () => verifySettings(name, result), 'secondary');
    const actions = el('div', undefined, 'service-actions');
    if (isModel) actions.append(help);
    actions.append(verify);
    panel.append(grid, clearLabel, note, actions, result);
    $(isModel ? 'model-settings' : 'external-settings').replaceChildren(panel);
    update();
  }
  updateModeActions();
}
function updateModeActions() {
  const mode = $('setting-mode').value;
  const external = $('external-settings');
  external.hidden = mode === 'direct';
  $('external-endpoint').disabled = external.hidden;
}
$('setting-mode').addEventListener('change', updateModeActions);
$('setup-action').addEventListener('click', () => {
  const step = setupStep(state.settings);
  const voice = step === 'configure_asr' || step === 'configure_tts';
  location.hash = voice ? 'settings/voice' : 'settings/model';
  if (voice) setTimeout(() => $(step === 'configure_asr'?'asr-provider':'tts-provider').focus(), 0);
});
function serviceFormValues(name) {
  if (name === 'asr') {
    const provider = $('asr-provider').value;
    return {provider, endpoint: provider === 'sensevoice' ? $('asr-endpoint').value : '',
      model: provider === 'doubao' ? '' :
        (savedSettings.asr.provider === 'sensevoice' && savedSettings.asr.model) || 'sensevoice',
      api_key: $('asr-key').value, clear_key: $('asr-clear').checked};
  }
  if (name === 'tts') {
    const cloudTTS = $('tts-provider').value !== 'system';
    return {provider: $('tts-provider').value, endpoint: '', model: draftTTSVoice(),
      api_key: cloudTTS ? $('tts-key').value : '', clear_key: $('tts-clear').checked};
  }
  return {provider:$(`${name}-provider`).value, endpoint:$(`${name}-endpoint`).value,
    model:$(`${name}-model`).value, api_key:$(`${name}-key`).value,
    clear_key:$(`${name}-clear`).checked};
}
async function verifySettings(service, output) {
  output.textContent = service === 'asr' ? '正在录音，请对音箱说一句话…' : service === 'tts' ? '正在让音箱播报…' : '正在验证…';
  try {
    const payload = {service, config:serviceFormValues(service)};
    if (service === 'tts') payload.language = $('tts-preview-language').value;
    const result = await api('/api/settings/verify', 'POST', payload);
    if (service === 'asr') output.textContent = '识别结果 · ' + result.text;
    else if (service === 'tts') output.textContent = '已提交播报，请确认音箱有声音。';
    else output.textContent = `验证成功 · ${result.duration_ms} ms`;
  } catch (error) {
    output.textContent = '验证失败 · ' + error.message;
  }
  await refresh();
}
for (const service of ['asr', 'tts']) {
  const control = $(`${service}-verify`);
  control.addEventListener('click', () => handle(() => verifySettings(service, $(`${service}-verify-result`)), control));
}
function updateSettingsSaveBars() {
  for (const scope of ['device','voice','model']) {
    const form = $(`settings-${scope}-form`);
    const dirty = settingsDirty.has(scope);
    form.querySelector('[type=submit]').disabled = settingsSaving || !dirty;
    form.querySelector('.settings-save-state').textContent = dirty ? '此页有未保存的修改' : '';
  }
}
for (const scope of ['device','voice','model']) {
  const form = $(`settings-${scope}-form`);
  function markDirty(event) {
    if ((event.target === timezoneInput && event.type==='input') || event.target.id==='tts-preview-language') return;
    settingsDirty.add(scope);
    settingsEditCount[scope]=(settingsEditCount[scope]||0)+1;
    updateSettingsSaveBars();
  }
  form.addEventListener('input',markDirty);
  form.addEventListener('change',markDirty);
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if (settingsSaving || !settingsDirty.has(scope)) return;
    const error=form.querySelector('.form-error');
    error.textContent='';
    const submittedEdits=settingsEditCount[scope];
    settingsSaving=true;
    updateSettingsSaveBars();
    try {
      const payload={scope,revision:settingsRevision};
      if (scope==='device') Object.assign(payload,{wake_word:$('setting-wake').value,timezone:chosenTimezone});
      if (scope==='voice') Object.assign(payload,{asr:serviceFormValues('asr'),tts:serviceFormValues('tts'),reply_language:$('reply-language').value});
      if (scope==='model') Object.assign(payload,{mode:$('setting-mode').value,llm:serviceFormValues('llm'),external:serviceFormValues('external')});
      const config=await api('/api/settings','PUT',payload);
      if (settingsEditCount[scope]===submittedEdits) {
        settingsDirty.delete(scope);
        fillSettings(config,scope);
      } else {
        savedSettings=config;
        settingsRevision=config.revision;
      }
      await refresh();
      toast('此页配置已保存');
    } catch(e) {error.textContent=e.message;}
    finally {settingsSaving=false;updateSettingsSaveBars();}
  });
}
let externalTaskRevision;
let selectedExternalTask;
let externalRequestID;
let externalRequestMessage;
let externalTaskTimer;
let externalTaskQuery = 0;
async function loadExternalTasks() {
  const revision = state.settings?.revision;
  if (!revision) return;
  const result = await api('/api/external/tasks');
  if (revision !== state.settings?.revision) return;
  externalTaskRevision = revision;
  $('external-tasks').hidden = !result.available;
  if (!result.available) {
    selectedExternalTask = null;
    clearTimeout(externalTaskTimer);
    return;
  }
  const entries = result.tasks.map(task => {
    const row = el('article', undefined, 'task-card');
    row.append(el('strong', when(task.created_at)),button('查看任务', () => showExternalTask(task.id), 'text-button'));
    const details = el('div'); details.dataset.externalTask = task.id; row.append(details);
    return row;
  });
  $('external-task-list').replaceChildren(...entries);
  if (result.tasks.some(task => task.id === selectedExternalTask)) await showExternalTask(selectedExternalTask);
}
async function showExternalTask(id, method = 'GET') {
  selectedExternalTask = id;
  clearTimeout(externalTaskTimer);
  const query = ++externalTaskQuery;
  const row = $('external-task-list').querySelector(`[data-external-task="${id}"]`);
  if (!row) return;
  try {
    const result = await api(`/api/external/tasks/${id}`, method);
    if (query !== externalTaskQuery || !row.isConnected) return;
    const label = {running:'执行中', cancelling:'正在取消', cancelled:'已取消', completed:'已完成', failed:'失败'};
    row.replaceChildren(el('p',label[result.status] || result.status));
    if (result.reply || result.error) row.append(el('pre',result.reply || result.error,'connector-result'));
    if (result.status === 'running') row.append(button('请求取消', () => showExternalTask(id,'DELETE'), 'text-button'));
    if (['running','cancelling'].includes(result.status) && !$('tasks').hidden) {
      externalTaskTimer = setTimeout(() => {
        if (!$('tasks').hidden) showExternalTask(id);
      }, 5000);
    }
  } catch (error) {
    if (query === externalTaskQuery && row.isConnected) row.replaceChildren(el('p',error.message,'form-error'));
  }
}
$('external-task-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  const message = $('external-task-message').value.trim();
  $('external-task-error').textContent = '';
  if (message !== externalRequestMessage || !externalRequestID) {
    externalRequestMessage = message;
    externalRequestID = crypto.randomUUID().replaceAll('-', '');
  }
  try {
    const result = await api('/api/external/tasks','POST',{message,request_id:externalRequestID});
    selectedExternalTask = result.id;
    externalRequestID = null;
    $('external-task-message').value = '';
    await loadExternalTasks();
  } catch (error) {
    $('external-task-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
let deviceLoginAttempt;
function stopDeviceLogin(message = '') {
  clearTimeout(deviceLoginAttempt?.timer);
  deviceLoginAttempt = null;
  $('device-login-actions').hidden = false;
  $('device-login-cancel').hidden = true;
  $('device-login-time').textContent = '';
  $('device-login-hint').textContent = message;
}
async function pollDeviceLogin(attempt) {
  if (deviceLoginAttempt !== attempt) return;
  const seconds = Math.ceil((attempt.expiry - Date.now()) / 1000);
  if (seconds <= 0) {
    stopDeviceLogin('确认已超时，请重新发起。');
    return;
  }
  $('device-login-time').textContent = `剩余 ${seconds} 秒`;
  try {
    const result = await api('/api/session/device/claim', 'POST', {});
    if (deviceLoginAttempt !== attempt) return;
    if (result.authenticated) {
      stopDeviceLogin();
      await refresh(true);
    } else {
      attempt.timer = setTimeout(() => pollDeviceLogin(attempt), 1000);
    }
  } catch (error) {
    if (deviceLoginAttempt === attempt) stopDeviceLogin(error.message);
  }
}
for (const method of ['voice', 'button']) {
  $(`device-${method}`).addEventListener('click', async () => {
    if (deviceLoginAttempt) return;
    const attempt = {};
    deviceLoginAttempt = attempt;
    $('device-login-actions').hidden = true;
    $('device-login-hint').textContent = '正在发送确认请求…';
    try {
      const result = await api('/api/session/device', 'POST', {method});
      if (deviceLoginAttempt !== attempt) return;
      attempt.expiry = Date.now() + result.seconds * 1000;
      $('device-login-hint').textContent = result.hint;
      $('device-login-cancel').hidden = false;
      await pollDeviceLogin(attempt);
    } catch (error) {
      if (deviceLoginAttempt === attempt) stopDeviceLogin(error.message);
    }
  });
}
$('device-login-cancel').addEventListener('click', async () => {
  const attempt = deviceLoginAttempt;
  if (!attempt) return;
  clearTimeout(attempt.timer);
  deviceLoginAttempt = null;
  try {
    await api('/api/session/device', 'DELETE', {});
    stopDeviceLogin();
  } catch (error) {
    stopDeviceLogin(error.message);
  }
});

$('pair-dialog').addEventListener('cancel', event => event.preventDefault());
$('pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  const label = submit.textContent;
  submit.textContent = '正在登录…';
  $('pair-error').textContent = '';
  try {
    const payload = {username: $('owner-name').value, password: $('owner-password').value};
    const setup = $('pair-form').dataset.mode === 'setup';
    if (setup && payload.password !== $('setup-repeat-password').value) {
      $('pair-error').textContent = '两次输入的密码不一致。';
      return;
    }
    await api(setup ? '/api/session/setup' : '/api/session/login', 'POST', payload);
    $('owner-password').value = '';
    $('setup-repeat-password').value = '';
    $('setup-strength').hidden = true;
    stopDeviceLogin();
    await refresh(true);
  } catch (error) {
    $('pair-error').textContent = error.message;
  } finally {
    submit.disabled = false;
    if ($('pair-dialog').open) submit.textContent = label;
  }
});

function updatePasswordStrength(input, meter) {
  const password = input.value;
  meter.hidden = password === '';
  if (meter.hidden) return;
  const length = [...password].length;
  const variety = new Set(password).size;
  const groups = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d\s]/].filter(test => test.test(password)).length;
  const common = /^(?:password|qwerty|admin|abc123|123456)(?:\d|!)*$/i.test(password);
  let level = 'weak';
  if (!common && length >= 8 && variety >= 5) {
    level = length >= 12 && variety >= 8 && (groups >= 3 || length >= 16) ? 'strong' : 'medium';
  }
  meter.dataset.level = level;
  meter.querySelector('.strength-label').textContent = {
    weak: '弱 · 建议换一个更难猜的密码', medium: '中', strong: '强'
  }[level];
}
$('owner-password').addEventListener('input', event => {
  if ($('pair-form').dataset.mode === 'setup') updatePasswordStrength(event.target, $('setup-strength'));
});
$('new-owner-password').addEventListener('input', event => updatePasswordStrength(event.target, $('password-strength')));
$('owner-change').addEventListener('click', () => {
  $('owner-change-form').reset();
  updatePasswordStrength($('new-owner-password'), $('password-strength'));
  $('owner-change-error').textContent = '';
  $('owner-change-dialog').showModal();
});
$('owner-change-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('new-owner-password').value;
  if (password !== $('repeat-owner-password').value) {
    $('owner-change-error').textContent = '两次输入的新密码不一致。';
    return;
  }
  const submit = event.submitter;
  submit.disabled = true;
  $('owner-change-error').textContent = '';
  try {
    await api('/api/session/password', 'POST', {password});
    $('owner-change-form').reset();
    $('owner-change-dialog').close();
    toast('管理员密码已修改');
  } catch (error) {
    $('owner-change-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
$('owner-logout').addEventListener('click', () => handle(async () => {
  await api('/api/session/logout', 'POST', {});
  location.reload();
}, $('owner-logout')));
const liveViews=new Set(['device-status','timers','alarms','automation','capability']);
function refreshLiveView() {
  if (document.hidden) return;
  const listening=consoleView==='abilities' && ($('room-audio-dialog').open || roomAudio?.status.running);
  if (!$('connection-error').hidden || (serverStatus && (liveViews.has(consoleView) || listening))) refresh();
}
page(location.hash.slice(1));refresh();
setInterval(refreshLiveView,5000);
document.addEventListener('visibilitychange',refreshLiveView);
setInterval(updateCountdowns,1000);

const activityTypes = {asr: '语音识别', llm: '大模型', tts: '语音合成', external: '外部 Agent', ability: '付费能力', search: '网页搜索'};
const activityPageSize = 50;
let usageOffset = 0;
let dialogueOffset = 0;
let usageRequest = 0;
let dialogueRequest = 0;
let usageData;
let usageRates = [];
const count = value => value.toLocaleString('zh-CN');
const amount = (number, currency) => new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency, maximumFractionDigits: 6
}).format(number);

function pageControls(prefix, offset, total) {
  $(prefix + '-prev').disabled = offset === 0;
  $(prefix + '-next').disabled = offset + activityPageSize >= total;
  $(prefix + '-page').textContent = total ? `${offset + 1}–${Math.min(offset + activityPageSize, total)} / ${total}` : '0 条';
}
function svgElement(name, attrs) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}
function activityChart(container, values, legend, render, formatMax) {
  if (!values.length) {
    container.replaceChildren(empty('暂无所选范围的数据。'));
    return;
  }
  const max = Math.max(...values.map(item => item.total), 0);
  const scale = max || 1;
  const svg = svgElement('svg', {viewBox: '0 0 496 160', role: 'img', 'aria-label': legend});
  for (const y of [20, 127]) {
    svg.append(svgElement('line', {x1: 0, y1: y, x2: 496, y2: y, class: 'activity-chart-axis'}));
  }
  const topLabel=svgElement('text',{x: 3,y: 14});
  topLabel.textContent=formatMax(max);
  svg.append(topLabel);
  const width = 488 / values.length;
  const y = value => 127 - (value / scale) * 105;
  render(svg, width, y);
  for (const [item, x, align] of [[values[0],4,'start'],[values.at(-1),492,'end']]) {
    const date=svgElement('text',{x,y:150,'text-anchor':align});
    date.textContent=item.day.slice(5);
    svg.append(date);
    if (values.length===1) break;
  }
  container.replaceChildren(svg);
}
function drawActivityCharts() {
  if (!usageData) return;
  const {daily, start_day: start, end_day: end} = usageData;
  const allDays = new Map();
  for (let day = new Date(start + 'T00:00Z'); day.toISOString().slice(0,10) <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const key=day.toISOString().slice(0,10);
    allDays.set(key,{day:key, calls:{}, cost:null});
  }
  const currency=$('usage-currency').value;
  for (const row of daily) {
    const slot=allDays.get(row.day);
    if (!slot) continue;
    slot.calls[row.service]=(slot.calls[row.service]||0)+row.calls;
    if (row.known_cost && row.currency===currency) slot.cost=(slot.cost||0)+row.estimated;
  }
  const points=[...allDays.values()];
  const counts=points.map(slot=>({...slot,total:Object.values(slot.calls).reduce((a,b)=>a+b,0)}));
  activityChart($('usage-call-chart'),daily.length ? counts : [],'每天各类请求次数',(svg,width,y)=>{
    for (const [index, point] of counts.entries()) {
      let total=0;
      for (const [service, calls] of Object.entries(point.calls)) {
        const height=y(total)-y(total+calls);
        const bar=svgElement('rect',{x:4+index*width+width*.13,y:y(total+calls),width:width*.74,height,class:'usage-type-'+service});
        const label=svgElement('title',{});
        label.textContent=`${point.day} ${activityTypes[service]||service} ${calls} 次`;
        bar.append(label); svg.append(bar);
        total+=calls;
      }
    }
  }, num=>count(num)+' 次');
  const costs=points.map(slot=>({...slot,total:slot.cost||0}));
  activityChart($('usage-cost-chart'),currency ? costs : [],'每天可估价的费用',(svg,width,y)=>{
    const line=[];
    let pen='M';
    for (const [index,point] of costs.entries()) {
      if (point.cost===null) { pen='M'; continue; }
      const x=4+(index+.5)*width, cy=y(point.cost);
      line.push(pen,x,cy); pen='L';
      const dot=svgElement('circle',{cx:x,cy,r:2.6,class:'activity-cost-point'});
      const label=svgElement('title',{});
      label.textContent=`${point.day} ${amount(point.cost,currency)}`;
      dot.append(label); svg.append(dot);
    }
    svg.prepend(svgElement('path',{d:line.join(' '),class:'activity-cost-line'}));
  }, num=>amount(num,currency));
  $('usage-chart-legend').replaceChildren(...Object.entries(activityTypes)
    .filter(([type])=>daily.some(row=>row.service===type))
    .map(([type,text])=>{
      const span=el('span',undefined,'muted');
      const mark=el('i',undefined,'usage-type-'+type);
      mark.setAttribute('aria-hidden','true');
      span.append(mark,document.createTextNode(text));
      return span;
    }));
}
$('usage-currency').addEventListener('change', drawActivityCharts);

function displayUsage(data) {
  usageData=data;
  usageRates=data.rates;
  const providers=$('usage-provider'), selected=providers.value;
  providers.replaceChildren(new Option('所有服务商',''),...Object.keys(data.providers).sort().map(name=>new Option(name,name)));
  providers.value=Object.hasOwn(data.providers,selected)?selected:'';
  const totals = {calls:0, metered:0, known:0, audio:0, characters:0, input:0, output:0};
  const costs=new Map();
  for (const row of data.daily) {
    totals.calls+=row.calls; totals.metered+=row.metered; totals.known+=row.known_cost;
    totals.audio+=row.audio_ms; totals.characters+=row.characters;
    totals.input+=row.input_tokens; totals.output+=row.output_tokens;
    if (row.known_cost) costs.set(row.currency,(costs.get(row.currency)||0)+row.estimated);
  }
  $('usage-requests').textContent=count(totals.calls);
  $('usage-measured').textContent=`${count(totals.metered)} 条有计量数据`;
  $('usage-estimated').textContent=[...costs].map(([currency,cost])=>amount(cost,currency)).join(' / ')||'—';
  $('usage-coverage').textContent=`${count(totals.known)} 条可估价 · ${count(totals.calls-totals.known)} 条无法估价`;
  $('usage-voice-units').textContent=totals.metered
    ? `${(totals.audio/60000).toLocaleString('zh-CN',{maximumFractionDigits:2})} 分钟 / ${count(totals.characters)} 字符` : '—';
  $('usage-tokens').textContent=`输入 / 输出 Token · ${count(totals.input)} / ${count(totals.output)}`;
  const currency=$('usage-currency'), currencyChoice=currency.value;
  currency.replaceChildren(...[...costs.keys()].sort().map(code=>new Option(code,code)));
  if (costs.has(currencyChoice)) currency.value=currencyChoice;
  $('usage-currency-label').hidden=costs.size<2;
  drawActivityCharts();

  const table=el('table'), heading=el('tr');
  for (const title of ['时间','类型 / 服务','结果','耗时','用量','估算费用','操作']) {
    const cell=el('th',title);
    cell.scope='col';
    heading.append(cell);
  }
  const head=el('thead'); head.append(heading); table.append(head);
  const body=el('tbody');
  for (const row of data.recent) {
    const measured=[];
    if (row.input_tokens!==undefined || row.output_tokens!==undefined) measured.push(`${row.input_tokens??'—'} / ${row.output_tokens??'—'} Token`);
    if (row.audio_ms!==undefined) measured.push(`${(row.audio_ms/1000).toFixed(2)} 秒（设备计量）`);
    if (row.billable_request!==undefined) measured.push(row.billable_request?'1 次计费请求':'0 次计费请求');
    if (row.characters!==undefined) measured.push(`${row.characters} ${row.provider === 'deepseek' ? '计费字符（估算）' : '字符（设备计量）'}`);
    const tr=el('tr');
    const service=`${activityTypes[row.service]||row.service} · ${[row.provider,row.model].filter(Boolean).join(' / ')}`;
    const status=(row.success?'成功':`失败 · ${row.error_code||'服务错误'}`)+(row.test?' · 验证':'');
    const usage=measured.join(' · ')||'未提供';
    const cost=row.estimated===undefined?'无法估价':amount(row.estimated,row.currency);
    for (const value of [when(row.at),service]) tr.append(el('td',value));
    const result=el('td');
    result.append(el('span',status,row.success?'badge':'badge error'));
    tr.append(result,el('td',`${row.duration_ms} ms`),el('td',usage),el('td',cost));
    const actions=el('td');
    actions.append(button('详情',()=>{
      const fields=[['时间',when(row.at)],['服务',service],['结果',status],['耗时',`${row.duration_ms} ms`],['用量',usage],['估算费用',cost]];
      if(row.price_source) fields.push(['价格来源',row.price_at ? `${row.price_source} · ${row.price_at.slice(0,10)}` : row.price_source]);
      $('usage-detail-fields').replaceChildren(...fields.flatMap(([name,value])=>[el('dt',name),el('dd',value)]));
      $('usage-detail').showModal();
    },'table-link'));
    tr.append(actions);
    body.append(tr);
  }
  table.append(body);
  $('usage-history').replaceChildren(data.recent.length?table:empty('暂无符合条件的最近调用。'));
  pageControls('usage',usageOffset,data.recent_count);
}
async function loadUsage() {
  const version=++usageRequest;
  const query=new URLSearchParams({days:$('usage-days').value,type:$('usage-type').value,provider:$('usage-provider').value,offset:usageOffset});
  try {
    const data=await api('/api/usage?'+query);
    if (version!==usageRequest) return;
    if (usageOffset && data.recent_count<=usageOffset) {
      usageOffset=Math.max(0,Math.floor((data.recent_count-1)/activityPageSize)*activityPageSize);
      return loadUsage();
    }
    $('usage-error').textContent='';
    displayUsage(data);
  } catch (err) {
    if (version===usageRequest) $('usage-error').textContent=err.message;
  }
}
for (const id of ['usage-days','usage-type','usage-provider']) $(id).addEventListener('change',()=>{usageOffset=0;loadUsage();});
$('usage-prev').addEventListener('click',()=>{usageOffset=Math.max(0,usageOffset-activityPageSize);loadUsage();});
$('usage-next').addEventListener('click',()=>{usageOffset+=activityPageSize;loadUsage();});

const rateForm=$('usage-rate-form');
function renderRateFields() {
  const id=rateForm.elements.service.value;
  const listed={asr:[['per_audio_hour','每小时音频']],tts:[['per_10k_chars','每万字']]};
  const fields=listed[id]||[['per_million_in','每百万输入 Token'],['per_million_hit','每百万缓存命中 Token（可选）'],['per_million_out','每百万输出 Token']];
  const current=usageRates.find(rate=>rate.service===id&&rate.provider===rateForm.elements.provider.value.trim()&&rate.model===rateForm.elements.model.value.trim());
  if (current) rateForm.elements.currency.value=current.currency;
  $('usage-rate-fields').replaceChildren(...fields.map(([name,title])=>{
    const input=el('input');input.name=name;input.type='number';input.min='0';input.step='any';
    input.value=current?.[name]??'';
    return inputLabel(title,input);
  }));
}
for (const name of ['service','provider','model']) rateForm.elements[name].addEventListener('change',renderRateFields);
renderRateFields();
rateForm.addEventListener('submit',event=>{
  event.preventDefault();
  handle(async()=>{
    const payload=Object.fromEntries(new FormData(rateForm));
    for (const key of Object.keys(payload)) if(key.startsWith('per_')) payload[key]=payload[key]===''?null:Number(payload[key]);
    await api('/api/usage/rates','PUT',payload);
    toast('估算单价已保存');
    await loadUsage();
  },event.submitter);
});

let dialogueRange;
async function loadDialogues() {
  const version=++dialogueRequest;
  if (!dialogueRange) {
    const today = localTimeValue(new Date()).slice(0,10);
    const first = new Date(today+'T00:00:00Z');
    first.setUTCDate(first.getUTCDate()-6);
    dialogueRange = {from:first.toISOString().slice(0,10),to:today};
    $('dialogue-from').value = dialogueRange.from;
    $('dialogue-to').value = dialogueRange.to;
  }
  const query=new URLSearchParams({...dialogueRange,offset:dialogueOffset});
  const data=await api('/api/dialogues?'+query);
  if (version!==dialogueRequest) return;
  if (dialogueOffset&&data.count<=dialogueOffset) {
    dialogueOffset=Math.max(0,Math.floor((data.count-1)/activityPageSize)*activityPageSize);
    return loadDialogues();
  }
  $('dialogue-enabled').checked=data.enabled;
  const short = text => text ? (Array.from(text).length>58?Array.from(text).slice(0,58).join('')+'…':text) : '—';
  const rows = data.items.map(item=>{
    const stage = item.timing.stage==='completed' ? '已完成' : voiceStageLabels[item.timing.stage] || '未知';
    const show=button('查看',()=>{
      const duration=el('p',`识别 ${item.timing.asr_ms||0} ms · 模型 ${item.timing.model_ms||0} ms · 播报 ${item.timing.playback_ms||0} ms`,'muted');
      const remove=button('删除记录',async()=>{
        if (!window.confirm('删除这一条对话记录？')) return;
        await api('/api/dialogues?id='+encodeURIComponent(item.id),'DELETE');
        $('dialogue-detail').close();
        await loadDialogues();
      },'secondary');
      $('dialogue-detail-body').replaceChildren(el('p',when(item.at)+' · '+stage,'muted'),
        el('h3','用户'),el('p',item.transcript||'未取得识别文本。'),el('h3','喜悦 Voice'),el('p',item.reply||'—'),duration,remove);
      $('dialogue-detail').showModal();
    },'secondary');
    return [when(item.at),short(item.transcript),short(item.reply),el('span',stage,item.timing.stage==='completed'?'badge':'badge paused'),[show]];
  });
  tableContent('dialogue-list',['时间','用户说','喜悦回复','结果','详情'],rows,
    data.enabled?'所选日期范围内没有对话记录。':'对话记录已关闭，可在系统配置开启。','dialogue-table');
  pageControls('dialogue',dialogueOffset,data.count);
}
$('dialogue-range').addEventListener('submit',event=>{
  event.preventDefault();
  const error = event.currentTarget.querySelector('.form-error');
  const from = $('dialogue-from').value, to = $('dialogue-to').value;
  error.textContent = from > to ? '开始日期须早于或等于结束日期。' : '';
  if (error.textContent) return;
  dialogueRange = {from,to};
  dialogueOffset = 0;
  handle(loadDialogues,event.submitter);
});
$('dialogue-prev').addEventListener('click',()=>{dialogueOffset=Math.max(0,dialogueOffset-activityPageSize);handle(loadDialogues);});
$('dialogue-next').addEventListener('click',()=>{dialogueOffset+=activityPageSize;handle(loadDialogues);});
$('dialogue-enabled').addEventListener('change',event=>handle(async()=>{
  try {await api('/api/dialogues','PUT',{enabled:event.target.checked});}
  catch (err){event.target.checked=!event.target.checked;throw err;}
  await loadDialogues();
},event.target));
$('dialogue-clear').addEventListener('click',()=>handle(async()=>{
  if(!window.confirm('清空音箱上的全部对话记录？'))return;
  await api('/api/dialogues','DELETE');
  dialogueOffset=0;
  await loadDialogues();
},$('dialogue-clear')));
function loadViewData() {
  if (consoleView==='usage') loadUsage();
  if (!networkConfig && (consoleView==='abilities' || location.hash==='#settings/search')) handle(loadNetworkConfig);
  if (consoleView==='dialogues' || location.hash==='#settings/privacy') handle(loadDialogues);
}

const networkRoot = '/api/network-tools';
let networkConfig;
let networkRead = 0;
let editingNetworkTool = '';
const searchForm = $('search-form');
const haConnection = $('ha-connection-form');
const haForm = $('ha-tool-form');
const httpForm = $('http-tool-form');

function updateSearchKey() {
  $('search-key-label').hidden = searchForm.elements.reuse.checked;
}

async function loadNetworkConfig() {
  const request = ++networkRead;
  const config = await api(networkRoot);
  if (request !== networkRead) return;
  const initial = !networkConfig;
  networkConfig = config;
  if (initial) {
    searchForm.elements.enabled.checked = config.search.enabled;
    searchForm.elements.reuse.checked = config.search.reuse;
    updateSearchKey();
  }
  $('search-key-status').textContent = config.search_key ? '已保存，留空保留。' : '';
  renderAbilities();
  renderHATools();
}

function searchPayload() {
  return {enabled: searchForm.elements.enabled.checked, reuse: searchForm.elements.reuse.checked,
    api_key: searchForm.elements.reuse.checked ? '' : searchForm.elements.api_key.value.trim()};
}

searchForm.elements.reuse.addEventListener('change', updateSearchKey);
searchForm.addEventListener('submit', event => {
  event.preventDefault();
  networkAction($('search-result'), searchForm.querySelector('[type=submit]'), async () => {
    await api(networkRoot + '/search', 'PUT', searchPayload());
    searchForm.elements.api_key.value = '';
    await loadNetworkConfig();
    return '搜索配置已保存。';
  });
});
$('search-test').onclick = event => networkAction($('search-result'), event.currentTarget, async () => {
  const data = await api(networkRoot + '/search/test', 'POST', {...searchPayload(), query: 'DeepSeek 官方网站'});
  const first = JSON.parse(data.result)[0];
  return first ? '搜索成功 · ' + first.title : '已连接搜索服务，本次没有结果。';
});

async function networkAction(result, trigger, action) {
  trigger.disabled = true;
  result.hidden = false;
  result.textContent = '处理中…';
  try { result.textContent = await action(); }
  catch (error) { result.textContent = error.message; }
  finally { trigger.disabled = false; }
}

function toolChannels(tool) {
  return [tool.voice && '语音', tool.automation && '自动化'].filter(Boolean).join('、') || '手动';
}
async function removeNetworkTool(tool) {
  if (!confirm('移除工具「'+tool.name+'」？')) return;
  await api(networkRoot + '/' + tool.id, 'DELETE');
  await loadNetworkConfig();
}
function renderHATools() {
  const tools = (networkConfig?.tools || []).filter(tool=>tool.kind==='ha');
  if (!tools.length) {
    $('ha-tool-list').replaceChildren();
    return;
  }
  renderCapabilityTable('ha-tool-list', tools.map(tool=>capabilityRow(tool.name, tool.entity,
    el('span',toolChannels(tool),'badge info'), [
      button('编辑',async () => {
        editingNetworkTool=tool.id;
        await loadHAEntities(tool);
      },'secondary'),
      button('移除',()=>removeNetworkTool(tool),'secondary')
    ])), '');
}
const practicePath='/api/abilities/language-practice';
const practiceForm=$('practice-form');
async function openPractice() {
  showPractice(await api(practicePath));
  $('practice-result').textContent='';
  $('practice-dialog').showModal();
}
function showPractice(config) {
  const {enabled,language} = practiceForm.elements;
  language.replaceChildren(...config.available.map(item=>new Option(item.name,item.id)));
  if (config.available.some(item=>item.id===config.language)) language.value=config.language;
  if (!config.available.length) language.append(new Option('暂无可用语言',''));
  language.disabled = !config.available.length;
  enabled.checked = config.enabled;
  enabled.disabled = !config.available.length && !config.enabled;
  const submit = practiceForm.querySelector('[type=submit]');
  const updateButton=()=>{submit.disabled=!config.available.length && (enabled.checked || !config.enabled);};
  enabled.onchange=updateButton;
  updateButton();
  const limits = (config.languages || []).filter(item=>!config.available.some(choice=>choice.id===item.id));
  $('practice-language-limits').replaceChildren(...limits.map(item=>{
    const reasons = [];
    if (!config.asr_ready) reasons.push('语音识别未配置');
    else if (!config.asr_languages?.includes(item.id)) reasons.push('当前语音识别不支持');
    if (!config.tts_ready) reasons.push('语音合成未配置');
    else if (!config.tts_languages?.includes(item.id)) reasons.push('当前语音合成服务或音色不支持');
    if (config.external_only) reasons.push('仅外部 Agent 模式');
    return el('li',item.name+'不可选 · '+reasons.join('、'));
  }));
  const setupLink=$('practice-voice-link');
  setupLink.hidden = Boolean(config.available.length);
  setupLink.href = config.external_only ? '#settings/model' : '#settings/voice';
  setupLink.textContent = config.external_only ? '配置模型与助手' : '配置语音服务';
  $('practice-note').textContent = config.external_only ? '请选择直连大模型或混合模式。' :
    !config.asr_ready ? '请先配置语音识别。' :
    !config.tts_ready ? '请先配置语音合成。' :
    !config.available.length ? '当前识别服务和合成音色没有共同支持的陪练语言。' :
    '此列表只显示当前识别和播报都支持的陪练语言。';
}
$('practice-voice-link').onclick=()=>$('practice-dialog').close();
practiceForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const {enabled,language}=practiceForm.elements;
  const submit=practiceForm.querySelector('[type=submit]');
  submit.disabled=true;
  try {
    const previousRevision=settingsRevision;
    const result=await api(practicePath,'PUT',{enabled:enabled.checked,language:language.value});
    if (result.revision===previousRevision+1) settingsRevision=result.revision;
    $('practice-dialog').close();
    await refresh();
    toast('陪练设置已保存');
  } catch(error) {$('practice-result').textContent=error.message;}
  finally {if (enabled.onchange) enabled.onchange();}
});
async function openHA(tool) {
  if (!networkConfig) await loadNetworkConfig();
  editingNetworkTool = tool?.id || '';
  haConnection.reset();
  haForm.reset();
  haForm.hidden = true;
  haConnection.elements.endpoint.value = networkConfig.home_assistant || '';
  $('ha-key-status').textContent = networkConfig.ha_key ? '已保存，留空保留。' : '';
  $('ha-connection-status').textContent = $('ha-tool-status').textContent = '';
  renderHATools();
  $('ha-dialog').showModal();
  if (networkConfig.home_assistant) {
    await networkAction($('ha-connection-status'), $('ha-reload'), () => loadHAEntities(tool));
  }
}

function updateHAOperation() {
  const [domain] = haForm.elements.entity.value.split('.');
  const movable = domain === 'light' || domain === 'switch';
  for (const option of haForm.elements.operation.options) option.disabled = option.value !== 'state' && !movable;
  if (haForm.elements.operation.selectedOptions[0]?.disabled) haForm.elements.operation.value = 'state';
  const read = haForm.elements.operation.value === 'state';
  haForm.elements.voice.disabled = !read;
  if (!read) haForm.elements.voice.checked = false;
}

async function loadHAEntities(tool) {
  const items = await api(networkRoot + '/home-assistant/entities');
  const entities = haForm.elements.entity;
  const ordered = [...items].sort((a,b) => a.entity_id.localeCompare(b.entity_id));
  entities.replaceChildren(new Option('请选择实体', ''), ...ordered.map(item => {
    const id = item.entity_id;
    const name = item.attributes.friendly_name;
    return new Option(name ? name+' · '+id : id, id);
  }));
  if (tool) {
    entities.value = tool.entity;
    haForm.elements.operation.value = tool.operation;
    haForm.elements.name.value = tool.name;
    haForm.elements.voice.checked = tool.voice;
    haForm.elements.automation.checked = tool.automation;
  }
  updateHAOperation();
  haForm.hidden = false;
  return ordered.length ? '已读取 '+ordered.length+' 个实体。' : '连接成功，未找到实体。';
}
$('ha-reload').onclick = event => networkAction($('ha-connection-status'), event.currentTarget,
  () => loadHAEntities((networkConfig?.tools || []).find(tool => tool.id === editingNetworkTool)));
haConnection.addEventListener('submit', event => {
  event.preventDefault();
  networkAction($('ha-connection-status'), haConnection.querySelector('[type=submit]'), async () => {
    await api(networkRoot + '/home-assistant', 'PUT', Object.fromEntries(new FormData(haConnection)));
    haConnection.elements.api_key.value = '';
    await loadNetworkConfig();
    $('ha-key-status').textContent = '已保存，留空保留。';
    return loadHAEntities((networkConfig.tools || []).find(tool => tool.id === editingNetworkTool));
  });
});
haForm.elements.entity.onchange = () => {
  const selected = haForm.elements.entity.selectedOptions[0];
  if (selected?.value && !haForm.elements.name.value) haForm.elements.name.value = selected.textContent.split(' · ')[0].slice(0,40);
  updateHAOperation();
};
haForm.elements.operation.onchange = updateHAOperation;
haForm.addEventListener('submit', event => {
  event.preventDefault();
  networkAction($('ha-tool-status'), haForm.querySelector('[type=submit]'), async () => {
    const {entity, operation, name, voice, automation} = haForm.elements;
    const purposes = {state:'读取状态', turn_on:'开启设备', turn_off:'关闭设备'};
    await saveNetworkTool({kind:'ha', entity:entity.value, operation:operation.value, name:name.value,
      description:purposes[operation.value]+' '+name.value, voice:voice.checked, automation:automation.checked});
    editingNetworkTool='';
    haForm.reset();
    updateHAOperation();
    toast('实体工具已保存');
    return '';
  });
});

async function saveNetworkTool(payload) {
  const id = editingNetworkTool;
  await api(id ? networkRoot + '/' + id : networkRoot, id ? 'PUT' : 'POST', payload);
  await loadNetworkConfig();
}

function appendHTTPParameter(param) {
  const row = el('div', undefined, 'network-parameter');
  const name = el('input');
  name.dataset.paramName = '';
  name.pattern = '[a-zA-Z_][a-zA-Z0-9_]{0,31}';
  name.required = true;
  name.value = param?.name || '';
  const type = el('select');
  type.dataset.paramType = '';
  type.append(new Option('文本', 'string'), new Option('数字', 'number'), new Option('布尔值', 'boolean'));
  type.value = param?.type || 'string';
  const example = el('input');
  example.dataset.paramExample = '';
  example.maxLength = 1000;
  row.append(inputLabel('参数名', name), inputLabel('类型', type), inputLabel('试运行值', example),
    button('移除', () => { row.remove(); $('http-add-param').disabled = false; }, 'secondary'));
  $('http-params').append(row);
  $('http-add-param').disabled = $('http-params').children.length >= 8;
}
$('http-add-param').onclick = () => appendHTTPParameter();
function updateHTTPMethod() {
  const read = httpForm.elements.method.value === 'GET';
  httpForm.elements.voice.disabled = !read;
  if (!read) httpForm.elements.voice.checked = false;
}
httpForm.elements.method.onchange = updateHTTPMethod;
async function openHTTP(tool) {
  if (!networkConfig) await loadNetworkConfig();
  editingNetworkTool = tool?.id || '';
  httpForm.reset();
  $('http-result').hidden = true;
  $('http-params').replaceChildren();
  $('http-add-param').disabled = false;
  const keySaved = networkConfig.tool_keys[editingNetworkTool];
  $('http-key-status').textContent = keySaved ? '已保存，留空保留。' : '';
  $('http-clear-label').hidden = !keySaved;
  for (const key of ['name','description','method','endpoint','extract','unit']) {
    if (tool?.[key]) httpForm.elements[key].value = tool[key];
  }
  httpForm.elements.voice.checked = Boolean(tool?.voice);
  httpForm.elements.automation.checked = Boolean(tool?.automation);
  updateHTTPMethod();
  (tool?.parameters || []).forEach(appendHTTPParameter);
  $('http-dialog').showModal();
}
$('http-open').onclick = event => handle(() => openHTTP(),event.currentTarget);
$('http-example-test').onclick = event => networkAction($('http-example-result'),event.currentTarget, async () => {
  return JSON.stringify(await api(networkRoot+'/example'),null,2);
});
$('http-example-copy').onclick = event => handle(async ()=>{
  await openHTTP({method:'GET',extract:'message'});
  $('http-example-dialog').close();
},event.currentTarget);

function httpPayload() {
  const form = httpForm.elements;
  const payload = {kind: 'http', voice:form.voice.checked, automation:form.automation.checked, clear_key:form.clear_key.checked};
  for (const key of ['name','description','endpoint','method','extract','unit','api_key']) payload[key] = form[key].value.trim();
  payload.parameters = [...$('http-params').children].map(row => ({
    name: row.querySelector('[data-param-name]').value,
    type: row.querySelector('[data-param-type]').value
  }));
  return payload;
}
$('http-test').onclick = event => {
  if (!httpForm.reportValidity()) return;
  const payload = httpPayload();
  if (payload.method === 'POST' && !confirm('这会向目标服务发送真实 POST 请求。确定试运行？')) return;
  payload.arguments = Object.fromEntries([...$('http-params').children].map((row,i) =>
    [payload.parameters[i].name, row.querySelector('[data-param-example]').value]));
  payload.id = editingNetworkTool;
  networkAction($('http-result'), event.currentTarget, async () => {
    const {result} = await api(networkRoot + '/test', 'POST', payload);
    return result || '调用成功，返回为空。';
  });
};
httpForm.addEventListener('submit', event => {
  event.preventDefault();
  networkAction($('http-result'), httpForm.querySelector('[type=submit]'), async () => {
    await saveNetworkTool(httpPayload());
    $('http-dialog').close();
    toast('HTTP 工具已保存');
    return '';
  });
});

function displayOverviewUsage(usage) {
  if (!usage) {
    $('home-usage-coverage').textContent='暂时无法读取用量';
    return;
  }
  const {today_calls:calls,month_unpriced:missing,month_costs:costs}=usage;
  $('home-usage-calls').textContent = count(calls);
  $('home-usage-cost').textContent = Object.entries(costs).map(([currency, cost]) => amount(cost,currency)).join(' / ') || (missing ? '—' : '暂无费用');
  $('home-usage-coverage').textContent = (missing ? count(missing)+' 次无法估价 · ' : '') + '仅供参考，以服务商账单为准';
}
