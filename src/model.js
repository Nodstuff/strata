// Reads a diagram file (YAML) and turns it into the checked, normalised model that
// layout and the viewer work from. Every problem is collected and reported at once.
import YAML from 'yaml';

export const PALETTE = {
  blue: [76, 124, 240], green: [34, 160, 90], red: [220, 70, 70], orange: [224, 122, 48], purple: [154, 107, 224],
  yellow: [200, 160, 30], grey: [130, 134, 146], gray: [130, 134, 146], violet: [130, 110, 240], teal: [47, 168, 150], slate: [120, 130, 200],
};
const KINDS = { // built in; a file's `kinds` adds to or overrides these
  service: { color: 'blue' }, store: { color: 'orange' }, infra: { color: 'purple' }, external: { color: 'grey', dashed: true },
  step: { color: 'slate' }, frame: { color: 'grey' }, note: { color: 'yellow' }, ref: { color: 'violet' },
};
const STYLES = { flow: { rank: 1 }, yes: { color: 'green', rank: 2, width: 1.6 }, no: { color: 'red', rank: 2, width: 1.6 } };
const SHAPES = { box: 'box', diamond: 'diamond', cylinder: 'cylinder', cyl: 'cylinder', actor: 'actor' };
const NODE_KEYS = new Set(['id', 'label', 'sub', 'detail', 'note', 'kind', 'shape', 'state', 'ref', 'group', 'flow', 'place', 'about', 'widths', 'nodes']);
const PLACE = /^(above|below|left of|right of|level with)\s+([\w.-]+)(?:\s+(none|tight|normal|wide))?$/;

export function load(text) {
  const errors = [], warnings = [];
  let doc;
  try { doc = YAML.parse(text); } catch (e) { throw new Error('not valid YAML: ' + e.message); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the file must be a YAML map with at least `nodes`');

  const colour = (v, where) => {
    if (v == null) return null;
    if (PALETTE[v]) return PALETTE[v];
    const m = /^#([0-9a-f]{6})$/i.exec(String(v));
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    errors.push(`${where}: unknown colour "${v}" (use ${Object.keys(PALETTE).filter(k => k !== 'gray').join(', ')} or "#rrggbb")`);
    return PALETTE.grey;
  };
  const asMap = (v, where) => (typeof v === 'string' ? { color: v } : v && typeof v === 'object' ? v : (errors.push(`${where}: expected a colour name or a map`), {}));

  const kinds = {};
  for (const [name, def] of Object.entries({ ...KINDS, ...(doc.kinds || {}) })) {
    const d = asMap(def, `kinds.${name}`);
    kinds[name] = { c: colour(d.color || 'grey', `kinds.${name}`), dashed: !!d.dashed };
  }
  const styles = {};
  for (const [name, def] of Object.entries({ ...STYLES, ...(doc.styles || {}) })) {
    const d = asMap(def, `styles.${name}`);
    const dash = d.dash === true || d.dash === 'dashed' ? [7, 5] : d.dash === 'dotted' ? [2, 4] : Array.isArray(d.dash) ? d.dash : null;
    styles[name] = { c: colour(d.color, `styles.${name}`), w: d.width || (d.color ? 1.7 : 1.3), dash, rank: d.rank ?? 1, label: d.label || null, noHead: d.arrow === 'none' || d.arrow === false };
  }
  const states = {};
  for (const [name, def] of Object.entries(doc.states || {})) {
    const d = asMap(def, `states.${name}`);
    states[name] = { label: d.label || name, c: colour(d.color || 'green', `states.${name}`) };
  }

  const byId = new Map();
  const node = (raw, where) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${where}: a node must be a map with an id`); return null; }
    const id = raw.id == null ? null : String(raw.id);
    const at = id ? `node "${id}"` : where;
    if (!id) errors.push(`${where}: missing id`);
    else if (byId.has(id)) errors.push(`${at}: the id is used twice; ids are global`);
    for (const k of Object.keys(raw)) if (!NODE_KEYS.has(k)) errors.push(`${at}: unknown key "${k}" (known: ${[...NODE_KEYS].join(', ')})`);
    const kids = raw.nodes == null ? null : Array.isArray(raw.nodes) ? raw.nodes : (errors.push(`${at}: nodes must be a list`), null);
    const nd = { id, label: String(raw.label ?? id ?? '?') };
    if (id) byId.set(id, nd);
    if (raw.sub != null) nd.sub = String(raw.sub);
    if (raw.detail != null) nd.detail = (Array.isArray(raw.detail) ? raw.detail.map(String) : String(raw.detail).split('\n')).filter(l => l.trim());
    if (raw.note != null) nd.note = String(raw.note).trim();
    if (nd.note && kids) errors.push(`${at}: a note cannot have nodes inside it`);
    if (nd.note && nd.detail) errors.push(`${at}: use either note or detail, not both`);
    nd.kind = raw.kind != null ? String(raw.kind) : nd.note ? 'note' : raw.ref ? 'ref' : kids ? 'frame' : 'step';
    if (!kinds[nd.kind]) {
      if (PALETTE[nd.kind]) kinds[nd.kind] = { c: PALETTE[nd.kind], dashed: false }; // a bare colour works as a kind
      else { errors.push(`${at}: unknown kind "${nd.kind}" (known: ${Object.keys(kinds).join(', ')}, or any colour name)`); nd.kind = 'step'; }
    }
    if (raw.shape != null) {
      if (!SHAPES[raw.shape]) errors.push(`${at}: unknown shape "${raw.shape}" (box, diamond, cylinder, actor)`);
      else if (SHAPES[raw.shape] !== 'box') nd.shape = SHAPES[raw.shape];
      if (kids && nd.shape) errors.push(`${at}: a node with nodes inside it must be a plain box`);
    }
    if (raw.state != null) { if (!states[raw.state]) errors.push(`${at}: unknown state "${raw.state}" (declare it under states)`); else nd.state = String(raw.state); }
    if (raw.ref != null) nd.ref = String(raw.ref);
    if (raw.group) { if (kids) nd.group = true; else errors.push(`${at}: group only makes sense on a node with nodes inside it`); }
    if (raw.flow != null) { if (raw.flow !== 'down' && raw.flow !== 'right') errors.push(`${at}: flow must be down or right`); else nd.flow = raw.flow; }
    if (raw.place != null) {
      nd.place = [];
      for (const text of Array.isArray(raw.place) ? raw.place : [raw.place]) {
        const m = PLACE.exec(String(text).trim());
        if (!m) errors.push(`${at}: cannot read place "${text}" (write: above X, below X, left of X, right of X or level with X, optionally followed by none, tight, normal or wide)`);
        else nd.place.push({ rel: m[1].split(' ')[0], target: m[2], gap: m[3] || 'normal' });
      }
    }
    if (raw.about != null) { if (!nd.note) errors.push(`${at}: about only makes sense on a note`); else nd.about = String(raw.about); }
    if (raw.widths != null) { if (raw.widths !== 'match' || !kids) errors.push(`${at}: widths takes only "match", on a node with nodes inside it`); else nd.widths = 'match'; }
    if (kids) {
      nd.children = kids.map((k, i) => node(k, `${at} › nodes[${i}]`)).filter(Boolean);
      if (!nd.children.length) { errors.push(`${at}: nodes is empty`); delete nd.children; }
      else if (nd.children.length > 16) warnings.push(`${at} has ${nd.children.length} boxes inside it; more than 16 is hard to read at one level, consider nesting`);
    }
    return nd;
  };

  if (!Array.isArray(doc.nodes) || !doc.nodes.length) errors.push('nodes: the file needs a non-empty list of nodes');
  const root = { id: '__root', label: String(doc.title || 'Untitled diagram'), kind: 'frame', group: true, children: (Array.isArray(doc.nodes) ? doc.nodes : []).map((k, i) => node(k, `nodes[${i}]`)).filter(Boolean) };
  if (doc.subtitle != null) root.sub = String(doc.subtitle);
  if (doc.flow === 'right' || doc.flow === 'down') root.flow = doc.flow;
  if (doc.widths === 'match') root.widths = 'match';

  for (const nd of byId.values()) if (nd.ref && !byId.has(nd.ref)) errors.push(`node "${nd.id}": ref points at "${nd.ref}", which does not exist`);
  walk(root, nd => { // a placement, and a note's subject, must name a box in the same container
    const here = new Set((nd.children || []).map(c => c.id));
    for (const c of nd.children || []) {
      for (const p of c.place || []) if (p.target === c.id || !here.has(p.target)) errors.push(`node "${c.id}": place names "${p.target}", which is not another box in the same container`);
      if (c.about && (c.about === c.id || !here.has(c.about))) errors.push(`node "${c.id}": about names "${c.about}", which is not another box in the same container`);
    }
  });

  const edges = [];
  (Array.isArray(doc.edges) ? doc.edges : doc.edges == null ? [] : (errors.push('edges must be a list'), [])).forEach((raw, i) => {
    const e = Array.isArray(raw) ? { from: raw[0], to: raw[1], label: raw[2], style: raw[3] } : raw || {};
    const where = `edges[${i}] (${e.from} → ${e.to})`;
    for (const end of ['from', 'to']) if (e[end] == null || !byId.has(String(e[end]))) errors.push(`${where}: ${end} "${e[end]}" is not a node id`);
    const style = e.style == null ? 'flow' : String(e.style);
    if (!styles[style]) errors.push(`${where}: unknown style "${style}" (known: ${Object.keys(styles).join(', ')})`);
    edges.push({ a: String(e.from), b: String(e.to), label: e.label == null ? '' : String(e.label), style });
  });

  if (errors.length) { const err = new Error(errors.join('\n')); err.problems = errors; throw err; }
  return { title: root.label, kinds, styles, states, root, edges, warnings };
}

export function walk(nd, fn, parent = null, depth = 0) {
  fn(nd, parent, depth);
  for (const c of nd.children || []) walk(c, fn, nd, depth + 1);
}
