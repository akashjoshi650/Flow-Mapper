'use strict';
// Per-language extractors. Everything here is plain pattern matching on source text (no LLM):
//   prep*    - first pass: functions, constants, imports, types, data models
//   extract* - second pass: backend routes and outgoing HTTP calls
const path = require('path');
const U = require('./util');
const { parseUrl, joinUrl } = require('./urls');

const VERBS = 'get|post|put|patch|delete';
const ID = '[A-Za-z_$][\\w$]*';
const KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'new', 'typeof',
  'await', 'super', 'with', 'class', 'throw', 'import', 'export', 'default', 'case', 'in', 'of', 'when', 'elif', 'print', 'func']);

const lineOf = (f, idx) => U.lineAt(f.starts, idx);
function snippet(f, s, e, max = 60) {
  const from = f.starts[lineOf(f, s) - 1];
  const lines = f.text.slice(from, Math.min(f.text.length, e + 1)).split('\n');
  return (lines.length > max ? lines.slice(0, max).concat('  // ...') : lines).join('\n').replace(/\s+$/, '');
}
const commented = (f, idx) => /^\s*(\/\/|\*|#)/.test(f.text.slice(f.starts[lineOf(f, idx) - 1], idx + 2));
const unq = (s) => String(s).trim().replace(/^[fF]?["'`]|["'`]$/g, '');

function addFn(f, name, s, e, kind) {
  if (!name || e == null || e <= s || KW.has(name)) return;
  if (f.fns.some((x) => x.s === s && x.name === name)) return;
  f.fns.push({ name, s, e, file: f.rel, kind: kind || 'fn' });
}
function addType(f, repo, name, s, e) {
  if (!name || e <= s || repo.types[name]) return;
  repo.types[name] = { name, file: f.rel, line: lineOf(f, s), snippet: snippet(f, s, e, 30) };
}
function addModel(f, repo, name, idx, tech, pattern) {
  if (!name || repo.models.some((m) => m.name === name)) return;
  repo.models.push({ name, tech, file: f.rel, line: lineOf(f, idx), re: new RegExp(pattern), s: idx });
}
const classLike = (n) => `\\b${n}(?:Repository|Repo|Dao|Model|Service)?\\b|\\b${n[0].toLowerCase()}${n.slice(1)}(?:Repository|Repo|Dao)\\b`;
function addConst(f, repo, name, expr) {
  if (!/["'`]/.test(expr)) return;
  f.consts[name] = expr;
  if (repo.consts[name] == null) repo.consts[name] = expr;
}
const nextFn = (f, idx) => f.fns.filter((x) => x.s > idx && x.kind !== 'class').sort((a, b) => a.s - b.s)[0];

// Raw SQL strings in any language: the table name becomes a data node.
function sqlTables(f, repo) {
  const res = [
    /\bSELECT\b[^;]{0,300}?\bFROM\s+[`"]?([A-Za-z_][\w.]*)/g, /\bINSERT\s+INTO\s+[`"]?([A-Za-z_][\w.]*)/g,
    /\bUPDATE\s+[`"]?([A-Za-z_][\w.]*)[`"]?\s+SET\b/g, /\bDELETE\s+FROM\s+[`"]?([A-Za-z_][\w.]*)/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(f.text))) addModel(f, repo, m[1], m.index, 'sql table', `(?:FROM|INTO|UPDATE|JOIN)\\s+[\`"]?${m[1].replace(/\./g, '\\.')}\\b`);
  }
}

// ───────────────────────────── JavaScript / TypeScript ─────────────────────────────

function resolveImport(from, spec, fileSet) {
  let base;
  if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(from), spec);
  else if (spec.startsWith('@/') || spec.startsWith('~/')) base = 'src/' + spec.slice(2);
  else return null;
  for (const suf of ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '/index.js', '/index.ts', '/index.jsx', '/index.tsx']) {
    if (fileSet.has(base + suf)) return base + suf;
  }
  const noExt = base.replace(/\.js$/, '');
  for (const suf of ['.ts', '.tsx']) if (fileSet.has(noExt + suf)) return noExt + suf;
  return null;
}

function prepJs(f, repo) {
  const t = f.text;
  let m;
  // imports: local name -> file it comes from
  const bind = (names, spec) => {
    const target = resolveImport(f.rel, spec, repo.fileSet);
    if (!target) return;
    for (const n of names.split(/[\s,:{}*]+/)) if (n && n !== 'as' && n !== 'type') f.imports[n] = target;
  };
  let re = /import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = re.exec(t))) bind(m[1], m[2]);
  re = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re.exec(t))) bind(m[1], m[2]);

  // string constants (API base URLs etc.)
  re = /(?:const|let|var)\s+([\w$]+)\s*(?::\s*[\w<>[\]]+)?\s*=\s*([^;\n]*['"`][^;\n]*)/g;
  while ((m = re.exec(t))) addConst(f, repo, m[1], m[2]);
  re = /^[ \t]*(?:(?:private|public|protected|readonly|static)\s+)+([\w$]+)\s*(?::\s*\w+)?\s*=\s*([^;\n]*['"`][^;\n]*)/gm;
  while ((m = re.exec(t))) addConst(f, repo, m[1], m[2]);

  // axios instances and their baseURL
  re = /([\w$]+)\s*=\s*axios\.create\s*\(/g;
  while ((m = re.exec(t))) {
    const { args } = U.callArgs(t, re.lastIndex - 1, 'js');
    const b = /baseURL\s*:\s*([^,}\n]+)/.exec(args.join(',')) || [];
    f.inst[m[1]] = b[1] || '';
    if (repo.inst[m[1]] == null) repo.inst[m[1]] = { expr: b[1] || '', f };
  }
  // variables that hold an express/fastify/hono router
  re = /([\w$]+)\s*=\s*(?:express\s*\(|(?:express\.)?Router\s*\(|new\s+(?:Router|Hono|Koa|Elysia)\b|[fF]astify\s*\()/g;
  while ((m = re.exec(t))) f.routeRecv.add(m[1]);

  // functions
  const arrowEnd = (p) => {
    const c = t[p];
    if (c === '{' || c === '(') return U.scan(t, p, 'js');
    const nl = t.indexOf('\n', p);
    return nl < 0 ? t.length : nl;
  };
  const afterParams = (close) => {
    const a = /^\s*(?::\s*[^=;{]+?)?\s*=>\s*/.exec(t.slice(close + 1, close + 200));
    return a ? arrowEnd(close + 1 + a[0].length) : null;
  };
  re = new RegExp(`\\bfunction\\s*\\*?\\s*(${ID})\\s*(?:<[^>(]*>)?\\s*\\(`, 'g');
  while ((m = re.exec(t))) { const c = U.scan(t, re.lastIndex - 1, 'js'); if (c > 0) addFn(f, m[1], m.index, U.bodyFrom(t, c + 1, 'js')); }
  re = new RegExp(`(?:\\b(?:const|let|var)\\s+|^[ \\t]*(?:(?:module\\.)?exports\\.)?)(${ID})\\s*(?::[^=\\n(]+)?[=:]\\s*(?:async\\s*)?(function\\b[^(]*)?\\(`, 'gm');
  while ((m = re.exec(t))) {
    const c = U.scan(t, re.lastIndex - 1, 'js');
    if (c > 0) addFn(f, m[1], m.index, m[2] ? U.bodyFrom(t, c + 1, 'js') : afterParams(c));
  }
  re = new RegExp(`(?:\\b(?:const|let|var)\\s+|^[ \\t]*(?:(?:module\\.)?exports\\.)?)(${ID})\\s*(?::[^=\\n(]+)?[=:]\\s*(?:async\\s*)?${ID}\\s*=>\\s*`, 'gm');
  while ((m = re.exec(t))) addFn(f, m[1], m.index, arrowEnd(re.lastIndex));
  re = new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\s*(?::[^=\\n(]+)?=\\s*(?:React\\.)?(?:memo|forwardRef|useCallback|useMemo|observer|asyncHandler|catchAsync|createAsyncThunk)\\s*(?:<[^(]*>)?\\(`, 'g');
  while ((m = re.exec(t))) addFn(f, m[1], m.index, U.scan(t, re.lastIndex - 1, 'js'));
  re = new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|async|override|readonly)\\s+)*(${ID})\\s*(?:<[^>(]*>)?\\(`, 'gm');
  while ((m = re.exec(t))) {
    if (KW.has(m[1])) continue;
    const c = U.scan(t, re.lastIndex - 1, 'js');
    if (c < 0) continue;
    const b = /^\s*(?::\s*[^{;=]+)?\{/.exec(t.slice(c + 1, c + 160));
    if (b) addFn(f, m[1], m.index, U.scan(t, c + b[0].length, 'js'));
  }
  re = new RegExp(`\\bclass\\s+(${ID})[^{;]*\\{`, 'g');
  while ((m = re.exec(t))) {
    const e = U.scan(t, re.lastIndex - 1, 'js');
    addFn(f, m[1], m.index, e, 'class');
    if (e > 0 && /(Dto|DTO|Request|Response|Input|Payload|Params|Body)$/.test(m[1])) addType(f, repo, m[1], m.index, e);
  }

  // types (TS interfaces / type aliases / zod + joi schemas)
  re = /\b(?:interface|type)\s+([A-Z]\w*)(?:<[^>]*>)?[^={;\n]*([={])/g;
  while ((m = re.exec(t))) {
    let p = re.lastIndex - 1;
    if (m[2] === '=') { p++; while (/\s/.test(t[p] || 'x')) p++; }
    let e = t[p] === '{' ? U.scan(t, p, 'js') : t.indexOf('\n', p);
    if (e < 0) e = Math.min(t.length, p + 400);
    addType(f, repo, m[1], m.index, e);
  }
  re = /\b(?:const|let)\s+(\w+)\s*=\s*(?:z|Joi|yup)\.object\s*\(/g;
  while ((m = re.exec(t))) { const e = U.scan(t, re.lastIndex - 1, 'js'); if (e > 0) addType(f, repo, m[1], m.index, e); }

  // data models
  re = /mongoose\.model(?:<[^>]*>)?\(\s*['"](\w+)['"]/g;
  while ((m = re.exec(t))) addModel(f, repo, m[1], m.index, 'mongoose model', classLike(m[1]));
  re = /\.define\(\s*['"](\w+)['"]\s*,\s*\{/g;
  while ((m = re.exec(t))) addModel(f, repo, m[1], m.index, 'sequelize model', classLike(m[1][0].toUpperCase() + m[1].slice(1)));
  re = /class\s+(\w+)\s+extends\s+(?:Model|BaseEntity)\b/g;
  while ((m = re.exec(t))) addModel(f, repo, m[1], m.index, 'model', classLike(m[1]));
  re = /@Entity\([^)]*\)\s*(?:export\s+)?class\s+(\w+)/g;
  while ((m = re.exec(t))) addModel(f, repo, m[1], m.index, 'typeorm entity', classLike(m[1]));

  re = /\.listen\(\s*(?:[\w.]+\s*(?:\|\||\?\?)\s*)?(\d{2,5})|\bPORT\s*(?:\|\||\?\?|=)\s*['"]?(\d{4,5})/g;
  while ((m = re.exec(t))) repo.ports.add(m[1] || m[2]);
}

const HTTP_RECV = /^(axios|api|http|https|client|request|instance|\$http|\$axios|\$api|apiClient|httpClient|axiosInstance|ky|got|superagent|fetcher|service|agent)$/i;
const NOT_HTTP = /^(params|searchParams|query|headers|map|cache|store|formData|localStorage|sessionStorage|cookies|req|res|_|Reflect|Object|config|env|props|state|context|ctx|session|redis|db|storage|i18n|t|form|url|data|options|args|json|kwargs|environ|settings|dict)$/i;

function extractJs(f, repo) {
  const t = f.text;
  let m;
  const pushCall = (method, urlExpr, idx, end, extra = {}) => {
    const p = parseUrl(urlExpr, f, repo);
    if (p.url == null) return;
    if (!extra.httpish && !extra.base && !p.hint && !/^(https?:)?\//.test(p.url)) return; // e.g. map.get('a/b')
    let url = p.url, hint = p.hint;
    if (extra.base) { const b = parseUrl(extra.base.expr, extra.base.f, repo); url = joinUrl(b.url || '', url); hint = hint || b.hint; }
    repo.calls.push({ method: method.toUpperCase(), url, hint, f, idx, end, body: extra.body, gen: extra.gen, raw: urlExpr.trim().slice(0, 160) });
  };

  // x.get('/path', ...)  -> either a backend route or an outgoing HTTP call, depending on the receiver
  let re = new RegExp(`(${ID}(?:\\s*\\.[ \\t]*${ID})*)\\s*\\.[ \\t]*(${VERBS}|all)\\s*(<[^>()]*>)?\\s*\\(`, 'g');
  while ((m = re.exec(t))) {
    if (commented(f, m.index)) continue;
    const { args, close } = U.callArgs(t, re.lastIndex - 1, 'js');
    if (close < 0 || !args.length) continue;
    const recv = m[1].replace(/\s+/g, ''), last = recv.split('.').pop(), verb = m[2], a0 = args[0];
    const isInst = recv in f.inst || (repo.inst[last] && !f.routeRecv.has(recv));
    const routeRecv = !isInst && recv !== 'axios' && (f.routeRecv.has(recv) || /(router|routes)$/i.test(last));
    if (routeRecv && /^['"`]/.test(a0) && args.length >= 2) {
      repo.routes.push({ method: verb === 'all' ? 'ANY' : verb.toUpperCase(), path: unq(a0), f, idx: m.index, end: close });
      continue;
    }
    if (verb === 'all' || routeRecv || NOT_HTTP.test(last)) continue;
    const httpish = isInst || HTTP_RECV.test(last);
    if (!httpish && !/['"`][^'"`]*\//.test(a0)) continue;
    const inst = recv in f.inst ? { expr: f.inst[recv], f } : repo.inst[last];
    pushCall(verb, a0, m.index, close, {
      httpish,
      base: inst && inst.expr ? inst : null,
      body: /post|put|patch/.test(verb) ? args[1] : undefined,
      gen: m[3] ? m[3].slice(1, -1) : undefined,
    });
  }

  // fetch(url, { method, body })
  re = /(?<![\w$.])fetch\s*\(/g;
  while ((m = re.exec(t))) {
    if (commented(f, m.index)) continue;
    const { args, close } = U.callArgs(t, re.lastIndex - 1, 'js');
    if (close < 0 || !args.length) continue;
    const opts = args.slice(1).join(',');
    pushCall((/method\s*:\s*['"`](\w+)/i.exec(opts) || [])[1] || 'GET', args[0], m.index, close,
      { httpish: true, body: (/body\s*:\s*([^\n]+?),?\s*$/m.exec(opts) || [])[1] });
  }

  // axios({ url, method, data })
  re = /\baxios(?:\.request)?\s*\(\s*\{/g;
  while ((m = re.exec(t))) {
    const open = t.indexOf('(', m.index);
    const { args, close } = U.callArgs(t, open, 'js');
    const url = /\burl\s*:\s*([^,\n]+)/.exec(args[0] || '');
    if (close < 0 || !url) continue;
    pushCall((/method\s*:\s*['"`](\w+)/i.exec(args[0]) || [])[1] || 'GET', url[1], m.index, close,
      { httpish: true, body: (/\bdata\s*:\s*([^\n]+?),?\s*$/m.exec(args[0]) || [])[1] });
  }

  // app.use('/prefix', someRouter)
  re = new RegExp(`(${ID})\\.use\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,`, 'g');
  while ((m = re.exec(t))) {
    const { args } = U.callArgs(t, t.indexOf('(', m.index), 'js');
    for (const a of args.slice(1)) {
      const rq = /require\(\s*['"]([^'"]+)['"]/.exec(a);
      const target = rq ? resolveImport(f.rel, rq[1], repo.fileSet) : f.imports[a.split('.')[0].trim()];
      if (target) repo.mounts.push({ from: f.rel, prefix: m[2], target });
    }
  }

  // NestJS:  @Controller('orders')  +  @Get(':id')
  const ctrls = [];
  re = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?/g;
  while ((m = re.exec(t))) ctrls.push({ idx: m.index, prefix: m[1] || '' });
  re = /@(Get|Post|Put|Patch|Delete|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
  while ((m = re.exec(t))) {
    const c = ctrls.filter((x) => x.idx < m.index).pop();
    const fn = nextFn(f, m.index);
    if (!c || !fn) continue;
    repo.routes.push({ method: m[1] === 'All' ? 'ANY' : m[1].toUpperCase(), path: joinUrl('/' + c.prefix, m[2] || ''), f, idx: m.index, end: fn.e });
  }
}

// ───────────────────────────── Python ─────────────────────────────

function pyBlockEnd(f, defLine, indent) {
  let sig = false, last = defLine;
  for (let ln = defLine; ln <= f.starts.length; ln++) {
    const line = f.text.slice(f.starts[ln - 1], ln < f.starts.length ? f.starts[ln] - 1 : f.text.length);
    if (!sig) { if (/:\s*(#.*)?$/.test(line) || (ln === defLine && /\)\s*(->[^:]+)?:\s*\S/.test(line))) sig = true; last = ln; continue; }
    if (!line.trim()) continue;
    if (line.match(/^[ \t]*/)[0].length <= indent) break;
    last = ln;
  }
  return last < f.starts.length ? f.starts[last] - 1 : f.text.length;
}

function prepPy(f, repo) {
  const t = f.text;
  let m;
  let re = /^([ \t]*)(?:async\s+)?(def|class)\s+(\w+)([^\n]*)/gm;
  while ((m = re.exec(t))) {
    const s = m.index + m[1].length;
    const e = pyBlockEnd(f, lineOf(f, s), m[1].length);
    if (m[2] === 'def') { addFn(f, m[3], s, e); continue; }
    addFn(f, m[3], s, e, 'class');
    addType(f, repo, m[3], s, e);
    if (/\(\s*(?:[\w.]*\.)?(?:Base|Model|SQLModel|Document|DeclarativeBase)\b/.test(m[4])) addModel(f, repo, m[3], s, 'orm model', classLike(m[3]));
  }
  re = /^[ \t]*([A-Za-z_]\w*)\s*(?::\s*\w+)?\s*=\s*([^\n]*["'][^\n]*)$/gm;
  while ((m = re.exec(t))) addConst(f, repo, m[1], m[2]);
  re = /(\w+)\s*=\s*(?:APIRouter|Blueprint)\(([^)]*)\)/g;
  while ((m = re.exec(t))) { const p = /(?:url_)?prefix\s*=\s*["']([^"']*)["']/.exec(m[2]); if (p) f.prefix[m[1]] = p[1]; }
  re = /^[ \t]*from\s+([\w.]+)\s+import\s+([^\n]+)/gm;
  while ((m = re.exec(t))) {
    const mod = m[1].split('.').filter(Boolean).pop();
    for (const part of m[2].replace(/[()]/g, '').split(',')) {
      const [name, , alias] = part.trim().split(/\s+/);
      if (name && mod) f.imports[alias || name] = mod;
    }
  }
  re = /port\s*=\s*(\d{4,5})|--port[ =](\d{4,5})/g;
  while ((m = re.exec(t))) repo.ports.add(m[1] || m[2]);
}

function extractPy(f, repo) {
  const t = f.text;
  let m;
  // @app.get("/x")  @router.post("/x")  @app.route("/x", methods=["GET", "POST"])
  let re = /^[ \t]*@([\w.]+)\.(get|post|put|patch|delete|route|api_route)\(\s*(?:["']([^"']*)["'])?([^\n]*)/gm;
  while ((m = re.exec(t))) {
    const fn = nextFn(f, m.index);
    if (!fn || m[3] == null) continue;
    let methods = [m[2].toUpperCase()];
    if (/route/.test(m[2])) {
      const ms = /methods\s*=\s*[[(]([^\])]*)/.exec(m[4]);
      methods = ms ? ms[1].split(',').map(unq).filter(Boolean).map((x) => x.toUpperCase()) : ['GET'];
    }
    const pre = f.prefix[m[1].split('.').pop()] || '';
    for (const method of methods) repo.routes.push({ method, path: joinUrl(pre, m[3]) || '/', f, idx: m.index, end: fn.e });
  }
  // app.include_router(items.router, prefix="/api")   app.register_blueprint(bp, url_prefix="/api")
  re = /(?:include_router|register_blueprint)\(\s*([\w.]+)([^)]*)\)/g;
  while ((m = re.exec(t))) {
    const p = /prefix\s*=\s*["']([^"']*)["']/.exec(m[2]);
    if (!p) continue;
    const parts = m[1].split('.');
    const mod = parts.length > 1 ? parts[parts.length - 2] : f.imports[parts[0]];
    const target = mod && [...repo.fileSet].find((r) => r.endsWith('/' + mod + '.py') || r === mod + '.py' || r.endsWith('/' + mod + '/__init__.py'));
    if (target) repo.mounts.push({ from: f.rel, prefix: p[1], target });
  }
  // requests.get(f"{BASE}/x")   httpx.post(...)   client.get(...)
  re = new RegExp(`([\\w.]+)\\.(${VERBS})\\(`, 'g');
  while ((m = re.exec(t))) {
    if (commented(f, m.index) || /^\s*@/.test(t.slice(f.starts[lineOf(f, m.index) - 1], m.index + 1))) continue;
    const last = m[1].split('.').pop();
    if (NOT_HTTP.test(last)) continue;
    const { args, close } = U.callArgs(t, re.lastIndex - 1, 'py');
    if (close < 0 || !args.length) continue;
    const httpish = /^(requests|httpx|aiohttp)$|client|session|http/i.test(last);
    if (!httpish && !/["'][^"']*\//.test(args[0])) continue;
    const p = parseUrl(args[0], f, repo);
    if (p.url == null || (!httpish && !p.hint && !/^(https?:)?\//.test(p.url))) continue;
    const body = (/\b(?:json|data)\s*=\s*([^\n]+)/.exec(args.slice(1).join(', ')) || [])[1];
    repo.calls.push({ method: m[2].toUpperCase(), url: p.url, hint: p.hint, f, idx: m.index, end: close, body, raw: args[0].slice(0, 160) });
  }
}

// ───────────────────────────── Java / Kotlin (Spring) ─────────────────────────────

function prepJava(f, repo) {
  const t = f.text;
  let m;
  let re = /^[ \t]*(?:(?:public|private|protected|static|final|abstract|synchronized|override|suspend|open|internal)\s+)+(?:<[^>]+>\s+)?(?:[\w<>[\],.?]+(?: [\w<>[\],.?]+)*\s+)?(\w+)\s*\(/gm;
  while ((m = re.exec(t))) { const c = U.scan(t, re.lastIndex - 1, 'java'); if (c > 0) addFn(f, m[1], m.index, U.bodyFrom(t, c + 1, 'java')); }
  re = /\bfun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/g;
  while ((m = re.exec(t))) {
    const c = U.scan(t, re.lastIndex - 1, 'java');
    if (c < 0) continue;
    let e = U.bodyFrom(t, c + 1, 'java');
    if (e < 0) e = t.indexOf('\n', c);
    addFn(f, m[1], m.index, e < 0 ? t.length : e);
  }
  re = /\b(class|record|interface|enum)\s+(\w+)[^{;\n]*([{(])/g;
  while ((m = re.exec(t))) {
    const e = U.scan(t, re.lastIndex - 1, 'java');
    if (e < 0) continue;
    addType(f, repo, m[2], m.index, e);
    if (m[3] === '{') addFn(f, m[2], m.index, e, 'class');
    if (/@(Entity|Document|Table)\b[^;{}]{0,300}$/.test(t.slice(Math.max(0, m.index - 300), m.index))) addModel(f, repo, m[2], m.index, 'entity', classLike(m[2]));
  }
  re = /\b(?:String|val|const val)\s+(\w+)\s*(?::\s*String)?\s*=\s*("[^"\n]*"[^;\n]*)/g;
  while ((m = re.exec(t))) addConst(f, repo, m[1], m[2]);
}

function extractJava(f, repo) {
  const t = f.text;
  let m;
  const feign = /@FeignClient\(([^)]*)\)/.exec(t);
  const prefixes = [];
  let re = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b\s*(\()?/g;
  while ((m = re.exec(t))) {
    let argText = '', after = re.lastIndex;
    if (m[2]) { const c = U.scan(t, re.lastIndex - 1, 'java'); if (c < 0) continue; argText = t.slice(re.lastIndex, c); after = c + 1; }
    const p = (/"([^"]*)"/.exec(argText) || [])[1] || '';
    if (/^(?:\s*@\w+(?:\([^)]*\))?)*\s*(?:(?:public|abstract|final|open|data|internal)\s+)*(?:class|interface)\s/.test(t.slice(after, after + 400))) {
      prefixes.push({ idx: m.index, p });
      continue;
    }
    const method = m[1] === 'Request' ? ((/RequestMethod\.(\w+)/.exec(argText) || [])[1] || 'ANY') : m[1].toUpperCase();
    const pre = (prefixes.filter((x) => x.idx < m.index).pop() || {}).p || '';
    const fn = nextFn(f, m.index);
    const full = joinUrl(pre, p) || '/';
    if (feign) {
      const hint = (/(?:name|value)\s*=\s*"([^"]+)"/.exec(feign[1]) || /"([^"]+)"/.exec(feign[1]) || [])[1] || '';
      const base = (/url\s*=\s*"([^"]+)"/.exec(feign[1]) || [])[1] || '';
      repo.calls.push({ method, url: joinUrl(/^http/.test(base) ? base : '', full), hint, f, idx: m.index, end: t.indexOf('\n', after), raw: full });
    } else if (fn) repo.routes.push({ method, path: full, f, idx: m.index, end: fn.e });
  }
  // restTemplate.getForObject("http://inventory/stock/" + sku, ...)
  re = /\w*[rR]est(?:Template|Client)\w*\.(getFor\w+|postFor\w+|patchFor\w+|put|delete|exchange)\(/g;
  while ((m = re.exec(t))) {
    const { args, close } = U.callArgs(t, re.lastIndex - 1, 'java');
    if (close < 0 || !args.length) continue;
    const method = m[1] === 'exchange' ? ((/HttpMethod\.(\w+)/.exec(args.join(',')) || [])[1] || 'GET') : m[1].replace(/For\w+/, '');
    const p = parseUrl(args[0], f, repo);
    if (p.url != null) repo.calls.push({ method: method.toUpperCase(), url: p.url, hint: p.hint, f, idx: m.index, end: close, body: /post|put|patch/i.test(method) ? args[1] : undefined, raw: args[0].slice(0, 160) });
  }
  // webClient.post().uri("/x")
  re = /\.uri\(/g;
  while ((m = re.exec(t))) {
    const { args, close } = U.callArgs(t, re.lastIndex - 1, 'java');
    if (close < 0 || !args.length || !/^"/.test(args[0])) continue;
    const verbs = [...t.slice(Math.max(0, m.index - 200), m.index).matchAll(/\.(get|post|put|patch|delete)\(\)/g)];
    const p = parseUrl(args[0], f, repo);
    if (p.url != null) repo.calls.push({ method: (verbs.length ? verbs.pop()[1] : 'GET').toUpperCase(), url: p.url, hint: p.hint, f, idx: m.index, end: close, raw: args[0].slice(0, 160) });
  }
}

// ───────────────────────────── Go (gin / echo / chi / net/http) ─────────────────────────────

function prepGo(f, repo) {
  const t = f.text;
  let m;
  let re = /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/gm;
  while ((m = re.exec(t))) { const c = U.scan(t, re.lastIndex - 1, 'go'); if (c > 0) addFn(f, m[1], m.index, U.bodyFrom(t, c + 1, 'go')); }
  re = /\btype\s+(\w+)\s+struct\s*\{/g;
  while ((m = re.exec(t))) {
    const e = U.scan(t, re.lastIndex - 1, 'go');
    if (e < 0) continue;
    addType(f, repo, m[1], m.index, e);
    if (/gorm\.Model|gorm:"/.test(t.slice(m.index, e))) addModel(f, repo, m[1], m.index, 'gorm model', classLike(m[1]));
  }
  re = /\b(\w+)\s*:?=\s*("[^"\n]*"[^\n]*)/g;
  while ((m = re.exec(t))) addConst(f, repo, m[1], m[2]);
  re = /(\w+)\s*:?=\s*(\w+)\.Group\(\s*"([^"]*)"/g;
  while ((m = re.exec(t))) f.prefix[m[1]] = (f.prefix[m[2]] || '') + m[3];
  re = /(?:ListenAndServe|Run|Start)\(\s*":(\d+)"/g;
  while ((m = re.exec(t))) repo.ports.add(m[1]);
}

function extractGo(f, repo) {
  const t = f.text;
  let m;
  let re = /(\w+)\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Any|Handle|HandleFunc)\(/g;
  while ((m = re.exec(t))) {
    if (commented(f, m.index)) continue;
    const { args, close } = U.callArgs(t, re.lastIndex - 1, 'go');
    if (close < 0 || !args.length) continue;
    const verb = m[2], lit = /^"/.test(args[0]);
    if (m[1] === 'http' && /^(Get|Post)$/.test(verb)) {
      const p = parseUrl(args[0], f, repo);
      if (p.url != null) repo.calls.push({ method: verb.toUpperCase(), url: p.url, hint: p.hint, f, idx: m.index, end: close, raw: args[0].slice(0, 160) });
      continue;
    }
    if (lit && args.length >= 2) {
      let p = unq(args[0]), method = /^(Any|Handle|HandleFunc)$/.test(verb) ? 'ANY' : verb.toUpperCase();
      const mm = /^([A-Z]+)\s+(\/.*)$/.exec(p);
      if (mm) { method = mm[1]; p = mm[2]; }
      const chained = /^\s*\.Methods\(\s*"(\w+)"/.exec(t.slice(close + 1, close + 60));
      if (chained) method = chained[1];
      if (p.startsWith('/') || f.prefix[m[1]]) repo.routes.push({ method, path: (f.prefix[m[1]] || '') + p, f, idx: m.index, end: close });
    } else if (args.length === 1 && /^(Get|Post|Put|Patch|Delete)$/.test(verb)) {
      const p = parseUrl(args[0], f, repo);
      if (p.url != null && /\//.test(p.url)) repo.calls.push({ method: verb.toUpperCase(), url: p.url, hint: p.hint, f, idx: m.index, end: close, raw: args[0].slice(0, 160) });
    }
  }
  re = /http\.NewRequest(?:WithContext)?\(/g;
  while ((m = re.exec(t))) {
    const { args, close } = U.callArgs(t, re.lastIndex - 1, 'go');
    const mi = args.findIndex((a) => /^"[A-Z]+"$|http\.Method/.test(a));
    if (close < 0 || mi < 0 || !args[mi + 1]) continue;
    const p = parseUrl(args[mi + 1], f, repo);
    if (p.url != null) repo.calls.push({ method: unq(args[mi]).replace(/^http\.Method/, '').toUpperCase(), url: p.url, hint: p.hint, f, idx: m.index, end: close, raw: args[mi + 1].slice(0, 160) });
  }
}

// ───────────────────────────── config files ─────────────────────────────

function readCfg(f, repo) {
  const name = f.rel.split('/').pop();
  if (name === 'package.json') {
    try {
      const pkg = JSON.parse(f.text);
      const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
      if (['react', 'vue', '@angular/core', 'svelte', 'next', 'preact', 'solid-js', 'nuxt'].some((d) => d in deps)) repo.frontend = true;
    } catch { /* ignore */ }
    return;
  }
  if (name.startsWith('.env')) {
    for (const line of f.text.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*["']?([^"'#\n]*)/.exec(line);
      if (!m) continue;
      const v = m[2].trim();
      if (/^(https?:\/\/|\/)/.test(v) && repo.env[m[1]] == null) repo.env[m[1]] = v;
      if (/^PORT$/.test(m[1]) && /^\d+$/.test(v)) repo.ports.add(v);
    }
    return;
  }
  const p = /server\.port\s*[=:]\s*(\d+)|server:\s*\n\s+port:\s*(\d+)/.exec(f.text);
  if (p) repo.ports.add(p[1] || p[2]);
}

const PREP = { js: prepJs, py: prepPy, java: prepJava, go: prepGo };
const EXTRACT = { js: extractJs, py: extractPy, java: extractJava, go: extractGo };

function prep(f, repo) {
  if (f.lang === 'cfg') return readCfg(f, repo);
  if (f.lang === 'prisma') {
    const re = /^model\s+(\w+)\s*\{/gm;
    let m;
    while ((m = re.exec(f.text))) addModel(f, repo, m[1], m.index, 'prisma model', `\\bprisma\\.${m[1][0].toLowerCase()}${m[1].slice(1)}\\b`);
    return;
  }
  PREP[f.lang](f, repo);
  sqlTables(f, repo);
}
const extract = (f, repo) => { if (EXTRACT[f.lang]) EXTRACT[f.lang](f, repo); };

module.exports = { prep, extract, snippet, lineOf };
