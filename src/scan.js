'use strict';
// Scans every repo and builds one graph:
//   UI component -> API call -> backend endpoint -> (calls to other services) -> data model / table
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { prep, extract, snippet, lineOf } = require('./extract');
const { splitUrl, joinUrl } = require('./urls');

const COMMON = new Set(['index', 'handle', 'handler', 'render', 'create', 'update', 'remove', 'delete', 'fetch', 'start',
  'close', 'setup', 'config', 'print', 'error', 'value', 'query', 'parse', 'check', 'build', 'reset', 'clear', 'write', 'read']);
const GENERIC = new Set(['http', 'https', 'base', 'url', 'uri', 'api', 'host', 'service', 'services', 'client', 'endpoint',
  'localhost', 'react', 'vite', 'next', 'public', 'app', 'server', 'backend', 'frontend', 'web', 'main', 'process', 'env', 'config']);
const tokens = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 4 && !GENERIC.has(x));
const baseName = (rel) => rel.split('/').pop().replace(/\.\w+$/, '');

function loadRepo(def) {
  const root = path.resolve(def.path);
  const repo = {
    name: def.name || path.basename(root), root, files: [], fileSet: new Set(), consts: {}, env: {}, inst: {},
    routes: [], calls: [], models: [], types: {}, ports: new Set(), mounts: [], frontend: false,
  };
  if (!fs.existsSync(root)) { repo.error = 'folder not found: ' + root; return repo; }
  for (const file of U.walk(root)) {
    let text;
    try { text = fs.readFileSync(file.abs, 'utf8'); } catch { continue; }
    repo.files.push(Object.assign(file, {
      text, starts: U.lineStarts(text), fns: [], consts: {}, imports: {}, inst: {}, prefix: {},
      routeRecv: new Set(['app', 'router', 'server', 'fastify', 'routes']),
    }));
    repo.fileSet.add(file.rel);
    if (/\.(jsx|tsx|vue)$/.test(file.rel)) repo.frontend = true;
  }
  const safe = (fn, f) => { try { fn(f, repo); } catch (e) { console.warn(`  ! skipped ${repo.name}/${f.rel}: ${e.message}`); } };
  repo.files.forEach((f) => safe(prep, f));
  repo.files.forEach((f) => safe(extract, f));
  return repo;
}

// ── who calls whom (inside one repo) ──
function buildCallGraph(repo) {
  const byName = new Map();
  const all = [];
  for (const f of repo.files) for (const fn of f.fns) {
    fn.f = f;
    if (fn.kind === 'class') continue;
    all.push(fn);
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }
  const resolve = (recv, name, f) => {
    const c = byName.get(name);
    if (!c) return null;
    const same = c.find((x) => x.file === f.rel);
    if (!recv || recv === 'this' || recv === 'self') {
      if (same) return same;
      if (recv) return null;
      const imp = f.imports[name];
      if (imp) { const x = c.find((y) => y.file === imp || baseName(y.file) === imp); if (x) return x; }
      return c.length === 1 && name.length >= 5 && !COMMON.has(name) ? c[0] : null;
    }
    const imp = f.imports[recv];
    if (imp) { const x = c.find((y) => y.file === imp || baseName(y.file) === imp); if (x) return x; }
    const r = U.norm(recv);
    if (r.length < 4) return null;
    return c.find((y) => { const b = U.norm(baseName(y.file)); return b.length >= 4 && (b.includes(r) || r.includes(b)); }) || null;
  };
  const refsIn = (f, s, e, self) => {
    const out = new Set();
    const text = f.text.slice(s, e + 1);
    const re = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g;
    let m;
    while ((m = re.exec(text))) {
      if (text[m.index - 1] === '<' || text[m.index - 1] === '/') continue; // JSX tags are not calls
      const parts = m[0].split(/\s*\.\s*/);
      for (let i = 0; i < parts.length; i++) {
        if (!byName.has(parts[i])) continue;
        const t = resolve(i ? parts[i - 1] : null, parts[i], f);
        if (t && t !== self) out.add(t);
      }
    }
    return out;
  };
  const callers = new Map();
  for (const fn of all) {
    fn.refs = refsIn(fn.f, fn.s, fn.e, fn);
    for (const t of fn.refs) { if (!callers.has(t)) callers.set(t, new Set()); callers.get(t).add(fn); }
  }
  const reach = (start, depth = 3) => {
    const seen = new Set(start);
    let frontier = [...start];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const fn of frontier) for (const t of fn.refs || []) if (!seen.has(t)) { seen.add(t); next.push(t); }
      frontier = next;
    }
    return seen;
  };
  const roots = (fn) => {
    const seen = new Set([fn]), out = [];
    let frontier = [fn];
    for (let d = 0; d < 5 && frontier.length; d++) {
      const next = [];
      for (const x of frontier) {
        const cs = [...(callers.get(x) || [])].filter((c) => !seen.has(c));
        if (!cs.length && ![...(callers.get(x) || [])].length) out.push(x);
        for (const c of cs) { seen.add(c); next.push(c); }
      }
      if (d === 4) out.push(...next);
      frontier = next;
    }
    return out.length ? out.slice(0, 6) : [fn];
  };
  return { refsIn, reach, roots };
}

function typesIn(repo, text, skip) {
  const out = [], seen = new Set();
  for (const m of text.matchAll(/\b[A-Za-z_]\w{2,}\b/g)) {
    const t = repo.types[m[0]];
    if (!t || seen.has(m[0]) || m[0] === skip) continue;
    seen.add(m[0]);
    out.push({ name: t.name, file: t.file, line: t.line, snippet: t.snippet });
    if (out.length >= 4) break;
  }
  return out;
}

function cmp(a, b) {
  let lits = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '{}' || b[i] === '{}') continue;
    if (a[i] !== b[i]) return -1;
    lits++;
  }
  return lits;
}

function matchCall(c, endpoints, repos) {
  let best = null, bestScore = 0;
  const hints = new Set([...tokens(c.host), ...tokens(c.hint)]);
  const portOwners = c.port ? repos.filter((r) => r.ports.has(c.port)).map((r) => r.name) : [];
  for (const ep of endpoints) {
    if (ep.method !== 'ANY' && ep.method !== c.method) continue;
    const a = c.segs, b = ep.segs;
    let s = 0;
    if (a.length === b.length) { const l = cmp(a, b); if (l >= 0) s = a.length && !l ? 40 : 100 + l; }
    else if (a.length && a.length < b.length) { const l = cmp(a, b.slice(b.length - a.length)); if (l > 0) s = 60 + l; }
    else if (b.length && b.length < a.length) { const l = cmp(a.slice(a.length - b.length), b); if (l > 0) s = 50 + l; }
    if (!s) continue;
    if (tokens(ep.repo).some((t) => hints.has(t))) s += 25;
    if (portOwners.length) s += portOwners.includes(ep.repo) ? 25 : -30;
    if (ep.repo === c.repo) s -= 40;
    if (s > bestScore) { best = ep; bestScore = s; }
  }
  return bestScore >= 50 ? best : null;
}

function expandRepos(list, baseDir) {
  const out = [];
  for (const item of list || []) {
    const def = typeof item === 'string' ? { path: item } : Object.assign({}, item);
    if (/[\\/]\*$/.test(def.path)) { // "E:/work/*" -> every sub-folder is a repo
      const parent = path.resolve(baseDir, def.path.slice(0, -2));
      let dirs = [];
      try { dirs = fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules'); } catch { /* reported below */ }
      if (!dirs.length) out.push({ name: path.basename(parent), path: parent });
      for (const d of dirs) out.push({ name: d.name, path: path.join(parent, d.name) });
    } else out.push({ name: def.name, path: path.resolve(baseDir, def.path) });
  }
  return out;
}

function scan(config, baseDir) {
  const repos = expandRepos(config.repos, baseDir).map(loadRepo);
  const nodes = new Map(), edges = new Map(), endpoints = [], calls = [];
  const edge = (from, to, type) => edges.set(from + '>' + to, { from, to, type });

  for (const repo of repos) {
    const cg = buildCallGraph(repo);

    // route prefixes from app.use('/api', router) / include_router(prefix=...)
    const filePrefix = {};
    for (let pass = 0; pass < 3; pass++) for (const m of repo.mounts) if (filePrefix[m.target] == null || pass) filePrefix[m.target] = (filePrefix[m.from] || '') + m.prefix;

    const eps = [];
    for (const r of repo.routes) {
      const u = splitUrl(joinUrl(filePrefix[r.f.rel] || '', r.path));
      const line = lineOf(r.f, r.idx);
      const id = `ep:${repo.name}:${r.method}:${u.display}:${r.f.rel}:${line}`;
      if (nodes.has(id)) continue;
      const direct = cg.refsIn(r.f, r.idx, r.end, null);
      const reached = cg.reach(direct);
      let code = snippet(r.f, r.idx, r.end);
      let ext = r.f.text.slice(r.idx, r.end + 1);
      for (const fn of reached) ext += '\n' + fn.f.text.slice(fn.s, fn.e + 1);
      const handler = [...direct][0];
      if (code.split('\n').length < 4 && handler) code += `\n\n// ${handler.file}\n` + snippet(handler.f, handler.s, handler.e, 50);
      const ep = { id, kind: 'endpoint', label: `${r.method} ${u.display}`, method: r.method, path: u.display, segs: u.segs, repo: repo.name,
        file: r.f.rel, line, snippet: code, types: typesIn(repo, ext), f: r.f, s: r.idx, e: r.end, reached };
      nodes.set(id, ep); eps.push(ep); endpoints.push(ep);
      for (const m of repo.models) {
        if (!m.re.test(ext)) continue;
        const mid = `data:${repo.name}:${m.name}`;
        if (!nodes.has(mid)) {
          const mf = repo.files.find((x) => x.rel === m.file);
          const t = repo.types[m.name];
          nodes.set(mid, { id: mid, kind: 'data', label: m.name, tech: m.tech, repo: repo.name, file: m.file, line: m.line,
            snippet: t && t.file === m.file ? t.snippet : snippet(mf, mf.starts[Math.max(0, m.line - 13)], Math.min(mf.text.length, m.s + 300), 24), types: [] });
        }
        edge(id, mid, 'uses');
      }
    }

    for (const c of repo.calls) {
      const u = splitUrl(c.url);
      const line = lineOf(c.f, c.idx);
      const id = `call:${repo.name}:${c.f.rel}:${line}:${c.method}`;
      if (nodes.has(id)) continue;
      const enclosing = c.f.fns.filter((x) => x.kind !== 'class' && x.s <= c.idx && x.e >= c.idx).sort((a, b) => (a.e - a.s) - (b.e - b.s));
      const inner = enclosing[0];
      const code = inner ? snippet(c.f, inner.s, inner.e, 40) : snippet(c.f, c.idx, c.end, 20);
      const node = { id, kind: 'call', label: `${c.method} ${u.display}`, method: c.method, path: u.display, segs: u.segs, host: u.host, port: u.port,
        hint: c.hint, repo: repo.name, file: c.f.rel, line, snippet: code, sends: c.body ? c.body.slice(0, 300) : undefined,
        responseType: c.gen, urlInCode: c.raw, types: typesIn(repo, code + ' ' + (c.gen || '')) };
      nodes.set(id, node); calls.push(node);

      const owners = eps.filter((ep) => (ep.f === c.f && ep.s <= c.idx && ep.e >= c.idx) || enclosing.some((fn) => ep.reached.has(fn)));
      if (owners.length) { for (const ep of owners) edge(ep.id, id, 'calls'); continue; }
      const rootFns = inner ? cg.roots(inner) : [null];
      for (const fn of rootFns) {
        const rf = fn ? fn.f : c.f;
        const cls = fn && rf.fns.find((x) => x.kind === 'class' && x.s <= fn.s && x.e >= fn.e);
        const name = fn ? (cls ? `${cls.name}.${fn.name}` : fn.name) : baseName(c.f.rel);
        const uid = `ui:${repo.name}:${rf.rel}:${name}`;
        if (!nodes.has(uid)) {
          nodes.set(uid, { id: uid, kind: 'ui', label: name, frontend: repo.frontend, repo: repo.name, file: rf.rel, line: fn ? lineOf(rf, fn.s) : 1,
            snippet: fn ? snippet(rf, fn.s, fn.e, 50) : '', types: fn ? typesIn(repo, rf.text.slice(fn.s, fn.e + 1), name) : [] });
        }
        edge(uid, id, 'triggers');
      }
    }
  }

  for (const c of calls) {
    const ep = matchCall(c, endpoints, repos);
    if (ep) { edge(c.id, ep.id, 'http'); c.target = ep.repo; continue; }
    c.unmatched = true;
    if (/\./.test(c.host) && !/^[\d.]+$/.test(c.host)) { c.external = true; c.label = `${c.method} ${c.host}${c.path}`; }
  }

  const strip = ({ f, s, e, reached, segs, ...rest }) => rest;
  const outNodes = [...nodes.values()].map(strip);
  const count = (repo, kind) => outNodes.filter((n) => n.repo === repo && n.kind === kind).length;
  return {
    generatedAt: new Date().toISOString(),
    repos: repos.map((r) => ({ name: r.name, path: r.root, frontend: r.frontend, files: r.files.length, error: r.error,
      endpoints: count(r.name, 'endpoint'), calls: count(r.name, 'call'), ports: [...r.ports] })),
    nodes: outNodes,
    edges: [...edges.values()],
  };
}

module.exports = { scan };
