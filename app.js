'use strict';
const $ = (id) => document.getElementById(id);
let state = {abilities: {}, tasks: [], schedules: [], events: []};
let editingAbility = null;
let refreshBusy = false;
let lastSnapshot = '';
let providerOptions = null;
let settingsDirty = false;
let settingsRevision = 0;
let savedSettings;
let lastUsage = '';
let serverStatus = null;
const titles = {
  home: ['系统总览', '配置服务、管理能力，了解喜悦的运行情况。'],
  system: ['系统配置', '选择语音与模型服务，配置外部 Agent 和基础设置。'],
  abilities: ['能力管理', '配置功能、管理授权，并启用你需要的能力。'],
  usage: ['状态与用量', '查看运行情况与真实调用记录。'],
  tasks: ['任务与待办', '查看功能执行进度，确认、暂停或取消任务。'],
  schedules: ['定时计划', '管理能力的定时执行。']
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
  if (!titles[name]) name = 'home';
  document.querySelectorAll('.page').forEach(p => {p.hidden = p.id !== name;});
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('selected', b.dataset.page === name));
  $('page-title').textContent = titles[name][0]; $('page-subtitle').textContent = titles[name][1];
  if (name === 'tasks' && state.settings) handle(loadExternalTasks);
  $('new-task').hidden = !['tasks', 'schedules'].includes(name);
}
function when(iso, timeZone = state.settings?.timezone) {
  return new Date(iso).toLocaleString('zh-CN', {timeZone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
function active(t) {return !['done', 'cancelled'].includes(t.status);}
function taskCard(task) {
  const card = el('article', undefined, 'task-card');
  const top = el('div', undefined, 'card-top'); top.append(el('h3', task.title), el('span', statusNames[task.status] || task.status, 'badge ' + task.status)); card.append(top);
  const step = task.steps[Math.min(task.index, task.steps.length - 1)];
  card.append(el('p', step?.text || '任务已结束', 'task-text'));
  const meta = el('p', `${when(task.created_at)} · 步骤 ${Math.min(task.index + 1, task.steps.length)} / ${task.steps.length}`, 'muted');
  card.append(meta);
  if (task.due_at) {const c = el('p', '', 'countdown'); c.dataset.due = task.due_at; card.append(c);}
  const actions = el('div', undefined, 'actions');
  const act = (action) => async () => {await api(`/api/tasks/${task.id}/${action}`, 'POST', {index: task.index, status: task.status}); await refresh();};
  if (task.status === 'waiting') actions.append(button('确认完成，继续', act('confirm'), 'main-action'));
  if (task.status === 'paused') actions.append(button('继续', act('resume'), 'main-action'));
  if (['waiting', 'timer'].includes(task.status)) actions.append(button('暂停', act('pause')));
  if (active(task)) actions.append(button('重看提示', act('repeat')), button('取消任务', act('cancel'), 'danger'));
  card.append(actions); return card;
}
function empty(text) {return el('div', text, 'empty');}
function renderTasks() {
  const tasks = [...state.tasks].reverse();
  $('task-list').replaceChildren(...(tasks.length ? tasks.map(taskCard) : [empty('还没有任务。先记一件待办吧。')]));

}
function renderAbilities() {
  const abilities = Object.values(state.abilities).sort((a,b) => a.manifest.id.localeCompare(b.manifest.id));
  $('stat-abilities').textContent = abilities.filter(a => a.enabled).length;
  $('ability-list').replaceChildren(...abilities.map(a => {
    const card = el('article', undefined, 'ability-card'); const m = a.manifest;
    const icon = el('div', m.id === 'todo' ? '✓' : m.id === 'reminder' ? '◷' : '✧', 'ability-icon');
    const top = el('div', undefined, 'card-top'); top.append(el('h3', m.name), el('span', a.enabled ? '已启用' : '未启用', 'badge' + (a.enabled ? '' : ' paused')));
    const actions = el('div', undefined, 'actions'); actions.append(button('配置', () => openConfig(m.id)));
    if (a.enabled) actions.append(button('创建任务', () => openTask(m.id), 'main-action'));
    card.append(icon, top, el('p', m.description, 'description'), actions, el('p', `${m.id} · v${m.version} · ${m.steps.length} 个步骤`, 'ability-meta'));
    return card;
  }));
}
function renderSchedules() {

  $('schedule-list').replaceChildren(...(state.schedules.length ? state.schedules.map(sc => {
    const card = el('article', undefined, 'schedule-card');
    const top = el('div', undefined, 'card-top'); const waitingRetry = sc.enabled && sc.repeat === 'once' && sc.failure;
    const label = waitingRetry ? '执行失败' : sc.enabled ? '已启用' : '任务已创建';
    top.append(el('h3', state.abilities[sc.ability_id]?.manifest.name || sc.ability_id), el('span', label, 'badge'));
    card.append(top, el('p', `${when(sc.next_at, sc.timezone)} · ${{once:'一次',daily:'每天',weekdays:'工作日'}[sc.repeat]} · ${sc.timezone}`, 'muted'));
    if (sc.inputs.content) card.append(el('p', sc.inputs.content, 'task-text'));
    if (sc.failure) card.append(el('p', sc.failure, 'form-error'));
    if (waitingRetry) card.append(button('重试一次', async () => {
      await api(`/api/schedules/${sc.id}/retry`, 'POST', {});
      await refresh();
    }, 'text-button'));
    card.append(button('删除计划', async () => {await api(`/api/schedules/${sc.id}`, 'DELETE'); await refresh();}, 'text-button'));
    return card;
  }) : [empty('还没有定时计划。可以先添加一个明天的提醒。')]));
}
function renderEvents() {
  const events = [...state.events].reverse().slice(0, 15);
  $('home-events').replaceChildren(...(events.length ? events.map(event => {
    const box = el('div', undefined, 'event'); const time = el('time', when(event.at)); time.dateTime = event.at;
    box.append(time, el('p', event.text));
    const delivery = {
      pending:'待播报', playing:'正在播报', delivered:'已播报', failed:'播报失败',
      interrupted:'播报被中断', expired:'提醒已过期', skipped:'任务已暂停或取消',
      queue_full:'播报队列已满', unavailable:'播报服务未就绪'
    }[event.delivery];
    if (delivery) box.append(el('small', delivery, 'muted'));
    return box;
  }) : [empty('任务开始后，喜悦的提示会出现在这里。')]));
}
function updateCountdowns() {document.querySelectorAll('[data-due]').forEach(e => {const remaining = Math.max(0, Math.ceil((new Date(e.dataset.due) - Date.now()) / 1000)); e.textContent = remaining ? `剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒` : '计时到期，正在更新…';});}
async function refresh() {
  if (refreshBusy) return; refreshBusy = true;
  try {
    const session = await api('/api/session');
    const paired = session.authenticated;
    $('owner-logout').hidden = $('owner-management').hidden = !session.required || !paired;
    document.querySelector('body > main').hidden = !paired;
    document.querySelector('body > aside').hidden = !paired;
    if (!paired) {
      $('device-login').hidden = !session.device_voice && !session.device_button;
      $('device-voice').hidden = !session.device_voice;
      $('device-button').hidden = !session.device_button;
      const setup = !session.configured && session.setup_available;
      $('pair-title').textContent = session.configured ? '登录喜悦音箱' : '设置管理员';
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
    if (!providerOptions) providerOptions = await api('/api/providers');
    const [next, status] = await Promise.all([api('/api/state'), api('/api/status')]); serverStatus = status; $('connection-error').hidden = true;
    const snapshot = JSON.stringify(next);
    // Preserve button focus and click targets while polling unchanged state.
    if (snapshot !== lastSnapshot) {state = next; lastSnapshot = snapshot; renderTasks(); renderAbilities(); renderSchedules(); renderEvents();}
    renderManagement(); updateCountdowns();
    if (!$('tasks').hidden && state.settings?.revision !== externalTaskRevision) await loadExternalTasks();
  }
  catch {
    $('connection-error').hidden = false;
    $('runtime-state').textContent = '状态暂不可用';
    $('runtime-uptime').textContent = '';
    $('status-uptime').textContent = '—';
    $('status-memory').textContent = '—';
  }
  finally {refreshBusy = false;}
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
function openTask(abilityID = 'todo', schedule = false) {
  const choices = Object.values(state.abilities).filter(a => a.enabled);
  if (!choices.length) {toast('请先启用一个能力'); return;}
  $('task-ability').replaceChildren(...choices.map(a => {const o = el('option', a.manifest.name); o.value = a.manifest.id; return o;}));
  if (choices.some(a => a.manifest.id === abilityID)) $('task-ability').value = abilityID;
  $('task-form').querySelector('.form-error').textContent = '';
  $('task-when').value = schedule ? 'once' : 'now'; updateWhen();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: state.settings.timezone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date(Date.now() + 3600000));
  const time = Object.fromEntries(parts.map(part => [part.type, part.value]));
  $('task-date').value = `${time.year}-${time.month}-${time.day}T${time.hour}:${time.minute}`;
  fieldsFor(state.abilities[$('task-ability').value], $('task-fields'), 'task');
  $('task-dialog').showModal();
}
function updateWhen() {const scheduled = $('task-when').value !== 'now'; $('date-label').hidden = !scheduled; $('task-date').required = scheduled; $('timezone-note').textContent = scheduled ? `使用时区：${state.settings.timezone}` : '';}
function openConfig(id) {
  editingAbility = id; const a = state.abilities[id];
  $('config-title').textContent = a.manifest.name; $('config-description').textContent = a.manifest.description;
  $('config-enabled').checked = a.enabled; fieldsFor(a, $('config-fields'), 'config');
  $('config-form').querySelector('.form-error').textContent = ''; $('config-dialog').showModal();
}
async function submitForm(event, fn) {
  event.preventDefault(); const form = event.currentTarget; const b = form.querySelector('[type=submit]'); b.disabled = true;
  try {await fn(); form.closest('dialog').close(); await refresh(); toast('已保存');}
  catch (e) {form.querySelector('.form-error').textContent = e.message;}
  finally {b.disabled = false;}
}
$('task-form').addEventListener('submit', e => submitForm(e, async () => {
  const body = {ability_id: $('task-ability').value, inputs: fieldValues($('task-fields'))};
  if ($('task-when').value === 'now') await api('/api/tasks', 'POST', body);
  else {body.local_time = $('task-date').value; body.repeat = $('task-when').value; await api('/api/schedules', 'POST', body);}
}));
$('config-form').addEventListener('submit', e => submitForm(e, () => api(`/api/abilities/${editingAbility}`, 'PUT', {enabled: $('config-enabled').checked, config: fieldValues($('config-fields')), secrets: Object.fromEntries([...$('config-fields').querySelectorAll('input[data-kind=secret]')].filter(i => i.value).map(i => [i.name,i.value])), clear_secrets: [...$('config-fields').querySelectorAll('input[data-clear-secret]:checked')].map(i=>i.dataset.clearSecret)})));
$('task-ability').addEventListener('change', () => fieldsFor(state.abilities[$('task-ability').value], $('task-fields'), 'task'));
$('task-when').addEventListener('change', updateWhen);
$('new-task').addEventListener('click', () => openTask());
$('new-schedule').addEventListener('click', () => openTask('reminder', true));
$('import-ability').addEventListener('click', () => $('ability-file').click());
$('ability-file').addEventListener('change', () => handle(async () => {
  const file = $('ability-file').files[0]; if (!file) return;
  try {if (file.size > 128 * 1024) throw new Error('能力文件不能超过128KB'); const manifest = JSON.parse(await file.text()); await api('/api/abilities', 'POST', manifest); await refresh(); toast('已导入，配置后可启用');}
  finally {$('ability-file').value = '';}
}));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => {location.hash = b.dataset.page;}));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {location.hash = b.dataset.go;}));
window.addEventListener('hashchange', () => page(location.hash.slice(1)));

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
    if (config.tts.provider === 'doubao' && (!serverStatus.voice.cloud_tts_available || !config.tts.key_configured || !config.tts.model)) return 'configure_tts';
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
  $('asr-unavailable').textContent = serverStatus.voice?.available ? '' : '语音链路待接通，可以先保存识别配置。';
  $('tts-system-summary').textContent = serverStatus.voice?.available ? '' : '语音链路待接通，可以先选择并保存播报方式。';
  $('runtime-version').textContent = `版本 ${serverStatus.version}`;
  $('runtime-state').textContent = '运行中';
  $('runtime-uptime').textContent = `已运行 ${formatDuration(serverStatus.uptime_seconds)}`;
  $('status-uptime').textContent = formatDuration(serverStatus.uptime_seconds);
  $('status-memory').textContent = `${(serverStatus.memory_bytes / 1024 / 1024).toFixed(1)} MiB（非进程总内存 / 整机内存）`;
  const runtimeLabel = {disabled:'设备语音未启用', not_configured:'待配置', configured:'已配置，等待验证', succeeded:'最近验证成功', failed:'最近验证失败'};
  $('service-status').replaceChildren(...Object.entries(serverStatus.services || {}).flatMap(([name, value]) =>
    [el('dt', serviceNames[name] || name), el('dd', runtimeLabel[value.state] || '—')]));
  const voice = serverStatus.voice;
  $('voice-monitor').hidden = !voice?.available;
  if (voice?.available) {
    const last = voice.last_turn?.revision === config.revision ? voice.last_turn : null;
    const stage = {configuration:'配置不完整', capture:'收音失败', cancelled:'语音已取消', local_task:'本地任务创建失败', confirmed_on_device:'已处理登录指令', asr:'识别失败', model:'模型回复失败', playback:'播报失败', completed:'已播报'};
    $('voice-state').textContent = voice.busy ? '正在处理' : last ? stage[last.stage] || last.stage : '等待语音';
    $('voice-timing').textContent = last
      ? (last.capture_ms ? '收音 ' + last.capture_ms + ' ms · ' : '') + '识别 ' + last.asr_ms + ' ms · 模型 ' + last.model_ms + ' ms · 播报 ' + last.playback_ms + ' ms'
      : '';
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
  if (!settingsDirty && settingsRevision !== config.revision) fillSettings(config);
  const usageSignature=JSON.stringify(serverStatus.usage || []);
  if (usageSignature !== lastUsage) {lastUsage=usageSignature; renderUsage(serverStatus.usage || []);}
}
function renderUsage(records) {
  $('usage-requests').textContent = records.length;
  const measured=records.filter(r => r.input_tokens !== undefined || r.output_tokens !== undefined);
  $('usage-tokens').textContent=measured.length ? `${measured.reduce((n,r)=>n+(r.input_tokens||0),0).toLocaleString()} / ${measured.reduce((n,r)=>n+(r.output_tokens||0),0).toLocaleString()}` : '—';
  $('usage-token-note').textContent=measured.length ? `${measured.length} 条调用返回用量；其余不估算` : '尚无服务商返回的用量';
  if (!records.length) {$('usage-history').replaceChildren(empty('暂无调用记录。配置模型后，可手动发起文字验证。'));return;}
  const table=el('table');const head=el('tr');for (const text of ['时间','服务 / 模型','结果','耗时','输入 / 输出 Token']) head.append(el('th',text));table.append(head);
  for (const r of [...records].reverse()) {const row=el('tr');for (const text of [when(r.at),`${serviceNames[r.service] || r.service} · ${r.model || r.provider}`,r.success?'成功':`失败 · ${r.error_code}`,`${r.duration_ms} ms`,`${r.input_tokens ?? '未提供'} / ${r.output_tokens ?? '未提供'}`]) row.append(el('td',text));table.append(row);}
  $('usage-history').replaceChildren(table);
}
function inputLabel(title,input) {const label=el('label',title);label.append(input);return label;}
function updateASRFields() {
  const cloud = $('asr-provider').value === 'doubao';
  $('asr-endpoint-field').hidden = cloud;
  $('asr-endpoint').disabled = cloud;
  $('asr-resource-field').hidden = !cloud;
  $('asr-resource').disabled = !cloud;
  $('asr-key-title').textContent = cloud ? '豆包语音 API Key' : '访问凭证（可选）';
  $('asr-cloud-note').hidden = !cloud;
  $('asr-guide').href = '/help.html#' + (cloud ? 'asr-doubao' : 'asr-sensevoice');
}
$('asr-provider').addEventListener('change', updateASRFields);
function updateTTSFields() {
  const cloud = $('tts-provider').value === 'doubao';
  $('tts-voice-field').hidden = !cloud;
  $('tts-key-field').hidden = !cloud;
  $('tts-cloud-note').hidden = !cloud;
  $('tts-clear-label').hidden = !savedSettings.tts.key_configured;
  if (cloud && !$('tts-voice').value) $('tts-voice').value = providerOptions.tts.find(item => item.id === 'doubao')?.model || '';
}
$('tts-provider').addEventListener('change', updateTTSFields);
const timezoneLabels = {'Asia/Shanghai':'中国 · 北京、上海','Asia/Hong_Kong':'香港','Asia/Taipei':'台北',
  'Asia/Tokyo':'东京','Asia/Singapore':'新加坡','Europe/London':'伦敦','America/New_York':'纽约',
  'America/Los_Angeles':'洛杉矶','UTC':'协调世界时'};
function renderTimezoneOptions(selected, query = '') {
  const control = $('setting-timezone');
  const zones = new Set([...Object.keys(timezoneLabels), ...(Intl.supportedValuesOf?.('timeZone') || []),
    savedSettings.timezone, selected].filter(Boolean));
  query = query.trim().toLowerCase();
  const matches = [...zones].filter(zone => zone === selected || (zone + ' ' + (timezoneLabels[zone] || '')).toLowerCase().includes(query));
  control.replaceChildren(...matches.map(zone => new Option(timezoneLabels[zone] ? `${timezoneLabels[zone]} · ${zone}` : zone, zone)));
  control.value = selected;
}
$('timezone-search').addEventListener('input', event => renderTimezoneOptions($('setting-timezone').value, event.target.value));
function fillSettings(config) {
  settingsRevision=config.revision;
  savedSettings=config;
  $('device-asr-fields').hidden = false;
  $('device-tts-fields').hidden = false;
  $('tts-provider').value = config.tts.provider === 'doubao' ? 'doubao' : 'system';
  $('tts-voice').value = config.tts.provider === 'doubao' ? config.tts.model : '';
  $('tts-key').value = '';
  $('tts-clear').checked = false;
  $('tts-key-configured').textContent = config.tts.key_configured ? '已保存，留空则保留。' : '';
  updateTTSFields();
  $('asr-provider').value = config.asr.provider === 'sensevoice' ? 'sensevoice' : 'doubao';
  $('asr-endpoint').value = config.asr.provider === 'sensevoice' ? config.asr.endpoint : '';
  const cloudPreset = providerOptions.asr.find(item => item.id === 'doubao');
  $('asr-resource').replaceChildren(...(cloudPreset?.models || []).map(id => new Option(id, id)));
  const resourceID = config.asr.provider === 'doubao' ? config.asr.model : '';
  if (resourceID && ![...$('asr-resource').options].some(option => option.value === resourceID)) {
    $('asr-resource').append(new Option(resourceID, resourceID));
  }
  $('asr-resource').value = resourceID || cloudPreset?.model || '';
  updateASRFields();
  $('asr-key').value = '';
  $('asr-clear').checked = false;
  $('asr-clear-label').hidden = !config.asr.key_configured;
  $('asr-key-configured').textContent = config.asr.key_configured ? '已保存凭证，留空则保留。' : '';
  $('setting-wake').value = config.wake_word;
  $('timezone-search').value = '';
  renderTimezoneOptions(config.timezone);
  $('setting-mode').value = config.mode;
  $('settings-save-state').textContent=config.updated_at ? `已保存 · ${when(config.updated_at)}` : '默认配置尚未保存';
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
  if (step === 'verify') location.hash = 'system';
  else {
    location.hash = 'system';
    if (step === 'configure_asr') setTimeout(() => $('asr-provider').focus(), 0);
    if (step === 'configure_tts') setTimeout(() => $('tts-provider').focus(), 0);
  }
});
async function verifySettings(service, output) {
  if (settingsDirty) {
    output.textContent = '请先保存当前配置。';
    return;
  }
  output.textContent = '正在验证…';
  try {
    const result = await api('/api/settings/verify', 'POST', {service});
    output.textContent = `验证成功 · ${result.duration_ms} ms`;
  } catch (error) {
    output.textContent = '验证失败 · ' + error.message;
  }
  await refresh();
}
$('open-preview').addEventListener('click', () => { location.hash = 'system'; });
$('settings-form').addEventListener('input',event=>{if(event.target.id==='timezone-search')return;settingsDirty=true;$('settings-save-state').textContent='有未保存的修改';});
$('settings-form').addEventListener('change',event=>{if(event.target.id==='timezone-search')return;settingsDirty=true;$('settings-save-state').textContent='有未保存的修改';});
$('reload-settings').addEventListener('click',()=>handle(async()=>{const config=await api('/api/settings');settingsDirty=false;fillSettings(config);$('settings-error').textContent='';}));
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();const b=event.currentTarget.querySelector('[type=submit]');b.disabled=true;$('settings-error').textContent='';
  try{
    const payload={revision:settingsRevision,name:savedSettings.name,wake_word:$('setting-wake').value,timezone:$('setting-timezone').value,mode:$('setting-mode').value};
    const provider = $('asr-provider').value;
    payload.asr = {provider, endpoint: provider === 'sensevoice' ? $('asr-endpoint').value : '',
      model: provider === 'doubao' ? $('asr-resource').value :
        (savedSettings.asr.provider === 'sensevoice' && savedSettings.asr.model) || 'sensevoice',
      api_key: $('asr-key').value, clear_key: $('asr-clear').checked};
    const cloudTTS = $('tts-provider').value === 'doubao';
    payload.tts = {provider: $('tts-provider').value, endpoint: '', model: cloudTTS ? $('tts-voice').value : '',
      api_key: cloudTTS ? $('tts-key').value : '', clear_key: $('tts-clear').checked};
    for(const name of ['llm', 'external'])payload[name]={provider:$(`${name}-provider`).value,endpoint:$(`${name}-endpoint`).value,model:$(`${name}-model`).value,api_key:$(`${name}-key`).value,clear_key:$(`${name}-clear`).checked};
    const config=await api('/api/settings','PUT',payload);settingsDirty=false;fillSettings(config);await refresh();toast('配置已保存');
  }catch(e){$('settings-error').textContent=e.message;}finally{b.disabled=false;}
});
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
      await refresh();
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
    await refresh();
  } catch (error) {
    $('pair-error').textContent = error.message;
  } finally {
    submit.disabled = false;
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
page(location.hash.slice(1));refresh();setInterval(refresh,2500);setInterval(updateCountdowns,1000);
