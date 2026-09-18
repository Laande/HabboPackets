#!/usr/bin/env node
/**
 * HabboPackets — JSON database generator for packet structures.
 *
 * Parses the Rust structures of the G-Rust framework and outputs :
 *   - api/packets.json    : grouped by direction { in | out : { name : { custom?, layout } } }
 *   - api/fields.json     : same grouping, detail only { description?, note?, layoutIsEstimate?, fields? }
 *   - api/templates.json  : reusable sub-structures (subparsers, stuffdata)
 *
 * Usage :
 *   node scripts/generate.js [path/to/g-rust/src]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'api');
const DEFAULT_SRC = path.resolve(ROOT, 'G-Rust-main', 'G-Rust-main', 'src');

// ---------------------------------------------------------------------------
// Types primitifs
// ---------------------------------------------------------------------------

const PRIMITIVES = {
  String:        { token: 's' },
  LongString:    { token: 'S' },
  bool:          { token: 'b' },
  u8:            { token: 'c' },
  i8:            { token: 'c' },
  i16:           { token: 'h' },
  u16:           { token: 'h' },
  i32:           { token: 'i' },
  u32:           { token: 'i' },
  i64:           { token: 'd' },
  f32:           { token: 'f' },
  f64:           { token: 'g' },
  LegacyId:      { token: 'i', legacy: true },
  LegacyLength:  { token: 'i', legacy: true },
  LegacyStringId:{ token: 's', legacy: true },
  LegacyDouble:  { token: 's', legacy: true }
};

// ---------------------------------------------------------------------------
// Utilitaires de parsing
// ---------------------------------------------------------------------------

function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
}

function strip(m) { return m === undefined ? undefined : m.trim(); }

// ---------------------------------------------------------------------------
// Parse a Rust type → type node
// ---------------------------------------------------------------------------

function parseType(raw) {
  const t = (raw || '').trim().replace(/;$/, '').trim();
  if (!t) return { kind: 'unknown', type: '' };

  let m;

  // Option<T>
  m = t.match(/^Option\s*<(.*)>$/s);
  if (m) return { kind: 'optional', of: parseType(m[1]) };

  // Vec<T>
  m = t.match(/^Vec\s*<(.*)>$/s);
  if (m) return { kind: 'list', of: parseType(m[1]) };

  // HashMap<K, V>
  m = t.match(/^HashMap\s*<(.*)>$/s);
  if (m) {
    const kv = splitTopLevel(m[1], ',');
    return {
      kind: 'map',
      key: parseType(kv[0] || ''),
      value: parseType(kv[1] || '')
    };
  }

  // tuple (A, B, C)
  m = t.match(/^\((.*)\)$/s);
  if (m) {
    const inner = m[1].trim();
    if (inner === '') return { kind: 'tuple', items: [] };
    return { kind: 'tuple', items: splitTopLevel(inner, ',').map(parseType) };
  }

  // fixed array [T; N]
  m = t.match(/^\[(.*)\s*;\s*(\d+)\]\s*$/s);
  if (m) return { kind: 'array', of: parseType(m[1]), size: parseInt(m[2], 10) };

  // primitives
  if (Object.prototype.hasOwnProperty.call(PRIMITIVES, t)) {
    const p = PRIMITIVES[t];
    const node = { kind: 'primitive', token: p.token, type: t };
    if (p.legacy) node.legacy = true;
    return node;
  }

  // reference to a named template
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    return { kind: 'template', ref: t };
  }

  return { kind: 'unknown', type: t };
}

// ---------------------------------------------------------------------------
// Layout (compact notation) from a type node
// ---------------------------------------------------------------------------

function layoutOf(node) {
  switch (node.kind) {
    case 'primitive': return node.token;
    case 'optional':  return layoutOf(node.of) + '?';
    case 'list':      return 'i[' + layoutOf(node.of) + ']';
    case 'map':       return 'i[' + layoutOf(node.key) + layoutOf(node.value) + ']';
    case 'array':     return '#' + node.size + '[' + layoutOf(node.of) + ']';
    case 'tuple':     return node.items.map(layoutOf).join('');
    case 'template':  return '<' + node.ref + '>';
    default:          return '?';
  }
}

// Expanded layout : template references are replaced by the structure inline,
// so the string shows the exact layout without any <Name>. A reference name is
// kept only when a structure contains itself (recursion) to avoid infinite text.
// A token is a top-level space-separated unit. Composite tokens (brackets,
// parens) never expose their inner spaces at the top level.
function hasTopLevelSpace(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === '[' || ch === '(' || ch === '<') depth++;
    else if (ch === ']' || ch === ')' || ch === '>') depth--;
    else if (ch === ' ' && depth === 0) return true;
  }
  return false;
}

function expandedLayoutOf(node, templateByName, path) {
  if (!node) return '';
  switch (node.kind) {
    case 'primitive': return node.token;
    case 'optional': {
      const inner = expandedLayoutOf(node.of, templateByName, path);
      return inner
        ? (hasTopLevelSpace(inner) ? '(' + inner + ')?' : inner + '?')
        : '?';
    }
    case 'list':      return 'i[' + expandedLayoutOf(node.of, templateByName, path) + ']';
    case 'map':       return 'i[' + expandedLayoutOf(node.key, templateByName, path) + expandedLayoutOf(node.value, templateByName, path) + ']';
    case 'array':     return '#' + node.size + '[' + expandedLayoutOf(node.of, templateByName, path) + ']';
    case 'tuple':     return node.items.map(it => expandedLayoutOf(it, templateByName, path)).join('');
    case 'template': {
      const t = templateByName.get(node.ref);
      if (!t || (path && path.has(node.ref))) return '<' + node.ref + '>';
      const next = new Set(path || []).add(node.ref);
      if (t.kind === 'enum' && t.variants) {
        const parts = t.variants.map(v => {
          const l = (v.fields || []).map(f => expandedLayoutOf(f, templateByName, next)).join(' ');
          return l || '·';
        });
        return new Set(parts).size === 1 && parts[0] === '·'
          ? 'i'
          : 'i(' + parts.join(' | ') + ')';
      }
      return (t.fields || []).map(f => expandedLayoutOf(f, templateByName, next)).join(' ');
    }
    default: return '?';
  }
}

function expandedLayoutOfFields(fields, templateByName, path) {
  return (fields || []).map(f => expandedLayoutOf(f, templateByName, path)).join(' ');
}

// ---------------------------------------------------------------------------
// Field node (JSON)
// ---------------------------------------------------------------------------

function fieldNode(name, typeNode, note) {
  const out = { name };
  switch (typeNode.kind) {
    case 'primitive':
      out.kind = 'primitive';
      out.token = typeNode.token;
      out.type = typeNode.type;
      break;
    case 'optional':
      out.kind = 'optional';
      out.of = fieldNode(name + '?', typeNode.of, undefined);
      Object.assign(out, { optional: true });
      break;
    case 'list':
      out.kind = 'list';
      out.count = 'i';
      out.of = fieldNode('item', typeNode.of, undefined);
      break;
    case 'map':
      out.kind = 'map';
      out.key = fieldNode('key', typeNode.key, undefined);
      out.value = fieldNode('value', typeNode.value, undefined);
      break;
    case 'array':
      out.kind = 'array';
      out.size = typeNode.size;
      out.of = fieldNode('item', typeNode.of, undefined);
      break;
    case 'tuple':
      out.kind = 'tuple';
      out.items = (typeNode.items || []).map((it, i) => fieldNode(String(i), it, undefined));
      break;
    case 'template':
      out.kind = 'template';
      out.ref = typeNode.ref;
      break;
    default:
      out.kind = 'unknown';
      out.type = typeNode.type || '';
  }
  out.layout = layoutOf(typeNode);
  if (note) out.note = note;
  return out;
}

// ---------------------------------------------------------------------------
// Parser de fichiers Rust
// ---------------------------------------------------------------------------

const FIELD_RE = /^pub(?:\(crate\))?\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
const PRIVATE_FIELD_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/;
const VARIANT_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*[,{]?\s*(.*)$/;

function countBraces(line) {
  let d = 0;
  for (const ch of line) {
    if (ch === '{') d++;
    else if (ch === '}') d--;
  }
  return d;
}

function stripComment(line) {
  // strips a // comment outside of strings (Rust declarations contain no strings)
  const idx = line.indexOf('//');
  if (idx === -1) return { code: line.trim(), comment: null };
  return { code: line.slice(0, idx).trim(), comment: line.slice(idx + 2).trim() };
}

function parseFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const units = [];
  const customImpls = new Set();
  const fileComments = [];

  // pass 1 : find manual PacketVariable impls
  for (const line of lines) {
    const m = line.match(/impl\s+PacketVariable\s+for\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) customImpls.add(m[1]);
  }

  let unit = null;        // current unit
  let variant = null;     // current enum variant
  let depth = 0;          // brace depth inside the unit
  let pendingAttrs = [];
  let pendingDoc = [];
  let pendingNote = null; // standalone note waiting for a field

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!unit) {
      if (!trimmed) { i++; continue; }
      if (trimmed.startsWith('#[')) {
        pendingAttrs.push(trimmed);
      } else if (trimmed.startsWith('//')) {
        fileComments.push(trimmed.slice(2).trim());
      } else if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) {
        fileComments.push(trimmed.replace(/^[/\s*]+/, '').trim());
      } else {
        const hm = trimmed.match(/^(pub\s+)?(struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (hm) {
          const kind = hm[2];
          unit = {
            file: path.basename(filePath),
            source: path.basename(filePath),
            kind,
            name: hm[3],
            attrs: pendingAttrs,
            doc: pendingDoc,
            fields: [],
            variants: [],
            custom: customImpls.has(hm[3])
          };
          const b = countBraces(line);
          depth = b;
          pendingAttrs = [];
          pendingDoc = [];
          if (b === 0 && line.includes('}')) {
            // empty struct/enum on one line : {}  → unit is finished immediately
            units.push(unit);
            unit = null;
          }
          i++;
          continue;
        }
        // line outside any unit (use, fn, etc.) : ignore
        pendingAttrs = [];
        pendingDoc = [];
      }
      i++;
      continue;
    }

    // --- inside a unit ---
    const st = stripComment(line);
    const braces = st.code.split('').filter(c => c === '{').length - st.code.split('').filter(c => c === '}').length;

    if (unit.kind === 'enum' && depth === 1 && variant === null && !st.code.startsWith('}')) {
      const vm = st.code.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*([,{]|$)/);
      if (vm) {
        const v = { name: vm[1], fields: [], note: st.comment };
        unit.variants.push(v);
        if (vm[2] === '{') {
          variant = v;
        }
        depth += braces;
        i++;
        continue;
      }
      // "newtype" variant : Variant(Type),
      const tn = st.code.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)\s*,?\s*$/);
      if (tn) {
        const v = {
          name: tn[1],
          fields: [fieldNode('value', parseType(tn[2]), undefined)],
          note: st.comment
        };
        unit.variants.push(v);
        depth += braces;
        i++;
        continue;
      }
    }

    // field in a struct (or in an enum variant)
    let fm = null;
    if (variant === null) fm = st.code.match(FIELD_RE);
    else fm = st.code.match(FIELD_RE) || st.code.match(PRIVATE_FIELD_RE);

    if (fm && !st.code.startsWith('}')) {
      const name = fm[1];
      const typeRaw = fm[2].replace(/,$/, '').trim();
      const typeNode = parseType(typeRaw);
      const note = st.comment || pendingNote || undefined;
      const field = fieldNode(name, typeNode, note);
      if (variant) {
        variant.fields.push(field);
      } else {
        unit.fields.push(field);
      }
      pendingNote = null;
      depth += braces;
      i++;
      continue;
    }

    // standalone comment → future note
    if (trimmed.startsWith('//') && !st.code) {
      pendingNote = trimmed.slice(2).trim();
      i++;
      continue;
    }
    if (trimmed.startsWith('//') && st.code) {
      // trailing comment not attached (e.g. after ) ; )
      i++;
      continue;
    }

    // closing braces / misc
    if (st.code.startsWith('}')) {
      if (variant) {
        variant = null;
        depth += braces;
        i++;
        continue;
      }
      // end of unit
      units.push(unit);
      unit = null;
      pendingNote = null;
      depth += braces;
      // takes into account any multiple '}'
      if (unit === null) {
        i++;
        continue;
      }
    }

    depth += braces;
    i++;
  }

  if (unit) units.push(unit);

  return { units, fileComments };
}

// ---------------------------------------------------------------------------
// Assemblage
// ---------------------------------------------------------------------------

function buildLayoutFromFields(fields) {
  return fields.map(f => f.layout).join(' ');
}

function buildPacketEntry(unit, direction) {
  const entry = {
    name: unit.name,
    direction,
    source: unit.source,
    revision: unit.revision,
    custom: unit.custom
  };
  if (unit.doc && unit.doc.length) entry.description = unit.doc;
  if (unit.custom) entry.layoutIsEstimate = true;
  const layout = buildLayoutFromFields(unit.fields);
  if (layout) entry.layout = layout;
  if (unit.fields && unit.fields.length) entry.fields = unit.fields;
  else entry.fields = [];
  if (unit.custom && unit.fields.length) {
    entry.note = 'Custom parsing (manual PacketVariable impl) — the exact structure may depend on conditions.';
  }
  return entry;
}

function buildTemplateEntry(unit) {
  const entry = {
    name: unit.name,
    kind: unit.kind === 'enum' ? 'enum' : 'object',
    source: unit.source,
    custom: unit.custom
  };
  if (unit.doc && unit.doc.length) entry.description = unit.doc;
  if (unit.kind === 'enum') {
    entry.variants = unit.variants.map(v => {
      const vo = { name: v.name };
      if (v.note) vo.note = v.note;
      if (v.fields.length) {
        vo.fields = v.fields;
        vo.layout = buildLayoutFromFields(v.fields);
      }
      return vo;
    });
    entry.sharedPrefix = computeSharedPrefix(unit.variants.map(v => v.fields));
    const hasFields = unit.variants.some(v => v.fields.length);
    if (hasFields) {
      entry.layoutIsEstimate = true;
      if (unit.custom) {
        entry.note = 'Enum read via a discriminant (the PacketVariable impl is not analyzed).';
      }
    }
  } else {
    const layout = buildLayoutFromFields(unit.fields);
    if (layout) entry.layout = layout;
    if (unit.custom) entry.layoutIsEstimate = true;
    entry.fields = unit.fields || [];
    if (unit.custom && unit.fields.length) {
      entry.note = 'Custom parsing — the exact structure may depend on conditions.';
    }
  }
  return entry;
}

function computeSharedPrefix(fieldLists) {
  if (!fieldLists.length) return null;
  const first = fieldLists[0];
  let n = 0;
  outer:
  for (let i = 0; i < first.length; i++) {
    const name = first[i].name;
    const layout = first[i].layout;
    for (const fl of fieldLists) {
      if (!fl[i] || fl[i].name !== name || fl[i].layout !== layout) break outer;
    }
    n++;
  }
  if (n === 0) return null;
  return { count: n, fields: first.slice(0, n) };
}

function directionFor(attrs) {
  for (const a of attrs) {
    const m = a.match(/#\[to\(direction\s*=\s*(\d+)\)\]/);
    if (m) return m[1] === '1' ? 'out' : 'in';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const srcRoot = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SRC;
  const parsersDir = path.join(srcRoot, 'extension', 'parsers');
  const parsersFiles = [
    { file: path.join(parsersDir, 'incoming.rs'), direction: 'in', source: 'incoming.rs' },
    { file: path.join(parsersDir, 'outgoing.rs'), direction: 'out', source: 'outgoing.rs' }
  ];
  const templateFiles = [
    path.join(parsersDir, 'subparsers.rs'),
    path.join(parsersDir, 'stuffdata.rs')
  ];

  if (!fs.existsSync(parsersDir)) {
    console.error('Not found : ' + parsersDir);
    console.error('Pass the path to the G-Rust src/ folder :  node scripts/generate.js <path>');
    process.exit(1);
  }

  const packets = [];
  const revisions = {};
  const unknownRefs = new Map();

  for (const pf of parsersFiles) {
    const { units, fileComments } = parseFile(pf.file);
    const revision = (fileComments.find(c => /WIN\d+/.test(c)) || '').trim();
    if (revision) revisions[pf.source] = revision;
    for (const unit of units) {
      if (unit.kind !== 'struct') continue;
      const dir = directionFor(unit.attrs);
      if (!dir) continue;
      const entry = buildPacketEntry(unit, dir);
      if (!entry.revision) entry.revision = revision;
      packets.push(entry);
    }
  }

  const templatesByName = new Map();
  const templateUnits = [];
  for (const tf of templateFiles) {
    if (!fs.existsSync(tf)) continue;
    const { units } = parseFile(tf);
    for (const unit of units) {
      templateUnits.push(unit);
      if (!templatesByName.has(unit.name)) templatesByName.set(unit.name, unit);
    }
  }
  const templates = templateUnits
    .map(buildTemplateEntry)
    .sort((a, b) => a.name.localeCompare(b.name));

  // validation : are all template references resolved ?
  const templateNames = new Set(templates.map(t => t.name));

  function checkRefs(node, where) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(n => checkRefs(n, where)); return; }
    if (typeof node !== 'object') return;
    if (node.kind === 'template' && !templateNames.has(node.ref)) {
      if (!unknownRefs.has(node.ref)) unknownRefs.set(node.ref, []);
      unknownRefs.get(node.ref).push(where);
    }
    ['of', 'key', 'value', 'items', 'fields'].forEach(k => {
      if (node[k]) checkRefs(node[k], where);
    });
  }

  packets.forEach(p => { p.fields.forEach(f => checkRefs(f, p.name)); });
  templates.forEach(t => {
    if (t.fields) t.fields.forEach(f => checkRefs(f, 'tpl:' + t.name));
    if (t.variants) t.variants.forEach(v => (v.fields || []).forEach(f => checkRefs(f, 'tpl:' + t.name)));
  });

  // full layout : replace every <Name> reference by the structure itself (a name
  // survives only where the structure contains itself).
  packets.forEach(p => {
    if (p.layout) p.layout = expandedLayoutOfFields(p.fields, templatesByName, new Set());
  });

  packets.sort((a, b) => a.name.localeCompare(b.name));

  const incoming = packets.filter(p => p.direction === 'in').length;
  const outgoing = packets.length - incoming;

  // Grouped by direction : packets.json holds only what the summary needs
  // (custom flag + layout) ; fields.json only the detail (fields + metadata).
  // Anything present in packets.json is intentionally NOT repeated here.
  function groupByDir(packets, mapper) {
    const out = { in: {}, out: {} };
    for (const p of packets) out[p.direction][p.name] = mapper(p);
    return out;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.writeFileSync(path.join(OUT_DIR, 'packets.json'), JSON.stringify(
    groupByDir(packets, p => {
      const o = {};
      if (p.custom) o.custom = true;
      o.layout = p.layout || '';
      return o;
    }), null, 2));

  fs.writeFileSync(path.join(OUT_DIR, 'fields.json'), JSON.stringify(
    groupByDir(packets, p => {
      const o = {};
      if (p.description) o.description = p.description;
      if (p.layoutIsEstimate) o.layoutIsEstimate = true;
      if (p.note) o.note = p.note;
      if (p.fields && p.fields.length) o.fields = p.fields;
      return o;
    }), null, 2));

  fs.writeFileSync(path.join(OUT_DIR, 'templates.json'), JSON.stringify(
    templates.map(t => {
      if (t.source) delete t.source;
      return t;
    }), null, 2));

  console.log('Source path : ' + srcRoot);
  console.log('Packets : ' + incoming + ' in / ' + outgoing + ' out (' + packets.length + ' total)');
  console.log('Templates : ' + templates.length);
  if (revisions) console.log('Revisions : ' + JSON.stringify(revisions));
  console.log('Unknown template references : ' + (unknownRefs.size || 0));
  for (const [ref, where] of unknownRefs) {
    console.log('  - ' + ref + ' (used by : ' + where.slice(0, 5).join(', ') + (where.length > 5 ? ', …' : '') + ')');
  }
  console.log('Written to : ' + OUT_DIR);
}

if (require.main === module) {
  main();
}

module.exports = { parseFile, parseType, layoutOf, fieldNode, ROOT, DEFAULT_SRC };