// Turns a laid-out model into one self-contained HTML page: the data, the viewer, nothing else.
import { readFile } from 'node:fs/promises';
import { walk } from './model.js';

const KEEP = ['id', 'label', 'sub', 'detail', 'note', 'kind', 'shape', 'state', 'ref', 'group', 'x', 'y', 'w', 'h', 'iw', 'ih', 'routes', 'xr'];
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
#crumbs button,.toggle{all:unset;cursor:pointer;padding:2px 6px;border-radius:6px}
#crumbs button:hover,.toggle:hover{background:var(--chipb)}
#crumbs button:last-of-type{font-weight:600}
#crumbs span{color:var(--muted)}
#legend{top:12px;right:12px;display:flex;gap:12px;align-items:center;color:var(--muted);font-size:12px}
#legend i{display:inline-block;width:22px;height:0;border-top:2px solid;vertical-align:middle;margin-right:5px}
.toggle{color:var(--ink);border:1px dashed;font-weight:600}
#hint{bottom:12px;left:12px;color:var(--muted)}
#stats{bottom:12px;right:12px;color:var(--muted);font-variant-numeric:tabular-nums}
@media (max-width:1100px){#legend span{display:none}}
@media (max-width:900px){#hint{display:none}}
</style>
</head>
<body>
<canvas id="cv"></canvas>
<div id="crumbs" class="hud"></div>
<div id="legend" class="hud"></div>
<div id="hint" class="hud">Scroll or pinch to zoom · drag to pan · double-click a box to dive in · Esc goes up · 0 fits all</div>
<div id="stats" class="hud"></div>
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
  walk(model.root, nd => {
    if (!nd.children) return;
    const k = Math.min(vw * 0.92 / nd.iw, (vh - 100) * 0.92 / nd.ih), small = [];
    for (const c of nd.children) {
      const lines = c.label.split('\n'), rows = lines.length * 1.2 + (c.sub ? 0.85 : 0) + (c.children ? 1 : 0);
      const px = Math.min(22, c.w * k * (c.shape === 'diamond' ? 0.6 : 0.86) / (Math.max(...lines.map(l => l.length)) * 0.6), c.h * k * (c.shape === 'diamond' ? 0.5 : 0.7) / rows);
      if (px < 7.5) small.push(c.id);
    }
    if (small.length) out.push(`when ${nd.id === '__root' ? 'the top level' : '"' + nd.id + '"'} fills a ${vw}x${vh} window, ${small.length} of its ${nd.children.length} titles are too small to read (${small.join(', ')}): use shorter labels or fewer boxes at this level`);
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
