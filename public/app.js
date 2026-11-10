'use strict';
/* FlowMap UI: draws the graph as left-to-right columns and wires up details + chat. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SVG = 'http://www.w3.org/2000/svg';
const W = 224, H = 46, COL = 72, ROW = 14;
const KIND = { ui: 'UI / caller', call: 'API call', endpoint: 'Endpoint', data: 'Data' };
const HEAD = { ui: 'UI / callers', call: 'API calls', endpoint: 'Endpoints', data: 'Data' };
const BASE = { ui: 0, call: 1, endpoint: 2, data: 3 };

let G = { nodes: [], edges: [], repos: [] };
let byId = new Map(), out = new Map(), inc = new Map(), pos = new Map();
let hiddenRepos = new Set(), selected = null, view = { x: 40, y: 60, k: 1 };
let history = [], busy = false;

// ───────── data ─────────
async function load(rescan) {
  $('#rescan').disabled = true;
  try {
    G = await (await fetch(rescan ? '/api/rescan' : '/api/graph', { method: rescan ? 'POST' : 'GET' })).json();
  } finally { $('#rescan').disabled = false; }
  byId = new Map(G.nodes.map((n) => [n.id, n]));
  if (selected && !byId.has(selected)) selected = null;
  const eps = G.nodes.filter((n) => n.kind === 'endpoint').length;
  const calls = G.nodes.filter((n) => n.kind === 'call');
  $('#stats').textContent = `${G.repos.length} repos · ${eps} endpoints · ${calls.length} API calls (${calls.filter((c) => !c.unmatched).length} matched)`;
  if (!rescan) $('#connected').checked = G.nodes.length > 120;
  $('#repos').innerHTML = G.repos.map((r) => `<span class="chip${hiddenRepos.has(r.name) ? ' off' : ''}" data-repo="${esc(r.name)}" title="${esc(r.path)}">${esc(r.name)}<small>${r.error ? 'not found' : r.frontend ? 'frontend' : r.endpoints + ' endpoints'}</small></span>`).join('');
  draw();
  if (!rescan) fit();
  showDetails();
}

function visibleNodes() {
  let ns = G.nodes.filter((n) => !hiddenRepos.has(n.repo));
  const ok = new Set(ns.map((n) => n.id));
  out = new Map(); inc = new Map();
  for (const e of G.edges) {
    if (!ok.has(e.from) || !ok.has(e.to)) continue;
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inc.has(e.to)) inc.set(e.to, []);
    out.get(e.from).push(e.to); inc.get(e.to).push(e.from);
  }
  if ($('#connected').checked) ns = ns.filter((n) => out.has(n.id) || inc.has(n.id));
  return ns;
}

// ───────── layout ─────────
function layout(ns) {
  const layer = new Map();
  const layerOf = (id, stack) => {
    if (layer.has(id)) return layer.get(id);
    const n = byId.get(id);
    if (stack.has(id)) return BASE[n.kind];
    stack.add(id);
    let l = BASE[n.kind];
    for (const p of inc.get(id) || []) l = Math.max(l, layerOf(p, stack) + 1);
    stack.delete(id);
    layer.set(id, l);
    return l;
  };
  const cols = [];
  for (const n of ns) { const l = layerOf(n.id, new Set()); (cols[l] = cols[l] || []).push(n); }
  pos = new Map();
  const byName = (a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file) || a.label.localeCompare(b.label);
  const avg = (ids) => { const ys = (ids || []).map((id) => pos.get(id)).filter(Boolean).map((p) => p.y); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null; };
  const place = (col, x, wish) => {
    const items = col.map((n) => ({ n, w: wish(n) })).sort((a, b) => (a.w == null) - (b.w == null) || (a.w - b.w) || byName(a.n, b.n));
    let cursor = 0;
    for (const it of items) { const y = Math.max(cursor, it.w == null ? cursor : it.w); pos.set(it.n.id, { x, y, layer: Math.round(x / (W + COL)) }); cursor = y + H + ROW; }
  };
  cols.forEach((col, i) => { if (col) place(col.sort(byName), i * (W + COL), (n) => (i ? avg(inc.get(n.id)) : null)); });
  // pull earlier columns towards the things they point at
  for (let i = cols.length - 2; i >= 0; i--) if (cols[i]) place(cols[i], i * (W + COL), (n) => avg((out.get(n.id) || []).filter((id) => pos.get(id).layer > i)));
  return cols;
}

// ───────── drawing ─────────
const el = (tag, attrs, text) => { const e = document.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
const cut = (s, n) => (s.length <= n ? s : s.slice(0, Math.floor(n * 0.4)) + '…' + s.slice(-(n - Math.floor(n * 0.4) - 1)));

function draw() {
  const ns = visibleNodes();
  const cols = layout(ns);
  const gN = $('#nodes'), gE = $('#edges'), gH = $('#heads');
  gN.textContent = ''; gE.textContent = ''; gH.textContent = '';
  const empty = $('#empty');
  empty.hidden = ns.length > 0;
  if (!ns.length) {
    const errs = G.repos.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`).join('\n');
    empty.textContent = errs || (G.nodes.length ? 'Everything is filtered out. Turn a repo back on or untick "Connected only".' : 'No endpoints or API calls were found.\nCheck the repo paths in flowmap.config.json, then press Rescan.');
  }
  cols.forEach((col, i) => {
    if (!col) return;
    const kinds = [...new Set(col.map((n) => n.kind))];
    gH.appendChild(el('text', { x: i * (W + COL), y: -18, class: 'head' }, kinds.map((k) => HEAD[k]).join(' + ')));
  });
  for (const e of G.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2, dx = Math.max(40, Math.abs(x2 - x1) / 2);
    const p = el('path', { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, class: 'edge ' + e.type });
    p.dataset.from = e.from; p.dataset.to = e.to;
    gE.appendChild(p);
  }
  for (const n of ns) {
    const p = pos.get(n.id);
    const g = el('g', { class: `node ${n.kind}${n.unmatched ? ' unmatched' : ''}`, transform: `translate(${p.x},${p.y})` });
    g.dataset.id = n.id;
    g.appendChild(el('title', {}, `${n.label}\n${n.repo} · ${n.file}:${n.line}`));
    g.appendChild(el('rect', { class: 'box', width: W, height: H, rx: 7 }));
    g.appendChild(el('rect', { class: 'bar', width: 4, height: H - 12, x: 0, y: 6, rx: 2 }));
    const t1 = el('text', { class: 't1', x: 14, y: 19 });
    const sp = n.method ? n.label.indexOf(' ') : -1;
    if (sp > 0) { t1.appendChild(el('tspan', { class: 'verb' }, n.label.slice(0, sp) + ' ')); t1.appendChild(el('tspan', {}, cut(n.label.slice(sp + 1), 26 - sp))); } else t1.textContent = cut(n.label, 26);
    g.appendChild(t1);
    g.appendChild(el('text', { class: 't2', x: 14, y: 35 }, cut(`${n.repo} · ${n.file.split('/').pop()}:${n.line}`, 34)));
    gN.appendChild(g);
  }
  paint();
  applyView();
}

function related(id) {
  const set = new Set([id]);
  const go = (start, map) => { const q = [start]; while (q.length) for (const x of map.get(q.pop()) || []) if (!set.has(x)) { set.add(x); q.push(x); } };
  go(id, out); go(id, inc);
  return set;
}

function paint() {
  const q = $('#search').value.trim().toLowerCase();
  const rel = selected && pos.has(selected) ? related(selected) : null;
  for (const g of $('#nodes').children) {
    const n = byId.get(g.dataset.id);
    const hit = q && (n.label + ' ' + n.file + ' ' + n.repo).toLowerCase().includes(q);
    g.classList.toggle('sel', n.id === selected);
    g.classList.toggle('hit', !!hit);
    g.classList.toggle('dim', rel ? !rel.has(n.id) : !!q && !hit);
  }
  for (const p of $('#edges').children) {
    const on = rel && rel.has(p.dataset.from) && rel.has(p.dataset.to);
    p.classList.toggle('hi', !!on);
    p.classList.toggle('dim', rel ? !on : !!q);
  }
}

function applyView() { $('#view').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`); }
function fit() {
  if (!pos.size) return;
  let maxX = 0, maxY = 0;
  for (const p of pos.values()) { maxX = Math.max(maxX, p.x + W); maxY = Math.max(maxY, p.y + H); }
  const r = $('#svg').getBoundingClientRect();
  view.k = Math.max(0.72, Math.min(1.1, (r.width - 60) / maxX, (r.height - 110) / maxY)); // never shrink text below readable
  view.x = Math.max(30, (r.width - maxX * view.k) / 2); view.y = 60;
  applyView();
}
function focus(id) {
  const p = pos.get(id);
  if (!p) return;
  const r = $('#svg').getBoundingClientRect();
  view.x = r.width / 2 - (p.x + W / 2) * view.k; view.y = r.height / 2 - (p.y + H / 2) * view.k;
  applyView();
}
function select(id, center) {
  selected = id;
  if (id && !pos.has(id)) { const n = byId.get(id); if (n) { hiddenRepos.delete(n.repo); $('#connected').checked = false; load.redraw(); } }
  paint(); showDetails(); showContext();
  if (center && id) focus(id);
}
load.redraw = () => { for (const c of $('#repos').children) c.classList.toggle('off', hiddenRepos.has(c.dataset.repo)); draw(); };

// pan / zoom / click
(() => {
  const svg = $('#svg');
  let drag = null;
  svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; svg.setPointerCapture(e.pointerId); });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; svg.classList.add('drag'); }
    if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; applyView(); }
  });
  svg.addEventListener('pointerup', (e) => {
    const moved = drag && drag.moved;
    drag = null; svg.classList.remove('drag');
    if (moved) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const g = hit && hit.closest ? hit.closest('.node') : null;
    select(g ? g.dataset.id : null);
  });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.max(0.15, Math.min(2.5, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k;
    applyView();
  }, { passive: false });
})();

// ───────── details ─────────
function linkBtn(id) {
  const n = byId.get(id);
  return `<button class="link ${n.kind}" data-go="${esc(id)}">${esc(n.label)}<small>${esc(KIND[n.kind])} · ${esc(n.repo)}</small></button>`;
}
function showDetails() {
  const box = $('#details');
  const n = selected && byId.get(selected);
  if (!n) {
    box.innerHTML = `<div class="hint"><b>Click any box</b> to see where its data comes from and where it goes.
      <ul><li>Columns read left to right: UI → API call → endpoint → other services → data.</li>
      <li>Selecting a box highlights its whole flow.</li>
      <li>Drag to move, scroll to zoom, <b>Fit</b> to reset.</li>
      <li>Open <b>Chat</b> to ask questions in plain language.</li></ul></div>`;
    return;
  }
  const ins = inc.get(n.id) || [], outs = out.get(n.id) || [];
  let h = `<div class="kind ${n.kind}">${esc(KIND[n.kind])}${n.tech ? ' · ' + esc(n.tech) : ''}</div><h2>${esc(n.label)}</h2><div class="where">${esc(n.repo)} · ${esc(n.file)}:${n.line}</div>`;
  if (n.kind === 'call') {
    if (n.urlInCode) h += `<div class="kv" style="margin-top:10px"><b>URL in code:</b> <code>${esc(n.urlInCode)}</code></div>`;
    if (n.sends) h += `<div class="kv"><b>Sends:</b> <code>${esc(n.sends)}</code></div>`;
    if (n.responseType) h += `<div class="kv"><b>Expects back:</b> <code>${esc(n.responseType)}</code></div>`;
    if (n.unmatched) h += `<div class="warn">${n.external ? 'Calls an external API (' + esc(n.host) + ').' : 'No matching endpoint was found in the scanned repos. The service may not be in the config, or the URL is built dynamically.'}</div>`;
  }
  h += `<h3>Comes from</h3><div class="links">${ins.map(linkBtn).join('') || '<span class="muted">Nothing calls this (in the scanned repos).</span>'}</div>`;
  h += `<h3>Goes to</h3><div class="links">${outs.map(linkBtn).join('') || '<span class="muted">End of the flow.</span>'}</div>`;
  h += `<div class="explain"><button id="explain">Explain with Ollama</button> <button id="askabout">Ask about this</button><div id="explained" class="answer"></div></div>`;
  for (const t of n.types || []) h += `<h3>Type · ${esc(t.name)} <span class="muted" style="text-transform:none;letter-spacing:0">${esc(t.file)}:${t.line}</span></h3><pre><code>${esc(t.snippet)}</code></pre>`;
  if (n.snippet) h += `<h3>Code</h3><pre><code>${esc(n.snippet)}</code></pre>`;
  box.innerHTML = h;
  box.scrollTop = 0;
}
$('#details').addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go) return select(go.dataset.go, true);
  if (e.target.id === 'askabout') { tab('chat'); $('#question').focus(); return; }
  if (e.target.id === 'explain') {
    const btn = e.target, target = $('#explained'), id = selected;
    btn.disabled = true; target.innerHTML = '<p class="muted">Thinking…</p>';
    let text = '';
    await streamTo('/api/explain', { id, model: $('#model').value, refresh: btn.dataset.again === '1' }, {
      token: (t) => { text += t; if (selected === id) target.innerHTML = md(text); },
      error: (m) => { target.innerHTML = `<p class="warn">${esc(m)}</p>`; },
    });
    btn.disabled = false; btn.textContent = 'Explain again'; btn.dataset.again = '1';
  }
});

// ───────── chat ─────────
function md(src) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return src.split('```').map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/^[\w+-]*\n/, ''))}</code></pre>`;
    let html = '', list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const line of part.split('\n')) {
      const ul = /^\s*[-*•]\s+(.*)/.exec(line), ol = /^\s*\d+[.)]\s+(.*)/.exec(line), hd = /^#{1,6}\s+(.*)/.exec(line);
      if (ul || ol) { const t = ul ? 'ul' : 'ol'; if (list !== t) { close(); html += `<${t}>`; list = t; } html += `<li>${inline((ul || ol)[1])}</li>`; continue; }
      close();
      if (hd) html += `<p><b>${inline(hd[1])}</b></p>`; else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    close();
    return html;
  }).join('');
}

async function streamTo(url, body, on) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (j.sources && on.sources) on.sources(j.sources);
        if (j.token) on.token(j.token);
        if (j.error) on.error(j.error);
      }
    }
  } catch (e) { on.error('FlowMap server is not reachable. Is "node flowmap.js" still running?'); }
}

function showContext() {
  const n = selected && byId.get(selected), c = $('#context');
  c.hidden = !n;
  if (n) c.innerHTML = `Asking about <b>${esc(n.label)}</b><button title="Ask about everything instead" data-clear>×</button>`;
  if (!history.length) suggestions();
}
$('#context').addEventListener('click', (e) => { if (e.target.dataset.clear != null) select(null); });

function suggestions() {
  const n = selected && byId.get(selected);
  const qs = n ? [`Explain the full flow for ${n.label}, step by step`, `What data (fields and types) does ${n.label} send and receive?`, `Which services and data stores does ${n.label} touch?`]
    : ['Give me an overview of every flow, from the UI to the database', 'Which services talk to each other, and through which endpoints?', 'Which API calls have no matching endpoint?'];
  $('#messages').innerHTML = `<div class="suggest"><div class="muted">Try asking:</div>${qs.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
}
$('#messages').addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]'), src = e.target.closest('[data-go]');
  if (q) ask(q.dataset.q);
  if (src) select(src.dataset.go, true);
});

async function ask(question) {
  question = question.trim();
  if (!question || busy) return;
  busy = true; $('#send').disabled = true;
  const box = $('#messages');
  if (!history.length) box.innerHTML = '';
  const add = (cls, html) => { const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html; box.appendChild(d); box.scrollTop = box.scrollHeight; return d; };
  add('user', esc(question));
  const bot = add('bot', '<span class="muted">Thinking…</span>');
  let text = '', sources = [], failed = false;
  const renderBot = () => {
    const chips = sources.filter((id) => byId.has(id)).map((id) => `<button data-go="${esc(id)}" title="Show on map">${esc(cut(byId.get(id).label, 34))}</button>`).join('');
    bot.innerHTML = md(text) + (chips ? `<div class="sources">${chips}</div>` : '');
    box.scrollTop = box.scrollHeight;
  };
  await streamTo('/api/chat', { question, history, selectedId: selected, model: $('#model').value }, {
    sources: (s) => { sources = s; },
    token: (t) => { text += t; renderBot(); },
    error: (m) => { failed = true; bot.className = 'msg err'; bot.textContent = m; },
  });
  if (!failed) { renderBot(); history.push({ role: 'user', content: question }, { role: 'assistant', content: text }); }
  busy = false; $('#send').disabled = false;
}
$('#ask').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#question'); ask(q.value); q.value = ''; });
$('#question').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask').requestSubmit(); } });

async function status() {
  const pill = $('#ollama'), sel = $('#model');
  try {
    const s = await (await fetch('/api/status')).json();
    const has = s.models.find((m) => m === s.model || m.split(':')[0] === s.model);
    const current = sel.value;
    const list = s.models.length ? s.models : [s.model];
    sel.innerHTML = list.map((m) => `<option>${esc(m)}</option>`).join('');
    sel.value = list.includes(current) ? current : has || list[0];
    pill.className = 'pill ' + (s.ollama ? 'ok' : 'off');
    pill.textContent = s.ollama ? (s.models.length ? 'Ollama ready' : 'Ollama: no models') : 'Ollama offline';
    pill.title = s.ollama ? (has ? `Using ${s.url}` : `Model "${s.model}" is not installed. Run: ollama pull ${s.model}`) : `Start Ollama to use chat (${s.url}). The map works without it.`;
  } catch { pill.className = 'pill off'; pill.textContent = 'Server stopped'; }
}

// ───────── wiring ─────────
function tab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  $('#details').hidden = name !== 'details'; $('#chat').hidden = name !== 'chat';
}
document.querySelector('.tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) tab(e.target.dataset.tab); });
$('#search').addEventListener('input', paint);
$('#search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim().toLowerCase();
  const n = q && G.nodes.find((x) => pos.has(x.id) && (x.label + ' ' + x.file + ' ' + x.repo).toLowerCase().includes(q));
  if (n) select(n.id, true);
});
$('#connected').addEventListener('change', draw);
$('#fit').addEventListener('click', fit);
$('#rescan').addEventListener('click', () => load(true));
$('#repos').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  if (hiddenRepos.has(c.dataset.repo)) hiddenRepos.delete(c.dataset.repo); else hiddenRepos.add(c.dataset.repo);
  load.redraw();
});

load(false).then(suggestions);
status();
setInterval(status, 15000);
