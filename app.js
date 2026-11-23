'use strict';
const $ = (id) => document.getElementById(id);
let state = {abilities: {}, tasks: [], schedules: [], events: []};
let editingAbility = null;
let refreshActive;
let lastSnapshot = '';
let providerOptions = null;
let settingsDirty = false;
let settingsRevision = 0;
let savedSettings;
let serverStatus = null;
let roomAudio;
let roomAudioDirty = false;
let roomAudioPending = false;
let roomAudioRead = 0;
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
  if (name === 'abilities' && state.settings) handle(loadRoomAudio);
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
function roomAudioDraft() {
  return {name: $('room-audio-name').value.trim(), source: $('room-audio-source').value.trim(),
    volume: $('room-audio-volume').valueAsNumber};
}
function renderRoomAudio() {
  if (!roomAudio) return;
  const {available, config, status} = roomAudio;
  if (!roomAudioDirty) {
    $('room-audio-name').value = config.name || '';
    $('room-audio-source').value = config.source;
    $('room-audio-volume').value = config.volume;
  }
  $('room-audio-name').disabled = $('room-audio-source').disabled = $('room-audio-volume').disabled = status.running;
  $('room-audio-save').disabled = roomAudioPending || status.running || !roomAudioDirty;
  $('room-audio-verify').disabled = roomAudioPending || status.running || !roomAudioDraft().source;
  $('room-audio-play').disabled = roomAudioPending || status.stage === 'stopping' ||
    (!status.running && (!available || !config.source || roomAudioDirty));
  $('room-audio-play').textContent = status.running ? '停止听音' : '开始听音';
  const labels = {stopped: '已停止', connecting: '正在连接收音设备', connected: '已连接，等待音频数据',
    playing: '正在向音箱送音', reconnecting: '音频流中断或不可用，正在重连',
    paused: '已让行，等待音箱空闲', stopping: '正在停止'};
  const label = available ? [config.name, labels[status.stage] || '状态暂不可用'].filter(Boolean).join(' · ')
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
    const latest = roomAudioDraft();
    if (latest.name === submitted.name && latest.source === submitted.source && latest.volume === submitted.volume) roomAudioDirty = false;
    await loadRoomAudio();
    toast('房间声音配置已保存');
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
$('room-audio-play').addEventListener('click', () => handle(() => roomAudioAction(async () => {
  const action = roomAudio.status.running ? 'stop' : 'start';
  roomAudio.status = await api(`/api/room-audio/${action}`, 'POST', {});
})));
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
    const session = await api('/api/session');
    const paired = session.authenticated;
    $('owner-logout').hidden = $('owner-management').hidden = !session.required || !paired;
    document.querySelector('body > main').hidden = !paired;
    document.querySelector('body > aside').hidden = !paired;
    if (!paired) {
      roomAudioRead++;
      roomAudio = undefined;
      roomAudioDirty = false;
      $('room-audio-source').value = '';
      $('room-audio-name').value = '';
      $('room-audio-check').hidden = true;
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
    if (!providerOptions) providerOptions = await api('/api/providers');
    const [next, status] = await Promise.all([api('/api/state'), api('/api/status')]); serverStatus = status; $('connection-error').hidden = true;
    const snapshot = JSON.stringify(next);
    // Preserve button focus and click targets while polling unchanged state.
    if (snapshot !== lastSnapshot) {state = next; lastSnapshot = snapshot; renderTasks(); renderAbilities(); renderSchedules(); renderEvents();}
    renderManagement(); updateCountdowns();
    if (!$('abilities').hidden && !roomAudioPending) {
      try {await loadRoomAudio();}
      catch {$('room-audio-status').textContent = '暂时无法获取听音状态';}
    }
    if (!$('tasks').hidden && state.settings?.revision !== externalTaskRevision) await loadExternalTasks();
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
  $('asr-unavailable').textContent = serverStatus.voice?.available ? '' : '自动唤醒尚未接通，可单独验证识别。';
  $('tts-system-summary').textContent = serverStatus.voice?.available ? '' : '自动唤醒尚未接通，可单独验证播报。';
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
    const stage = {configuration:'配置不完整', capture:'收音失败', cancelled:'语音已取消', local_task:'本地任务创建失败', confirmed_on_device:'已处理登录指令', conversation_ended:'对话已结束', asr:'识别失败', model:'模型回复失败', playback:'播报失败', completed:'已播报'};
    $('voice-state').textContent = voice.alarm_ringing ? '倒计时响铃中' : voice.listening_followup ? '继续聆听' : voice.busy ? '正在处理' : last ? stage[last.stage] || last.stage : '等待语音';
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
  if (location.hash === '#usage' && usageRequest === 0) refreshActivityPage();
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
  updateASRFields();
  $('asr-key').value = '';
  $('asr-clear').checked = false;
  $('asr-clear-label').hidden = !config.asr.key_configured;
  $('asr-key-configured').textContent = config.asr.key_configured ? '已保存凭证，留空则保留。' : '';
  $('setting-wake').value = config.wake_word;
  chosenTimezone = config.timezone;
  closeTimezoneList();
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
function serviceFormValues(name) {
  if (name === 'asr') {
    const provider = $('asr-provider').value;
    return {provider, endpoint: provider === 'sensevoice' ? $('asr-endpoint').value : '',
      model: provider === 'doubao' ? '' :
        (savedSettings.asr.provider === 'sensevoice' && savedSettings.asr.model) || 'sensevoice',
      api_key: $('asr-key').value, clear_key: $('asr-clear').checked};
  }
  if (name === 'tts') {
    const cloudTTS = $('tts-provider').value === 'doubao';
    return {provider: $('tts-provider').value, endpoint: '', model: cloudTTS ? $('tts-voice').value : '',
      api_key: cloudTTS ? $('tts-key').value : '', clear_key: $('tts-clear').checked};
  }
  return {provider:$(`${name}-provider`).value, endpoint:$(`${name}-endpoint`).value,
    model:$(`${name}-model`).value, api_key:$(`${name}-key`).value,
    clear_key:$(`${name}-clear`).checked};
}
async function verifySettings(service, output) {
  output.textContent = service === 'asr' ? '正在录音，请对音箱说一句话…' : service === 'tts' ? '正在让音箱播报…' : '正在验证…';
  try {
    const result = await api('/api/settings/verify', 'POST', {service, config:serviceFormValues(service)});
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
$('settings-form').addEventListener('input',event=>{if(event.target === timezoneInput)return;settingsDirty=true;$('settings-save-state').textContent='有未保存的修改';});
$('settings-form').addEventListener('change',()=>{settingsDirty=true;$('settings-save-state').textContent='有未保存的修改';});
$('reload-settings').addEventListener('click',()=>handle(async()=>{const config=await api('/api/settings');settingsDirty=false;fillSettings(config);$('settings-error').textContent='';}));
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();const b=event.currentTarget.querySelector('[type=submit]');b.disabled=true;$('settings-error').textContent='';
  try{
    const payload={revision:settingsRevision,name:savedSettings.name,wake_word:$('setting-wake').value,timezone:chosenTimezone,mode:$('setting-mode').value};
    for (const name of ['asr', 'tts']) payload[name] = serviceFormValues(name);
    for (const name of ['llm', 'external']) payload[name] = serviceFormValues(name);
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
page(location.hash.slice(1));refresh();setInterval(refresh,2500);setInterval(updateCountdowns,1000);

const activityTypes = {asr: '语音识别', llm: '大模型', tts: '语音合成', external: '外部 Agent', ability: '付费能力'};
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
    ? `${(totals.audio/60000).toLocaleString('zh-CN',{maximumFractionDigits:2})} 分钟 / ${count(totals.characters)} 字` : '—';
  $('usage-tokens').textContent=`输入 / 输出 Token · ${count(totals.input)} / ${count(totals.output)}`;
  const currency=$('usage-currency'), currencyChoice=currency.value;
  currency.replaceChildren(...[...costs.keys()].sort().map(code=>new Option(code,code)));
  if (costs.has(currencyChoice)) currency.value=currencyChoice;
  $('usage-currency-label').hidden=costs.size<2;
  drawActivityCharts();

  const table=el('table'), heading=el('tr');
  for (const title of ['时间','类型 / 服务','结果','耗时','用量','估算费用']) heading.append(el('th',title));
  const head=el('thead'); head.append(heading); table.append(head);
  const body=el('tbody');
  for (const row of data.recent) {
    const measured=[];
    if (row.input_tokens!==undefined || row.output_tokens!==undefined) measured.push(`${row.input_tokens??'—'} / ${row.output_tokens??'—'} Token`);
    if (row.audio_ms!==undefined) measured.push(`${(row.audio_ms/1000).toFixed(2)} 秒（设备计量）`);
    if (row.characters!==undefined) measured.push(`${row.characters} 字（设备计量）`);
    const tr=el('tr');
    const service=`${activityTypes[row.service]||row.service} · ${[row.provider,row.model].filter(Boolean).join(' / ')}`;
    const status=(row.success?'成功':`失败 · ${row.error_code||'服务错误'}`)+(row.test?' · 验证':'');
    for (const value of [when(row.at),service,status,`${row.duration_ms} ms`,measured.join(' · ')||'未提供']) tr.append(el('td',value));
    const estimate=el('td',row.estimated===undefined?'无法估价':amount(row.estimated,row.currency));
    if (row.price_source) estimate.title=`${row.price_source} · ${row.price_at?.slice(0,10)||''}`;
    tr.append(estimate);
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

async function loadDialogues() {
  const version=++dialogueRequest;
  const query=new URLSearchParams({date:$('dialogue-date').value,offset:dialogueOffset});
  const data=await api('/api/dialogues?'+query);
  if (version!==dialogueRequest) return;
  if (dialogueOffset&&data.count<=dialogueOffset) {
    dialogueOffset=Math.max(0,Math.floor((data.count-1)/activityPageSize)*activityPageSize);
    return loadDialogues();
  }
  $('dialogue-enabled').checked=data.enabled;
  $('dialogue-list').replaceChildren(...(data.items.length?data.items.map(item=>{
    const article=el('article',undefined,'dialogue-entry');
    const stage=item.timing.stage==='completed'?'已播报':(`结束阶段 · ${item.timing.stage}`);
    const detail=`${when(item.at)} · ${stage} · 识别 ${item.timing.asr_ms} ms · 模型 ${item.timing.model_ms} ms`;
    article.append(el('small',detail,'muted'),el('p',item.transcript?'我说：'+item.transcript:'未取得识别文本。'));
    if (item.reply) article.append(el('p','喜悦 Voice：'+item.reply));
    const remove=button('删除',async()=>{
      if (!window.confirm('删除这一条对话记录？')) return;
      await api('/api/dialogues?id='+encodeURIComponent(item.id),'DELETE');
      await loadDialogues();
    },'secondary');
    article.append(remove);
    return article;
  }):[empty(data.enabled?'暂无对话记录。':'对话记录已关闭。')]));
  pageControls('dialogue',dialogueOffset,data.count);
}
$('dialogue-panel').addEventListener('toggle',()=>{if($('dialogue-panel').open)handle(loadDialogues);});
$('dialogue-date').addEventListener('change',()=>{dialogueOffset=0;handle(loadDialogues);});
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
function refreshActivityPage() {
  if(location.hash!=='#usage'||!serverStatus)return;
  loadUsage();
  if($('dialogue-panel').open)handle(loadDialogues);
}
window.addEventListener('hashchange',refreshActivityPage);
setInterval(refreshActivityPage,15000);
