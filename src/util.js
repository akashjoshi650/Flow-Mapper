'use strict';
// Small text helpers shared by the scanner: file walking, bracket matching, line lookup.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'out', 'coverage', 'venv', '.venv', 'env',
  '__pycache__', 'target', 'vendor', '.idea', '.vscode', '.flowmap', 'bin', 'obj', '.gradle', 'migrations',
  '__tests__', '__mocks__', 'tests', 'test', 'e2e', 'cypress', '.ipynb_checkpoints', 'site-packages',
]);
const LANGS = {
  '.js': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.mjs': 'js', '.cjs': 'js', '.vue': 'js',
  '.py': 'py', '.java': 'java', '.kt': 'java', '.go': 'go', '.prisma': 'prisma',
};
const CFG_FILE = /^(\.env(\..+)?|package\.json|application[\w-]*\.(properties|ya?ml))$/;
const TEST_FILE = /(\.|_)(test|spec)\.|^test_|\.d\.ts$|\.min\.js$|\.stories\./;

function walk(root) {
  const out = [];
  const go = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) go(abs); continue; }
      if (!e.isFile()) continue;
      const lang = CFG_FILE.test(e.name) ? 'cfg' : LANGS[path.extname(e.name).toLowerCase()];
      if (!lang || (lang !== 'cfg' && TEST_FILE.test(e.name))) continue;
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { continue; }
      if (size > 500 * 1024) continue;
      out.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/'), lang });
    }
  };
  go(root);
  return out;
}

function lineStarts(text) {
  const a = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) a.push(i + 1);
  return a;
}
// 1-based line number of a character index
function lineAt(starts, idx) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

// Returns the index just after the string literal that starts at i.
function skipString(text, i, lang) {
  const q = text[i];
  if (lang === 'py' && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
    const e = text.indexOf(text.substr(i, 3), i + 3);
    return e < 0 ? text.length : e + 3;
  }
  if (q === '`') {
    let j = i + 1;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return j + 1;
      if (c === '$' && text[j + 1] === '{') { const e = scan(text, j + 1, lang); if (e < 0) return text.length; j = e + 1; continue; }
      j++;
    }
    return text.length;
  }
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (c === '\n') return i + 1; // not really a string (apostrophe in JSX text etc.)
    j++;
  }
  return text.length;
}

// From an opening bracket at `open`, return the index of its matching close (or -1).
function scan(text, open, lang, onComma) {
  let depth = 0;
  const limit = Math.min(text.length, open + 80000);
  for (let i = open; i < limit; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i, lang) - 1; continue; }
    if (lang !== 'py' && c === '/') {
      if (text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return -1; continue; }
      if (text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
    }
    if (lang === 'py' && c === '#') { i = text.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; if (depth < 0) return -1; }
    else if (c === ',' && depth === 1 && onComma) onComma(i);
  }
  return -1;
}

// Split the arguments of a call whose "(" is at `open`.
function callArgs(text, open, lang) {
  const commas = [];
  const close = scan(text, open, lang, (i) => commas.push(i));
  if (close < 0) return { args: [], close: -1 };
  const args = [];
  let prev = open + 1;
  for (const c of commas) { args.push(text.slice(prev, c)); prev = c + 1; }
  const last = text.slice(prev, close);
  if (last.trim() || args.length) args.push(last);
  return { args: args.map((a) => a.trim()), close };
}

// Find the end of a "{ ... }" body that starts somewhere after idx.
function bodyFrom(text, idx, lang) {
  const limit = Math.min(text.length, idx + 300);
  for (let i = idx; i < limit; i++) {
    const c = text[i];
    if (c === '{') return scan(text, i, lang);
    if (c === ';') return -1;
    if (c === '(') { const e = scan(text, i, lang); if (e < 0) return -1; i = e; }
  }
  return -1;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

module.exports = { walk, lineStarts, lineAt, skipString, scan, callArgs, bodyFrom, norm };
