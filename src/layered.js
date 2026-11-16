// EXPERIMENTAL: strata's own layered placement, to find out whether the layout engine (ELK) can go.
// It places boxes only; every arrow is then drawn by the router in layout.js, as on a level whose
// boxes are placed by hand. The method is the usual one for layered pictures:
//   1. an arrow that points to an earlier box in the file is a loop-back, and is turned round
//   2. each box takes the row after its latest predecessor, then moves toward the side it has more arrows on
//   3. an arrow that skips rows gets a small unseen point in each row it passes, so it keeps a lane
//   4. within each row the order is chosen to cross as few arrows as possible (barycentre sweeps, then swaps)
//   5. sideways positions put each box as near the middle of its neighbours as the order allows
//   6. parts with no arrow between them are laid out one by one and packed into a screen-shaped block
// Everything is worked out as if the flow ran down; a flow to the right is the same picture turned.

const DUMMY_W = 14;

// least squares with an order to keep: the values closest to t (weights w) that never decrease
function isotonic(t, w) {
  const blocks = [];
  for (let i = 0; i < t.length; i++) {
    blocks.push({ s: t[i] * w[i], w: w[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].s / blocks[blocks.length - 2].w > blocks[blocks.length - 1].s / blocks[blocks.length - 1].w) {
      const b = blocks.pop(), a = blocks[blocks.length - 1]; a.s += b.s; a.w += b.w; a.n += b.n;
    }
  }
  return blocks.flatMap(b => Array(b.n).fill(b.s / b.w));
}

function component(nodes, links, o) {
  nodes = [...nodes].sort((p, q) => p.key - q.key);
  // 2. rows. nodes are in file order and every link runs from an earlier node to a later one.
  const n = nodes.length;
  for (const nd of nodes) { nd.layer = 0; nd.ins = []; nd.outs = []; }
  for (const l of links) { l.a.outs.push(l.b); l.b.ins.push(l.a); }
  for (const nd of nodes) for (const p of nd.ins) nd.layer = Math.max(nd.layer, p.layer + 1);
  for (let pass = 0; pass < 4; pass++) for (let i = n - 1; i >= 0; i--) {
    const nd = nodes[i];
    const lo = nd.ins.length ? Math.max(...nd.ins.map(p => p.layer)) + 1 : 0, hi = nd.outs.length ? Math.min(...nd.outs.map(s => s.layer)) - 1 : nd.layer;
    if (hi < lo) continue;
    if (nd.outs.length > nd.ins.length) nd.layer = hi; else if (nd.ins.length > nd.outs.length) nd.layer = lo; else nd.layer = Math.min(hi, Math.max(lo, nd.layer));
  }
  const L = Math.max(...nodes.map(nd => nd.layer)) + 1;

  // 3. unseen points on arrows that skip rows; segs are the pieces between neighbouring rows
  const all = [...nodes], segs = [];
  for (const l of links) {
    let prev = l.a;
    for (let k = l.a.layer + 1; k < l.b.layer; k++) {
      const d = { dummy: true, key: l.a.key + (k - l.a.layer) / (l.b.layer - l.a.layer) * (l.b.key - l.a.key), w: DUMMY_W, h: 0, layer: k };
      all.push(d); segs.push({ a: prev, b: d, label: 0 }); prev = d;
    }
    segs.push({ a: prev, b: l.b, label: l.label });
  }
  for (const nd of all) { nd.up = []; nd.down = []; }
  for (const s of segs) { const wt = s.a.dummy && s.b.dummy ? 8 : s.a.dummy || s.b.dummy ? 2 : 1; s.a.down.push({ n: s.b, wt }); s.b.up.push({ n: s.a, wt }); }
  let rows = Array.from({ length: L }, () => []);
  for (const nd of all) rows[nd.layer].push(nd);
  for (const r of rows) r.sort((p, q) => p.key - q.key);
  const index = rs => { for (const r of rs) r.forEach((nd, i) => { nd.pos = i; }); };
  index(rows);

  // 4. order within rows
  const between = k => segs.filter(s => s.a.layer === k);
  const crossAt = k => { const ss = between(k); let c = 0; for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) if ((ss[i].a.pos - ss[j].a.pos) * (ss[i].b.pos - ss[j].b.pos) < 0) c++; return c; };
  const crossings = () => { let c = 0; for (let k = 0; k < L - 1; k++) c += crossAt(k); return c; };
  const firm = o.ord === 'NODES_AND_EDGES';
  const sweep = (k, side) => {
    const r = rows[k];
    for (const nd of r) { const nb = nd[side]; nd.bary = nb.length ? nb.reduce((s, e) => s + e.n.pos, 0) / nb.length : null; }
    // a box with no arrow on this side keeps its place between its neighbours in the row
    r.forEach((nd, i) => { if (nd.bary == null) { let a = i - 1; while (a >= 0 && r[a].bary == null) a--; nd.bary = a >= 0 ? r[a].bary + 1e-3 : -1; } });
    const sorted = [...r].sort((p, q) => p.bary - q.bary || p.key - q.key);
    if (firm) { // the file's order stands among the boxes; only the unseen points move between them
      const reals = r.filter(nd => !nd.dummy).sort((p, q) => p.key - q.key); let i = 0;
      rows[k] = sorted.map(nd => (nd.dummy ? nd : reals[i++]));
    } else rows[k] = sorted;
    rows[k].forEach((nd, i) => { nd.pos = i; });
  };
  let best = { c: crossings(), rows: rows.map(r => [...r]) };
  const keep = () => { const c = crossings(); if (c < best.c) best = { c, rows: rows.map(r => [...r]) }; };
  const rounds = o.ord === 'NONE' ? 24 : o.ord === 'PREFER_EDGES' ? 8 : 4;
  for (let it = 0; it < rounds && best.c > 0; it++) {
    if (it % 2 === 0) for (let k = 1; k < L; k++) sweep(k, 'up'); else for (let k = L - 2; k >= 0; k--) sweep(k, 'down');
    keep();
  }
  rows = best.rows; index(rows);
  if (!firm) for (let again = true, guard = 0; again && guard < 30; guard++) { // swap neighbours while that removes a crossing
    again = false;
    for (let k = 0; k < L; k++) for (let i = 0; i < rows[k].length - 1; i++) {
      const before = (k > 0 ? crossAt(k - 1) : 0) + (k < L - 1 ? crossAt(k) : 0), a = rows[k][i], b = rows[k][i + 1];
      rows[k][i] = b; rows[k][i + 1] = a; a.pos = i + 1; b.pos = i;
      const after = (k > 0 ? crossAt(k - 1) : 0) + (k < L - 1 ? crossAt(k) : 0);
      if (after < before) again = true; else { rows[k][i] = a; rows[k][i + 1] = b; a.pos = i; b.pos = i + 1; }
    }
  }

  // 5. sideways positions (centres)
  for (const r of rows) { let x = 0; for (const nd of r) { nd.x = x + nd.w / 2; x += nd.w + o.nodeGap; } const mid = (x - o.nodeGap) / 2; for (const nd of r) nd.x -= mid; }
  const settle = (r, sides) => {
    if (!r.length) return;
    const off = [0]; for (let i = 1; i < r.length; i++) off.push(off[i - 1] + r[i - 1].w / 2 + r[i].w / 2 + (r[i - 1].dummy && r[i].dummy ? 16 : o.nodeGap));
    const t = [], w = [];
    r.forEach((nd, i) => {
      let s = 0, ws = 0; for (const side of sides) for (const e of nd[side]) { s += e.n.x * e.wt; ws += e.wt; }
      t.push((ws ? s / ws : nd.x) - off[i]); w.push(ws || 0.05);
    });
    isotonic(t, w).forEach((v, i) => { r[i].x = v + off[i]; });
  };
  for (let it = 0; it < 8; it++) {
    for (let k = 1; k < L; k++) settle(rows[k], ['up']);
    for (let k = L - 2; k >= 0; k--) settle(rows[k], ['down']);
  }
  for (let it = 0; it < 4; it++) for (let k = 0; k < L; k++) settle(rows[k], ['up', 'down']);

  // rows from top to bottom; an arrow's label needs room between the rows it joins
  const tall = rows.map(r => Math.max(0, ...r.map(nd => nd.h))), room = Array(L).fill(0);
  for (const s of segs) if (s.label) room[s.a.layer] = Math.max(room[s.a.layer], o.labelRoom(s.label));
  let y = 0; const top = [];
  for (let k = 0; k < L; k++) { top.push(y); y += tall[k] + o.layerGap + room[k]; }
  for (const nd of nodes) nd.y = top[nd.layer] + tall[nd.layer] / 2;
  nodes = nodes.filter(nd => !nd.virtual); // the unseen points of a pull have done their work

  // a long chain folds: the rows are cut into runs and the runs set side by side (o.fold = how many runs)
  let wrapped = false;
  if (o.fold > 1 && L >= 2 * o.fold) {
    const per = Math.ceil(L / o.fold); let shift = 0;
    for (let c = 0; c * per < L; c++) {
      const mine = nodes.filter(nd => Math.floor(nd.layer / per) === c); if (!mine.length) continue;
      const x0 = Math.min(...mine.map(nd => nd.x - nd.w / 2)), x1 = Math.max(...mine.map(nd => nd.x + nd.w / 2)), y0 = top[c * per];
      for (const nd of mine) { nd.x += shift - x0; nd.y -= y0; }
      shift += x1 - x0 + o.layerGap + 24;
    }
    wrapped = true;
  }
  const x0 = Math.min(...nodes.map(nd => nd.x - nd.w / 2)), y0 = Math.min(...nodes.map(nd => nd.y - nd.h / 2));
  for (const nd of nodes) { nd.x -= x0; nd.y -= y0; }
  return { nodes, w: Math.max(...nodes.map(nd => nd.x + nd.w / 2)), h: Math.max(...nodes.map(nd => nd.y + nd.h / 2)), wrapped };
}

// boxes: [{ id, width, height }] in file order. arrows: [{ a, b, label }] (label: its width, or 0).
// Returns what the layout engine would: { width, height, children: [{ id, x, y, width, height }], edges: [] },
// with `score` (lower is a calmer picture) and `wrapped`.
// pulls: [{ side: 0 top | 1 bottom | 2 left | 3 right, kids: [id] }]: arrows that leave this level by that side, and the boxes they are for.
export function layered(boxes, arrows, { dir = 'DOWN', ord = 'NONE', wrap = false, layerGap = 64, nodeGap = 44, compGap = 54, aspect = 1.7, unit = 100, pulls = [] } = {}) {
  const right = dir === 'RIGHT';
  const nodes = boxes.map((b, i) => ({ id: b.id, key: i, w: right ? b.height : b.width, h: right ? b.width : b.height, real: b }));
  const by = new Map(nodes.map(nd => [nd.id, nd])), seen = new Set(), links = [];
  for (const e of arrows) {
    let a = by.get(e.a), b = by.get(e.b); if (!a || !b || a === b) continue;
    if (a.key > b.key) [a, b] = [b, a]; // 1. a loop-back
    const k = a.key + '>' + b.key; if (seen.has(k)) { const l = links.find(q => q.k === k); l.label = Math.max(l.label, e.label || 0); continue; }
    seen.add(k); links.push({ k, a, b, label: e.label || 0 });
  }
  // 6. parts with no arrow between them
  const root = new Map(nodes.map(nd => [nd, nd])), find = nd => { while (root.get(nd) !== nd) { root.set(nd, root.get(root.get(nd))); nd = root.get(nd); } return nd; };
  for (const l of links) root.set(find(l.a), find(l.b));
  const groups = new Map();
  for (const nd of nodes) { const r = find(nd); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(nd); }
  const o = { ord, layerGap, nodeGap, labelRoom: w => (right ? Math.min(w, 130) : 16) };
  // A pull along the flow is an unseen point before the first row or after the last, tied to its boxes.
  // (Sides are turned for a flow to the right.)
  const extra = new Map(); let vk = 0;
  for (const p of pulls) {
    const side = right ? [2, 3, 0, 1][p.side] : p.side, kids = p.kids.map(id => by.get(id)).filter(Boolean); if (!kids.length) continue;
    if (side >= 2) continue; // across the flow: settled at the end, by turning the whole picture over if that brings the boxes nearer
    const byPart = new Map(); for (const k of kids) { const r = find(k); if (!byPart.has(r)) byPart.set(r, []); byPart.get(r).push(k); }
    for (const [r, ks] of byPart) {
      const v = { id: 'pull:' + vk++, virtual: true, key: side === 0 ? -1 - vk : 1e6 + vk, w: 1, h: 0 };
      if (!extra.has(r)) extra.set(r, { nodes: [], links: [] });
      extra.get(r).nodes.push(v); for (const k of ks) extra.get(r).links.push(side === 0 ? { a: v, b: k, label: 0 } : { a: k, b: v, label: 0 });
    }
  }
  const parts = [...groups.values()].map(g => {
    const mine = links.filter(l => find(l.a) === find(g[0]));
    const ex = extra.get(find(g[0])) || { nodes: [], links: [] };
    let p = component([...g, ...ex.nodes], [...mine, ...ex.links], { ...o, fold: 1 });
    if (wrap) { // fold a strip onto the number of runs that comes nearest a screen's shape
      const shape = q => { const [w, h] = right ? [q.h, q.w] : [q.w, q.h]; return Math.abs(Math.log(w / h / aspect)); };
      for (let fold = 2; fold <= 4; fold++) { const snap = g.map(nd => [nd.x, nd.y]), q = component(g, mine, { ...o, fold }); if (q.wrapped && shape(q) < shape(p)) p = q; else { g.forEach((nd, i) => { [nd.x, nd.y] = snap[i]; }); } }
    }
    return right ? { nodes: g, w: p.h, h: p.w, wrapped: p.wrapped, turn: true } : { ...p, nodes: g };
  });
  for (const p of parts) if (p.turn) for (const nd of p.nodes) { [nd.x, nd.y] = [nd.y, nd.x]; [nd.w, nd.h] = [nd.h, nd.w]; }
  // pack the parts in rows, the widest row about `aspect` times as wide as the block is tall
  const area = parts.reduce((s, p) => s + (p.w + compGap) * (p.h + compGap), 0), limit = Math.max(...parts.map(p => p.w), Math.sqrt(area * aspect));
  // Parts that arrows leave upward go in the first rows and those that leave downward in the last; within a
  // row, leftward first. With no pulls every part leans 0 and the file's order stands.
  const lean = new Map(parts.map(p => [p, [0, 0]]));
  for (const pl of pulls) for (const id of pl.kids) { const k = by.get(id), p = k && parts.find(q => q.nodes.includes(k)); if (p) lean.get(p)[pl.side < 2 ? 1 : 0] += pl.side % 2 ? 1 : -1; }
  const sgn = v => Math.sign(v), queue = [...parts].sort((p, q) => sgn(lean.get(p)[1]) - sgn(lean.get(q)[1])), rowsOf = [[]];
  let x = 0, y = 0, rowH = 0;
  for (const p of queue) {
    if (x > 0 && x + p.w > limit) { x = 0; rowsOf.push([]); }
    rowsOf[rowsOf.length - 1].push(p); x += p.w + compGap;
  }
  for (const row of rowsOf) {
    row.sort((p, q) => sgn(lean.get(p)[0]) - sgn(lean.get(q)[0])); x = 0; rowH = 0;
    for (const p of row) { for (const nd of p.nodes) { nd.x += x; nd.y += y; } x += p.w + compGap; rowH = Math.max(rowH, p.h); }
    y += rowH + compGap;
  }
  const width = Math.max(...nodes.map(nd => nd.x + nd.w / 2)), height = Math.max(...nodes.map(nd => nd.y + nd.h / 2));
  // Left and right mean nothing to a flow that runs down (nor up and down to one that runs right), so the
  // picture may be turned over across its flow. It is, when that brings boxes nearer the sides their arrows leave by.
  const reach = () => { let d = 0; for (const p of pulls) for (const id of p.kids) { const k = by.get(id); if (k) d += [k.y - k.h / 2, height - k.y - k.h / 2, k.x - k.w / 2, width - k.x - k.w / 2][p.side]; } return d; };
  if (pulls.length) {
    const flip = () => { for (const nd of nodes) { if (right) nd.y = height - nd.y; else nd.x = width - nd.x; } };
    const as = reach(); flip(); if (reach() >= as - 1) flip();
  }
  const children = nodes.map(nd => ({ id: nd.id, x: nd.x - nd.w / 2, y: nd.y - nd.h / 2, width: nd.w, height: nd.h }));

  // how calm the picture is, judged before any arrow is drawn: a straight line stands in for each arrow
  let len = 0, bends = 0, crossings = 0;
  const hit = (l, c) => { // does the straight line of l pass through box c (neither of its ends)?
    for (let t = 0.1; t < 1; t += 0.1) { const px = l.a.x + (l.b.x - l.a.x) * t, py = l.a.y + (l.b.y - l.a.y) * t; if (px > c.x && px < c.x + c.width && py > c.y && py < c.y + c.height) return true; }
    return false;
  };
  for (const l of links) {
    const dx = Math.max(0, Math.abs(l.a.x - l.b.x) - (l.a.w + l.b.w) / 2), dy = Math.max(0, Math.abs(l.a.y - l.b.y) - (l.a.h + l.b.h) / 2);
    len += dx + dy; if (dx > 0 && dy > 0) bends += 2;
    for (const c of children) if (c.id !== l.a.id && c.id !== l.b.id && hit(l, c)) { bends += 2; len += Math.min(c.width, c.height); }
  }
  const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
    const p = links[i], q = links[j]; if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;
    if (side(p.a, p.b, q.a) * side(p.a, p.b, q.b) < 0 && side(q.a, q.b, p.a) * side(q.a, q.b, p.b) < 0) crossings++;
  }
  len += reach(); // a line that leaves is as long as its box is far from that side
  const need = Math.max(width / 1.7, height);
  const score = len / unit + 0.7 * bends + 5 * crossings + (8 + 1.3 * links.length) * Math.log(need / unit);
  return { width, height, children, edges: [], own: true, score, wrapped: parts.some(p => p.wrapped) };
}
