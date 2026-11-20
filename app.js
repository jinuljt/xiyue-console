'use strict';
const $ = (id) => document.getElementById(id);
let state = {abilities: {}, tasks: [], schedules: [], events: []};
let editingAbility = null;
let refreshBusy = false;
let lastSnapshot = '';
const titles = {
  home: ['让生活，有条不紊。', '能力、待办和日常的小事，都在这里。'],
  abilities: ['给喜悦，多一点本领。', '配置和启用能力，也可以导入你自己编写的流程。'],
  tasks: ['一件一件，慢慢完成。', '每个任务都有自己的进度，中途离开也不会丢失。'],
  schedules: ['到点，就交给喜悦。', '让提醒按时到来，让重复的小事自动发生。'],
  system: ['知道喜悦的近况。', '连接、设备与服务状态，如实呈现。']
};
const statusNames = {waiting: '等待确认', timer: '计时中', paused: '已暂停', done: '已完成', cancelled: '已取消', running: '进行中'};
function el(tag, text, className) {const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e;}
function button(text, handler, cls = '') {const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', () => handle(handler, b)); return b;}
function toast(text) {$('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => {$('toast').hidden = true;}, 4500);}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {method, headers: {'Content-Type': 'application/json', 'X-Xiyue-Request': 'console'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)});
  if (!response.ok) {let message = '操作失败，请重试'; try {message = (await response.json()).error || message;} catch {} throw new Error(message);}
  return response.json();
}
async function handle(fn, b) {if (b) b.disabled = true; try {await fn();} catch (e) {toast(e.message);} finally {if (b) b.disabled = false;}}
function page(name) {
  if (!titles[name]) name = 'home';
  document.querySelectorAll('.page').forEach(p => {p.hidden = p.id !== name;});
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('selected', b.dataset.page === name));
  $('page-title').textContent = titles[name][0]; $('page-subtitle').textContent = titles[name][1];
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
  const ongoing = tasks.filter(active).slice(0, 4);
  $('home-tasks').replaceChildren(...(ongoing.length ? ongoing.map(taskCard) : [empty('暂时没有挂心的事。')]));
  $('stat-tasks').textContent = tasks.filter(active).length;
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
  $('stat-schedules').textContent = state.schedules.filter(s => s.enabled).length;
  $('schedule-list').replaceChildren(...(state.schedules.length ? state.schedules.map(sc => {
    const card = el('article', undefined, 'schedule-card');
    const top = el('div', undefined, 'card-top'); top.append(el('h3', state.abilities[sc.ability_id]?.manifest.name || sc.ability_id), el('span', sc.enabled ? '已启用' : '已执行', 'badge'));
    card.append(top, el('p', `${when(sc.next_at)} · ${{once:'一次',daily:'每天',weekdays:'工作日'}[sc.repeat]} · ${sc.timezone}`, 'muted'));
    if (sc.inputs.content) card.append(el('p', sc.inputs.content, 'task-text'));
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
    const next = await api('/api/state'); $('connection-error').hidden = true;
    const snapshot = JSON.stringify(next);
    // Preserve button focus and click targets while polling unchanged state.
    if (snapshot !== lastSnapshot) {state = next; lastSnapshot = snapshot; renderTasks(); renderAbilities(); renderSchedules(); renderEvents();}
    updateCountdowns();
  }
  catch { $('connection-error').hidden = false; }
  finally {refreshBusy = false;}
}
function fieldsFor(ability, container, mode) {
  container.replaceChildren();
  for (const f of ability.manifest.fields) {
    if (mode === 'task' && f.kind === 'credential_ref') continue;
    const label = el('label', f.label + (f.required ? ' *' : ''));
    const input = el('input'); input.name = f.key; input.type = f.kind === 'number' ? 'number' : 'text'; input.maxLength = 2000;
    if (input.type === 'number') input.step = 'any';
    input.value = ability.config[f.key] ?? f.default ?? ''; input.required = mode === 'task' && f.required;
    if (f.kind === 'credential_ref') {input.placeholder = 'bitwarden:item:条目UUID'; input.pattern = 'bitwarden:item:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';}
    label.append(input);
    if (f.kind === 'credential_ref') label.append(el('small', '首版只保存 Bitwarden 条目引用，不读取凭证、不接受明文密钥。', 'muted'));
    container.append(label);
  }
}
function fieldValues(container) {return Object.fromEntries([...container.querySelectorAll('input')].map(i => [i.name, i.value]));}
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
$('config-form').addEventListener('submit', e => submitForm(e, () => api(`/api/abilities/${editingAbility}`, 'PUT', {enabled: $('config-enabled').checked, config: fieldValues($('config-fields'))})));
$('task-ability').addEventListener('change', () => fieldsFor(state.abilities[$('task-ability').value], $('task-fields'), 'task'));
$('task-when').addEventListener('change', updateWhen);
$('new-task').addEventListener('click', () => openTask()); $('quick-todo').addEventListener('click', () => openTask('todo'));
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
page(location.hash.slice(1)); refresh(); setInterval(refresh, 2500); setInterval(updateCountdowns, 1000);
