'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

const TOGGLES = [
  ['enabled', 'Protection on'], ['antibug', 'Bug messages'], ['antispam', 'Spam and floods'],
  ['antiraid', 'Raids'], ['antitag', 'Status tags'], ['welcome', 'Welcome message']
];
const NUMBERS = [
  ['warnLimit', 'Warnings before removal'], ['floodCount', 'Flood: messages'], ['floodSeconds', 'Flood: seconds'],
  ['raidJoins', 'Raid: joins per minute'], ['lockMinutes', 'Lockdown minutes']
];
const STATUS = {
  starting: 'Starting', scan: 'Not linked', connecting: 'Connecting', connected: 'Protecting',
  replaced: 'Running elsewhere', banned: 'Refused by WhatsApp'
};

let timer = null;
let drawnGroups = '';

async function api(path, body) {
  const res = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') showLogin();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function showLogin() {
  clearTimeout(timer);
  $('dash').hidden = true;
  $('login').hidden = false;
}

async function save(id, name, value) {
  try {
    await api('group', { id, name, value });
    $('notice').textContent = '';
  } catch (e) {
    $('notice').textContent = e.message;
    drawnGroups = '';
    load();
  }
}

function groupCard(g, bounds) {
  const s = g.settings;
  const toggles = el('div', { className: 'toggles' });
  for (const [name, label] of TOGGLES) {
    const box = el('input', { type: 'checkbox', checked: s[name] });
    box.addEventListener('change', () => save(g.id, name, box.checked));
    toggles.append(el('label', { className: 'check' }, box, label));
  }
  const links = el('select');
  for (const [v, t] of [['off', 'Allow all links'], ['invites', 'Block invite links'], ['all', 'Block every link']]) {
    links.append(el('option', { value: v, textContent: t, selected: s.antilink === v }));
  }
  links.addEventListener('change', () => save(g.id, 'antilink', links.value));
  const fields = el('div', { className: 'fields' }, el('label', {}, 'Links', links));
  for (const [name, label] of NUMBERS) {
    const [min, max] = bounds[name];
    const input = el('input', { type: 'number', min, max, value: s[name] });
    input.addEventListener('change', () => save(g.id, name, Number(input.value)));
    fields.append(el('label', {}, label, input));
  }
  const rules = el('textarea', { rows: 3, maxLength: 2000, value: s.rules, placeholder: 'Shown with .rules and the welcome message' });
  rules.addEventListener('change', () => save(g.id, 'rules', rules.value));

  const badge = el('span', { className: g.botAdmin ? 'badge ok' : 'badge bad', textContent: g.botAdmin ? 'Bot is admin' : 'Make the bot an admin' });
  return el('details', { className: 'card' },
    el('summary', {}, el('b', { textContent: g.name }), el('span', { className: 'hint', textContent: `${g.members} members` }), badge),
    toggles, fields, el('label', {}, 'Rules', rules));
}

function render(s) {
  $('login').hidden = true;
  $('dash').hidden = false;
  $('bot-name').textContent = s.name;
  document.title = s.name;
  $('status').textContent = (STATUS[s.status] || s.status) + (s.dryRun ? ' (test mode)' : '');
  $('status').dataset.state = s.status;
  if (s.error) $('notice').textContent = s.error;
  $('link').hidden = s.status !== 'scan';
  $('qr').hidden = !s.qr;
  if (s.qr) $('qr').src = s.qr;

  $('tiles').replaceChildren(...[
    ['Bugs caught', s.stats.bugs], ['Messages deleted', s.stats.deleted], ['Warnings', s.stats.warned],
    ['Removed', s.stats.kicked], ['Lockdowns', s.stats.raids]
  ].map(([k, v]) => el('div', { className: 'tile' }, el('strong', { textContent: v || 0 }), el('span', { textContent: k }))));

  // Redraw only on change so an open panel or half-typed rule is not lost.
  const sig = JSON.stringify(s.groups.map((g) => [g.id, g.name, g.members, g.botAdmin]));
  if (sig !== drawnGroups) {
    drawnGroups = sig;
    $('groups').replaceChildren(...(s.groups.length
      ? s.groups.map((g) => groupCard(g, s.bounds))
      : [el('p', { className: 'hint', textContent: s.status === 'connected' ? 'Add this number to a group and make it an admin.' : 'Groups appear here once WhatsApp is linked.' })]));
  }

  $('incidents').replaceChildren(...(s.incidents.length ? s.incidents.map((i) => el('tr', {},
    el('td', { textContent: new Date(i.at).toLocaleString() }), el('td', { textContent: i.name || '' }),
    el('td', { textContent: i.who }), el('td', { textContent: i.detail }), el('td', { textContent: i.action })))
    : [el('tr', {}, el('td', { colSpan: 5, className: 'hint', textContent: 'Nothing yet.' }))]));
}

async function load() {
  clearTimeout(timer);
  let wait = 10000;
  try {
    const s = await api('state');
    render(s);
    if (s.status !== 'connected') wait = 3000;
  } catch (e) {
    if (!$('login').hidden) return;
    $('notice').textContent = 'Cannot reach the bot. Retrying.';
  }
  timer = setTimeout(load, wait);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('login', { password: $('password').value });
    $('password').value = '';
    $('login-error').textContent = '';
    $('login').hidden = true;
    load();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});
$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-code').textContent = 'Asking WhatsApp…';
  try {
    const { code } = await api('pair', { phone: $('phone').value });
    $('pair-code').textContent = code;
  } catch (err) {
    $('pair-code').textContent = err.message;
  }
});
$('logout').addEventListener('click', () => api('logout', {}).catch(() => {}).then(showLogin));
$('refresh').addEventListener('click', () => api('refresh', {}).catch(() => {}).then(load));
load();
