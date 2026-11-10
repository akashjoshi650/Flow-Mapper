#!/usr/bin/env node
'use strict';
// FlowMap - map how data flows across your repos, then chat about it with a local Ollama model.
//
//   node flowmap.js                      scan the repos in flowmap.config.json and open the map
//   node flowmap.js <repo> <repo> ...    scan these folders instead of the ones in the config
//   node flowmap.js scan                 only scan and write .flowmap/graph.json
//   options: --port 4321  --model <name>  --no-open
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const { scan } = require('./src/scan');
const chat = require('./src/chat');

if (parseInt(process.versions.node, 10) < 18) { console.error('FlowMap needs Node.js 18 or newer. You have ' + process.version); process.exit(1); }

const HERE = __dirname;
const OUT = path.join(HERE, '.flowmap');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const portArg = flag('--port'), modelArg = flag('--model');
const noOpen = argv.includes('--no-open');
const rest = argv.filter((a) => !a.startsWith('--'));
const scanOnly = rest[0] === 'scan';
const cliRepos = rest.filter((a) => a !== 'scan');

function loadConfig() {
  let cfg = {};
  const file = path.join(HERE, 'flowmap.config.json');
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (fs.existsSync(file)) { console.error('flowmap.config.json is not valid JSON: ' + e.message + '\nTip: on Windows write paths with forward slashes, e.g. "E:/work/my-repo".'); process.exit(1); }
  }
  cfg.ollama = Object.assign({ url: 'http://localhost:11434', model: 'qwen2.5-coder:7b' }, cfg.ollama);
  if (modelArg) cfg.ollama.model = modelArg;
  if (cliRepos.length) cfg.repos = cliRepos.map((p) => path.resolve(process.cwd(), p));
  cfg.port = Number(portArg || cfg.port || 4321);
  return cfg;
}

let graph = null;
function runScan() {
  const cfg = loadConfig();
  const t = Date.now();
  graph = scan(cfg, HERE);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'graph.json'), JSON.stringify(graph, null, 1));
  console.log(`\nScanned ${graph.repos.length} repo(s) in ${Date.now() - t} ms`);
  for (const r of graph.repos) {
    console.log(r.error ? `  x ${r.name}: ${r.error}` : `  - ${r.name.padEnd(28)} ${String(r.files).padStart(5)} files  ${String(r.endpoints).padStart(4)} endpoints  ${String(r.calls).padStart(4)} API calls`);
  }
  const links = graph.edges.filter((e) => e.type === 'http').length;
  const totalCalls = graph.nodes.filter((n) => n.kind === 'call').length;
  console.log(`  ${links} of ${totalCalls} API calls matched to an endpoint`);
  return cfg;
}

let cfg = runScan();
if (scanOnly) { console.log('\nWrote ' + path.join(OUT, 'graph.json')); process.exit(0); }

// ── explanation cache ──
const cacheFile = path.join(OUT, 'explanations.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first run */ }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

// Streams newline-delimited JSON: {sources:[ids]} {token:"..."} ... {done:true} or {error:"..."}
async function stream(req, res, messages, sources, model, onDone) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  const send = (o) => res.write(JSON.stringify(o) + '\n');
  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  if (sources) send({ sources });
  let full = '';
  try {
    await chat.ollamaChat({ url: cfg.ollama.url, model: model || cfg.ollama.model, messages, signal: ctl.signal, onToken: (t) => { full += t; send({ token: t }); } });
    if (onDone) onDone(full);
    send({ done: true });
  } catch (e) {
    if (!ctl.signal.aborted) send({ error: e.message });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/graph') return json(res, 200, graph);
    if (url.pathname === '/api/rescan' && req.method === 'POST') { cfg = runScan(); return json(res, 200, graph); }
    if (url.pathname === '/api/status') {
      try {
        const models = await chat.ollamaTags(cfg.ollama.url);
        return json(res, 200, { ollama: true, models, model: cfg.ollama.model, url: cfg.ollama.url });
      } catch { return json(res, 200, { ollama: false, models: [], model: cfg.ollama.model, url: cfg.ollama.url }); }
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.question) return json(res, 400, { error: 'question is required' });
      const { messages, sources } = chat.buildMessages(graph, body);
      return stream(req, res, messages, sources, body.model);
    }
    if (url.pathname === '/api/explain' && req.method === 'POST') {
      const body = await readBody(req);
      const node = graph.nodes.find((n) => n.id === body.id);
      if (!node) return json(res, 404, { error: 'unknown item' });
      const key = body.id + '|' + (node.snippet || '').length + '|' + (body.model || cfg.ollama.model);
      if (cache[key] && !body.refresh) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        return res.end(JSON.stringify({ token: cache[key] }) + '\n' + JSON.stringify({ done: true, cached: true }) + '\n');
      }
      return stream(req, res, chat.explainMessages(graph, body.id), null, body.model, (full) => {
        cache[key] = full;
        try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* cache is optional */ }
      });
    }
    // static files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(HERE, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.join(HERE, 'public')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${cfg.port} is already in use. Try:  node flowmap.js --port ${cfg.port + 1}`);
  else console.error(e.message);
  process.exit(1);
});
server.listen(cfg.port, '127.0.0.1', () => {
  const link = `http://localhost:${cfg.port}`;
  console.log(`\nFlowMap is running at ${link}   (Ctrl+C to stop)`);
  chat.ollamaTags(cfg.ollama.url)
    .then((models) => {
      if (!models.some((m) => m === cfg.ollama.model || m.split(':')[0] === cfg.ollama.model)) console.log(`Chat: Ollama is running but "${cfg.ollama.model}" is not installed. Run:  ollama pull ${cfg.ollama.model}`);
      else console.log(`Chat: using Ollama model ${cfg.ollama.model}`);
    })
    .catch(() => console.log('Chat: Ollama is not running. The map works without it; start Ollama to use chat.'));
  if (!noOpen) {
    const cmd = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
    exec(cmd, () => {});
  }
});
