const API = '/api/tasks';
const PRIORITIES = ['low', 'medium', 'high'];
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const RING_CIRCUMFERENCE = 2 * Math.PI * 28;
const VIEW_TITLES = { today: 'Today', upcoming: 'Upcoming', inbox: 'Inbox', tags: 'Tags' };
const EMPTY_TEXT = {
  today: 'Nothing due today. Add a task with a due date to see it here.',
  upcoming: 'Nothing scheduled ahead.',
  inbox: 'Tasks without a due date land here.',
  tags: 'Add #hashtags to a task to group it here.'
};

// Which tasks belong to each view
const VIEW_TEST = {
  today: (t) => Boolean(t.dueDate) && t.dueDate <= todayKey(),
  upcoming: (t) => Boolean(t.dueDate) && t.dueDate > todayKey(),
  inbox: (t) => !t.dueDate,
  tags: (t) => tagsOf(t.text).length > 0
};

let tasks = [];
let view = 'today';
let activeTag = null;
let loaded = false;
let lastDay = todayKey();
let motion = { id: null, type: null }; // which row animates on the next render
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const list = $('task-list');
const form = $('quick-add');
const input = $('task-input');
const dueInput = $('due-date');
const emptyEl = $('empty');
const toastEl = $('toast');

/* ---------- Helpers ---------- */

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Highlights #tags. The text is escaped first, so this is safe.
function formatText(text) {
  return escapeHtml(text).replace(/#([A-Za-z0-9_-]+)/g, '<span class="tag">#$1</span>');
}

function tagsOf(text) {
  const found = String(text).match(/#[A-Za-z0-9_-]+/g) || [];
  return [...new Set(found.map((t) => t.slice(1).toLowerCase()))];
}

// Today as YYYY-MM-DD in the user's local time
function todayKey() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function dateFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dueLabel(key, completed) {
  const date = dateFromKey(key);
  const diff = Math.round((date - dateFromKey(todayKey())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 0) {
    const short = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return completed ? short : `Overdue · ${short}`;
  }
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function dueClass(key, completed) {
  if (completed) return '';
  const today = todayKey();
  if (key < today) return 'overdue';
  if (key === today) return 'today';
  return '';
}

// Which view a task belongs to, used to explain where a new task went
function homeFor(task) {
  if (!task.dueDate) return 'inbox';
  return task.dueDate <= todayKey() ? 'today' : 'upcoming';
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
}

/* ---------- Data and sorting ---------- */

function tasksFor(name) {
  let items = tasks.filter(VIEW_TEST[name]);
  if (name === 'tags' && activeTag) {
    items = items.filter((t) => tagsOf(t.text).includes(activeTag));
  }
  return items;
}

function sortTasks(items) {
  return [...items].sort((a, b) =>
    Number(a.completed) - Number(b.completed) ||
    (a.dueDate || '9999').localeCompare(b.dueDate || '9999') ||
    (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
    String(a.createdAt).localeCompare(String(b.createdAt))
  );
}

/* ---------- Rendering ---------- */

function taskHtml(t) {
  const id = escapeHtml(t.id);
  const plain = escapeHtml(t.text);
  const priority = PRIORITIES.includes(t.priority) ? t.priority : 'medium';

  const classes = ['task'];
  if (t.completed) classes.push('is-done');
  if (motion.id === t.id) classes.push(motion.type);

  const due = t.dueDate
    ? `<span class="due ${dueClass(t.dueDate, t.completed)}">${escapeHtml(dueLabel(t.dueDate, t.completed))}</span>`
    : '';

  return `
    <li class="${classes.join(' ')}">
      <button type="button" class="check" data-action="toggle" data-id="${id}"
        aria-label="${t.completed ? 'Mark not done' : 'Mark done'}: ${plain}"
        aria-pressed="${t.completed}">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path pathLength="1" d="M3.5 8.5l3 3 6-6.5"/></svg>
      </button>
      <div class="task-body">
        <p class="task-text">${formatText(t.text)}</p>
        <div class="meta">
          <span class="priority ${priority}">${priority}</span>
          ${due}
        </div>
      </div>
      <button type="button" class="delete" data-action="delete" data-id="${id}" aria-label="Delete ${plain}">×</button>
    </li>`;
}

function renderNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    const name = btn.dataset.view;
    const open = tasks.filter(VIEW_TEST[name]).filter((t) => !t.completed).length;
    btn.querySelector('.count').textContent = open || '';
    const active = name === view;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

function renderSummary(items) {
  $('view-title').textContent = VIEW_TITLES[view];
  const open = items.filter((t) => !t.completed).length;
  let text;

  if (view === 'today') {
    text = items.length === 0 ? 'Nothing due today'
      : open === 0 ? 'All done for today'
      : `${open} left for today`;
  } else if (view === 'upcoming') {
    text = open ? `${open} scheduled` : 'Nothing scheduled';
  } else if (view === 'inbox') {
    text = open ? `${open} without a due date` : 'Inbox is clear';
  } else {
    text = activeTag ? `${items.length} tagged #${activeTag}` : 'Pick a tag to filter';
  }
  $('subtitle').textContent = text;
}

// The ring always shows today's progress, whichever view is open
function renderRing() {
  const today = tasksFor('today');
  const total = today.length;
  const done = today.filter((t) => t.completed).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const fill = $('ring-fill');
  fill.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
  fill.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - pct / 100)}`;
  fill.style.opacity = pct ? '1' : '0';
  $('ring-label').textContent = total ? `${pct}%` : '–';
}

function renderTagRow() {
  const row = $('tag-row');
  row.classList.toggle('hidden', view !== 'tags');
  if (view !== 'tags') return;

  const counts = new Map();
  tasks.forEach((t) => {
    tagsOf(t.text).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1));
  });

  row.innerHTML = [...counts.keys()].sort().map((tag) => `
    <button type="button" class="tag-chip ${tag === activeTag ? 'active' : ''}" data-tag="${escapeHtml(tag)}">
      #${escapeHtml(tag)}<span>${counts.get(tag)}</span>
    </button>`).join('');
}

function render() {
  const items = sortTasks(tasksFor(view));
  list.innerHTML = items.map(taskHtml).join('');
  motion = { id: null, type: null }; // animation applies to one render only

  renderNav();
  renderSummary(items);
  renderRing();
  renderTagRow();

  emptyEl.textContent = loaded ? EMPTY_TEXT[view] : 'Loading…';
  emptyEl.classList.toggle('hidden', items.length > 0);
}

async function loadTasks() {
  try {
    const data = await request(API);
    tasks = Array.isArray(data) ? data : [];
  } catch (err) {
    showToast(err.message, true);
  } finally {
    loaded = true;
    render();
  }
}

/* ---------- Events ---------- */

// Add: show the task at once, then save it
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  const checked = form.querySelector('input[name="priority"]:checked');
  const task = {
    id: newId(),
    text,
    priority: checked ? checked.value : 'medium',
    dueDate: dueInput.value,
    completed: false,
    createdAt: new Date().toISOString()
  };

  tasks.push(task);
  motion = { id: task.id, type: 'fresh' };
  input.value = '';
  dueInput.value = '';
  render();
  input.focus();

  if (!tasksFor(view).includes(task)) {
    showToast(`Added to ${VIEW_TITLES[homeFor(task)]}`);
  }

  try {
    await request(API, { method: 'POST', body: JSON.stringify(task) });
  } catch (err) {
    tasks = tasks.filter((t) => t.id !== task.id);
    render();
    showToast(err.message, true);
  }
});

// Tick or delete: update the screen at once, then save
list.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;

  const id = btn.dataset.id;
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const url = `${API}/${encodeURIComponent(id)}`;

  if (btn.dataset.action === 'toggle') {
    const previous = task.completed;
    task.completed = !previous;
    if (task.completed) motion = { id, type: 'pop' };
    render();

    try {
      await request(url, {
        method: 'PATCH',
        body: JSON.stringify({ completed: task.completed })
      });
    } catch (err) {
      task.completed = previous;
      render();
      showToast(err.message, true);
    }
  } else {
    btn.closest('.task').classList.add('leaving');
    await wait(220);
    tasks = tasks.filter((t) => t.id !== id);
    render();

    try {
      await request(url, { method: 'DELETE' });
    } catch (err) {
      showToast(err.message, true);
      loadTasks();
    }
  }
});

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    view = btn.dataset.view;
    activeTag = null;
    render();
  });
});

$('tag-row').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag]');
  if (!chip) return;
  activeTag = activeTag === chip.dataset.tag ? null : chip.dataset.tag;
  render();
});

// Re-render when the date rolls over: checked every minute and when you return to the app
function checkDay() {
  if (todayKey() !== lastDay) {
    lastDay = todayKey();
    render();
  }
}
setInterval(checkDay, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkDay();
});
window.addEventListener('focus', checkDay);

render();   // shows "Loading…" until the server replies
loadTasks();