'use strict';
// Turns URL expressions found in code into comparable paths.
//   `${API}/orders/${id}`      ->  /orders/{}      (API is resolved if it is a known constant)
//   BASE + "/stock/" + sku     ->  /stock/{}
//   f"{INVENTORY_URL}/stock"   ->  /stock
const U = require('./util');

// Value of a constant such as:  process.env.API || 'http://localhost:4000/api'
function litOf(expr, f, repo, depth) {
  let e = String(expr).trim();
  const g = /(?:getenv|environ\.get|getOrDefault|getProperty)\(\s*["'][^"']*["']\s*,\s*([fF]?["'][^"']*["'])\s*\)/.exec(e);
  if (g) e = g[1];
  if (/\|\||\?\?/.test(e)) e = e.split(/\|\||\?\?/).pop();
  return parseUrl(e, f, repo, depth + 1).url;
}

function parseUrl(expr, f, repo, depth = 0) {
  const lang = f.lang;
  const s = String(expr).trim();
  let out = '', hint = '', any = false, i = 0;

  const base = (chunk) => {
    const name = (/([A-Za-z_$][\w$]*)\s*(?:\(\s*\))?\s*$/.exec(chunk) || [])[1];
    if (!name) return '';
    hint = name;
    if (depth > 3) return '';
    const src = (f.consts && f.consts[name]) != null ? f.consts[name] : repo.consts[name];
    if (src != null && src.trim() !== s) { const v = litOf(src, f, repo, depth); if (v) return v; }
    return repo.env[name] || '';
  };

  while (i < s.length) {
    const c = s[i];
    if (/[\s+]/.test(c)) { i++; continue; }
    const pm = lang === 'py' ? /^([fFrRbB]{0,2})("""|'''|"|')/.exec(s.slice(i, i + 5)) : /^()(["'])/.exec(s.slice(i, i + 1));
    if (pm) {
      const q = pm[2], st = i + pm[0].length;
      let j = st;
      while (j < s.length && !s.startsWith(q, j)) { if (s[j] === '\\') j++; j++; }
      let lit = s.slice(st, j);
      if (lang === 'py' && /f/i.test(pm[1])) {
        const lead = out === '';
        lit = lit.replace(/\{([^}]*)\}/g, (all, e, pos) => (pos === 0 && lead ? base(e) : '{}'));
      }
      out += lit; any = true; i = j + q.length; continue;
    }
    if (c === '`') {
      let j = i + 1, lit = '';
      while (j < s.length && s[j] !== '`') {
        if (s[j] === '$' && s[j + 1] === '{') {
          const e = U.scan(s, j + 1, lang);
          const end = e < 0 ? s.length : e;
          lit += out === '' && lit === '' ? base(s.slice(j + 2, end)) : '{}';
          j = end + 1; continue;
        }
        lit += s[j++];
      }
      out += lit; any = true; i = j + 1; continue;
    }
    // a non-literal piece (variable, function call...) up to the next top-level "+"
    let j = i, d = 0;
    while (j < s.length) {
      const ch = s[j];
      if (ch === '"' || ch === "'" || ch === '`') { j = U.skipString(s, j, lang); continue; }
      if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; else if (ch === '+' && d === 0) break;
      j++;
    }
    const chunk = s.slice(i, j).trim();
    if (j === i) { i++; continue; }
    if (chunk.startsWith('.')) { i = j; continue; } // "...".format(x) and friends
    if (out === '' && !any) { const b = base(chunk); out += b; if (b) any = true; } else out += '{}';
    i = j;
  }
  return { url: any ? out : null, hint };
}

function joinUrl(base, url) {
  if (!base || /^([a-z]+:)?\/\//i.test(url)) return url;
  return base.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '');
}

const isParam = (s) => /^:|^\*|[{<]|^\$/.test(s);

// -> { host, port, segs: ['api','orders','{}'], display: '/api/orders/:id' }
function splitUrl(url) {
  let host = '', port = '', u = String(url).trim();
  const m = /^(?:[a-z]+:)?\/\/([^/:?#]*)(?::(\d+))?/i.exec(u);
  if (m) { host = m[1]; port = m[2] || ''; u = u.slice(m[0].length); }
  u = u.replace(/\$\{[^}]*\}/g, '{}').split(/[?#]/)[0];
  const segs = [], disp = [];
  for (const s of u.split('/')) {
    if (!s) continue;
    if (isParam(s)) { segs.push('{}'); disp.push(s === '{}' ? ':param' : s); } else { segs.push(s.toLowerCase()); disp.push(s); }
  }
  return { host: host.replace(/[{}]/g, ''), port, segs, display: '/' + disp.join('/') };
}

module.exports = { parseUrl, litOf, joinUrl, splitUrl };
