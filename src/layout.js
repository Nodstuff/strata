// Lays the diagram out. Nothing here runs in the browser: the viewer only reads the numbers
// this writes (x, y, w, h, iw, ih, routes, xr).
//
// Pass 1, deepest container first: each container gets its own inner space (iw x ih) holding
// its children as closed boxes. If the file states where the boxes go (`place`), those
// statements are solved; otherwise ELK places the boxes, several ways, and the least busy
// result is kept.
//
// Pass 2, top down: an arrow whose ends are in different containers is built from pieces. The
// piece between the two outermost boxes comes from pass 1. Where it meets a container's border
// is that container's *port* for the arrow, and inside the container a right-angle route runs
// from the port to the box the arrow is really for, going round every other box. So an arrow
// never passes behind a box, at any zoom.
import ELK from 'elkjs/lib/elk.bundled.js';
import { walk } from './model.js';

const elk = new ELK();
const CLOSED_W = 230, CLOSED_H = 180;   // the box a closed container is drawn as
const FIT = 0.3;                        // a closed container must stay under this share of its parent, so it is still closed when the parent fills the screen
const SIDE = 30, BOTTOM = 30;
const CLEAR = 13, LANE = 9;             // how far a routed line stays from a box, and from the next line in the same channel
const GAP = { none: 0, tight: 20, normal: 48, wide: 96 };
const r1 = v => Math.round(v * 10) / 10;

function leafSize(nd) {
  const lines = nd.label.split('\n'), tW = Math.max(...lines.map(l => l.length)) * 8.2;
  if (nd.shape === 'actor') return [Math.max(80, tW * 0.8), 104];
  if (nd.shape === 'diamond') { const w = Math.max(150, tW * 1.6 + 24); return [w, Math.max(96, lines.length * 22 + 62)]; }
  if (nd.note) { // sized for about 60 characters a line
    const body = nd.note.split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.length / 60)), 0);
    return [Math.max(400, Math.min(520, tW + 40)), 44 + Math.ceil(nd.label.length / 46) * 20 + body * 15.5];
  }
  const dW = nd.detail ? Math.max(...nd.detail.map(l => l.length)) * 5.7 : 0, sW = nd.sub ? nd.sub.length * 6.4 : 0;
  const w = Math.min(470, Math.max(150, tW + 36, dW + 28, sW + 30));
  let h = Math.max(66, 28 + lines.length * 20 + (nd.detail ? nd.detail.length * 15 + 6 : nd.sub ? 17 : 0));
  if (nd.shape === 'cylinder') h += 18;
  return [w, h];
}

// ---------- how busy is a layout: shorter arrows, fewer bends, fewer crossings, screen-shaped ----------
const pointsOf = e => { const s = e.sections && e.sections[0]; return s ? [s.startPoint, ...(s.bendPoints || []), s.endPoint] : null; };
function busyness(res, unit) {
  let len = 0, bends = 0, crossings = 0; const segs = [];
  (res.edges || []).forEach((e, ei) => {
    const p = pointsOf(e); if (!p) return;
    bends += p.length - 2;
    for (let i = 0; i < p.length - 1; i++) { len += Math.abs(p[i + 1].x - p[i].x) + Math.abs(p[i + 1].y - p[i].y); segs.push([p[i], p[i + 1], ei]); }
  });
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const [a, b, ei] = segs[i], [c, d, ej] = segs[j]; if (ei === ej) continue;
    const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) crossings++;
  }
  return len / unit + 0.7 * bends + 5 * crossings + 7 * Math.abs(Math.log(res.width / res.height / 1.7));
}

// ---------- the router: a right-angle path between two sets of points, round every box ----------
// starts and goals are lists of { at: a point on a border, out: the point CLEAR beyond it, cost }.
// occ holds the segments already drawn in this container; running along one that belongs to a
// different arrow is expensive, so parallel arrows take neighbouring lanes instead of one line.
const sidesOf = b => {
  const out = [];
  for (const [f, cost] of b.shape === 'diamond' ? [[0.5, 0]] : [[0.5, 0], [0.25, 6], [0.75, 6]]) out.push(
    { at: [b.x + b.w * f, b.y], out: [b.x + b.w * f, b.y - CLEAR], cost }, { at: [b.x + b.w * f, b.y + b.h], out: [b.x + b.w * f, b.y + b.h + CLEAR], cost },
    { at: [b.x, b.y + b.h * f], out: [b.x - CLEAR, b.y + b.h * f], cost }, { at: [b.x + b.w, b.y + b.h * f], out: [b.x + b.w + CLEAR, b.y + b.h * f], cost });
  return out;
};
function portGoal(port, W, H) { // the route arrives at a port square on, from CLEAR inside the border
  const d = [port[0], W - port[0], port[1], H - port[1]], m = Math.min(...d);
  return { at: port, cost: 0, out: m === d[2] ? [port[0], CLEAR] : m === d[3] ? [port[0], H - CLEAR] : m === d[0] ? [CLEAR, port[1]] : [W - CLEAR, port[1]] };
}
function route(starts, goals, walls, W, H, occ, tag) {
  const inside = (x, y, w) => x > w.x - CLEAR + 1 && x < w.x + w.w + CLEAR - 1 && y > w.y - CLEAR + 1 && y < w.y + w.h + CLEAR - 1;
  const ok = (x, y) => !walls.some(w => inside(x, y, w));
  const lanes = (lo, hi) => [0, 1, 2].flatMap(k => [lo - CLEAR - k * LANE, hi + CLEAR + k * LANE]);
  const axis = (vals, max) => [...new Set(vals.map(r1))].filter(v => v >= CLEAR - 1 && v <= max - CLEAR + 1).sort((p, q) => p - q);
  const ends = [...starts, ...goals];
  const xs = axis([CLEAR, W - CLEAR, ...ends.map(s => s.out[0]), ...walls.flatMap(w => lanes(w.x, w.x + w.w))], W);
  const ys = axis([CLEAR, H - CLEAR, ...ends.map(s => s.out[1]), ...walls.flatMap(w => lanes(w.y, w.y + w.h))], H);
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i])), NY = ys.length;
  const others = (occ || []).filter(s => s.tag !== tag), hor = others.filter(s => s.a[1] === s.b[1]), ver = others.filter(s => s.a[0] === s.b[0]);
  const lap = (a0, a1, b0, b1) => Math.max(0, Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1)));
  const stepCost = (x0, y0, x1, y1) => { // length, plus riding on or crossing another arrow's line
    let c = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    if (y0 === y1) {
      for (const s of hor) if (Math.abs(s.a[1] - y0) < LANE - 2) c += 4 * lap(x0, x1, s.a[0], s.b[0]);
      for (const s of ver) if (s.a[0] > Math.min(x0, x1) && s.a[0] < Math.max(x0, x1) && y0 > Math.min(s.a[1], s.b[1]) && y0 < Math.max(s.a[1], s.b[1])) c += 10;
    } else {
      for (const s of ver) if (Math.abs(s.a[0] - x0) < LANE - 2) c += 4 * lap(y0, y1, s.a[1], s.b[1]);
      for (const s of hor) if (s.a[1] > Math.min(y0, y1) && s.a[1] < Math.max(y0, y1) && x0 > Math.min(s.a[0], s.b[0]) && x0 < Math.max(s.a[0], s.b[0])) c += 10;
    }
    return c;
  };
  const goalAt = new Map();
  goals.forEach((g, gi) => { const i = xi.get(r1(g.out[0])), j = yi.get(r1(g.out[1])); if (i != null && j != null && ok(g.out[0], g.out[1])) { const k = i * NY + j; if (!goalAt.has(k) || goals[goalAt.get(k)].cost > g.cost) goalAt.set(k, gi); } });
  if (!goalAt.size) return null;
  // Dijkstra over (column, row, heading) with a binary heap; a bend costs as much as a long detour
  const BEND = 40, dist = new Map(), prev = new Map(), heap = [];
  const push = (c, k, from) => {
    if (dist.has(k) && dist.get(k) <= c) return; dist.set(k, c); prev.set(k, from);
    let n = heap.push([c, k]) - 1;
    while (n > 0) { const p = (n - 1) >> 1; if (heap[p][0] <= heap[n][0]) break; [heap[p], heap[n]] = [heap[n], heap[p]]; n = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let n = 0; for (;;) { let m = n; const l = 2 * n + 1, r = l + 1; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === n) break; [heap[m], heap[n]] = [heap[n], heap[m]]; n = m; } }
    return top;
  };
  starts.forEach((s, si) => {
    const i = xi.get(r1(s.out[0])), j = yi.get(r1(s.out[1])); if (i == null || j == null || !ok(s.out[0], s.out[1])) return;
    const d = s.out[1] < s.at[1] ? 0 : s.out[1] > s.at[1] ? 2 : s.out[0] < s.at[0] ? 3 : 1; // 0 up, 1 right, 2 down, 3 left
    push(s.cost, (i * NY + j) * 4 + d, -1 - si);
  });
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  let end = null, goal = null;
  while (heap.length) {
    const [c, k] = pop(); if (c > dist.get(k)) continue;
    const cell = k >> 2, d = k & 3, i = Math.floor(cell / NY), j = cell % NY;
    if (goalAt.has(cell)) { end = k; goal = goals[goalAt.get(cell)]; break; }
    for (let nd = 0; nd < 4; nd++) {
      if ((nd + 2) % 4 === d) continue;
      const ni = i + DX[nd], nj = j + DY[nd]; if (ni < 0 || nj < 0 || ni >= xs.length || nj >= NY) continue;
      if (!ok((xs[i] + xs[ni]) / 2, (ys[j] + ys[nj]) / 2) || !ok(xs[ni], ys[nj])) continue;
      push(c + stepCost(xs[i], ys[j], xs[ni], ys[nj]) + (nd === d ? 0 : BEND), (ni * NY + nj) * 4 + nd, k);
    }
  }
  if (end == null) return null;
  const pts = [goal.at, goal.out];
  for (let k = end; ;) {
    const cell = k >> 2; pts.push([xs[Math.floor(cell / NY)], ys[cell % NY]]);
    const p = prev.get(k);
    if (p < 0) { pts.push(starts[-1 - p].at); break; }
    k = p;
  }
  pts.reverse();
  const out = [pts[0]]; // drop points that lie on a straight run
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    if (Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05) continue;
    if (c && ((Math.abs(a[0] - b[0]) < 0.05 && Math.abs(b[0] - c[0]) < 0.05) || (Math.abs(a[1] - b[1]) < 0.05 && Math.abs(b[1] - c[1]) < 0.05))) continue;
    out.push(b);
  }
  return out.map(p => [r1(p[0]), r1(p[1])]);
}
const occupy = (occ, pts, tag) => { for (let i = 0; i < pts.length - 1; i++) occ.push({ a: pts[i], b: pts[i + 1], tag }); };

// ---------- stated placement: the file says where each box sits; this works out only the distances ----------
// A gap is a minimum, never an exact distance, and everything ends up as close together as the
// statements allow. Anything left ambiguous is an error that names the box, never a guess.
function placeStated(nd) {
  const kids = nd.children, idx = new Map(kids.map((c, i) => [c.id, i])), n = kids.length, where = nd.id === '__root' ? 'at the top level' : `in "${nd.id}"`;
  const free = kids.filter(c => !c.place);
  if (free.length !== 1) throw new Error(`${where}, ${free.length} boxes have no place (${free.map(c => c.id).join(', ') || 'none'}): once any box in a container is placed, all but one must be, and that one is what the rest are placed against`);
  const find = (p, i) => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
  const colOf = kids.map((_, i) => i), rowOf = kids.map((_, i) => i); // boxes sharing a centre line share a variable
  const sepX = [], sepY = [];
  kids.forEach((c, i) => {
    if (!c.place) return;
    const xs = c.place.filter(p => p.rel === 'left' || p.rel === 'right'), ys = c.place.filter(p => p.rel === 'above' || p.rel === 'below'), lv = c.place.filter(p => p.rel === 'level');
    if (!xs.length && !ys.length) throw new Error(`"${c.id}" ${where} is level with "${lv[0].target}" but does not say which side of anything it sits on: add left of or right of`);
    if (xs.length && !ys.length && !lv.length) { if (xs.length > 1) throw new Error(`"${c.id}" ${where} does not say which row it sits in: add level with, above or below`); rowOf[find(rowOf, i)] = find(rowOf, idx.get(xs[0].target)); }
    if (ys.length && !xs.length) { if (ys.length > 1) throw new Error(`"${c.id}" ${where} does not say which column it sits in: add left of or right of`); colOf[find(colOf, i)] = find(colOf, idx.get(ys[0].target)); }
    for (const p of lv) rowOf[find(rowOf, i)] = find(rowOf, idx.get(p.target));
    for (const p of [...xs, ...ys]) {
      const j = idx.get(p.target), t = kids[j], horiz = p.rel === 'left' || p.rel === 'right';
      const d = (horiz ? (c.w + t.w) / 2 : (c.h + t.h) / 2) + GAP[p.gap];
      const before = p.rel === 'right' || p.rel === 'below' ? j : i, after = before === j ? i : j;
      (horiz ? sepX : sepY).push({ i: before, j: after, d, own: i, text: `"${c.id}" ${p.rel === 'left' || p.rel === 'right' ? p.rel + ' of' : p.rel} "${p.target}"` });
    }
  });
  const solve = (group, seps, axis) => {
    const v = new Array(n).fill(0), g = i => find(group, i);
    for (const s of seps) if (g(s.i) === g(s.j)) throw new Error(`${s.text} ${where} contradicts another placement that puts the two on the same ${axis === 'x' ? 'column' : 'row'}`);
    for (let pass = 0, moved = true; moved; pass++) { // longest path: every box as far left (or up) as its statements allow
      moved = false;
      for (const s of seps) if (v[g(s.j)] < v[g(s.i)] + s.d) { v[g(s.j)] = v[g(s.i)] + s.d; moved = true; }
      if (pass > n + 2) throw new Error(`the placements ${where} go round in a circle (${seps.map(s => s.text).join('; ')})`);
    }
    for (let pass = 0, moved = true; moved && pass < 4 * n; pass++) { // then pull a box that sits before its target back up against it
      moved = false;
      for (const s of seps) {
        if (g(s.own) !== g(s.i)) continue;
        const room = Math.min(...seps.filter(o => g(o.i) === g(s.i)).map(o => v[g(o.j)] - o.d)) - v[g(s.i)];
        if (room > 0.01) { v[g(s.i)] += room; moved = true; }
      }
    }
    return kids.map((_, i) => v[g(i)]);
  };
  const cx = solve(colOf, sepX, 'x'), cy = solve(rowOf, sepY, 'y');
  const box = kids.map((c, i) => ({ id: c.id, x: cx[i] - c.w / 2, y: cy[i] - c.h / 2, w: c.w, h: c.h }));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = box[i], b = box[j];
    if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) throw new Error(`"${a.id}" and "${b.id}" ${where} overlap, and nothing says which side of the other either one sits on: place one against the other`);
  }
  const x0 = Math.min(...box.map(b => b.x)), y0 = Math.min(...box.map(b => b.y));
  for (const b of box) { b.x -= x0; b.y -= y0; }
  return { width: Math.max(...box.map(b => b.x + b.w)), height: Math.max(...box.map(b => b.y + b.h)), children: box, edges: [] };
}

export async function layout(model) {
  const parentOf = new Map(), byId = new Map();
  walk(model.root, (nd, parent) => { parentOf.set(nd, parent); byId.set(nd.id, nd); });
  const pathOf = nd => { const p = []; for (let c = nd; c; c = parentOf.get(c)) p.unshift(c); return p; };
  const childUnder = (container, nd) => { // the direct child of container that holds nd, if any
    let cur = nd;
    while (cur && parentOf.get(cur) !== container) cur = parentOf.get(cur);
    return cur || null;
  };
  const problems = [];

  // ---------- pass 1 ----------
  async function lay(nd) {
    if (!nd.children) { [nd.w, nd.h] = leafSize(nd); return; }
    for (const c of nd.children) await lay(c);
    if (nd.widths === 'match') { // plain boxes at this level all take the widest one's width
      const plain = nd.children.filter(c => !c.children && !c.note && (!c.shape || c.shape === 'cylinder')), w = Math.max(0, ...plain.map(c => c.w));
      for (const c of plain) c.w = w;
    }

    // arrows that, at this level, run between two of this container's children
    const pairs = new Map();
    model.edges.forEach((e, i) => {
      const a = childUnder(nd, byId.get(e.a)), b = childUnder(nd, byId.get(e.b));
      if (!a || !b || a === b) return;
      const key = a.id + '>' + b.id;
      if (!pairs.has(key)) pairs.set(key, { a, b, items: [] });
      pairs.get(key).items.push({ i, direct: a.id === e.a && b.id === e.b });
    });
    const wanted = []; // one route per entry
    for (const [key, p] of pairs) {
      const lab = text => (text ? [{ text, width: text.length * 6.2 + 12, height: 16 }] : []);
      const merged = p.items.length > 1 || !p.items[0].direct ? 'NN links' : model.edges[p.items[0].i].label; // a merged arrow's text is decided on screen; hold room for it
      // several arrows declared between the same two boxes (a decision's Yes and No) each keep their own route
      if (p.items.length > 1 && p.items.every(it => it.direct)) for (const it of p.items) wanted.push({ id: key + '#' + it.i, a: p.a, b: p.b, labels: lab(model.edges[it.i].label) });
      else wanted.push({ id: key, a: p.a, b: p.b, labels: lab(merged) });
    }
    const order = new Map(nd.children.map((c, i) => [c.id, i]));
    const stated = nd.children.some(c => c.place);
    let res, rerouted = [];

    if (stated) {
      try { res = placeStated(nd); } catch (e) { problems.push(e.message); res = null; }
    }
    if (!res) {
      const elkEdges = wanted.map(w => ({ id: w.id, sources: [w.a.id], targets: [w.b.id], labels: w.labels }));
      // a note that is about a box sits next to it: an unseen arrow ties the two together
      for (const c of nd.children) if (c.about && order.has(c.about)) elkEdges.push({ id: 'about:' + c.id, sources: [c.about], targets: [c.id], labels: [] });
      const once = (dir, ord, bare, wrap) => elk.layout({
        id: nd.id,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': dir,
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.layered.spacing.nodeNodeBetweenLayers': '56',
          'elk.spacing.nodeNode': '38',
          'elk.spacing.edgeNode': '22',
          'elk.spacing.edgeEdge': '14',
          'elk.layered.spacing.edgeNodeBetweenLayers': '22',
          'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
          'elk.layered.considerModelOrder.strategy': ord,               // how strongly the order in the file fixes the order on screen
          'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',          // a loop-back is the arrow that points to an earlier box in the file
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.nodePlacement.favorStraightEdges': 'true',
          'elk.layered.thoroughness': '30',
          'elk.edgeLabels.inline': 'true',
          'elk.layered.wrapping.strategy': wrap ? 'MULTI_EDGE' : 'OFF', // a long chain folds onto a second row instead of becoming a thin strip
          'elk.layered.wrapping.additionalEdgeSpacing': '24',
          'elk.separateConnectedComponents': 'true',
          'elk.spacing.componentComponent': '46',
          'elk.aspectRatio': '1.7',
          'elk.padding': '[top=0,left=0,bottom=0,right=0]',
        },
        children: nd.children.map(c => ({ id: c.id, width: c.w, height: c.h })),
        edges: structuredClone(elkEdges).map(e => (bare.has(e.id) ? { ...e, labels: [] } : e)), // ELK writes into what it is given
      });
      // ELK can drop the route of a labelled loop-back when it wraps a chain. Retry those arrows
      // without a reserved label, then without wrapping, so every arrow keeps a route.
      const routeless = r => (r.edges || []).filter(e => !pointsOf(e)).map(e => e.id);
      const run = async (dir, ord, wrap) => {
        let r = await once(dir, ord, new Set(), wrap), bad = routeless(r);
        if (bad.length) { r = await once(dir, ord, new Set(bad), wrap); bad = routeless(r); }
        if (bad.length && wrap) r = await once(dir, ord, new Set(), false);
        r.wrapped = wrap;
        return r;
      };
      // Try the directions the file allows, each with the file's order held firmly, loosely and
      // not at all, and keep the least busy picture. Holding the order firmly wins ties, so the
      // author's order stands unless ignoring it is clearly cleaner. A declared flow that comes
      // out as a thin strip is also tried folded onto extra rows.
      const unit = nd.children.reduce((s, c) => s + c.w + c.h, 0) / (2 * nd.children.length);
      const dirs = nd.flow ? [nd.flow === 'right' ? 'RIGHT' : 'DOWN'] : ['DOWN', 'RIGHT'];
      let best = Infinity;
      for (const dir of dirs) for (const [ord, handicap] of [['NODES_AND_EDGES', 0], ['PREFER_EDGES', 1.5], ['NONE', 3]]) {
        let tries = [await run(dir, ord, false)];
        const thin = nd.flow ? Math.max(tries[0].width / tries[0].height, tries[0].height / tries[0].width) : 0;
        if (thin > 3.5) tries = [await run(dir, ord, true)];       // a strip this thin is unreadable: fold it
        else if (thin > 2.6) tries.push(await run(dir, ord, true)); // borderline: let the score decide
        for (const r of tries) { const score = busyness(r, unit) + handicap; if (score < best) { best = score; res = r; } }
      }
      res.edges = (res.edges || []).filter(e => !e.id.startsWith('about:'));
      // In a folded flow ELK takes loop-backs the long way round the rows. Route those again, directly.
      if (res.wrapped) rerouted = res.edges.filter(e => { const w = wanted.find(q => q.id === e.id); return w && order.get(w.a.id) > order.get(w.b.id); }).map(e => e.id);
    }

    // the inner space: content, padding, a header band, and room so closed containers stay closed at fit
    const closable = nd.children.filter(c => c.children && !c.group);
    let W = Math.max(res.width + 2 * SIDE, ...closable.map(c => c.w / FIT));
    let H = 0, top = 0;
    for (let pass = 0; pass < 3; pass++) {
      top = Math.max(46, 0.07 * W, 0.11 * H);
      H = Math.max(top + res.height + BOTTOM, ...closable.map(c => c.h / FIT));
      if (!nd.group) { if (W / H > 2.3) H = W / 2.3; else if (W / H < 1.15) W = H * 1.15; }
    }
    const ox = (W - res.width) / 2, oy = top + (H - top - BOTTOM - res.height) / 2;
    nd.iw = W; nd.ih = H;
    const pos = new Map(res.children.map(c => [c.id, c]));
    for (const c of nd.children) { const p = pos.get(c.id); c.x = p.x + ox; c.y = p.y + oy; }
    nd.routes = {}; nd.occ = [];
    for (const e of res.edges || []) {
      const p = pointsOf(e); if (!p || rerouted.includes(e.id)) continue;
      const l = e.labels && e.labels[0];
      nd.routes[e.id] = { p: p.map(q => [r1(q.x + ox), r1(q.y + oy)]) };
      if (l && l.x != null) nd.routes[e.id].l = [r1(l.x + l.width / 2 + ox), r1(l.y + l.height / 2 + oy)];
      occupy(nd.occ, nd.routes[e.id].p, e.id);
    }
    // arrows this file's own router draws: every arrow of a stated container, and the loop-backs of a folded flow
    for (const w of wanted) {
      if (nd.routes[w.id]) continue;
      const p = route(sidesOf(w.a), sidesOf(w.b), nd.children, W, H, nd.occ, w.id);
      if (p) { nd.routes[w.id] = { p }; occupy(nd.occ, p, w.id); }
    }

    // the box this container is drawn as inside its parent
    if (nd.group) { nd.w = W; nd.h = H; }                    // a group is a frame at its parent's own scale
    else { const a = W / H; nd.w = CLOSED_W; nd.h = CLOSED_W / a; if (nd.h > CLOSED_H) { nd.h = CLOSED_H; nd.w = CLOSED_H * a; } }
  }
  await lay(model.root);
  if (problems.length) { const err = new Error(problems.join('\n')); err.problems = problems; throw err; }

  // ---------- pass 2 ----------
  // For an arrow a -> b whose ends meet at container L (A and B are L's children holding a and b):
  // every container between A and a gets a port for the group "o:B" and a route from the child on
  // the way to a, to that port. The same on b's side with "i:A". The viewer strings the pieces together.
  const clampTo = (v, max) => Math.max(CLEAR * 2, Math.min(max - CLEAR * 2, v));
  const toInner = (box, pt) => { // a point on a box's border in its parent's space, as a point on the border of the box's own inner space
    const x = (pt[0] - box.x) / box.w * box.iw, y = (pt[1] - box.y) / box.h * box.ih;
    const d = [x, box.iw - x, y, box.ih - y].map(Math.abs), m = Math.min(...d);
    return m === d[2] ? [clampTo(x, box.iw), 0] : m === d[3] ? [clampTo(x, box.iw), box.ih] : m === d[0] ? [0, clampTo(y, box.ih)] : [box.iw, clampTo(y, box.ih)];
  };
  // The level above decided which side of X the arrow meets. Slide that meeting point along the
  // side until it is in line with the box the arrow is for, so the route inside X is short. The
  // last leg of the outer route moves with it; if that leg would then cross a box, leave it be.
  const slide = (X, child, pts, atStart, siblings) => {
    if (pts.length < 3) return;
    const p = pts[atStart ? 0 : pts.length - 1], q = pts[atStart ? 1 : pts.length - 2], r = pts[atStart ? 2 : pts.length - 3];
    const vertical = Math.abs(p[0] - q[0]) < 0.05; // the leg into X is vertical: X is met on its top or bottom
    if (!vertical && Math.abs(p[1] - q[1]) >= 0.05) return;
    const k = vertical ? 0 : 1, lo = vertical ? X.x : X.y, span = vertical ? X.w : X.h, inner = vertical ? X.iw : X.ih;
    const centre = vertical ? child.x + child.w / 2 : child.y + child.h / 2;
    const want = r1(lo + span * Math.max(0.08, Math.min(0.92, centre / inner)));
    if (Math.abs(want - p[k]) < 1) return;
    const others = (X.ports ||= []).filter(o => o.vertical === vertical && Math.abs(o.at - p[1 - k]) < 0.5);
    if (others.some(o => Math.abs(o.v - want) < span * 0.06)) return; // another arrow already meets this side there
    const np = [...p], nq = [...q]; np[k] = want; nq[k] = want;
    const hits = (a, b) => siblings.some(w => w !== X && Math.max(a[0], b[0]) > w.x - 3 && Math.min(a[0], b[0]) < w.x + w.w + 3 && Math.max(a[1], b[1]) > w.y - 3 && Math.min(a[1], b[1]) < w.y + w.h + 3);
    if (hits(np, nq) || hits(nq, r)) return;
    p[k] = want; q[k] = want;
    X.ports.push({ vertical, at: p[1 - k], v: want });
  };
  let unrouted = 0;
  const side = (chain, group, pts, atStart, siblings) => { // chain: [A, ..., end]; pts: the route of the level above, which meets A at its start or its end
    for (let i = 0; i < chain.length - 1; i++) {
      const X = chain[i], child = chain[i + 1];
      X.xr ||= {};
      if (!X.xr[group]) slide(X, child, pts, atStart, siblings);
      const port = pts[atStart ? 0 : pts.length - 1];
      const g = X.xr[group] ||= { port: toInner(X, port).map(r1), r: {} };
      if (!(child.id in g.r)) {
        g.r[child.id] = route(sidesOf(child), [portGoal(g.port, X.iw, X.ih)], X.children, X.iw, X.ih, X.occ, group);
        if (g.r[child.id]) occupy(X.occ, g.r[child.id], group); else unrouted++;
      }
      if (!g.r[child.id]) return;
      pts = g.r[child.id]; atStart = true; siblings = X.children; // where this route leaves the child is the child's own port, one level down
    }
  };
  for (const e of model.edges) {
    const pa = pathOf(byId.get(e.a)), pb = pathOf(byId.get(e.b));
    let n = 0; while (n < pa.length && n < pb.length && pa[n] === pb[n]) n++;
    if (n >= pa.length || n >= pb.length) continue; // one end holds the other, or it is a self loop
    const L = pa[n - 1], A = pa[n], B = pb[n], key = A.id + '>' + B.id;
    const found = L.routes[key] || L.routes[Object.keys(L.routes).find(k => k.startsWith(key + '#'))];
    if (!found) continue;
    side(pa.slice(n), 'o:' + B.id, found.p, true, L.children);
    side(pb.slice(n), 'i:' + A.id, found.p, false, L.children);
  }
  if (unrouted) model.warnings.push(`${unrouted} arrow piece(s) could not be routed round the boxes in their container and will be drawn straight`);

  walk(model.root, nd => { delete nd.ports; delete nd.occ; for (const k of ['x', 'y', 'w', 'h', 'iw', 'ih']) if (nd[k] != null) nd[k] = r1(nd[k]); });
  return model;
}
