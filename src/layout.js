// Lays the diagram out. Nothing here runs in the browser: the viewer only reads the numbers
// this writes (x, y, w, h, iw, ih, routes, xr).
//
// Pass 1, deepest container first: each container gets its own inner space (iw x ih) holding
// its children as closed boxes. ELK places the boxes and routes the arrows between them.
// Several ELK settings are tried and the least busy result is kept.
//
// Pass 2, top down: an arrow whose ends are in different containers is built from pieces. The
// piece between the two outermost boxes is the ELK route from pass 1. Where that route meets a
// container's border is that container's *port* for the arrow, and inside the container a
// right-angle route runs from the port to the box the arrow is really for, going round every
// other box. So an arrow never passes behind a box, at any zoom.
import ELK from 'elkjs/lib/elk.bundled.js';
import { walk } from './model.js';

const elk = new ELK();
const CLOSED_W = 230, CLOSED_H = 180;   // the box a closed container is drawn as
const FIT = 0.3;                        // a closed container must stay under this share of its parent, so it is still closed when the parent fills the screen
const SIDE = 30, BOTTOM = 30;
const CLEAR = 13;                       // how far a routed line stays from a box
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

// ---------- a right-angle route from a box to a point on the container's border, round every box ----------
function routeToPort(from, port, walls, W, H) {
  const inside = (x, y, w) => x > w.x - CLEAR + 1 && x < w.x + w.w + CLEAR - 1 && y > w.y - CLEAR + 1 && y < w.y + w.h + CLEAR - 1;
  // the port sits on a border; the route arrives at it square on, from CLEAR inside
  const dl = port[0], dr = W - port[0], dt = port[1], db = H - port[1], near = Math.min(dl, dr, dt, db);
  const goal = near === dt ? [port[0], CLEAR] : near === db ? [port[0], H - CLEAR] : near === dl ? [CLEAR, port[1]] : [W - CLEAR, port[1]];
  const starts = [];
  for (const f of [0.5, 0.25, 0.75]) starts.push(
    { at: [from.x + from.w * f, from.y], out: [from.x + from.w * f, from.y - CLEAR] }, { at: [from.x + from.w * f, from.y + from.h], out: [from.x + from.w * f, from.y + from.h + CLEAR] },
    { at: [from.x, from.y + from.h * f], out: [from.x - CLEAR, from.y + from.h * f] }, { at: [from.x + from.w, from.y + from.h * f], out: [from.x + from.w + CLEAR, from.y + from.h * f] });
  const uniq = a => [...new Set(a.map(r1))].filter(v => v >= CLEAR - 1 && v <= Math.max(W, H)).sort((p, q) => p - q);
  const xs = uniq([goal[0], CLEAR, W - CLEAR, ...starts.map(s => s.out[0]), ...walls.flatMap(w => [w.x - CLEAR, w.x + w.w + CLEAR])]).filter(v => v <= W - CLEAR + 1);
  const ys = uniq([goal[1], CLEAR, H - CLEAR, ...starts.map(s => s.out[1]), ...walls.flatMap(w => [w.y - CLEAR, w.y + w.h + CLEAR])]).filter(v => v <= H - CLEAR + 1);
  const ok = (x, y) => !walls.some(w => inside(x, y, w));
  const free = (x0, y0, x1, y1) => { const mx = (x0 + x1) / 2, my = (y0 + y1) / 2; return ok(mx, my) && ok(x1, y1); };
  const ix = v => xs.indexOf(r1(v)), iy = v => ys.indexOf(r1(v));
  const gx = ix(goal[0]), gy = iy(goal[1]); if (gx < 0 || gy < 0) return null;
  // Dijkstra over (column, row, heading); a bend costs as much as a long detour
  const BEND = 40, key = (i, j, d) => (i * ys.length + j) * 4 + d, dist = new Map(), prev = new Map(), open = [];
  const push = (i, j, d, c, from) => { const k = key(i, j, d); if (dist.has(k) && dist.get(k) <= c) return; dist.set(k, c); prev.set(k, from); open.push([c, i, j, d]); };
  starts.forEach((s, si) => {
    const i = ix(s.out[0]), j = iy(s.out[1]); if (i < 0 || j < 0 || !ok(s.out[0], s.out[1])) return;
    const d = s.out[1] < s.at[1] ? 0 : s.out[1] > s.at[1] ? 2 : s.out[0] < s.at[0] ? 3 : 1; // 0 up, 1 right, 2 down, 3 left
    push(i, j, d, si < 4 ? 0 : 6, -1 - si); // the middle of a side is preferred
  });
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  let end = null;
  while (open.length) {
    let bi = 0; for (let n = 1; n < open.length; n++) if (open[n][0] < open[bi][0]) bi = n;
    const [c, i, j, d] = open.splice(bi, 1)[0];
    if (c > dist.get(key(i, j, d))) continue;
    if (i === gx && j === gy) { end = key(i, j, d); break; }
    for (let nd = 0; nd < 4; nd++) {
      if ((nd + 2) % 4 === d) continue;
      const ni = i + DX[nd], nj = j + DY[nd]; if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length) continue;
      if (!free(xs[i], ys[j], xs[ni], ys[nj])) continue;
      push(ni, nj, nd, c + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (nd === d ? 0 : BEND), key(i, j, d));
    }
  }
  if (end == null) return null;
  const pts = [port, goal]; let k = end;
  for (;;) {
    const cell = Math.floor(k / 4); pts.push([xs[Math.floor(cell / ys.length)], ys[cell % ys.length]]);
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

export async function layout(model) {
  const parentOf = new Map(), byId = new Map();
  walk(model.root, (nd, parent) => { parentOf.set(nd, parent); byId.set(nd.id, nd); });
  const pathOf = nd => { const p = []; for (let c = nd; c; c = parentOf.get(c)) p.unshift(c); return p; };
  const childUnder = (container, nd) => { // the direct child of container that holds nd, if any
    let cur = nd;
    while (cur && parentOf.get(cur) !== container) cur = parentOf.get(cur);
    return cur || null;
  };

  // ---------- pass 1 ----------
  async function lay(nd) {
    if (!nd.children) { [nd.w, nd.h] = leafSize(nd); return; }
    for (const c of nd.children) await lay(c);

    // arrows that, at this level, run between two of this container's children
    const pairs = new Map();
    model.edges.forEach((e, i) => {
      const a = childUnder(nd, byId.get(e.a)), b = childUnder(nd, byId.get(e.b));
      if (!a || !b || a === b) return;
      const key = a.id + '>' + b.id;
      if (!pairs.has(key)) pairs.set(key, { a, b, items: [] });
      pairs.get(key).items.push({ i, direct: a.id === e.a && b.id === e.b });
    });
    const elkEdges = [];
    for (const [key, p] of pairs) {
      const lab = text => (text ? [{ text, width: text.length * 6.2 + 12, height: 16 }] : []);
      const merged = p.items.length > 1 || !p.items[0].direct ? 'NN links' : model.edges[p.items[0].i].label; // a merged arrow's text is decided on screen; hold room for it
      // several arrows declared between the same two boxes (a decision's Yes and No) each keep their own route
      if (p.items.length > 1 && p.items.every(it => it.direct)) for (const it of p.items) elkEdges.push({ id: key + '#' + it.i, sources: [p.a.id], targets: [p.b.id], labels: lab(model.edges[it.i].label) });
      else elkEdges.push({ id: key, sources: [p.a.id], targets: [p.b.id], labels: lab(merged) });
    }

    const once = (dir, order, bare, wrap) => elk.layout({
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
        'elk.layered.considerModelOrder.strategy': order,             // how strongly the order in the file fixes the order on screen
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
    const run = async (dir, order, wrap) => {
      let r = await once(dir, order, new Set(), wrap), bad = routeless(r);
      if (bad.length) { r = await once(dir, order, new Set(bad), wrap); bad = routeless(r); }
      if (bad.length && wrap) r = await once(dir, order, new Set(), false);
      return r;
    };
    // Try the directions the file allows, each with the file's order held firmly, loosely and
    // not at all, and keep the least busy picture. Holding the order firmly wins ties, so the
    // author's order stands unless ignoring it is clearly cleaner.
    const unit = nd.children.reduce((s, c) => s + c.w + c.h, 0) / (2 * nd.children.length);
    const dirs = nd.flow ? [nd.flow === 'right' ? 'RIGHT' : 'DOWN'] : ['DOWN', 'RIGHT'];
    let res = null, best = Infinity;
    for (const dir of dirs) for (const [order, handicap] of [['NODES_AND_EDGES', 0], ['PREFER_EDGES', 1.5], ['NONE', 3]]) {
      let r = await run(dir, order, false);
      // wrapping is only for a declared flow that would otherwise be a thin strip; on a fan-in architecture it tears the picture in two
      if (nd.flow && Math.max(r.width / r.height, r.height / r.width) > 3.5) r = await run(dir, order, true);
      const score = busyness(r, unit) + handicap;
      if (score < best) { best = score; res = r; }
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
    nd.routes = {};
    for (const e of res.edges || []) {
      const p = pointsOf(e); if (!p) continue;
      const l = e.labels && e.labels[0];
      nd.routes[e.id] = { p: p.map(q => [r1(q.x + ox), r1(q.y + oy)]) };
      if (l && l.x != null) nd.routes[e.id].l = [r1(l.x + l.width / 2 + ox), r1(l.y + l.height / 2 + oy)];
    }

    // the box this container is drawn as inside its parent
    if (nd.group) { nd.w = W; nd.h = H; }                    // a group is a frame at its parent's own scale
    else { const a = W / H; nd.w = CLOSED_W; nd.h = CLOSED_W / a; if (nd.h > CLOSED_H) { nd.h = CLOSED_H; nd.w = CLOSED_H * a; } }
  }
  await lay(model.root);

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
        g.r[child.id] = routeToPort(child, g.port, X.children, X.iw, X.ih);
        if (!g.r[child.id]) unrouted++;
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
    const route = L.routes[key] || L.routes[Object.keys(L.routes).find(k => k.startsWith(key + '#'))];
    if (!route) continue;
    side(pa.slice(n), 'o:' + B.id, route.p, true, L.children);
    side(pb.slice(n), 'i:' + A.id, route.p, false, L.children);
  }
  if (unrouted) model.warnings.push(`${unrouted} arrow piece(s) could not be routed round the boxes in their container and will be drawn straight`);

  walk(model.root, nd => { delete nd.ports; for (const k of ['x', 'y', 'w', 'h', 'iw', 'ih']) if (nd[k] != null) nd[k] = r1(nd[k]); });
  return model;
}
