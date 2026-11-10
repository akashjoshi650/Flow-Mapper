'use strict';
// Talks to Ollama. The model never sees whole repos - only the relevant slice of the
// already-extracted graph (nodes, their connections, code snippets and types).

const STOP = new Set(('the a an is are was what which who how where when why does do did of to in on for from with and or it this that ' +
  'i me my we our you can could would should tell show give about there be by at as into data type types flow full explain please').split(' '));
const words = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

function indexGraph(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map(), inc = new Map();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inc.has(e.to)) inc.set(e.to, []);
    out.get(e.from).push(e.to); inc.get(e.to).push(e.from);
  }
  return { byId, out, inc };
}

const KIND = { ui: 'UI', call: 'API CALL', endpoint: 'ENDPOINT', data: 'DATA' };
const name = (n) => (n.kind === 'endpoint' ? `[${n.repo}] ${n.label}` : n.kind === 'data' ? `${n.tech || 'data'} ${n.label}` : n.kind === 'ui' ? `${n.label} (${n.repo})` : n.label);

// One line per end-to-end path:  CheckoutPage (shop-frontend) -> POST /api/orders -> [order-service] POST /api/orders -> ...
function flowLines(graph, ix, startIds, max = 60) {
  const lines = new Set();
  const walk = (id, trail, seen) => {
    if (lines.size >= max) return;
    const n = ix.byId.get(id);
    const next = (ix.out.get(id) || []).filter((x) => !seen.has(x));
    const here = trail.concat(n.kind === 'call' && trail.length && next.length ? [] : [name(n) + (n.unmatched ? ' (no matching endpoint found)' : '')]);
    if (!next.length || here.length > 9) { if (here.length > 1) lines.add(here.join(' -> ')); return; }
    for (const x of next) walk(x, here, new Set(seen).add(x));
  };
  const starts = startIds || graph.nodes.filter((n) => !(ix.inc.get(n.id) || []).length && (ix.out.get(n.id) || []).length).map((n) => n.id);
  for (const s of starts) walk(s, [], new Set([s]));
  return [...lines];
}

function describe(n, ix, codeLines = 45) {
  const lab = (ids) => (ids || []).map((id) => name(ix.byId.get(id))).slice(0, 8).join('; ') || 'none';
  let s = `### ${KIND[n.kind]}: ${n.label}\nrepo: ${n.repo} | file: ${n.file}:${n.line}\n`;
  s += `comes from: ${lab(ix.inc.get(n.id))}\ngoes to: ${lab(ix.out.get(n.id))}\n`;
  if (n.kind === 'call') s += n.unmatched ? `target: ${n.external ? 'external API ' + n.host : 'no matching endpoint found in scanned repos'}\n` : `target service: ${n.target}\n`;
  if (n.sends) s += `request body sent: ${n.sends}\n`;
  if (n.responseType) s += `response type: ${n.responseType}\n`;
  if (n.snippet) s += 'code:\n```\n' + n.snippet.split('\n').slice(0, codeLines).join('\n') + '\n```\n';
  for (const t of n.types || []) s += `type ${t.name} (${t.file}:${t.line}):\n\`\`\`\n${t.snippet}\n\`\`\`\n`;
  return s;
}

function retrieve(graph, ix, question, selectedId, k = 6) {
  const q = [...new Set(words(question))];
  const docs = graph.nodes.map((n) => ({
    n, head: new Set(words(n.label + ' ' + n.repo)), file: new Set(words(n.file)),
    body: new Set(words((n.snippet || '') + ' ' + (n.sends || '') + ' ' + (n.types || []).map((t) => t.name + ' ' + t.snippet).join(' '))),
  }));
  const df = {};
  for (const w of q) df[w] = docs.filter((d) => d.head.has(w) || d.file.has(w) || d.body.has(w)).length;
  const scored = docs.map((d) => {
    let s = 0;
    for (const w of q) {
      if (!df[w]) continue;
      const idf = Math.log(1 + docs.length / df[w]);
      s += idf * (d.head.has(w) ? 3 : d.file.has(w) ? 2 : d.body.has(w) ? 1 : 0);
    }
    return { n: d.n, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.n);
  const picked = [];
  const add = (n) => { if (n && !picked.includes(n)) picked.push(n); };
  if (selectedId) add(ix.byId.get(selectedId));
  scored.forEach(add);
  // pull in direct neighbours of the best hits so the model sees both ends of a connection
  for (const n of picked.slice(0, 3)) for (const id of [...(ix.out.get(n.id) || []), ...(ix.inc.get(n.id) || [])].slice(0, 4)) add(ix.byId.get(id));
  return picked.slice(0, 12);
}

const SYSTEM = `You are FlowMap, an assistant that explains how data moves through a system made of several code repositories.
You are given facts extracted from the code by static analysis: UI components, the API calls they make, backend endpoints, calls between services, and data models/tables, with code snippets and type definitions.
Rules:
- Answer ONLY from the provided context. If the context does not contain the answer, say so plainly and say what is missing.
- When you describe a flow, go step by step: UI -> API call (method + path) -> service endpoint -> downstream services -> data store.
- For data types, quote field names and types exactly as they appear in the snippets.
- Mention the file and line (file:line) for the things you reference.
- Be concise and use plain language.`;

function buildMessages(graph, { question, history = [], selectedId, numCtxChars = 14000 }) {
  const ix = indexGraph(graph);
  const picked = retrieve(graph, ix, question, selectedId);
  const overview = graph.repos.map((r) => `- ${r.name} (${r.frontend ? 'frontend' : 'service'}): ${r.endpoints} endpoints, ${r.calls} outgoing API calls`).join('\n');
  const flows = flowLines(graph, ix);
  let ctx = `## Repositories\n${overview}\n\n## End-to-end flows found\n${flows.join('\n') || '(none found)'}\n`;
  if (selectedId && ix.byId.has(selectedId)) ctx += `\n## The user currently has this item selected: ${name(ix.byId.get(selectedId))}\n`;
  ctx += '\n## Relevant items\n';
  const used = [];
  for (const n of picked) {
    const d = describe(n, ix, used.length < 4 ? 45 : 20);
    if (ctx.length + d.length > numCtxChars && used.length) break;
    ctx += d + '\n'; used.push(n.id);
  }
  const messages = [{ role: 'system', content: SYSTEM }, ...history.slice(-6),
    { role: 'user', content: `Context extracted from the code:\n\n${ctx}\n---\nQuestion: ${question}` }];
  return { messages, sources: used };
}

function explainMessages(graph, id) {
  const ix = indexGraph(graph);
  const n = ix.byId.get(id);
  if (!n) return null;
  const up = [], seen = new Set([id]);
  let frontier = [id];
  while (frontier.length) { // walk back to where this flow starts
    const next = [];
    for (const x of frontier) for (const p of ix.inc.get(x) || []) if (!seen.has(p)) { seen.add(p); next.push(p); }
    if (!next.length) up.push(...frontier);
    frontier = next;
  }
  const flows = flowLines(graph, ix, up, 40).filter((l) => l.includes(name(n)) || n.kind === 'call');
  let ctx = `## Flows through this item\n${flows.slice(0, 12).join('\n') || '(not connected to anything)'}\n\n## The item\n${describe(n, ix, 60)}\n## Directly connected items\n`;
  for (const x of [...(ix.inc.get(id) || []), ...(ix.out.get(id) || [])].slice(0, 5)) ctx += describe(ix.byId.get(x), ix, 20) + '\n';
  return [{ role: 'system', content: SYSTEM }, {
    role: 'user',
    content: `Context extracted from the code:\n\n${ctx.slice(0, 14000)}\n---\nExplain "${n.label}" in a few short points: what it does, what data comes in (fields and types), what it sends or returns, and what it connects to.`,
  }];
}

async function ollamaTags(url) {
  const res = await fetch(url.replace(/\/$/, '') + '/api/tags', { signal: AbortSignal.timeout(2500) });
  const j = await res.json();
  return (j.models || []).map((m) => m.name);
}

async function ollamaChat({ url, model, messages, onToken, signal }) {
  let res;
  try {
    res = await fetch(url.replace(/\/$/, '') + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ model, messages, stream: true, options: { temperature: 0.2, num_ctx: 8192 } }),
    });
  } catch (e) {
    throw new Error(`Could not reach Ollama at ${url}. Start it with "ollama serve" (or open the Ollama app) and try again.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404) throw new Error(`Ollama does not have the model "${model}". Run:  ollama pull ${model}`);
    throw new Error(`Ollama error ${res.status}: ${body.slice(0, 200)}`);
  }
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new Error('Ollama: ' + j.error);
      if (j.message && j.message.content) onToken(j.message.content);
    }
  }
}

module.exports = { buildMessages, explainMessages, ollamaTags, ollamaChat };
