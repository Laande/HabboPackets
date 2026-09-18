'use strict';

const PATHS = {
  packets: './api/packets.json',
  fields: './api/fields.json',
  templates: './api/templates.json'
};

const DIR_LABEL = {
  in: { text: 'In', long: 'Server → Client' },
  out: { text: 'Out', long: 'Client → Server' }
};

const MAX_DEPTH = 6;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  mode: 'packets',
  q: '',
  dir: 'all',
  customOnly: false,
  packets: null,
  fields: null,
  templates: null,
  selection: null
};

const $ = sel => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + url);
  return res.json();
}

function loadPackets() {
  return fetchJson(PATHS.packets).then(d => {
    const out = [];
    for (const dir of ['in', 'out']) {
      for (const [name, v] of Object.entries(d[dir] || {})) out.push(Object.assign({ name, direction: dir }, v));
    }
    return out;
  });
}
function loadFields() {
  return fetchJson(PATHS.fields).then(d => {
    const out = [];
    for (const dir of ['in', 'out']) {
      for (const [name, v] of Object.entries(d[dir] || {})) out.push(Object.assign({ name, direction: dir }, v));
    }
    return out;
  });
}
function loadTemplates() { return fetchJson(PATHS.templates); }

// ---------------------------------------------------------------------------
// Field tree rendering
// ---------------------------------------------------------------------------

function kindLabel(f) {
  switch (f.kind) {
    case 'primitive': return f.type;
    case 'optional': return 'optional';
    case 'list': return 'list ×' + (f.count || 'i');
    case 'map': return 'map (pairs)';
    case 'array': return 'array ×' + f.size;
    case 'tuple': return 'tuple';
    case 'unknown': return 'unknown';
    default: return '';
  }
}

function kindBadge(f) {
  if (f.kind === 'primitive') return '';
  return ' <span class="kind-badge ' + esc(f.kind) + '">' + kindLabel(f) + '</span>';
}

function treeHtml(fields) {
  if (!fields || !fields.length) return '';
  return '<ul class="tree">' + fields.map(f => renderNode(f, 0, new Set())).join('') + '</ul>';
}

// Renders a single node (<li>). Template references are expanded inline.
function renderNode(node, depth, seen) {
  depth = depth || 0;
  seen = seen || new Set();
  if (!node) return '';

  const nameHtml = (node.name !== undefined && node.name !== null && node.name !== '')
    ? '<span class="fname">' + esc(node.name) + '</span>'
    : '';
  // Layout tokens that contain a <reference> are hidden : the structure itself
  // is shown inline instead of the placeholder name.
  const hasRef = node.layout !== undefined && node.layout !== null && String(node.layout).includes('<');
  const tok = !hasRef && node.layout !== undefined && node.layout !== null
    ? ' <code class="tok">' + esc(node.layout) + '</code>'
    : '';
  const opt = node.optional ? ' <span class="opt-mark">?</span>' : '';
  const note = node.note ? ' <span class="note">// ' + esc(node.note) + '</span>' : '';

  if (node.kind === 'template') {
    if (seen.has(node.ref)) {
      return '<li><div class="row">' + nameHtml
        + ' <span class="tpl">' + esc(node.ref) + '</span> <span class="note">(recursive)</span></div></li>';
    }
    return '<li><div class="row">' + nameHtml + opt + '</div>'
      + templateBody(node.ref, depth + 1, seen) + '</li>';
  }

  let html = '<li><div class="row">' + nameHtml + tok + opt + kindBadge(node) + note + '</div>';

  if (Array.isArray(node.items)) {
    html += '<ul class="tree">' + node.items.map(it => renderNode(it, depth + 1, seen)).join('') + '</ul>';
  }
  if (node.key && node.value) {
    html += '<ul class="tree">' + renderNode(node.key, depth + 1, seen) + renderNode(node.value, depth + 1, seen) + '</ul>';
  }
  if (node.of) {
    html += '<ul class="tree">' + renderNode(node.of, depth + 1, seen) + '</ul>';
  }
  return html + '</li>';
}

// Renders the body (children) of a referenced structure.
function templateBody(name, depth, seen) {
  if (depth > MAX_DEPTH) return ' <span class="note">( … )</span>';
  if (seen && seen.has(name)) return ' <span class="note">(recursive)</span>';

  const t = (state.templates || []).find(x => x.name === name);
  if (!t) return ' <span class="note">(unknown structure)</span>';

  const nextSeen = new Set(seen).add(name);
  let html = '<ul class="tree">';

  if (t.kind === 'enum' && t.variants) {
    for (const v of t.variants) {
      const vlayout = v.layout && !String(v.layout).includes('<')
        ? ' <code class="tok">' + esc(v.layout) + '</code>' : '';
      html += '<li><div class="row"><span class="fname">' + esc(v.name) + '</span>'
        + vlayout
        + (v.note ? ' <span class="note">// ' + esc(v.note) + '</span>' : '') + '</div>';
      if (v.fields && v.fields.length) {
        html += '<ul class="tree">' + v.fields.map(f => renderNode(f, depth + 1, nextSeen)).join('') + '</ul>';
      }
      html += '</li>';
    }
  } else if (t.fields && t.fields.length) {
    html += t.fields.map(f => renderNode(f, depth + 1, nextSeen)).join('');
  }

  html += '</ul>';
  return html;
}

// True when the expanded string has a top-level space (it spans several
// tokens) — mirrors scripts/generate.js.
function hasTopLevelSpace(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === '[' || ch === '(' || ch === '<') depth++;
    else if (ch === ']' || ch === ')' || ch === '>') depth--;
    else if (ch === ' ' && depth === 0) return true;
  }
  return false;
}

// Splits an expanded layout string into top-level tokens : spaces inside
// brackets/parens belong to the enclosing token (e.g. "i[i s]", "(i i)?",
// "<Name>", "i(... | ...)" are each a single token).
function tokenizeLayout(s) {
  const tokens = [];
  let cur = '', depth = 0;
  for (const ch of String(s || '')) {
    if (ch === '[' || ch === '(' || ch === '<') depth++;
    else if (ch === ']' || ch === ')' || ch === '>') depth--;
    if (ch === ' ' && depth === 0) {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// ---------------------------------------------------------------------------
// Layout (character ranges) ↔ tree rows highlighting
// ---------------------------------------------------------------------------

function layoutBlock(p) {
  if (!p.layout) return '';
  const id = 'layout-' + p.name;
  const rows = packetRowsOf(p);
  return '<div class="layout-block"><code id="' + id + '">' + layoutHtml(p.layout, rows) + '</code>'
    + '<button class="copy-btn" data-copy="' + id + '">Copy</button></div>'
    + '<div class="layout-hint">Hover a token or a field to cross-highlight it; click to lock the highlight (click again or press Esc to unlock).</div>'
}

function packetRowsOf(p) {
  if (!p._rows) p._rows = buildSpanRows(p);
  return p._rows;
}

// Builds, for each "<div class=row>" rendered for a packet, the exact character
// range [cs, ce) it occupies in the expanded layout. Ranges are computed from
// the very same expansion grammar as scripts/generate.js (exp()), so each
// element inside a composite — a list item, an enum variant, an optional group,
// a template object — gets its own precise slice of the layout string.
function buildSpanRows(p) {
  const rows = [];
  const tpl = name => (state.templates || []).find(t => t.name === name);

  function exp(node, seen) {
    if (!node) return '';
    switch (node.kind) {
      case 'primitive': return node.token;
      case 'optional': {
        const inner = exp(node.of, seen);
        return inner ? (hasTopLevelSpace(inner) ? '(' + inner + ')?' : inner + '?') : '?';
      }
      case 'list': return 'i[' + exp(node.of, seen) + ']';
      case 'map': return 'i[' + exp(node.key, seen) + exp(node.value, seen) + ']';
      case 'array': return '#' + node.size + '[' + exp(node.of, seen) + ']';
      case 'tuple': return (node.items || []).map(it => exp(it, seen)).join('');
      case 'template': {
        const t = tpl(node.ref);
        if (!t || (seen && seen.has(node.ref))) return '<' + node.ref + '>';
        const next = new Set(seen || []).add(node.ref);
        if (t.kind === 'enum' && t.variants) {
          const parts = t.variants.map(v => {
            const l = (v.fields || []).map(f => exp(f, next)).join(' ');
            return l || '\u00B7';
          });
          return (new Set(parts).size === 1 && parts[0] === '\u00B7')
            ? 'i'
            : 'i(' + parts.join(' | ') + ')';
        }
        return (t.fields || []).map(f => exp(f, next)).join(' ');
      }
      default: return '?';
    }
  }

  // Places the node's own row (range [base, base + expansion length)) and its
  // children, in the same order as renderNode/templateBody (template bodies are
  // capped at MAX_DEPTH; composite children are not).
  function place(node, depth, seen, base, emit) {
    const text = exp(node, seen);
    const len = text.length;
    if (emit) rows.push({ cs: base, ce: base + len, pl: depth, kind: node.kind, ref: node.ref });
    if (node.kind === 'primitive' || node.kind === 'unknown') return base + len;

    const kidsOfTemplate = emit && depth + 1 <= MAX_DEPTH;

    switch (node.kind) {
      case 'list': place(node.of, depth + 1, seen, base + 2, emit); break;
      case 'map': {
        const kEnd = place(node.key, depth + 1, seen, base + 2, emit);
        place(node.value, depth + 1, seen, kEnd, emit);
        break;
      }
      case 'array': place(node.of, depth + 1, seen, base + 2 + String(node.size).length, emit); break;
      case 'tuple': {
        let pos = base;
        for (const it of (node.items || [])) pos = place(it, depth + 1, seen, pos, emit);
        break;
      }
      case 'optional': {
        const inner = exp(node.of, seen);
        const off = inner && hasTopLevelSpace(inner) ? 1 : 0;
        place(node.of, depth + 1, seen, base + off, emit);
        break;
      }
      case 'template': {
        const t = tpl(node.ref);
        if (!t || (seen && seen.has(node.ref))) return base + len;
        const next = new Set(seen).add(node.ref);
        if (t.kind === 'enum' && t.variants) {
          const parts = t.variants.map(v => (v.fields || []).map(f => exp(f, next)).join(' ') || '\u00B7');
          if (new Set(parts).size === 1 && parts[0] === '\u00B7') {
            const z = base + 1;
            if (emit) for (const v of t.variants) rows.push({ cs: z, ce: z, pl: depth + 1, kind: 'variant', ref: node.ref, name: v.name });
            if (kidsOfTemplate) for (const v of t.variants) for (const f of (v.fields || [])) place(f, depth + 1, next, z, emit);
          } else {
            let vStart = base + 2;
            t.variants.forEach((v, vi) => {
              const vLen = parts[vi].length;
              if (emit) rows.push({ cs: vStart, ce: vStart + vLen, pl: depth + 1, kind: 'variant', ref: node.ref, name: v.name });
              if (kidsOfTemplate) {
                let fOff = vStart;
                for (const f of (v.fields || [])) { fOff = place(f, depth + 1, next, fOff, emit); fOff += 1; }
              }
              vStart += vLen + 3;
            });
          }
          return base + len;
        }
        // object template : fields joined with a single space
        let fOff = base;
        for (const f of (t.fields || [])) { fOff = place(f, depth + 1, next, fOff, kidsOfTemplate); fOff += 1; }
        return base + len;
      }
    }
    return base + len;
  }

  let base = 0;
  const fields = p.fields || [];
  for (let i = 0; i < fields.length; i++) {
    base = place(fields[i], 0, new Set(), base, true);
    if (i < fields.length - 1) base += 1;
  }
  return rows;
}

// Renders the layout with a nested <span class="ltok"> per tree row, using the
// rows' [cs, ce) ranges. Hovering an inner span (e.g. a list element, an enum
// variant, a field of an optional group) therefore targets exactly that slice.
function layoutHtml(layout, rows) {
  const sorted = rows.map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.cs - b.r.cs || b.r.ce - a.r.ce || a.i - b.i);
  const stack = [];
  const children = new Map();
  const roots = [];
  for (const { r, i } of sorted) {
    while (stack.length && !(stack[stack.length - 1].r.cs <= r.cs && r.ce <= stack[stack.length - 1].r.ce)) stack.pop();
    const top = stack.length ? stack[stack.length - 1] : null;
    if (top) {
      if (!children.has(top.i)) children.set(top.i, []);
      children.get(top.i).push(i);
    } else {
      roots.push(i);
    }
    stack.push({ r, i });
  }

  function nodeHtml(i) {
    const r = rows[i];
    let out = '<span class="ltok" data-ps="' + r.cs + '" data-pe="' + r.ce + '" data-pl="' + r.pl + '">';
    let cur = r.cs;
    const kids = (children.get(i) || []).slice().sort((a, b) => rows[a].cs - rows[b].cs);
    for (const k of kids) {
      out += esc(layout.slice(cur, rows[k].cs)) + nodeHtml(k);
      cur = rows[k].ce;
    }
    out += esc(layout.slice(cur, r.ce)) + '</span>';
    return out;
  }

  roots.sort((a, b) => rows[a].cs - rows[b].cs);
  let out = '', cur = 0;
  for (const rI of roots) {
    out += esc(layout.slice(cur, rows[rI].cs)) + nodeHtml(rI);
    cur = rows[rI].ce;
  }
  out += esc(layout.slice(cur, layout.length));
  return out;
}

// Attaches the character ranges to the rendered rows, in DOM order.
function wireSpans(p) {
  pinned = null;
  const detail = $('#detail');
  const rows = packetRowsOf(p);
  detail.querySelectorAll('.tree .row').forEach((el, i) => {
    const r = rows[i];
    if (!r) return;
    el.dataset.ps = r.cs;
    el.dataset.pe = r.ce;
    el.dataset.pl = r.pl;
    el.dataset.ls = (p.layout || '').slice(r.cs, r.ce);
  });
}

function clearAllHl() {
  const d = $('#detail');
  d.querySelectorAll('.tree .row').forEach(r => r.classList.remove('hl', 'hl-a', 'hl-c'));
  d.querySelectorAll('.ltok').forEach(t => t.classList.remove('tok-hl'));
}

function clearHover() {
  if (pinned) restorePin();
  else clearAllHl();
}

// Returns the hoverable element under the pointer : a layout slice (.ltok) or a
// tree row (.row), with its kind — or null.
function targetOf(e) {
  const ltok = e.target.closest('.ltok');
  if (ltok && ltok.parentNode && ltok.parentNode.closest('.layout-block')) return { kind: 'ltok', el: ltok };
  const row = e.target.closest('.row');
  if (row && row.closest('.tree') && row.dataset.ps !== undefined && row.dataset.pe !== undefined) {
    return { kind: 'row', el: row };
  }
  return null;
}

// Highlights based on one element. A layout slice highlights the most specific
// (smallest) row covering its centre, that row's ancestors (.hl-a) and
// descendants (.hl-c). A tree row highlights its own exact slice as a single
// box (.tok-hl) — the row's span already covers the whole range [ps, pe),
// so there is no need for one box per contained element.
function applyHighlight(kind, el) {
  const detail = $('#detail');
  if (kind === 'ltok') {
    const cs = +el.dataset.ps, ce = +el.dataset.pe;
    if (!Number.isFinite(cs) || !Number.isFinite(ce) || ce <= cs) return;
    const mid = (cs + ce) / 2;
    let best = null;
    for (const r of detail.querySelectorAll('.tree .row[data-ps]')) {
      const ps = +r.dataset.ps, pe = +r.dataset.pe, w = pe - ps;
      if (w > 0 && ps <= mid && mid <= pe
        && (!best || w < +best.dataset.pe - +best.dataset.ps
          || (w === +best.dataset.pe - +best.dataset.ps && +r.dataset.pl < +best.dataset.pl))) {
        best = r;
      }
    }
    if (!best) return;
    const bps = +best.dataset.ps, bpe = +best.dataset.pe;
    best.classList.add('hl');
    for (const r of detail.querySelectorAll('.tree .row[data-ps]')) {
      if (r === best) continue;
      const ps = +r.dataset.ps, pe = +r.dataset.pe;
      if (pe > ps && ps <= mid && mid <= pe) r.classList.add('hl-a');
      else if (ps >= bps && pe <= bpe) r.classList.add('hl-c');
    }
    setHoverInfo('token', el, best);
    return;
  }
  const ps = +el.dataset.ps, pe = +el.dataset.pe;
  // The row's own exact slice is drawn as one single box. Rows born from an
  // "envelope collapse" (a variant wrapping its only field, a template wrapping
  // one list, …) share the same range with nested spans : keep the innermost.
  let self = null;
  for (const t of detail.querySelectorAll('.layout-block .ltok')) {
    if (+t.dataset.ps === ps && +t.dataset.pe === pe) self = t;
  }
  if (self) self.classList.add('tok-hl');
  setHoverInfo('row', el);
}

// A click "locks" the highlight: the pinned target is marked (.locked) and
// stays highlighted until it is clicked again, another element is pinned, or
// the user clicks empty space / presses Escape. While pinned, hover is
// disabled so the highlight stays put.
let pinned = null;

function pin(t) {
  if (pinned && pinned.el.classList) pinned.el.classList.remove('locked');
  pinned = t;
  t.el.classList.add('locked');
  clearAllHl();
  applyHighlight(t.kind, t.el);
}

function unpin() {
  if (pinned && pinned.el.classList) pinned.el.classList.remove('locked');
  pinned = null;
  clearAllHl();
}

function restorePin() {
  clearAllHl();
  if (pinned) applyHighlight(pinned.kind, pinned.el);
}

function onDetailMouseover(e) {
  if (pinned) return;
  clearAllHl();
  const t = targetOf(e);
  if (t) applyHighlight(t.kind, t.el);
}

function onDetailKeydown(e) {
  if (pinned && (e.key === 'Escape' || e.key === 'Esc')) {
    unpin();
    e.preventDefault();
  }
}

// ---------------------------------------------------------------------------
// Packet rendering
// ---------------------------------------------------------------------------

function badgesOf(p) {
  const items = [];
  if (p.direction) {
    const d = DIR_LABEL[p.direction];
    items.push('<span class="badge ' + p.direction + '" title="' + d.long + '">' + d.text + '</span>');
  }
  if (p.kind) items.push('<span class="badge plain">' + p.kind + '</span>');
  if (p.custom) items.push('<span class="badge custom" title="custom parsing">custom</span>');
  if (p.layoutIsEstimate) items.push('<span class="badge plain" title="Estimated layout, custom parsing">~</span>');
  return items.join(' ');
}

function packetHtml(p) {
  let html = '<div class="detail-head"><h2>' + esc(p.name) + '</h2>' + badgesOf(p) + '</div>';
  if (p.description) html += '<div class="desc">' + esc(p.description) + '</div>';
  if (p.note) html += '<div class="desc note">⚠ ' + esc(p.note) + '</div>';
  html += layoutBlock(p);
  html += '<h3 class="section">Structure</h3>';
  if (p.fields && p.fields.length) html += treeHtml(p.fields);
  else if (p.layout) html += '<div class="hint">No field detail — layout only.</div>';
  else html += '<div class="hint">No fields (empty packet).</div>';
  return html;
}

// ---------------------------------------------------------------------------
// Packet list
// ---------------------------------------------------------------------------

function renderPacketList() {
  const list = $('#list');
  list.innerHTML = '';
  const rows = (state.packets || []).filter(p => {
    if (state.dir !== 'all' && p.direction !== state.dir) return false;
    if (state.customOnly && !p.custom) return false;
    if (state.q && !p.name.toLowerCase().includes(state.q)) return false;
    return true;
  });
  $('#empty').hidden = rows.length !== 0;
  $('#result-meta').textContent = rows.length + ' packet(s)';
  const frag = document.createDocumentFragment();
  for (const p of rows) {
    const li = document.createElement('li');
    li.className = 'row' + (state.selection && state.selection.name === p.name && state.selection.direction === p.direction ? ' active' : '');
    li.dataset.name = p.name;
    li.dataset.direction = p.direction;
    const d = DIR_LABEL[p.direction];
    li.innerHTML = '<span class="d" style="color:' + (p.direction === 'in' ? 'var(--in)' : 'var(--out)') + '" title="' + esc(d.long) + '">' + d.text + '</span>'
      + '<span class="nm">' + esc(p.name) + '</span>'
      + (p.custom ? '<span class="badge custom" title="parsing custom">c</span>' : '');
    li.addEventListener('click', () => openPacket(p.name, p.direction));
    frag.appendChild(li);
  }
  list.appendChild(frag);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function showTab(mode) {
  state.mode = mode;
  $('#list-panel').style.display = mode === 'packets' ? '' : 'none';
  $('#packet-controls').style.display = mode === 'packets' ? '' : 'none';
  const detail = $('#detail');
  renderPacketList();
  if (!state.selection) {
    detail.innerHTML = '<div id="loading">Select a packet on the left…</div>';
  } else {
    const p = findPacket(state.selection.name);
    detail.innerHTML = packetHtml(p);
    wireSpans(p);
  }
}

function findPacket(name, direction) {
  const s = (state.packets || []).find(x => x.name === name && (direction === undefined || x.direction === direction));
  const d = (state.fields || []).find(x => x.name === name && (direction === undefined || x.direction === direction));
  if (!s && !d) return { name, fields: [], layout: '' };
  // merge the summary (custom, layout) with the detail (fields, metadata)
  return Object.assign({ name, direction: (s && s.direction) || (d && d.direction) }, s || {}, d || {});
}

function openPacket(name, direction) {
  const p = findPacket(name, direction);
  state.selection = { name, direction };
  document.querySelectorAll('#list .row').forEach(r =>
    r.classList.toggle('active', r.dataset.name === name && r.dataset.direction === direction));
  $('#detail').innerHTML = packetHtml(p);
  wireSpans(p);
  location.hash = '#/packet/' + encodeURIComponent(name) + (direction ? '/' + direction : '');
}

function showError(e) {
  $('#detail').innerHTML = '<div id="error">Could not load the data.<br>'
    + esc(String(e && e.message || e)) + '<br><br>'
    + 'Tip : open the site through a static server (<code>python -m http.server</code> or <code>npx serve</code>), not as file://.</div>';
}

// ---------------------------------------------------------------------------
// Hash routing
// ---------------------------------------------------------------------------

function route() {
  const h = location.hash;
  const pm = h.match(/^#\/packet\/([^/]+)(?:\/(in|out))?/);
  if (pm) {
    showTab('packets');
    openPacket(decodeURIComponent(pm[1]), pm[2]);
  } else {
    showTab(state.mode);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    const [packets, fields, templates] = await Promise.all([loadPackets(), loadFields(), loadTemplates()]);
    state.packets = packets;
    state.fields = fields;
    state.templates = templates;
    const incoming = (packets || []).filter(p => p.direction === 'in').length;
    $('#cnt-packets').textContent = incoming + '+' + ((packets || []).length - incoming);
  } catch (e) {
    showError(e);
    return;
  }

  // events
  $('#search').addEventListener('input', e => {
    state.q = e.target.value.trim().toLowerCase();
    if (state.mode === 'packets') renderPacketList();
  });
  $('#dir-filter').addEventListener('change', e => {
    state.dir = e.target.value;
    renderPacketList();
  });
  $('#custom-only').addEventListener('change', e => {
    state.customOnly = e.target.checked;
    if (state.mode === 'packets') renderPacketList();
  });
  $('#detail').addEventListener('mouseover', onDetailMouseover);
  $('#detail').addEventListener('mouseleave', clearHover);
  $('#detail').addEventListener('click', e => {
    const btn = e.target.closest('.copy-btn');
    if (btn) {
      const code = document.getElementById(btn.dataset.copy);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code.textContent).then(() => {
          const old = btn.textContent;
          btn.textContent = 'Copied ✓';
          setTimeout(() => { btn.textContent = old; }, 1200);
        }).catch(() => {});
      }
      return;
    }
    const t = targetOf(e);
    if (t) {
      if (pinned && pinned.kind === t.kind && pinned.el === t.el) unpin();
      else pin(t);
    } else if (pinned) {
      unpin();
    }
  });
  window.addEventListener('keydown', onDetailKeydown);

  window.addEventListener('hashchange', route);
  route();
}

// Node-only hooks for headless testing.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderNode, treeHtml, layoutBlock, esc, MAX_DEPTH, state, tokenizeLayout, buildSpanRows };
}

if (typeof document !== 'undefined') init();