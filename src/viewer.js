// The viewer. Plain browser JavaScript with no dependencies: `strata build` pastes this
// file, and the laid-out diagram as window.STRATA, into one HTML page.
(function () {
'use strict';
const D = window.STRATA, root = D.root, KIND = D.kinds, STY = D.styles, STATES = D.states;
const $ = id => document.getElementById(id);

// ---------- the tree: absolute positions, once ----------
const all = [], byId = {};
(function walk(nd, parent) {
  nd.parent = parent; nd.path = parent ? parent.path.concat(nd) : [nd];
  nd.st = nd.state || (parent && parent.st) || null;
  nd.lines = nd.label.split('\n'); nd.title = nd.lines.join(' ');
  all.push(nd); byId[nd.id] = nd;
  if (!nd.children) return;
  const u = nd.aw / nd.iw; // one inner unit of this container, in root units
  for (const c of nd.children) { c.ax = nd.ax + c.x * u; c.ay = nd.ay + c.y * u; c.aw = c.w * u; c.ah = c.h * u; walk(c, nd); }
})(Object.assign(root, { ax: 0, ay: 0, aw: root.iw, ah: root.ih }), null);
const E = D.edges.map(e => ({ a: byId[e.a], b: byId[e.b], label: e.label, style: e.style }));

// ---------- theme ----------
const FONT = 'system-ui,-apple-system,"Segoe UI",sans-serif';
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const colOf = nd => nd.st && !nd.note ? STATES[nd.st].c : (KIND[nd.kind] || KIND.frame).c;
const mq = matchMedia('(prefers-color-scheme:dark)');
let C;
function theme() {
  C = mq.matches
    ? { bg: '#121215', box: '#1f1f25', panel: '#17171b', ink: '#ececf1', muted: '#9c9ca8', line: [122, 122, 136], tint: 0.17, pill: '#2a2a33' }
    : { bg: '#f5f4f1', box: '#ffffff', panel: '#fbfbf9', ink: '#1c1c1f', muted: '#6a6a72', line: [120, 120, 132], tint: 0.09, pill: '#ffffff' };
}
theme(); mq.addEventListener('change', () => { theme(); req(); });

// ---------- camera ----------
const cv = $('cv'), ctx = cv.getContext('2d');
let vw = 0, vh = 0, dpr = 1, k = 1, tx = 0, ty = 0, kfit = 1, raf = 0, anim = null;
const off = new Set(); // states switched off
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
function req() { if (!raf) raf = requestAnimationFrame(draw); }
function target(nd) {
  const top = 56, bot = 44;
  const kk = Math.min(vw * 0.92 / nd.aw, (vh - top - bot) * 0.92 / nd.ah);
  return { k: kk, tx: vw / 2 - (nd.ax + nd.aw / 2) * kk, ty: top + (vh - top - bot) / 2 - (nd.ay + nd.ah / 2) * kk };
}
function fit(nd, instant) {
  const m = target(nd);
  if (instant) { anim = null; k = m.k; tx = m.tx; ty = m.ty; req(); return; }
  const ax = vw / 2, ay = vh / 2, k0 = k, k1 = m.k;
  const c0 = [(ax - tx) / k, (ay - ty) / k], c1 = [(ax - m.tx) / m.k, (ay - m.ty) / m.k];
  const dur = Math.min(1300, 420 + 140 * Math.abs(Math.log2(k1 / k0))), s0 = performance.now();
  anim = () => {
    const s = Math.min(1, (performance.now() - s0) / dur);
    const e = s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
    k = k0 * Math.pow(k1 / k0, e);
    const u = Math.abs(k1 / k0 - 1) < 1e-6 ? e : (1 - k0 / k) / (1 - k0 / k1); // the target travels in a straight line on screen
    tx = ax - lerp(c0[0], c1[0], u) * k; ty = ay - lerp(c0[1], c1[1], u) * k;
    if (s >= 1) anim = null;
  };
  req();
}
const jump = nd => fit(nd.children ? nd : nd.parent);
function zoomAt(x, y, f) {
  anim = null;
  const nk = clamp(k * f, kfit * 0.4, kfit * 1e6); f = nk / k;
  tx = x - (x - tx) * f; ty = y - (y - ty) * f; k = nk; req();
}
function resize() {
  const first = !vw;
  dpr = window.devicePixelRatio || 1; vw = innerWidth; vh = innerHeight;
  cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
  kfit = target(root).k;
  if (first) fit(root, true); else req();
}
addEventListener('resize', resize);

// ---------- text metrics, once ----------
const twCache = {};
function tw(s, wgt) { // width at 1px; measured small, where system fonts run wider
  const key = (wgt || 600) + s;
  if (!(key in twCache)) { ctx.font = `${wgt || 600} 12px ${FONT}`; twCache[key] = ctx.measureText(s).width / 12; }
  return twCache[key];
}
function wrap(text, W) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (line && tw(next, 400) > W) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}
for (const nd of all) {
  if (nd.ref) nd.sub = '↗ ' + byId[nd.ref].title;
  nd.wL = nd.lines.map(l => tw(l)); nd.wT = Math.max(...nd.wL);
  if (nd.note) { // wrap to the widest measure whose block still fits the note's shape
    const aspect = nd.h / nd.w;
    for (const W of [30, 36, 42, 50, 58, 68, 80, 95, 115]) {
      nd.body = wrap(nd.note, W);
      if (0.9 / W * (1.62 * nd.lines.length + 0.5 + 1.32 * nd.body.length) <= 0.86 * aspect && 1.35 * nd.wT <= W) break;
    }
  } else if (nd.detail) nd.body = nd.detail;
  if (nd.body) nd.wB = Math.max(...nd.body.map(l => tw(l, 400)));
}

// ---------- drawing ----------
function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function shapePath(nd) {
  const x = nd.sx, y = nd.sy, w = nd.sw, h = nd.sh;
  if (nd.shape === 'diamond') { ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h / 2); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x, y + h / 2); ctx.closePath(); }
  else if (nd.shape === 'cylinder') { const ry = Math.min(h * 0.13, 12); ctx.beginPath(); ctx.ellipse(x + w / 2, y + ry, w / 2, ry, 0, Math.PI, 0); ctx.lineTo(x + w, y + h - ry); ctx.ellipse(x + w / 2, y + h - ry, w / 2, ry, 0, 0, Math.PI); ctx.closePath(); }
  else rr(x, y, w, h, clamp(w * 0.07, 2, 12));
}
function exitPoint(nd, cx, cy, dx, dy) {
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (nd.sx + nd.sw - cx) / dx); else if (dx < 0) t = Math.min(t, (nd.sx - cx) / dx);
  if (dy > 0) t = Math.min(t, (nd.sy + nd.sh - cy) / dy); else if (dy < 0) t = Math.min(t, (nd.sy - cy) / dy);
  const L = Math.hypot(dx, dy); t = Math.max(0, t) + 3 / L;
  return [cx + dx * t, cy + dy * t];
}
function clipSeg(p0, p1, x0, y0, x1, y1) {
  let t0 = 0, t1 = 1; const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  for (const [p, q] of [[-dx, p0[0] - x0], [dx, x1 - p0[0]], [-dy, p0[1] - y0], [dy, y1 - p0[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[p0[0] + dx * t0, p0[1] + dy * t0], [p0[0] + dx * t1, p0[1] + dy * t1]];
}
function reps(nd) { // the boxes standing in for nd at this zoom; weights sum to 1 across a fade
  const out = [], p = nd.path;
  for (let i = 0; i < p.length; i++) {
    const nv = i + 1 < p.length ? p[i + 1].vis : 0, w = p[i].vis - nv;
    if (w > 0.02) out.push([p[i], w]);
    if (nv <= 0) break;
  }
  return out;
}
function relName(nd, other) {
  let i = 0; while (i < nd.path.length - 1 && i < other.path.length && nd.path[i] === other.path[i]) i++;
  return nd.path.slice(i).map(x => x.title).join(' › ');
}
function arrowHead(x, y, ux, uy, s) {
  ctx.beginPath(); ctx.moveTo(x, y);
  ctx.lineTo(x - ux * s - uy * s * 0.5, y - uy * s + ux * s * 0.5); ctx.lineTo(x - ux * s + uy * s * 0.5, y - uy * s - ux * s * 0.5);
  ctx.closePath(); ctx.fill();
}

// The whole route of an arrow between two boxes, in screen space. The two boxes meet at a
// container L. Between L's two children the route is the one layout made (L.routes). On each side,
// every open container the arrow has to leave contributes a piece from the box inside it to its port.
function pieces(nd, L, group, pts) {
  for (let n = nd; n.parent !== L; n = n.parent) {
    const X = n.parent, r = X.xr && X.xr[group] && X.xr[group].r[n.id]; if (!r) return false;
    const u = X.sw / X.iw; for (const p of r) pts.push([X.sx + p[0] * u, X.sy + p[1] * u]);
  }
  return true;
}
function crossPath(a, b, gkey) {
  let n = 0; while (a.path[n] === b.path[n]) n++;
  const L = a.path[n - 1], A = a.path[n], B = b.path[n], key = A.id + '>' + B.id;
  if (!L.routes) return null;
  if (!L.rk) L.rk = {};
  if (!(key in L.rk)) L.rk[key] = L.routes[key] || L.routes[Object.keys(L.routes).find(q => q.startsWith(key + '#'))] || null;
  const route = (A === a && B === b && L.routes[gkey]) || L.rk[key]; if (!route) return null;
  const up = [], down = [];
  if (!pieces(a, L, 'o:' + B.id, up) || !pieces(b, L, 'i:' + A.id, down)) return null;
  const u = L.sw / L.iw, all = up.concat(route.p.map(p => [L.sx + p[0] * u, L.sy + p[1] * u]), down.reverse()), pts = [all[0]];
  for (let i = 1; i < all.length; i++) { const q = pts[pts.length - 1]; if (Math.abs(q[0] - all[i][0]) + Math.abs(q[1] - all[i][1]) > 0.3) pts.push(all[i]); }
  return pts.length > 1 ? { pts, L, l: route.l } : null;
}

let pills = [], focus = root, lastFocus = null;
function draw() {
  raf = 0;
  if (anim) anim();
  const T = performance.now(), T0 = 0.34, T1 = 0.46;

  // level of detail: a container opens by how much of the viewport it covers, nothing else
  for (const nd of all) {
    nd.sx = nd.ax * k + tx; nd.sy = nd.ay * k + ty; nd.sw = nd.aw * k; nd.sh = nd.ah * k;
    nd.t = nd.children ? (nd === root || nd.group ? 1 : smooth((Math.max(nd.sw / vw, nd.sh / vh) - T0) / (T1 - T0))) : 0;
    nd.vis = nd.st && off.has(nd.st) ? 0 : nd.parent ? Math.min(nd.parent.vis, nd.parent.t) : 1;
    nd.on = nd.vis > 0 && nd.sx < vw && nd.sy < vh && nd.sx + nd.sw > 0 && nd.sy + nd.sh > 0;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.fillStyle = C.bg; ctx.fillRect(0, 0, vw, vh);

  // pass 1: frames of open containers
  for (const nd of all) if (nd.on && nd.t > 0 && nd !== root) {
    const c = colOf(nd);
    ctx.globalAlpha = nd.vis;
    rr(nd.sx, nd.sy, nd.sw, nd.sh, clamp(nd.sw * 0.02, 6, 16));
    ctx.fillStyle = C.panel; ctx.fill(); ctx.fillStyle = rgba(c, C.tint * 0.4); ctx.fill();
    ctx.strokeStyle = rgba(c, 0.55); ctx.lineWidth = 1.25; if (nd.st) ctx.setLineDash([8, 5]);
    ctx.stroke(); ctx.setLineDash([]);
  }

  // pass 2: arrows, aggregated to whatever is visible
  const agg = new Map();
  E.forEach((e, i) => {
    if ((e.a.st && off.has(e.a.st)) || (e.b.st && off.has(e.b.st))) return;
    if (e.a === e.b) { if (e.a.vis > 0.6 && e.a.on) agg.set('self' + i, { a: e.a, b: e.a, alpha: e.a.vis, es: new Set([i]) }); return; }
    for (const [na, wa] of reps(e.a)) for (const [nb, wb] of reps(e.b)) {
      if (na === nb || na.path.includes(nb) || nb.path.includes(na)) continue;
      // an arrow between a reference box and the thing it refers to is not drawn while the reference
      // box is on show (the box already says it); it still counts once the box's container is closed
      const rf = na === e.a && na.ref ? [byId[na.ref], nb] : nb === e.b && nb.ref ? [byId[nb.ref], na] : null;
      if (rf && (rf[0] === rf[1] || rf[0].path.includes(rf[1]) || rf[1].path.includes(rf[0]))) continue;
      let key = na.id + '>' + nb.id;
      const P = na.parent;
      if (P && P === nb.parent && na === e.a && nb === e.b && P.routes[key + '#' + i]) key += '#' + i; // its own laid-out route
      let g = agg.get(key);
      if (!g) agg.set(key, g = { key, a: na, b: nb, alpha: 0, es: new Set() });
      g.alpha = Math.max(g.alpha, wa * wb); g.es.add(i);
    }
  });
  pills = []; let arrows = 0; const midLabels = [], stubs = [];
  for (const g of agg.values()) {
    const a = g.a, b = g.b, es = [...g.es].map(i => E[i]);
    if (!a.on && !b.on) continue;
    // a merged arrow takes the worst style among the arrows it stands for, and says so
    const st = es.reduce((w, e) => STY[e.style].rank > w.rank ? STY[e.style] : w, { rank: -1, w: 1.3 });
    const col = st.c || C.line, labels = new Set(es.map(e => e.label).filter(Boolean));
    const worst = es.filter(e => STY[e.style] === st).length;
    const text = es.length === 1 ? es[0].label : (labels.size === 1 && es.every(e => e.label) ? `${[...labels][0]} ×${es.length}` : `${es.length} links`)
      + (st.label && st.c ? (worst === es.length ? ` · all ${st.label}` : ` · ${worst} ${st.label}`) : '');
    ctx.globalAlpha = g.alpha; ctx.lineWidth = st.w; ctx.strokeStyle = ctx.fillStyle = rgba(col, 1); ctx.setLineDash(st.dash || []);
    if (a === b) { // self loop, drawn over the top edge
      const x0 = a.sx + a.sw * 0.5, x1 = a.sx + a.sw * 0.82, y = a.sy, hgt = clamp(a.sh * 0.3, 8, 22);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0, y - hgt); ctx.lineTo(x1, y - hgt); ctx.lineTo(x1, y - 2); ctx.stroke();
      ctx.setLineDash([]); arrowHead(x1, y - 1, 0, 1, 7); arrows++;
      midLabels.push({ x: (x0 + x1) / 2, y: y - hgt, len: 1e9, text, alpha: g.alpha, col: st.c });
      continue;
    }
    const cp = crossPath(a, b, g.key);
    if (cp) { // a laid-out route: right angles, round every box, through each container's port
      let pts = cp.pts, cut = null;
      if (!a.on || !b.on) { // one end is off-screen: follow the route to the edge of the view and say where it goes
        const seq = a.on ? pts : pts.slice().reverse(), out = [seq[0]];
        for (let i = 0; i < seq.length - 1; i++) {
          const c = clipSeg(seq[i], seq[i + 1], 14, 52, vw - 14, vh - 46);
          if (!c) { if (i === 0) out.length = 0; break; }
          if (i === 0) out[0] = c[0];
          out.push(c[1]);
          if (Math.abs(c[1][0] - seq[i + 1][0]) + Math.abs(c[1][1] - seq[i + 1][1]) > 0.5) { cut = c[1]; break; }
        }
        if (out.length < 2) { ctx.setLineDash([]); continue; }
        pts = a.on ? out : out.reverse();
      }
      const n = pts.length, seg = i => Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < n - 1; i++) ctx.arcTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], Math.min(6, seg(i - 1) / 2, seg(i) / 2));
      ctx.lineTo(pts[n - 1][0], pts[n - 1][1]); ctx.stroke(); ctx.setLineDash([]);
      arrows++;
      if (b.on && !st.noHead) { const L = seg(n - 2) || 1; arrowHead(pts[n - 1][0], pts[n - 1][1], (pts[n - 1][0] - pts[n - 2][0]) / L, (pts[n - 1][1] - pts[n - 2][1]) / L, clamp(Math.min(b.sw, b.sh) * 0.09, 4, 8)); }
      if (g.alpha < 0.6) continue; // mid-fade arrows stay as faint lines: no label, no stub
      if (cut) { // arrows to the same off-screen box that leave the view together share one label
        const node = a.on ? b : a;
        const near = d => q => q.out === a.on && Math.hypot(q.at[0] - cut[0], q.at[1] - cut[1]) < d, twin = stubs.find(q => q.node !== node && near(8)(q));
        if (twin) twin.more = (twin.more || 0) + 1; // a second box at the end of the very same line: one label, counted
        else if (!stubs.some(q => q.node === node && near(90)(q))) stubs.push({ at: cut, node, other: a.on ? a : b, out: a.on, alpha: g.alpha, col: st.c });
      } else if (text) {
        const pu = cp.L.sw / cp.L.iw, l = cp.l && [cp.L.sx + cp.l[0] * pu, cp.L.sy + cp.l[1] * pu];
        if (l && l[0] > 20 && l[0] < vw - 20 && l[1] > 56 && l[1] < vh - 50) { if (pu >= 0.66) midLabels.push({ x: l[0], y: l[1], len: 1e9, text, alpha: g.alpha, col: st.c, f: Math.min(10.5, 10.5 * pu) }); } // the spot the layout kept free for it
        else { let best = 0, bi = 0; for (let i = 0; i < n - 1; i++) if (seg(i) > best) { best = seg(i); bi = i; } midLabels.push({ x: (pts[bi][0] + pts[bi + 1][0]) / 2, y: (pts[bi][1] + pts[bi + 1][1]) / 2, len: best, text, alpha: g.alpha, col: st.c }); }
      }
      continue;
    }
    let ax = a.sx + a.sw / 2, ay = a.sy + a.sh / 2, bx = b.sx + b.sw / 2, by = b.sy + b.sh / 2;
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy); if (L < 1) { ctx.setLineDash([]); continue; }
    if (agg.has(b.id + '>' + a.id)) { const ox = -dy / L * 5, oy = dx / L * 5; ax += ox; ay += oy; bx += ox; by += oy; }
    const p0 = exitPoint(a, ax, ay, dx, dy), p1 = exitPoint(b, bx, by, -dx, -dy);
    if ((p1[0] - p0[0]) * dx + (p1[1] - p0[1]) * dy <= 0) { ctx.setLineDash([]); continue; }
    let q0 = p0, q1 = p1, stub = null;
    if (!a.on || !b.on) { // one end is off-screen: cut at the viewport edge and say where it goes
      const c = clipSeg(p0, p1, 14, 52, vw - 14, vh - 46); if (!c) { ctx.setLineDash([]); continue; }
      q0 = c[0]; q1 = c[1];
      stub = a.on ? { at: q1, node: b, other: a, out: true } : { at: q0, node: a, other: b, out: false };
    }
    arrows++;
    ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]); ctx.stroke(); ctx.setLineDash([]);
    if (b.on && !st.noHead) arrowHead(q1[0], q1[1], dx / L, dy / L, 7.5);
    if (g.alpha < 0.6) continue; // mid-fade arrows stay as faint lines: no label, no stub
    if (stub) stubs.push({ ...stub, alpha: g.alpha, col: st.c });
    else if (text) midLabels.push({ x: (q0[0] + q1[0]) / 2, y: (q0[1] + q1[1]) / 2, len: Math.hypot(q1[0] - q0[0], q1[1] - q0[1]), text, alpha: g.alpha, col: st.c });
  }
  ctx.setLineDash([]);
  ctx.font = `600 10.5px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const m of midLabels) {
    const f = m.f || 10.5; ctx.font = `600 ${f}px ${FONT}`;
    const w = ctx.measureText(m.text).width + f, h = f * 1.5; if (m.len < w + 12) continue;
    ctx.globalAlpha = m.alpha; ctx.fillStyle = C.bg; rr(m.x - w / 2, m.y - h / 2, w, h, 5); ctx.fill();
    ctx.fillStyle = m.col ? rgba(m.col, 1) : C.muted; ctx.fillText(m.text, m.x, m.y + 0.5);
  }
  ctx.textBaseline = 'alphabetic';

  // pass 3: closed boxes and every label
  let boxes = 0;
  for (const nd of all) {
    if (!nd.on || nd.sw < 3 || nd === root) continue;
    boxes++;
    if (nd.t < 1) {
      const c = colOf(nd);
      ctx.globalAlpha = nd.vis * (1 - nd.t); ctx.lineWidth = 1.3; ctx.strokeStyle = rgba(c, 0.9);
      if (nd.shape === 'actor') { // stick figure in the top of the box
        const cx = nd.sx + nd.sw / 2, r = Math.min(nd.sw * 0.2, nd.sh * 0.1), y0 = nd.sy + r + 1, y1 = nd.sy + nd.sh * 0.58;
        ctx.beginPath(); ctx.arc(cx, y0, r, 0, Math.PI * 2); ctx.fillStyle = rgba(c, 0.45); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, y0 + r); ctx.lineTo(cx, y1 - r * 1.6); ctx.moveTo(cx - r * 1.5, y0 + r * 2); ctx.lineTo(cx + r * 1.5, y0 + r * 2);
        ctx.moveTo(cx, y1 - r * 1.6); ctx.lineTo(cx - r * 1.3, y1); ctx.moveTo(cx, y1 - r * 1.6); ctx.lineTo(cx + r * 1.3, y1); ctx.stroke();
      } else {
        shapePath(nd);
        ctx.fillStyle = C.box; ctx.fill(); ctx.fillStyle = rgba(c, nd.note ? C.tint * 1.5 : C.tint); ctx.fill();
        if (nd.st && !nd.note) ctx.setLineDash([7, 4]); else if ((KIND[nd.kind] || {}).dashed) ctx.setLineDash([5, 4]); else if (nd.ref) ctx.setLineDash([2, 3]);
        ctx.stroke(); ctx.setLineDash([]);
        if (nd.shape === 'cylinder') { const ry = Math.min(nd.sh * 0.13, 12); ctx.beginPath(); ctx.ellipse(nd.sx + nd.sw / 2, nd.sy + ry, nd.sw / 2, ry, 0, 0, Math.PI); ctx.stroke(); }
      }
    }
    label(nd);
  }

  // pass 4: off-screen stubs, on top of everything, clickable
  ctx.font = `500 11px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  // Labels that would overlap along the top or bottom edge move apart sideways, each staying over
  // its own line; only if there is no room for that do they stack.
  const tags = stubs.map(s => {
    const text = (s.out ? '→ ' : '← ') + relName(s.node, s.other) + (s.more ? ` +${s.more}` : ''), w = ctx.measureText(text).width + 16, h = 20;
    return { s, text, w, h, x: clamp(s.at[0], 14 + w / 2, vw - 14 - w / 2), y: clamp(s.at[1], 52 + h / 2, vh - 46 - h / 2) };
  });
  for (const edge of [52 + 10, vh - 46 - 10]) {
    const row = tags.filter(t => Math.abs(t.y - edge) < 1).sort((p, q) => p.s.at[0] - q.s.at[0]);
    const reach = t => Math.max(0, t.w / 2 - 12); // how far a label may sit off its line and still cover it
    for (let pass = 0; pass < 4; pass++) for (let i = 0; i < row.length - 1; i++) {
      const a = row[i], b = row[i + 1], over = (a.w + b.w) / 2 + 6 - (b.x - a.x); if (over <= 0) continue;
      const la = Math.max(0, Math.min(a.x - (a.s.at[0] - reach(a)), a.x - (14 + a.w / 2))), rb = Math.max(0, Math.min(b.s.at[0] + reach(b) - b.x, vw - 14 - b.w / 2 - b.x));
      const da = Math.min(la, Math.max(over / 2, over - rb)), db = Math.min(rb, over - da);
      a.x -= da; b.x += db;
    }
  }
  for (const t of tags) {
    const { s, text, w, h } = t; let { x, y } = t;
    const dir = y > vh / 2 ? -1 : 1;
    for (let i = 0; i < 10 && pills.some(p => Math.abs(p.x - x) < (p.w + w) / 2 + 4 && Math.abs(p.y - y) < h + 2); i++) y += dir * (h + 3);
    pills.push({ x, y, w, h, node: s.node });
    ctx.globalAlpha = s.alpha;
    rr(x - w / 2, y - h / 2, w, h, 10); ctx.fillStyle = C.pill; ctx.fill();
    ctx.strokeStyle = rgba(s.col || C.line, 0.9); ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = C.ink; ctx.fillText(text, x, y + 0.5);
  }
  ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;

  // where am I: the deepest open container under the middle of the screen
  focus = root;
  for (let go = true; go;) {
    go = false;
    for (const c of focus.children || []) if (c.children && c.vis > 0 && c.t >= 0.5 && c.sx < vw / 2 && c.sy < vh / 2 && c.sx + c.sw > vw / 2 && c.sy + c.sh > vh / 2) { focus = c; go = true; break; }
  }
  if (focus !== lastFocus) { lastFocus = focus; crumbs(); }
  const z = k / kfit;
  $('stats').textContent = `${boxes} of ${all.length - 1} boxes · ${arrows} of ${E.length} arrows · ${(performance.now() - T).toFixed(1)} ms · ${z < 10 ? z.toFixed(1) : Math.round(z)}×`;
  if (anim) req();
}

function label(nd) {
  const lip = nd.shape === 'cylinder' ? Math.min(nd.sh * 0.13, 12) * 2 : 0, by = nd.sy + lip, bh = nd.sh - lip;
  const t = nd.t, cx = nd.sx + nd.sw / 2, L = nd.lines, nL = L.length, actor = nd.shape === 'actor', hint = !!nd.children;
  // compact: the title, centred; more appears only when there is room to read it
  const rows = nL * 1.2 + (nd.sub ? 0.85 : 0) + (hint ? 1 : 0);
  const fc = Math.min(22, nd.sw * (nd.shape === 'diamond' ? 0.6 : actor ? 1.1 : 0.86) / nd.wT, bh * (nd.shape === 'diamond' ? 0.5 : actor ? 0.36 : 0.7) / rows);
  const top = actor ? nd.sy + nd.sh * 0.62 : by + bh / 2 - rows * fc / 2;
  let m = 0, fd = 0, ft = fc, dtop = 0;
  if (nd.body && t < 1) { // detailed: title plus body lines
    const nB = nd.body.length, blk = 1.62 * nL + 0.5 + 1.32 * nB;
    fd = Math.min(13.5, bh * (hint ? 0.72 : 0.86) / blk, nd.sw * 0.9 / nd.wB, nd.sw * 0.9 / (1.35 * nd.wT));
    m = smooth((fd - 6.2) / 1.6); ft = 1.35 * fd; dtop = by + (bh * (hint ? 0.86 : 1) - fd * blk) / 2;
  }
  const f = lerp(fc, ft, m), fh = clamp(nd.sw * 0.018, 12, 15), hp = clamp(nd.sw * 0.02, 10, 18), left = nd.sx + nd.sw * 0.05;
  const lx = i => nd.note ? lerp(cx - nd.wL[i] * f / 2, left, m) : cx - nd.wL[i] * f / 2;
  const ly = i => lerp(top + (i * 1.2 + 0.95) * fc, dtop + (i * 1.2 + 0.95) * ft, m);
  if (t > 0.5) { // an open container's title sits on a plate, so an arrow coming in over the top edge never strikes through it
    ctx.font = `600 ${fh}px ${FONT}`; let hw = ctx.measureText(nd.title).width;
    if (nd.sub) { ctx.font = `400 ${fh * 0.9}px ${FONT}`; hw += 9 + ctx.measureText(nd.sub).width; }
    ctx.globalAlpha = nd.vis * (t - 0.5) * 2; rr(nd.sx + hp - 6, nd.sy + hp - 3, hw + 12, fh + 8, 5);
    ctx.fillStyle = C.panel; ctx.fill(); ctx.fillStyle = rgba(colOf(nd), C.tint * 0.4); ctx.fill();
  }
  ctx.fillStyle = C.ink; ctx.textAlign = 'left';
  if (nL === 1) { // one line: it slides from the middle of the box to the header as the box opens
    const ff = lerp(f, fh, t);
    if (ff >= 5.5) { ctx.globalAlpha = nd.vis; ctx.font = `600 ${ff}px ${FONT}`; ctx.fillText(L[0], lerp(lx(0), nd.sx + hp, t), lerp(ly(0), nd.sy + hp + fh * 0.8, t)); }
  } else {
    if (t < 1 && f >= 5.5) { ctx.globalAlpha = nd.vis * (1 - t); ctx.font = `600 ${f}px ${FONT}`; for (let i = 0; i < nL; i++) ctx.fillText(L[i], lx(i), ly(i)); }
    if (t > 0) { ctx.globalAlpha = nd.vis * t; ctx.font = `600 ${fh}px ${FONT}`; ctx.fillText(nd.title, nd.sx + hp, nd.sy + hp + fh * 0.8); }
  }
  if (t > 0.5 && nd.sub) {
    ctx.font = `600 ${fh}px ${FONT}`; const hw = ctx.measureText(nd.title).width;
    ctx.globalAlpha = nd.vis * (t - 0.5) * 2; ctx.fillStyle = C.muted; ctx.font = `400 ${fh * 0.9}px ${FONT}`; ctx.fillText(nd.sub, nd.sx + hp + hw + 9, nd.sy + hp + fh * 0.8);
  }
  if (t >= 1) return;
  const fs = nd.sub ? Math.min(fc * 0.62, nd.sw * 0.88 / tw(nd.sub, 400)) : 0, mb = clamp(2 * m - 1, 0, 1), ms = clamp(2 * m, 0, 1);
  if (nd.sub && fs >= 6 && ms < 1) { ctx.globalAlpha = nd.vis * (1 - t) * (1 - ms); ctx.fillStyle = nd.ref ? rgba(colOf(nd), 1) : C.muted; ctx.font = `400 ${fs}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText(nd.sub, cx, top + nL * 1.2 * fc + fs * 1.05); }
  if (mb > 0) {
    ctx.globalAlpha = nd.vis * (1 - t) * mb; ctx.fillStyle = nd.note ? C.ink : C.muted; ctx.font = `400 ${fd}px ${FONT}`; ctx.textAlign = nd.note ? 'left' : 'center';
    const y0 = dtop + nL * 1.62 * fd + 0.5 * fd;
    nd.body.forEach((line, j) => ctx.fillText(line, nd.note ? left : cx, y0 + (j + 0.9) * 1.32 * fd));
  }
  const fi = Math.min(12, nd.sh * 0.1);
  if (hint && fi >= 6.5) { ctx.globalAlpha = nd.vis * (1 - t); ctx.font = `600 ${fi}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillStyle = rgba(colOf(nd), 1); ctx.fillText(`${nd.children.length} inside ⊕`, cx, nd.sy + nd.sh - fi * 0.75); }
}

// ---------- chrome around the canvas ----------
function crumbs() {
  const el = $('crumbs'); el.textContent = '';
  const skip = Math.max(0, focus.path.length - 3); // deep paths keep the last three levels
  focus.path.forEach((nd, i) => {
    if (i < skip) return;
    if (i) { const s = document.createElement('span'); s.textContent = i === skip ? '… ›' : '›'; el.appendChild(s); }
    const b = document.createElement('button'); b.textContent = nd.title; b.onclick = () => fit(nd); el.appendChild(b);
  });
}
const legend = $('legend');
for (const s of Object.values(STY)) if (s.label && s.c) {
  const span = document.createElement('span'), i = document.createElement('i');
  i.style.borderColor = rgba(s.c, 1); i.style.borderTopStyle = !s.dash ? 'solid' : s.dash[0] < 4 ? 'dotted' : 'dashed';
  span.append(i, s.label); legend.appendChild(span);
}
const toggles = {};
function setState(name, shown) {
  if (!STATES[name]) return;
  if (shown) off.delete(name); else off.add(name);
  toggles[name].textContent = `${STATES[name].label}: ${shown ? 'shown' : 'hidden'}`; req();
}
for (const [name, s] of Object.entries(STATES)) {
  const b = toggles[name] = document.createElement('button');
  b.className = 'toggle'; b.style.borderColor = rgba(s.c, 1); b.onclick = () => setState(name, off.has(name));
  legend.appendChild(b); setState(name, true);
}
if (!legend.children.length) legend.remove();

// ---------- input ----------
function hit(x, y) {
  let cur = root;
  for (;;) {
    const c = (cur.children || []).find(c => c.vis > 0.5 && x >= c.sx && y >= c.sy && x <= c.sx + c.sw && y <= c.sy + c.sh);
    if (!c) return cur;
    if (c.t < 0.5) return c;
    cur = c;
  }
}
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const d = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  zoomAt(e.clientX, e.clientY, Math.exp(-d * (e.ctrlKey ? 0.012 : 0.0022)));
}, { passive: false });
const ptrs = new Map(); let moved = 0;
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (ptrs.size === 1) moved = 0;
  anim = null; cv.classList.add('drag');
});
cv.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  const nx = e.clientX, ny = e.clientY;
  if (ptrs.size === 1) { tx += nx - p[0]; ty += ny - p[1]; moved += Math.abs(nx - p[0]) + Math.abs(ny - p[1]); req(); }
  else if (ptrs.size === 2) {
    const o = [...ptrs.entries()].find(([id]) => id !== e.pointerId)[1];
    const d0 = Math.hypot(p[0] - o[0], p[1] - o[1]), d1 = Math.hypot(nx - o[0], ny - o[1]);
    tx += (nx - p[0]) / 2; ty += (ny - p[1]) / 2; moved += 10;
    if (d0 > 0) zoomAt((nx + o[0]) / 2, (ny + o[1]) / 2, d1 / d0);
  }
  p[0] = nx; p[1] = ny;
});
const up = e => {
  if (!ptrs.delete(e.pointerId)) return;
  if (!ptrs.size) cv.classList.remove('drag');
  if (e.type === 'pointerup' && moved < 5) {
    const p = pills.find(p => Math.abs(e.clientX - p.x) <= p.w / 2 && Math.abs(e.clientY - p.y) <= p.h / 2);
    if (p) return jump(p.node);
    const nd = hit(e.clientX, e.clientY);
    if (nd.ref && !nd.children) jump(byId[nd.ref]); // a reference: one click goes to the real thing
  }
};
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
cv.addEventListener('dblclick', e => { const nd = hit(e.clientX, e.clientY); if (!(nd.ref && !nd.children)) jump(nd); });
addEventListener('keydown', e => {
  if (e.key === 'Escape') fit(focus.parent || root);
  else if (e.key === '0' || e.key === 'f') fit(root);
  else if (e.key === '+' || e.key === '=') zoomAt(vw / 2, vh / 2, 1.35);
  else if (e.key === '-') zoomAt(vw / 2, vh / 2, 1 / 1.35);
});

// ---------- start: #at=<id> opens on that box, #hide=<state,state> starts with states off ----------
resize();
function fromHash(instant) {
  const q = new URLSearchParams(location.hash.slice(1));
  for (const s of (q.get('hide') || '').split(',')) if (s) setState(s, false);
  const at = byId[q.get('at')]; if (at) fit(at.children ? at : at.parent, instant);
}
fromHash(true); addEventListener('hashchange', () => fromHash(false));
window.strata = { fit, byId, zoomAt, setState, state: () => ({ zoom: k / kfit, focus: focus.id, pills: pills.map(p => p.node.id) }) };
})();
