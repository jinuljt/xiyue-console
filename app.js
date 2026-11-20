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
  const response = await fetch(path, {method, headers: {'Content-Type': 'application/json', 'X-Xiyue-Request': 'console'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === "/api/preview/chat" ? 50000 : 10000)});
  if (!response.ok) {let message = '操作失败，请重试'; try {message = (await response.json()).error || message;} catch {} throw new Error(message);}
  return response.json();
}
async function handle(fn, b) {if (b) b.disabled = true; try {await fn();} catch (e) {toast(e.message);} finally {if (b) b.disabled = false;}}
function page(name) {
  if (!titles[name]) name = 'home';
  document.querySelectorAll('.page').forEach(p => {p.hidden = p.id !== name;});
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('selected', b.dataset.page === name));
  $('page-title').textContent = titles[name][0]; $('page-subtitle').textContent = titles[name][1];
  $('new-task').hidden = !['tasks', 'schedules'].includes(name);
}
function when(iso) {return new Date(iso).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
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
    card.append(top, el('p', `${when(sc.next_at)} · ${{once:'一次',daily:'每天',weekdays:'工作日'}[sc.repeat]} · ${sc.timezone}`, 'muted'));
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
    box.append(time, el('p', event.text)); return box;
  }) : [empty('任务开始后，喜悦的提示会出现在这里。')]));
}
function updateCountdowns() {document.querySelectorAll('[data-due]').forEach(e => {const remaining = Math.max(0, Math.ceil((new Date(e.dataset.due) - Date.now()) / 1000)); e.textContent = remaining ? `剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒` : '计时到期，正在更新…';});}
async function refresh() {
  if (refreshBusy) return; refreshBusy = true;
  try {
    if (!providerOptions) providerOptions = await api('/api/providers');
    const [next, status] = await Promise.all([api('/api/state'), api('/api/status')]); serverStatus = status; $('connection-error').hidden = true;
    const snapshot = JSON.stringify(next);
    // Preserve button focus and click targets while polling unchanged state.
    if (snapshot !== lastSnapshot) {state = next; lastSnapshot = snapshot; renderTasks(); renderAbilities(); renderSchedules(); renderEvents();}
    renderManagement(); updateCountdowns();
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
  const next = new Date(Date.now() + 3600000); next.setSeconds(0,0);
  $('task-date').value = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}T${String(next.getHours()).padStart(2,'0')}:${String(next.getMinutes()).padStart(2,'0')}`;
  fieldsFor(state.abilities[$('task-ability').value], $('task-fields'), 'task');
  $('task-dialog').showModal();
}
function updateWhen() {const scheduled = $('task-when').value !== 'now'; $('date-label').hidden = !scheduled; $('task-date').required = scheduled; $('timezone-note').textContent = scheduled ? `使用时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}` : '';}
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
  else {body.next_at = new Date($('task-date').value).toISOString(); body.repeat = $('task-when').value; body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; await api('/api/schedules', 'POST', body);}
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
  if (config.setup_complete) return null;
  if (config.mode === 'external' && config.external.endpoint) return 'verify';
  if (config.mode === 'direct' && config.updated_at && config.llm.endpoint && config.llm.model &&
      (config.llm.key_configured || config.llm.provider.startsWith('custom'))) return 'verify';
  return 'configure';
}
function renderManagement() {
  const config = state.settings; if (!config) return;
  $('device-name').textContent = config.name;
  $('runtime-version').textContent = `版本 ${serverStatus.version}`;
  $('runtime-state').textContent = '运行中';
  $('runtime-uptime').textContent = `已运行 ${formatDuration(serverStatus.uptime_seconds)}`;
  $('status-uptime').textContent = formatDuration(serverStatus.uptime_seconds);
  $('status-memory').textContent = `${(serverStatus.memory_bytes / 1024 / 1024).toFixed(1)} MiB（非进程总内存 / 整机内存）`;
  const step = setupStep(config);
  $('first-setup').hidden = !step;
  const service = config.mode === 'external' ? '外部助手' : '大模型';
  $('setup-next').textContent = step === 'verify'
    ? `已保存配置。发送一条文字，确认${service}能正常回复。`
    : '选择大模型厂商，填写模型 ID 和 API Key，然后保存。';
  $('setup-action').textContent = step === 'verify' ? '验证服务' : '配置大模型';
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
function fillSettings(config) {
  settingsRevision=config.revision;
  savedSettings=config;
  $('setting-name').value=config.name; $('setting-wake').value=config.wake_word; $('setting-timezone').value=config.timezone; $('setting-mode').value=config.mode;
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
    const verify = button('发送文字验证', openPreview, 'secondary');
    verify.dataset.verifyMode = isModel ? 'direct' : 'external';
    panel.append(grid, clearLabel);
    if (isModel) panel.append(note, help);
    panel.append(verify);
    $(isModel ? 'model-settings' : 'external-settings').replaceChildren(panel);
    update();
  }
  updateModeActions();
}
function updateModeActions() {
  const mode = $('setting-mode').value;
  document.querySelectorAll('[data-verify-mode]').forEach(control => {
    control.hidden = mode !== control.dataset.verifyMode;
  });
  const external = $('external-settings');
  external.hidden = mode === 'direct';
  $('external-endpoint').disabled = external.hidden;
}
$('setting-mode').addEventListener('change', updateModeActions);
$('setup-action').addEventListener('click', () => {
  if (setupStep(state.settings) === 'verify') openPreview();
  else location.hash = 'system';
});
function openPreview() {
  if(settingsDirty){toast('请先保存当前配置，再进行验证');return;}
  if(state.settings?.mode === 'hybrid'){toast('混合模式暂未开放，请先选择可用模式');return;}
  $('preview-form').querySelector('.form-error').textContent='';$('preview-result').textContent='';$('preview-dialog').showModal();
}
$('open-preview').addEventListener('click',openPreview);
$('settings-form').addEventListener('input',()=>{settingsDirty=true;$('settings-save-state').textContent='有未保存的修改';});
$('settings-form').addEventListener('change',()=>{settingsDirty=true;$('settings-save-state').textContent='有未保存的修改';});
$('reload-settings').addEventListener('click',()=>handle(async()=>{const config=await api('/api/settings');settingsDirty=false;fillSettings(config);$('settings-error').textContent='';}));
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();const b=event.currentTarget.querySelector('[type=submit]');b.disabled=true;$('settings-error').textContent='';
  try{
    const payload={revision:settingsRevision,name:$('setting-name').value,wake_word:$('setting-wake').value,timezone:$('setting-timezone').value,mode:$('setting-mode').value};
    for (const name of ['asr', 'tts']) {
      const {provider, endpoint, model} = savedSettings[name];
      payload[name] = {provider, endpoint, model};
    }
    for(const name of ['llm', 'external'])payload[name]={provider:$(`${name}-provider`).value,endpoint:$(`${name}-endpoint`).value,model:$(`${name}-model`).value,api_key:$(`${name}-key`).value,clear_key:$(`${name}-clear`).checked};
    const config=await api('/api/settings','PUT',payload);settingsDirty=false;fillSettings(config);await refresh();toast('配置已保存');
  }catch(e){$('settings-error').textContent=e.message;}finally{b.disabled=false;}
});
$('preview-form').addEventListener('submit',async event=>{
  event.preventDefault();const b=event.currentTarget.querySelector('[type=submit]');b.disabled=true;$('preview-result').textContent='正在调用已保存的服务…';event.currentTarget.querySelector('.form-error').textContent='';
  try{const result=await api('/api/preview/chat','POST',{message:$('preview-message').value});$('preview-result').textContent=result.reply;}
  catch(e){$('preview-result').textContent='';$('preview-form').querySelector('.form-error').textContent=e.message;}
  finally{b.disabled=false;await refresh();}
});
page(location.hash.slice(1));refresh();setInterval(refresh,2500);setInterval(updateCountdowns,1000);
