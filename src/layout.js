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
// never passes behind a box, at any zoom. A port may move along its side when that keeps the
// picture above clean; the route inside decides where it lands, and no two arrows share one.
import ELK from 'elkjs/lib/elk.bundled.js';
import { walk } from './model.js';
import { quality } from './build.js';
import { layered } from './layered.js';
let OWN = false; // EXPERIMENTAL (layout's `engine: 'own'`): boxes placed by src/layered.js, not by ELK
const DEBUG = typeof process !== 'undefined' && process.env && process.env.STRATA_DEBUG; // no process in a browser

const elk = new ELK();
const CLOSED_W = 230, CLOSED_H = 180;   // the box a closed container is drawn as
const FIT = 0.3;                        // a closed container must stay under this share of its parent, so it is still closed when the parent fills the screen
const SIDE = 38, BOTTOM = 38;
const CROSS = 10;                       // what crossing another arrow costs the router; raising it was measured and does not lower the count
const CLEAR = 13, LANE = 9;             // how far a routed line stays from a box, and from the next line in the same channel
const GAP = { none: 0, tight: 24, normal: 58, wide: 112 };
const WIDE = 1.55, STRETCH = [1.5, 2.1, 2.8, 3.6]; // a level narrower than a screen has its gaps widened sideways until it is about screen-shaped
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
  // how small the boxes come out once the picture is fitted to a screen: the side of the screen it needs,
  // weighed against the rest in proportion to how many arrows there are to argue the other way
  const side = Math.max(res.width / 1.7, res.height), n = (res.edges || []).length;
  return len / unit + 0.7 * bends + 5 * crossings + (8 + 1.3 * n) * Math.log(side / unit);
}

// ---------- the router: a right-angle path between two sets of points, round every box ----------
// starts and goals are lists of { at: a point on a border, out: the point CLEAR beyond it, cost }.
// occ holds the segments already drawn in this container; running along one that belongs to a
// different arrow is expensive, so parallel arrows take neighbouring lanes instead of one line.
// A box offers the middle and the quarter points of each side, and also the points in line with
// where the arrow is going (toward), so an arrow to something straight below leaves straight down.
const sidesOf = (b, toward = []) => {
  const out = [];
  const add = (x, y, cost) => out.push(
    ...(x == null ? [] : [{ at: [x, b.y], out: [x, b.y - CLEAR], cost }, { at: [x, b.y + b.h], out: [x, b.y + b.h + CLEAR], cost }]),
    ...(y == null ? [] : [{ at: [b.x, y], out: [b.x - CLEAR, y], cost }, { at: [b.x + b.w, y], out: [b.x + b.w + CLEAR, y], cost }]));
  for (const [f, cost] of b.shape === 'diamond' ? [[0.5, 0]] : [[0.5, 0], [0.25, 6], [0.75, 6]]) add(b.x + b.w * f, b.y + b.h * f, cost);
  if (b.shape !== 'diamond') for (const t of toward) {
    const m = Math.min(16, b.w / 4, b.h / 4);
    add(t[0] > b.x + m && t[0] < b.x + b.w - m ? r1(t[0]) : null, t[1] > b.y + m && t[1] < b.y + b.h - m ? r1(t[1]) : null, 2);
  }
  return out;
};
const centre = b => [b.x + b.w / 2, b.y + b.h / 2];
// a port on side 0 top, 1 bottom, 2 left, 3 right of a W x H space, u along the side; the route arrives square on
const portAt = (sd, u, W, H) => (sd === 0 ? [u, 0] : sd === 1 ? [u, H] : sd === 2 ? [0, u] : [W, u]);
const portGoal = (sd, u, W, H, cost = 0) => ({ at: portAt(sd, u, W, H), cost, out: sd === 0 ? [u, CLEAR] : sd === 1 ? [u, H - CLEAR] : sd === 2 ? [CLEAR, u] : [W - CLEAR, u] });
const sideOfPort = (pt, W, H) => { const d = [pt[1], H - pt[1], pt[0], W - pt[0]].map(Math.abs); return d.indexOf(Math.min(...d)); };
function route(starts, goals, walls, W, H, occ, tag, grp, join) {
  const inside = (x, y, w) => x > w.x - CLEAR + 1 && x < w.x + w.w + CLEAR - 1 && y > w.y - CLEAR + 1 && y < w.y + w.h + CLEAR - 1;
  const ok = (x, y) => !walls.some(w => inside(x, y, w));
  const lanes = (lo, hi) => [0, 1, 2].flatMap(k => [lo - CLEAR - k * LANE, hi + CLEAR + k * LANE]);
  const axis = (vals, max) => [...new Set(vals.map(r1))].filter(v => v >= CLEAR - 1 && v <= max - CLEAR + 1).sort((p, q) => p - q);
  const ends = [...starts, ...goals];
  // Arrows of one family (same style, into the same box or out of the same box) may share a line:
  // running along a relative is cheaper than a lane of its own, so they gather into one trunk near the box.
  const kin = s => grp && s.grp && s.grp.some(g => grp.includes(g));
  const rest = (occ || []).filter(s => s.tag !== tag), others = rest.filter(s => !kin(s)), mates = rest.filter(kin);
  const hor = others.filter(s => s.a[1] === s.b[1]), ver = others.filter(s => s.a[0] === s.b[0]);
  const mhor = mates.filter(s => s.a[1] === s.b[1]), mver = mates.filter(s => s.a[0] === s.b[0]);
  const kinLines = [...((join && join.into) || []), ...((join && join.outof) || [])].flat();
  const xs = axis([CLEAR, W - CLEAR, ...ends.map(s => s.out[0]), ...walls.flatMap(w => lanes(w.x, w.x + w.w)), ...mver.map(s => s.a[0]), ...kinLines.map(p => p[0])], W);
  const ys = axis([CLEAR, H - CLEAR, ...ends.map(s => s.out[1]), ...walls.flatMap(w => lanes(w.y, w.y + w.h)), ...mhor.map(s => s.a[1]), ...kinLines.map(p => p[1])], H);
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i])), NY = ys.length;
  // A hub's arrows form a tree. An arrow into a box may end on a relative's line and ride it the
  // rest of the way in; an arrow out of a box may begin on a relative's line. Not on the stretch
  // next to the relative's own far end, where it would read as coming from that box.
  const far = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
  const along = m => m.slice(0, -1).reduce((n, q, i) => n + far(q, m[i + 1]), 0);
  const onLine = (m, i) => { // the grid points on segment i of a relative's route
    const a = m[i], b = m[i + 1], out = [];
    if (Math.abs(a[1] - b[1]) < 0.05) { for (const x of xs) if (x >= Math.min(a[0], b[0]) - 0.05 && x <= Math.max(a[0], b[0]) + 0.05) out.push([x, r1(a[1])]); }
    else for (const y of ys) if (y >= Math.min(a[1], b[1]) - 0.05 && y <= Math.max(a[1], b[1]) + 0.05) out.push([r1(a[0]), y]);
    return out;
  };
  starts = [...starts]; goals = [...goals];
  for (const m of (join && join.into) || []) for (let i = 0; i < m.length - 1; i++) for (const P of onLine(m, i)) {
    if (i === 0) continue; // the stretch that leaves the relative's own box: a line joining there reads as going to that box
    const tail = [P, ...m.slice(i + 1)];
    goals.push({ at: P, out: P, cost: 0.3 * along(tail) - 14, tail: m.slice(i + 1), joined: true });
  }
  for (const m of (join && join.outof) || []) for (let i = 0; i < m.length - 1; i++) for (const P of onLine(m, i)) {
    const n = m.length - 1;
    if (i === n - 1) continue;
    starts.push({ at: P, out: P, cost: 0.3 * along([...m.slice(0, i + 1), P]) - 14, head: m.slice(0, i + 1), joined: true });
  }
  const lap = (a0, a1, b0, b1) => Math.max(0, Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1)));
  const stepCost = (x0, y0, x1, y1) => { // length, plus riding on or crossing another arrow's line
    let c = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    if (y0 === y1) {
      for (const s of hor) if (Math.abs(s.a[1] - y0) < LANE - 2) c += 4 * lap(x0, x1, s.a[0], s.b[0]);
      for (const s of ver) if (s.a[0] > Math.min(x0, x1) && s.a[0] < Math.max(x0, x1) && y0 > Math.min(s.a[1], s.b[1]) && y0 < Math.max(s.a[1], s.b[1])) c += CROSS;
      let on = 0; for (const s of mhor) if (Math.abs(s.a[1] - y0) < 0.06) on = Math.max(on, lap(x0, x1, s.a[0], s.b[0])); c -= 0.62 * on;
    } else {
      for (const s of ver) if (Math.abs(s.a[0] - x0) < LANE - 2) c += 4 * lap(y0, y1, s.a[1], s.b[1]);
      for (const s of hor) if (s.a[1] > Math.min(y0, y1) && s.a[1] < Math.max(y0, y1) && x0 > Math.min(s.a[0], s.b[0]) && x0 < Math.max(s.a[0], s.b[0])) c += CROSS;
      let on = 0; for (const s of mver) if (Math.abs(s.a[0] - x0) < 0.06) on = Math.max(on, lap(y0, y1, s.a[1], s.b[1])); c -= 0.62 * on;
    }
    return c;
  };
  const meets = s => mates.some(m => (Math.abs(m.a[0] - s.at[0]) < 0.06 && Math.abs(m.a[1] - s.at[1]) < 0.06) || (Math.abs(m.b[0] - s.at[0]) < 0.06 && Math.abs(m.b[1] - s.at[1]) < 0.06));
  const stub = s => s.joined ? s.cost : s.cost + (meets(s) ? -45 : 0) + stepCost(s.at[0], s.at[1], s.out[0], s.out[1]) - Math.abs(s.at[0] - s.out[0]) - Math.abs(s.at[1] - s.out[1]); // leaving a box on another arrow's line; a relative's meeting point is the place to join
  const heading = (f, t) => (t[1] < f[1] ? 0 : t[1] > f[1] ? 2 : t[0] < f[0] ? 3 : 1); // 0 up, 1 right, 2 down, 3 left
  const goalAt = new Map();
  goals.forEach((g, gi) => { const i = xi.get(r1(g.out[0])), j = yi.get(r1(g.out[1])); if (i != null && j != null && ok(g.out[0], g.out[1])) { const k = i * NY + j; if (!goalAt.has(k)) goalAt.set(k, []); goalAt.get(k).push(gi); } });
  if (!goalAt.size) return null;
  const NX = xs.length, DONE = NX * NY * 4; // keys from here up stand for "arrived at goal n"
  // What the search asks again and again is worked out once per grid point and per grid step:
  // whether it is clear of every box, and what the step costs (the same in both directions).
  const free = new Int8Array(NX * NY), openH = new Int8Array(NX * NY), openV = new Int8Array(NX * NY), costH = new Float64Array(NX * NY).fill(NaN), costV = new Float64Array(NX * NY).fill(NaN);
  const clear = (i, j) => { const c = i * NY + j; return (free[c] || (free[c] = ok(xs[i], ys[j]) ? 1 : 2)) === 1; };
  const open = (i, j, ni, nj) => { // the step between two neighbouring grid points: its middle and its far end are clear
    const c = Math.min(i, ni) * NY + Math.min(j, nj), a = i === ni ? openV : openH;
    return (a[c] || (a[c] = ok((xs[i] + xs[ni]) / 2, (ys[j] + ys[nj]) / 2) ? 1 : 2)) === 1 && clear(ni, nj);
  };
  const step = (i, j, ni, nj) => { const c = Math.min(i, ni) * NY + Math.min(j, nj), a = i === ni ? costV : costH; return a[c] === a[c] ? a[c] : (a[c] = stepCost(xs[i], ys[j], xs[ni], ys[nj])); };
  // Dijkstra over (column, row, heading) with a binary heap; a bend costs as much as a long detour
  const BEND = 40, dist = new Float64Array(DONE + goals.length).fill(Infinity), prev = new Int32Array(DONE + goals.length), heap = [];
  const push = (c, k, from) => {
    if (dist[k] <= c) return; dist[k] = c; prev[k] = from;
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
    if (s.joined) { for (let h = 0; h < 4; h++) push(stub(s), (i * NY + j) * 4 + h, -1 - si); return; }
    push(stub(s), (i * NY + j) * 4 + heading(s.at, s.out), -1 - si);
  });
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  let end = null, goal = null;
  while (heap.length) {
    const [c, k] = pop(); if (c > dist[k]) continue;
    if (k >= DONE) { goal = goals[k - DONE]; end = prev[k]; break; }
    const cell = k >> 2, d = k & 3, i = Math.floor(cell / NY), j = cell % NY;
    for (const gi of goalAt.get(cell) || []) push(c + stub(goals[gi]) + (goals[gi].joined || heading(goals[gi].out, goals[gi].at) === d ? 0 : BEND), DONE + gi, k);
    for (let nd = 0; nd < 4; nd++) {
      if ((nd + 2) % 4 === d) continue;
      const ni = i + DX[nd], nj = j + DY[nd]; if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue;
      if (!open(i, j, ni, nj)) continue;
      push(c + step(i, j, ni, nj) + (nd === d ? 0 : BEND), (ni * NY + nj) * 4 + nd, k);
    }
  }
  if (end == null) return null;
  let from = null;
  const pts = [goal.at, goal.out];
  for (let k = end; ;) {
    const cell = k >> 2; pts.push([xs[Math.floor(cell / NY)], ys[cell % NY]]);
    const p = prev[k];
    if (p < 0) { from = starts[-1 - p]; pts.push(from.at); break; }
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
  const whole = [...((from && from.head) || []), ...out, ...(goal.tail || [])].map(p => [r1(p[0]), r1(p[1])]);
  const tidy = []; // no repeated points, and no point in the middle of a straight run
  for (let i = 0; i < whole.length; i++) {
    const a = tidy[tidy.length - 1], b = whole[i], c = whole[i + 1];
    if (a && far(a, b) < 0.06) continue;
    if (a && c && ((Math.abs(a[0] - b[0]) < 0.06 && Math.abs(b[0] - c[0]) < 0.06) || (Math.abs(a[1] - b[1]) < 0.06 && Math.abs(b[1] - c[1]) < 0.06))) continue;
    tidy.push(b);
  }
  return tidy;
}
const occupy = (occ, pts, tag, grp) => { for (let i = 0; i < pts.length - 1; i++) occ.push({ a: pts[i], b: pts[i + 1], tag, grp }); };

// ---------- stated placement: the file says where each box sits; this works out only the distances ----------
// A gap is a minimum, never an exact distance, and everything ends up as close together as the
// statements allow. Anything left ambiguous is an error that names the box, never a guess.
function placeStated(nd, fx = 1, fy = 1) {
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
      const d = (horiz ? (c.w + t.w) / 2 : (c.h + t.h) / 2) + GAP[p.gap] * (horiz ? fx : fy);
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

async function layoutOnce(model, hints) {
  const parentOf = new Map(), byId = new Map();
  walk(model.root, (nd, parent) => { parentOf.set(nd, parent); byId.set(nd.id, nd); });
  const pathOf = nd => { const p = []; for (let c = nd; c; c = parentOf.get(c)) p.unshift(c); return p; };
  const childUnder = (container, nd) => { // the direct child of container that holds nd, if any
    let cur = nd;
    while (cur && parentOf.get(cur) !== container) cur = parentOf.get(cur);
    return cur || null;
  };
  const problems = [], famOf = new Map(); // container id | route id -> the families that route belongs to

  // An arrow that ends inside a closed-looking container still has a box it is really for. Which
  // one, per container and per arrow group ("o:<other end>" going out, "i:<other end>" coming in).
  const deep = new Map();
  for (const e of model.edges) {
    const pa = pathOf(byId.get(e.a)), pb = pathOf(byId.get(e.b));
    let n = 0; while (n < pa.length && n < pb.length && pa[n] === pb[n]) n++;
    if (n >= pa.length || n >= pb.length) continue;
    for (const [chain, group] of [[pa.slice(n), 'o:' + pb[n].id], [pb.slice(n), 'i:' + pa[n].id]])
      for (let i = 0; i < chain.length - 1; i++) { const k = chain[i].id + '|' + group; if (!deep.has(k)) deep.set(k, new Set()); deep.get(k).add(chain[i + 1]); }
  }
  // Where an arrow may meet box b. For a container, a point far from the box the arrow is really
  // for costs what the detour inside will cost, so the arrow meets the container near that box
  // and on the side facing it. `share` turns a length inside b into the same share of the screen out here.
  const aim = (b, group) => { // the space inside b taken by the boxes this arrow is for
    const set = deep.get(b.id + '|' + group); if (!set) return null;
    const x = Math.min(...[...set].map(c => c.x)), y = Math.min(...[...set].map(c => c.y));
    return { x, y, w: Math.max(...[...set].map(c => c.x + c.w)) - x, h: Math.max(...[...set].map(c => c.y + c.h)) - y };
  };
  // what the line inside b will cost if the arrow meets b at pt (a point on b's border, in the level's own units)
  const within = (b, group, pt, share) => {
    const c = aim(b, group); if (!c) return 0;
    const cc = centre(c), u = (pt[0] - b.x) / b.w * b.iw, v = (pt[1] - b.y) / b.h * b.ih;
    const flat = Math.abs(pt[1] - b.y) < 0.05 || Math.abs(pt[1] - b.y - b.h) < 0.05;
    return (flat ? Math.abs(u - cc[0]) + Math.min(Math.abs(v - c.y), Math.abs(v - c.y - c.h)) : Math.abs(v - cc[1]) + Math.min(Math.abs(u - c.x), Math.abs(u - c.x - c.w))) * 0.5 * share / b.iw;
  };
  const exits = (b, group, toward, share) => {
    const c = aim(b, group);
    if (!c) return sidesOf(b, toward);
    const cc = centre(c), f = 0.5 * share / b.iw;
    return sidesOf(b, [...toward, [b.x + cc[0] / b.iw * b.w, b.y + cc[1] / b.ih * b.h]]).map(s => {
      const u = (s.at[0] - b.x) / b.w * b.iw, v = (s.at[1] - b.y) / b.h * b.ih;
      const flat = Math.abs(s.at[1] - b.y) < 0.05 || Math.abs(s.at[1] - b.y - b.h) < 0.05; // on the top or the bottom
      const inside = flat ? Math.abs(u - cc[0]) + Math.min(Math.abs(v - c.y), Math.abs(v - c.y - c.h)) : Math.abs(v - cc[1]) + Math.min(Math.abs(u - c.x), Math.abs(u - c.x - c.w));
      return { ...s, cost: s.cost + inside * f };
    });
  };

  const segsOf = pts => pts.slice(0, -1).map((p, i) => [p, pts[i + 1]]);
  const boxHit = (a, b, w, m) => Math.max(a[0], b[0]) > w.x - m && Math.min(a[0], b[0]) < w.x + w.w + m && Math.max(a[1], b[1]) > w.y - m && Math.min(a[1], b[1]) < w.y + w.h + m;
  const clash = (pts, occ, tag, fam) => { // how often a line crosses, or rides along, the other arrows in its container
    let n = 0;
    for (const [a, b] of segsOf(pts)) for (const s of occ) {
      if (s.tag === tag || (fam && s.grp && s.grp.some(g => fam.includes(g)))) continue;
      const h1 = Math.abs(a[1] - b[1]) < 0.05, h2 = Math.abs(s.a[1] - s.b[1]) < 0.05;
      const lo = (p, q, k) => Math.min(p[k], q[k]), hi = (p, q, k) => Math.max(p[k], q[k]);
      if (h1 === h2) { const k = h1 ? 0 : 1; if (Math.abs(a[1 - k] - s.a[1 - k]) < LANE - 2 && Math.min(hi(a, b, k), hi(s.a, s.b, k)) - Math.max(lo(a, b, k), lo(s.a, s.b, k)) > 1) n++; }
      else { const [h, v] = h1 ? [[a, b], [s.a, s.b]] : [[s.a, s.b], [a, b]]; if (v[0][0] > lo(...h, 0) && v[0][0] < hi(...h, 0) && h[0][1] > lo(...v, 1) && h[0][1] < hi(...v, 1)) n++; }
    }
    return n;
  };

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
      // the family an arrow belongs to, for sharing a trunk: the style it will be drawn in, and the box at either end
      const sty = p.items.map(it => model.edges[it.i].style).reduce((w, n) => ((model.styles[n].rank ?? 0) > (model.styles[w].rank ?? 0) ? n : w));
      const grp = [`i:${p.b.id}:${sty}`, `o:${p.a.id}:${sty}`];
      if (p.items.length > 1 && p.items.every(it => it.direct)) for (const it of p.items) wanted.push({ id: key + '#' + it.i, a: p.a, b: p.b, labels: lab(model.edges[it.i].label) });
      else { wanted.push({ id: key, a: p.a, b: p.b, labels: lab(merged), grp }); famOf.set(nd.id + '|' + key, grp); }
    }
    const order = new Map(nd.children.map((c, i) => [c.id, i]));
    const stated = nd.children.some(c => c.place);
    let res, rerouted = [], make = null;
    // Use the room a screen has: while the level is taller than a screen is, widen its sideways
    // gaps; while it is a long strip, widen the gaps between its rows. Boxes keep their size.
    const shape = r => (r.width + 2 * SIDE) / (r.height + 46 + BOTTOM);
    const closed = nd.children.filter(c => c.children && !c.group);
    const roomW = Math.max(0, ...closed.map(c => c.w / FIT)) - 2 * SIDE, roomH = Math.max(0, ...closed.map(c => c.h / FIT)) - 46 - BOTTOM; // room the level has anyway: a closed container must stay small beside it
    const widen = async make => {
      let r = await make(1, 1), fx = 1;
      if (nd.children.length < 2) return r;
      for (const f of STRETCH) {
        if (r.width >= 0.92 * roomW && shape(r) >= WIDE) break;
        const t = await make(f, 1);
        if (t.width <= r.width + 1 || (t.width > 1.04 * roomW && shape(t) > WIDE + 0.3)) break;
        r = t; fx = f;
      }
      for (const f of STRETCH) {
        if (r.height >= 0.92 * roomH && shape(r) <= 1.9) break;
        const t = await make(fx, f);
        if (t.height <= r.height + 1 || (t.height > 1.04 * roomH && shape(t) < WIDE - 0.1)) break;
        r = t;
      }
      return r;
    };

    if (stated) {
      try { make = (fx, fy) => placeStated(nd, fx, fy); res = await widen(make); } catch (e) { problems.push(e.message); res = null; make = null; }
    }
    let hint = OWN ? null : hints && hints.get(nd.id); // the pulls of a second pass are ELK's only, so far
    while (!res) {
      const elkEdges = wanted.map(w => ({ id: w.id, sources: [w.a.id], targets: [w.b.id], labels: w.labels }));
      // a note that is about a box sits next to it: an unseen arrow ties the two together
      for (const c of nd.children) if (c.about && order.has(c.about)) elkEdges.push({ id: 'about:' + c.id, sources: [c.about], targets: [c.id], labels: [] });
      // Second time round (see layout): the level above has said which side each arrow out of this
      // level leaves by. An unseen point on that side, tied to the boxes the arrow is for, pulls them
      // toward it. Only the two sides the flow runs between can be asked for.
      const pulls = dir => {
        const nodes = [], edges = [];
        for (const [group, h] of hint || []) {
          const first = dir === 'DOWN' ? h.side === 0 : h.side === 2, last = dir === 'DOWN' ? h.side === 1 : h.side === 3, kids = h.kids.filter(k => order.has(k));
          if ((!first && !last) || !kids.length) continue;
          nodes.push({ id: 'away:' + group, width: 1, height: 1, layoutOptions: { 'elk.layered.layering.layerConstraint': first ? 'FIRST_SEPARATE' : 'LAST_SEPARATE' } });
          for (const k of kids) edges.push({ id: 'away:' + group + ':' + k, sources: [first ? 'away:' + group : k], targets: [first ? k : 'away:' + group], labels: [] });
        }
        return { nodes, edges };
      };
      const strip = r => { // take the unseen points out again, and close the room they took
        r.children = r.children.filter(c => !c.id.startsWith('away:')); r.edges = (r.edges || []).filter(e => !e.id.startsWith('away:'));
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const see = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
        const pts = e => (e.sections || []).flatMap(sc => [sc.startPoint, ...(sc.bendPoints || []), sc.endPoint]);
        for (const c of r.children) { see(c.x, c.y); see(c.x + c.width, c.y + c.height); }
        for (const e of r.edges) { for (const p of pts(e)) see(p.x, p.y); for (const l of e.labels || []) if (l.x != null) { see(l.x, l.y); see(l.x + l.width, l.y + l.height); } }
        for (const c of r.children) { c.x -= x0; c.y -= y0; }
        for (const e of r.edges) { for (const p of pts(e)) { p.x -= x0; p.y -= y0; } for (const l of e.labels || []) if (l.x != null) { l.x -= x0; l.y -= y0; } }
        r.width = x1 - x0; r.height = y1 - y0;
        return r;
      };
      const unit = nd.children.reduce((s, c) => s + c.w + c.h, 0) / (2 * nd.children.length);
      const own = (dir, ord, bare, wrap, fx, fy) => layered(nd.children.map(c => ({ id: c.id, width: c.w, height: c.h })),
        elkEdges.map(e => ({ a: e.sources[0], b: e.targets[0], label: bare.has(e.id) || !e.labels[0] ? 0 : e.labels[0].width })),
        { dir, ord, wrap, unit, layerGap: Math.round(64 * (dir === 'DOWN' ? fy : fx)), nodeGap: Math.round(44 * (dir === 'DOWN' ? fx : fy)), compGap: Math.round(54 * Math.max(fx, fy)) });
      const once = (dir, ord, bare, wrap, fx = 1, fy = 1, pull = pulls(dir)) => OWN ? own(dir, ord, bare, wrap, fx, fy) : elk.layout({
        id: nd.id,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': dir,
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(64 * (dir === 'DOWN' ? fy : fx))),
          'elk.spacing.nodeNode': String(Math.round(44 * (dir === 'DOWN' ? fx : fy))),
          'elk.spacing.edgeNode': '24',
          'elk.spacing.edgeEdge': '16',
          'elk.layered.spacing.edgeNodeBetweenLayers': '24',
          'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
          'elk.layered.considerModelOrder.strategy': ord,               // how strongly the order in the file fixes the order on screen
          'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',          // a loop-back is the arrow that points to an earlier box in the file
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.nodePlacement.favorStraightEdges': 'true',
          'elk.layered.thoroughness': '30',
          'elk.edgeLabels.inline': 'true',
          'elk.layered.wrapping.strategy': wrap ? 'MULTI_EDGE' : 'OFF', // a long chain folds onto a second row instead of becoming a thin strip
          'elk.layered.wrapping.additionalEdgeSpacing': '24',
          'elk.separateConnectedComponents': 'true',
          'elk.spacing.componentComponent': String(Math.round(54 * Math.max(fx, fy))),
          'elk.aspectRatio': '1.7',
          'elk.padding': '[top=0,left=0,bottom=0,right=0]',
        },
        children: [...nd.children.map(c => ({ id: c.id, width: c.w, height: c.h })), ...pull.nodes],
        edges: [...structuredClone(elkEdges).map(e => (bare.has(e.id) ? { ...e, labels: [] } : e)), ...pull.edges], // ELK writes into what it is given
      });
      // ELK can drop the route of a labelled loop-back when it wraps a chain. Retry those arrows
      // without a reserved label, then without wrapping, so every arrow keeps a route.
      const routeless = r => (r.edges || []).filter(e => !pointsOf(e)).map(e => e.id);
      const run = async (dir, ord, wrap, fx = 1, fy = 1) => {
        let r = await once(dir, ord, new Set(), wrap, fx, fy), bad = routeless(r);
        if (bad.length) { r = await once(dir, ord, new Set(bad), wrap, fx, fy); bad = routeless(r); }
        if (bad.length && wrap) { r = await once(dir, ord, new Set(), false, fx, fy); wrap = false; }
        r.wrapped = r.own ? r.wrapped : wrap; r.how = [dir, ord, wrap];
        if (hint) { r.score = busyness(r, unit); strip(r); } // judged with the pulls in: they stand for the lines that leave
        return r;
      };
      // Try the directions the file allows, each with the file's order held firmly, loosely and
      // not at all, and keep the least busy picture. Holding the order firmly wins ties, so the
      // author's order stands unless ignoring it is clearly cleaner. A declared flow that comes
      // out as a thin strip is also tried folded onto extra rows.
      const dirs = nd.flow ? [nd.flow === 'right' ? 'RIGHT' : 'DOWN'] : ['DOWN', 'RIGHT'];
      let best = Infinity;
      for (const dir of dirs) for (const [ord, handicap] of [['NODES_AND_EDGES', 0], ['PREFER_EDGES', 1.5], ['NONE', 3]]) {
        let tries = [await run(dir, ord, false)];
        const thin = Math.max(tries[0].width / tries[0].height, tries[0].height / tries[0].width);
        if (nd.flow && thin > 3.5) tries = [await run(dir, ord, true)]; // a strip this thin is unreadable: fold it
        else if (thin > 2.6) tries.push(await run(dir, ord, true));     // borderline, or no direction was asked for: let the score decide
        for (const r of tries) { const score = (r.score ?? busyness(r, unit)) + handicap; if (DEBUG) console.error(nd.id, r.how.join(' '), Math.round(r.width), 'x', Math.round(r.height), 'score', score.toFixed(1)); if (score < best) { best = score; res = r; } }
      }
      { const [dir, ord, wrap] = res.how, first = res; res = await widen((fx, fy) => (fx === 1 && fy === 1 ? first : run(dir, ord, wrap, fx, fy))); make = (fx, fy) => run(dir, ord, wrap, fx, fy); }
      res.edges = (res.edges || []).filter(e => !e.id.startsWith('about:'));
      // In a folded flow ELK takes loop-backs the long way round the rows. Route those again, directly.
      // A level pulled toward its exits must not come out smaller on a screen than it was without the pulls.
      const need = Math.max(res.width / 1.7, res.height);
      if (hint && need > 1.06 * hint.was) { hint = null; res = null; continue; }
      nd.need = need;
      if (res.wrapped) rerouted = res.edges.filter(e => { const w = wanted.find(q => q.id === e.id); return w && order.get(w.a.id) > order.get(w.b.id); }).map(e => e.id);
    }

    // A level that is still a tall column has width to spare, and one that is still a strip has
    // height to spare. Plain boxes grow into it: a wider box shows a larger title once the level is
    // fitted to a screen, a taller one shows its detail lines. Kept only if the level gets no longer.
    if (make && nd.children.length > 1) {
      const plain = nd.children.filter(c => !c.children && !c.note && (!c.shape || c.shape === 'cylinder'));
      const sh = shape(res), tall = sh < 1.2, strip = sh > 2.4;
      if (plain.length && (tall || strip)) {
        const f = tall ? Math.min(1.7, 1.5 / sh) : Math.min(1.45, sh / 2);
        const was = plain.map(c => [c.w, c.h]);
        for (const c of plain) { if (tall) c.w = Math.min(Math.max(c.w, CLOSED_W * 1.25), c.w * f); else c.h *= f; }
        let t = null; try { t = await widen(make); } catch (e) { t = null; }
        if (t && (tall ? t.height <= res.height * 1.02 : t.width <= res.width * 1.02)) { if (res.wrapped != null && t.wrapped == null) t.wrapped = res.wrapped; res = t; }
        else plain.forEach((c, i) => { [c.w, c.h] = was[i]; });
      }
    }

    // The layout engine can return a line that stops short of its box, or is not at right angles, when
    // it folds a flow. Such a line is thrown away and drawn by this file's own router.
    {
      const at = new Map(res.children.map(c => [c.id, c])), on = (q, c) => c && q.x >= c.x - 2 && q.x <= c.x + c.width + 2 && q.y >= c.y - 2 && q.y <= c.y + c.height + 2;
      for (const e of res.edges || []) {
        const p = pointsOf(e), w = wanted.find(q => q.id === e.id); if (!p || !w || rerouted.includes(e.id)) continue;
        const square = p.every((q, i) => !i || Math.abs(q.x - p[i - 1].x) < 0.15 || Math.abs(q.y - p[i - 1].y) < 0.15);
        if (!square || !on(p[0], at.get(w.a.id)) || !on(p[p.length - 1], at.get(w.b.id))) rerouted.push(e.id);
      }
    }

    // the inner space: content, padding, a header band, and room so closed containers stay closed at fit
    const closable = nd.children.filter(c => c.children && !c.group);
    let W = Math.max(res.width + 2 * SIDE, ...closable.map(c => c.w / FIT));
    let H = 0, top = 0;
    for (let pass = 0; pass < 3; pass++) {
      top = nd.id === '__root' ? SIDE : Math.max(nd.group ? 62 : 46, 0.07 * W, 0.11 * H); // the top level has no title band to leave room for
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
      occupy(nd.occ, nd.routes[e.id].p, e.id, (wanted.find(q => q.id === e.id) || {}).grp);
    }
    // arrows this file's own router draws: every arrow of a stated container, and the loop-backs of a folded flow
    const apart = w => { const a = centre(w.a), b = centre(w.b); return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]); };
    // A box with three or more arrows of one style coming in (or going out) is a hub: those arrows are drawn as one tree.
    // Only where this file's own router draws the arrows (a level whose boxes are placed by hand, and the loop-backs
    // of a folded flow): the layout engine has already ordered a hub's arrows on the levels it draws.
    const size = new Map();
    for (const w of wanted) if (w.grp) for (const g of w.grp) size.set(g, (size.get(g) || 0) + 1);
    const joinOf = w => {
      if (!w.grp) return null;
      const into = [], outof = [];
      for (const o of wanted) {
        if (o === w || !o.grp || !nd.routes[o.id]) continue;
        if (o.grp[0] === w.grp[0] && size.get(w.grp[0]) >= 3) into.push(nd.routes[o.id].p);
        if (o.grp[1] === w.grp[1] && size.get(w.grp[1]) >= 3) outof.push(nd.routes[o.id].p);
      }
      return into.length || outof.length ? { into, outof } : null;
    };
    for (const w of [...wanted].sort((p, q) => apart(p) - apart(q))) { // short arrows first: they get the straight lines
      if (nd.routes[w.id]) continue;
      const p = route(exits(w.a, 'o:' + w.b.id, [centre(w.b)], W), exits(w.b, 'i:' + w.a.id, [centre(w.a)], W), nd.children, W, H, nd.occ, w.id, w.grp, joinOf(w));
      if (p) { nd.routes[w.id] = { p }; occupy(nd.occ, p, w.id, w.grp); }
    }

    // An arrow that goes a long way round gets a second opinion from this file's own router, which
    // knows only boxes and the other arrows. The shorter, straighter line wins.
    const weight = p => p.slice(0, -1).reduce((n, q, i) => n + Math.abs(p[i + 1][0] - q[0]) + Math.abs(p[i + 1][1] - q[1]), 0) + 40 * (p.length - 2);
    for (const w of wanted) {
      const old = nd.routes[w.id]; if (!old) continue;
      const a = centre(w.a), b = centre(w.b), direct = Math.max(0, Math.abs(a[0] - b[0]) - (w.a.w + w.b.w) / 2) + Math.max(0, Math.abs(a[1] - b[1]) - (w.a.h + w.b.h) / 2);
      const inner = q => within(w.a, 'o:' + w.b.id, q[0], W) + within(w.b, 'i:' + w.a.id, q[q.length - 1], W), far = inner(old.p);
      if (weight(old.p) < 1.6 * direct + 120 && far < 0.12 * W) continue;
      const p = route(exits(w.a, 'o:' + w.b.id, [b], W), exits(w.b, 'i:' + w.a.id, [a], W), nd.children, W, H, nd.occ.filter(o => o.tag !== w.id), w.id, w.grp);
      const X = 150, rest = nd.occ.filter(o => o.tag !== w.id); // a new crossing on this level costs more than a long line inside
      if (!p || X * clash(p, rest, w.id, w.grp) + weight(p) + inner(p) > 0.8 * (X * clash(old.p, rest, w.id, w.grp) + weight(old.p) + far)) continue;
      nd.routes[w.id] = { p }; nd.occ = nd.occ.filter(s => s.tag !== w.id); occupy(nd.occ, p, w.id, w.grp);
    }
    // An arrow that shares a trunk is labelled on the longest stretch that is its own.
    for (const w of wanted) {
      const r = nd.routes[w.id]; if (!r || r.l || !w.grp) continue;
      const mates = nd.occ.filter(s => s.tag !== w.id && s.grp && s.grp.some(g => w.grp.includes(g)));
      let shared = false, best = null;
      for (let i = 0; i < r.p.length - 1; i++) {
        const a = r.p[i], b = r.p[i + 1], k = Math.abs(a[1] - b[1]) < 0.05 ? 0 : 1, len = Math.abs(a[k] - b[k]);
        const on = mates.some(s => Math.abs(s.a[1 - k] - s.b[1 - k]) < 0.05 && Math.abs(s.a[1 - k] - a[1 - k]) < 0.06 && Math.min(Math.max(a[k], b[k]), Math.max(s.a[k], s.b[k])) - Math.max(Math.min(a[k], b[k]), Math.min(s.a[k], s.b[k])) > 1);
        if (on) shared = true; else if (!best || len > best[2]) best = [r1((a[0] + b[0]) / 2), r1((a[1] + b[1]) / 2), r1(len)];
      }
      if (shared && best) r.m = best;
    }
    // the box this container is drawn as inside its parent
    if (nd.group) { nd.w = W; nd.h = H; }                    // a group is a frame at its parent's own scale
    else { const a = W / H; nd.w = CLOSED_W; nd.h = CLOSED_W / a; if (nd.h > CLOSED_H) { nd.h = CLOSED_H; nd.w = CLOSED_H * a; } }
  }
  await lay(model.root);
  if (problems.length) { const err = new Error(problems.join('\n')); err.problems = problems; throw err; }

  // ---------- pass 2 ----------
  // For an arrow a -> b whose ends meet at container L (A and B are L's children holding a and b):
  // every container X between A and a gets a port for the group "o:B", and a route from the child
  // on the way to a, to that port. The same on b's side with "i:A". The viewer strings the pieces
  // together. Containers are done top down, because where an arrow meets X is decided by the
  // piece one level up, and that piece has to exist first.
  const needs = new Map(); // container -> group -> { group, kids, tag, pts | from, atStart, other }
  for (const e of model.edges) {
    const pa = pathOf(byId.get(e.a)), pb = pathOf(byId.get(e.b));
    let n = 0; while (n < pa.length && n < pb.length && pa[n] === pb[n]) n++;
    if (n >= pa.length || n >= pb.length) continue; // one end holds the other, or it is a self loop
    const L = pa[n - 1], A = pa[n], B = pb[n], key = A.id + '>' + B.id;
    const id = L.routes[key] ? key : Object.keys(L.routes).find(k => k.startsWith(key + '#'));
    if (!id) continue;
    const chainOf = (chain, group, atStart, other) => {
      for (let i = 0; i < chain.length - 1; i++) {
        const X = chain[i], m = needs.get(X) || needs.set(X, new Map()).get(X);
        const d = m.get(group) || m.set(group, i === 0 ? { group, kids: [], tag: id, pts: L.routes[id].p, atStart, other } : { group, kids: [], tag: group, from: chain[i - 1], atStart: true, other: null }).get(group);
        if (!d.kids.includes(chain[i + 1])) d.kids.push(chain[i + 1]);
      }
    };
    chainOf(pa.slice(n), 'o:' + B.id, true, B);
    chainOf(pb.slice(n), 'i:' + A.id, false, A);
  }

  const reoccupy = (L, tag) => { // a piece in L changed shape: tell the lanes
    L.occ = L.occ.filter(s => s.tag !== tag);
    if (L.routes[tag]) occupy(L.occ, L.routes[tag].p, tag);
    else for (const r of Object.values((L.xr && L.xr[tag] && L.xr[tag].r) || {})) if (r) occupy(L.occ, r, tag);
  };

  // Where an arrow meets X. The piece above arrives somewhere on one side of X; it may meet that
  // side anywhere that keeps the picture above clean (no box in the way, no new crossing, not on
  // top of another arrow's meeting point). Among those places, the route inside X picks: every
  // candidate is a goal for one search from the box the arrow is for, so the port lands where
  // the inside route is shortest and straightest.
  let unrouted = 0;
  const meet = (X, L, d, pts) => {
    const e = d.atStart ? 0 : pts.length - 1, st = d.atStart ? 1 : -1, p = pts[e], q = pts[e + st], r = pts[e + 2 * st];
    const sd = sideOfPort([p[0] - X.x, p[1] - X.y], X.w, X.h), k = sd < 2 ? 0 : 1; // k: the axis along the side
    const lo = k ? X.y : X.x, span = k ? X.h : X.w, inner = k ? X.ih : X.iw;
    const toIn = v => Math.max(2 * CLEAR, Math.min(inner - 2 * CLEAR, (v - lo) / span * inner)), toOut = u => r1(lo + u / inner * span);
    // arrows of one family may meet the container at the same place: one trunk, which parts inside
    const fam = d.pts ? famOf.get(L.id + '|' + d.tag) : null, kin = o => fam && o.fam && o.fam.some(g => fam.includes(g));
    const taken = (X.ports ||= []).filter(o => o.sd === sd && !kin(o)).map(o => o.v), sep = Math.max(4.5, Math.min(0.04 * span, 30));
    const free = v => taken.every(t => Math.abs(t - v) >= sep - 0.01);
    const base = clash(pts, L.occ, d.tag, fam);
    const fine = np => {
      for (const [a, b] of segsOf(np)) for (const w of L.children) if (boxHit(a, b, w, w === X || w === d.other ? -1 : 3)) return false;
      return clash(np, L.occ, d.tag, fam) <= base;
    };
    const cands = [{ u: toIn(p[k]), cost: free(p[k]) ? 0 : 500, pts: null }];
    // a straight line in the picture above stays straight; a line with a bend can slide its last leg along the side,
    // unless it is part of a hub's tree: its relatives end on the same point, and the tree would come apart
    const twin = Object.entries(L.routes).some(([id, o]) => id !== d.tag && o.p !== pts && Math.abs(o.p[d.atStart ? 0 : o.p.length - 1][0] - p[0]) + Math.abs(o.p[d.atStart ? 0 : o.p.length - 1][1] - p[1]) < 0.2);
    if (r && !twin && Math.abs(p[k] - q[k]) < 0.05 && Math.abs(q[1 - k] - r[1 - k]) < 0.05) {
      const kid = d.kids[0], klo = k ? kid.y : kid.x, kspan = k ? kid.h : kid.w;
      for (const o of X.ports) if (o.sd === sd && kin(o)) { // where a relative already meets this side is the best place of all
        if (Math.abs(o.v - p[k]) < 1) { cands[0].cost = -70; continue; }
        const np = pts.map(x => [...x]); np[e][k] = o.v; np[e + st][k] = o.v;
        if (fine(np)) cands.push({ u: toIn(o.v), cost: -70, pts: np });
      }
      const us = [klo + kspan / 2, klo + kspan / 4, klo + kspan * 0.75]; // in line with the box, or with the lane beside any box
      for (const w of X.children) us.push((k ? w.y : w.x) - CLEAR, (k ? w.y + w.h : w.x + w.w) + CLEAR);
      for (const u0 of us) {
        const u = r1(Math.max(0.06 * inner, 2 * CLEAR, Math.min(0.94 * inner, inner - 2 * CLEAR, u0))), v = toOut(u);
        if (Math.abs(v - p[k]) < 1 || !free(v) || cands.some(c => Math.abs(c.u - u) < 1)) continue;
        const np = pts.map(x => [...x]); np[e][k] = v; np[e + st][k] = v; // slide the last leg along the side
        if (fine(np)) cands.push({ u, cost: 4, pts: np });
      }
    }
    const goals = cands.map(c => portGoal(sd, c.u, X.iw, X.ih, c.cost));
    const g = (X.xr ||= {})[d.group] = { port: null, r: {} };
    let first = route(exits(d.kids[0], d.group, goals.map(t => t.out), X.iw), goals, X.children, X.iw, X.ih, X.occ, d.group, fam), pick = cands[0];
    if (first) { const end = first[first.length - 1]; pick = cands.find(c => { const a = portAt(sd, c.u, X.iw, X.ih); return Math.abs(a[0] - end[0]) + Math.abs(a[1] - end[1]) < 0.2; }) || cands[0]; }
    if (pick.pts) { pts.length = 0; pts.push(...pick.pts); reoccupy(L, d.tag); }
    X.ports.push({ sd, v: pts[d.atStart ? 0 : pts.length - 1][k], fam });
    g.port = portAt(sd, pick.u, X.iw, X.ih).map(r1);
    // Several boxes in X may share this arrow. Their lines form one tree to the port: the nearest box
    // is routed first, and each later one may end on a line already drawn and ride it the rest of the way.
    const goal = portGoal(sd, pick.u, X.iw, X.ih), gap = kid => { const c = centre(kid); return Math.abs(c[0] - goal.at[0]) + Math.abs(c[1] - goal.at[1]); };
    const drawn = [];
    for (const kid of [d.kids[0], ...d.kids.slice(1).sort((p, q) => gap(p) - gap(q))]) {
      const rt = kid === d.kids[0] ? first : route(exits(kid, d.group, [goal.out], X.iw), [goal], X.children, X.iw, X.ih, X.occ, d.group, fam, drawn.length ? { into: drawn } : null);
      g.r[kid.id] = rt;
      if (rt) { occupy(X.occ, rt, d.group, fam); drawn.push(rt); } else unrouted++;
    }
  };
  for (const queue = [model.root]; queue.length;) {
    const L = queue.shift();
    for (const X of L.children || []) {
      if (!X.children) continue;
      const todo = [...(needs.get(X) || new Map()).values()].map(d => [d, d.pts || (L.xr && L.xr[d.group] && L.xr[d.group].r[X.id])]).filter(t => t[1]);
      todo.sort((a, b) => Math.min(a[1].length, 3) - Math.min(b[1].length, 3)); // straight lines cannot move, so they claim their place on the side first
      for (const [d, pts] of todo) meet(X, L, d, pts);
      queue.push(X);
    }
  }
  if (unrouted) model.warnings.push(`${unrouted} arrow piece(s) could not be routed round the boxes in their container and will be drawn straight`);

  walk(model.root, nd => { delete nd.ports; delete nd.occ; if (hints) delete nd.need; for (const k of ['x', 'y', 'w', 'h', 'iw', 'ih']) if (nd[k] != null) nd[k] = r1(nd[k]); });
  return model;
}

// With `twice`, the picture is laid out twice. The first time, each level is arranged before the level above has
// decided which side its outgoing arrows leave by, so a box can end up far from the side its arrow
// needs. The second time, every level is told those sides and arranges its boxes toward them. The
// second picture is kept only if its arrows are cleaner by the numbers `check --stats` prints.
export async function layout(model, { twice = false, engine = 'elk' } = {}) {
  OWN = engine === 'own';
  const spare = twice ? structuredClone(model) : null;
  const first = await layoutOnce(model, null);
  if (!spare) return first;
  const hints = new Map();
  walk(first.root, nd => {
    if (!nd.children || !nd.xr || nd.children.some(c => c.place)) return;
    const m = new Map();
    for (const [group, g] of Object.entries(nd.xr)) if (g.port) m.set(group, { side: sideOfPort(g.port, nd.iw, nd.ih), kids: Object.keys(g.r) });
    if (m.size && nd.need) { m.was = nd.need; hints.set(nd.id, m); }
  });
  if (!hints.size) return first;
  let second; try { second = await layoutOnce(spare, hints); } catch (e) { return first; }
  const mark = m => { const t = quality(m).total; return t.crossings + 0.25 * t.bends + t.length; };
  if (DEBUG) console.error('first', mark(first).toFixed(1), 'second', mark(second).toFixed(1));
  return mark(second) < mark(first) ? second : first;
}
