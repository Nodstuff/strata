// Turns a laid-out model into one self-contained HTML page: the data, the viewer, nothing else.
import { readFile } from 'node:fs/promises';
import { walk } from './model.js';

const KEEP = ['id', 'label', 'sub', 'detail', 'note', 'kind', 'shape', 'state', 'until', 'ref', 'group', 'x', 'y', 'w', 'h', 'iw', 'ih', 'routes', 'xr'];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function payload(model) {
  const strip = nd => {
    const out = {};
    for (const k of KEEP) if (nd[k] != null) out[k] = nd[k];
    if (nd.children) out.children = nd.children.map(strip);
    return out;
  };
  return { title: model.title, kinds: model.kinds, styles: model.styles, states: model.states, root: strip(model.root), edges: model.edges };
}

export async function html(model) {
  const viewer = await readFile(new URL('./viewer.js', import.meta.url), 'utf8');
  const data = JSON.stringify(payload(model)).replace(/</g, '\\u003c'); // no "</script>" inside the page
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.title)}</title>
<style>
:root{--bg:#f5f4f1;--ink:#1c1c1f;--muted:#6a6a72;--chip:#ffffffd9;--chipb:#00000017}
@media (prefers-color-scheme:dark){:root{--bg:#121215;--ink:#ececf1;--muted:#9c9ca8;--chip:#1e1e24d9;--chipb:#ffffff22}}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--ink);font:13px/1.4 system-ui,-apple-system,sans-serif}
canvas{position:fixed;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}
canvas.drag{cursor:grabbing}
.hud{position:fixed;background:var(--chip);border:1px solid var(--chipb);border-radius:9px;padding:6px 10px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);user-select:none;-webkit-user-select:none}
#crumbs{top:12px;left:12px;display:flex;gap:2px;align-items:center;max-width:calc(100vw - 48px);overflow:hidden;white-space:nowrap}
#crumbs button,.toggle,.sty{all:unset;cursor:pointer;padding:2px 6px;border-radius:6px}
#crumbs button:hover,.toggle:hover,.sty:hover{background:var(--chipb)}
.sty{transition:opacity .2s}.sty.sel{color:var(--ink);background:var(--chipb);font-weight:600;box-shadow:0 0 0 1.5px var(--ink)}.sty.dim{opacity:.45}
.all{all:unset;cursor:pointer;padding:2px 9px;border-radius:999px;font-weight:700;color:#1c1c1f;background:#f2c94c}.all[hidden]{display:none}
.sty:focus-visible{outline:2px solid var(--muted);outline-offset:2px}
.step{all:unset;cursor:pointer;padding:0 7px;border-radius:6px;font-size:16px;line-height:1;color:var(--ink)}.step:hover{background:var(--chipb)}
.hud[hidden]{display:none}
#info{top:58px;right:12px;width:300px;max-height:calc(100vh - 130px);overflow:auto;padding:10px 12px;font-size:12px;user-select:text;-webkit-user-select:text}
#info .ih{display:flex;gap:8px;align-items:baseline;margin-bottom:6px}#info .ih b{font-size:14px}#info .ih span{color:var(--muted);flex:1}
#info p{margin:2px 0;color:var(--muted)}
#info h4{margin:12px 0 4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
#info button{all:unset;cursor:pointer;border-radius:6px}#info button:hover{background:var(--chipb)}
#info .ix{padding:0 6px;color:var(--muted);font-size:16px}
#info .io{display:inline-block;margin-top:8px;padding:3px 9px;border:1px solid var(--chipb);font-weight:600}
#info .ir{display:grid;grid-template-columns:10px 1fr;column-gap:8px;padding:4px 6px;width:calc(100% - 12px)}
#info .ir i{width:8px;height:8px;border-radius:50%;margin-top:5px;grid-row:1/3}
#info .ir .in{font-weight:600}#info .ir .il{color:var(--muted);grid-column:2}
#find{top:58px;left:12px;width:320px;padding:8px}
#find input{all:unset;width:100%;box-sizing:border-box;padding:4px 6px;font-size:14px}
#find button{all:unset;cursor:pointer;display:block;padding:4px 6px;border-radius:6px;width:calc(100% - 12px)}
#find button:hover,#find button:first-child{background:var(--chipb)}
#find button span{display:block;color:var(--muted);font-size:11px}
@media (max-width:700px){#info{left:12px;right:12px;width:auto;top:auto;bottom:12px;max-height:42vh}#find{width:auto;right:12px}}
#crumbs button:last-of-type{font-weight:600}
#crumbs span{color:var(--muted)}
#legend{top:12px;right:12px;display:flex;gap:6px;align-items:center;color:var(--muted);font-size:12px}
#legend i{display:inline-block;width:22px;height:0;border-top:2px solid;vertical-align:middle;margin-right:5px}
.toggle{color:var(--ink);border:1px solid;border-radius:999px;padding:2px 10px 2px 8px;font-weight:600;display:inline-flex;align-items:center;gap:6px;transition:opacity .2s,background .2s}
.toggle b{width:8px;height:8px;border-radius:50%;border:1.5px solid var(--tc);background:var(--tc);transition:background .2s}
.toggle.off{opacity:.6;border-style:dashed;font-weight:500}
.toggle.off b{background:transparent}
.toggle:focus-visible{outline:2px solid var(--tc);outline-offset:2px}
#hint{bottom:12px;left:12px;color:var(--muted)}
#stats{bottom:12px;right:12px;color:var(--muted);font-variant-numeric:tabular-nums}
@media (max-width:1100px){#legend .sty{display:none}}
@media (max-width:900px){#hint{display:none}}
</style>
</head>
<body>
<canvas id="cv"></canvas>
<div id="crumbs" class="hud"></div>
<div id="legend" class="hud"></div>
<div id="hint" class="hud">Scroll or pinch to zoom · drag to pan · click a box for its links · double-click to dive in · / finds a box · Esc goes up</div>
<div id="stats" class="hud"></div>
<div id="info" class="hud" hidden></div>
<div id="find" class="hud" hidden><input placeholder="Find a box…" aria-label="Find a box"><div></div></div>
<script>window.STRATA=${data}</script>
<script>
${viewer}
</script>
</body>
</html>
`;
}

// Which titles will be too small to read when their container fills an ordinary window. The
// viewer shrinks text to fit its box, so a crowded level stays correct but becomes illegible.
export function legibility(model, vw = 1440, vh = 800) {
  const out = [];
  walk(model.root, (nd, parent) => {
    if (!nd.children) return;
    // the same fit the viewer makes: a gutter on each side of a container, a thin margin round the top level
    const top = !parent, gx = top ? vw * 0.04 : Math.max(70, Math.min(170, vw * 0.1)), gy = top ? (vh - 100) * 0.04 : 34;
    const k = Math.min((vw - 2 * gx) / nd.iw, (vh - 100 - 2 * gy) / nd.ih), small = [];
    for (const c of nd.children) {
      const lines = c.label.split('\n'), rows = lines.length * 1.2 + (c.sub ? 0.85 : 0) + (c.children ? 1 : 0);
      const px = Math.min(22, c.w * k * (c.shape === 'diamond' ? 0.6 : 0.86) / (Math.max(...lines.map(l => l.length)) * 0.6), c.h * k * (c.shape === 'diamond' ? 0.5 : 0.7) / rows);
      if (px < 7.5) small.push(c.id);
    }
    if (small.length) out.push(`when ${nd.id === '__root' ? 'the top level' : '"' + nd.id + '"'} fills a ${vw}x${vh} window, ${small.length} of its ${nd.children.length} titles are too small to read (${small.join(', ')}): use shorter labels or fewer boxes at this level`);
  });
  return out;
}

// Levels that will look busy: many boxes, or many separate arrows between them. Says which boxes
// carry the most arrows, since grouping those (or the things they all talk to) is the usual cure.
export function busy(model, maxBoxes = 16, maxArrows = 30) {
  const path = new Map();
  walk(model.root, (nd, parent) => path.set(nd.id, parent ? [...path.get(parent.id), nd] : [nd]));
  const per = new Map(); // container -> { pairs: Set of "childA>childB", deg: Map child -> count }
  for (const e of model.edges) {
    const pa = path.get(e.a), pb = path.get(e.b); let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    if (i >= pa.length || i >= pb.length) continue; // one end is inside the other
    const at = pa[i - 1], a = pa[i], b = pb[i];
    let s = per.get(at); if (!s) per.set(at, s = { pairs: new Set(), deg: new Map() });
    const key = a.id + '>' + b.id; if (s.pairs.has(key)) continue;
    s.pairs.add(key); for (const x of [a, b]) s.deg.set(x, (s.deg.get(x) || 0) + 1);
  }
  const out = [];
  walk(model.root, nd => {
    if (!nd.children) return;
    const s = per.get(nd), arrows = s ? s.pairs.size : 0, boxes = nd.children.filter(c => !c.note).length;
    if (boxes <= maxBoxes && arrows <= maxArrows) return;
    const hubs = s ? [...s.deg].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([x, n]) => `${x.id} (${n})`).join(', ') : '';
    out.push(`${nd.id === '__root' ? 'the top level' : '"' + nd.id + '"'} is busy: ${boxes} boxes and ${arrows} arrows on one level${hubs ? `; most arrows: ${hubs}` : ''}. Put boxes that talk to the same things inside one box, or move detail a level down`);
  });
  return out;
}

export function outline(model) { // a text picture of the tree, for people and for Claude to check its own work
  const lines = [];
  let boxes = 0, depth = 0;
  walk(model.root, (nd, parent, d) => {
    if (!parent) return;
    boxes++; depth = Math.max(depth, d);
    const bits = [nd.children ? `${nd.children.length} inside${nd.group ? ', group' : ''}` : null, nd.shape, nd.note ? 'note' : null, nd.state, nd.ref ? `→ ${nd.ref}` : null].filter(Boolean);
    lines.push(`${'  '.repeat(d - 1)}${nd.id}  "${nd.label.replace(/\n/g, ' ')}"${bits.length ? '  (' + bits.join(', ') + ')' : ''}`);
  });
  return { text: lines.join('\n'), boxes, depth, arrows: model.edges.length };
}
