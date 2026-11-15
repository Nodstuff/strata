// EXPERIMENTAL. Reads a Go module and writes a strata file of its packages: a box per package,
// nested the way the directories are, and an arrow for every import between two of the module's
// own packages. Nothing here guesses: it is what `go list` reports. Standard-library and
// third-party imports are counted on each box, not drawn.
import { execFile } from 'node:child_process';

const run = (cmd, args, cwd) => new Promise((ok, fail) => execFile(cmd, args, { cwd, maxBuffer: 256 << 20, env: { ...process.env, GOPROXY: 'off' } }, // GOPROXY off: never the network, only what is already on disk
  (err, out, errOut) => (err && !out ? fail(new Error(errOut || err.message)) : ok(out))));

// `go list -json` prints one JSON object after another with nothing between them
function objects(text) {
  const out = []; let depth = 0, start = 0, str = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') { if (!depth) start = i; depth++; }
    else if (c === '}' && !--depth) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out;
}

const q = s => JSON.stringify(String(s)); // a JSON string is a valid YAML double-quoted string
const idOf = rel => 'p_' + (rel || 'root').replace(/[^A-Za-z0-9]+/g, '_');

export async function genGo(dir, { only = null } = {}) {
  let listed;
  try { listed = objects(await run('go', ['list', '-e', '-json=ImportPath,Name,Imports,GoFiles,Doc,Module', './...'], dir)); }
  catch (e) { throw new Error(`go list failed in ${dir}: ${e.message.trim().split('\n')[0]}`); }
  if (!listed.length) throw new Error(`no Go packages under ${dir}`);
  const mod = (listed.find(p => p.Module) || {}).Module?.Path || '';
  const relOf = ip => (ip === mod ? '' : ip.startsWith(mod + '/') ? ip.slice(mod.length + 1) : null);
  let pkgs = listed.map(p => ({ ...p, rel: relOf(p.ImportPath) })).filter(p => p.rel != null && (p.GoFiles || []).length);
  if (only) pkgs = pkgs.filter(p => p.rel === only || p.rel.startsWith(only.replace(/\/$/, '') + '/'));
  if (!pkgs.length) throw new Error(only ? `no packages under "${only}" in ${mod}` : `no packages with Go files in ${mod}`);
  const mine = new Map(pkgs.map(p => [p.ImportPath, p]));
  const usedBy = new Map();
  for (const p of pkgs) for (const i of p.Imports || []) if (mine.has(i)) usedBy.set(i, (usedBy.get(i) || 0) + 1);

  // the directory tree: a directory that is a package and also holds packages becomes a box with the package inside it
  const base = only ? only.replace(/\/$/, '').split('/') : [];
  const tree = { name: '', kids: new Map(), pkg: null, rel: base.join('/') };
  for (const p of pkgs) {
    let at = tree; const parts = p.rel ? p.rel.split('/').slice(base.length) : [];
    parts.forEach((name, i) => { if (!at.kids.has(name)) at.kids.set(name, { name, kids: new Map(), pkg: null, rel: [...base, ...parts.slice(0, i + 1)].join('/') }); at = at.kids.get(name); });
    at.pkg = p;
  }
  // A directory with many packages is unreadable as one level. Two mechanical groupings, in order:
  // packages whose names share a start (cnqtrack, cnqclaim, cnqphase) go in one box; what is left, if
  // still many, is split by where it sits in the import graph of the module.
  const under = n => [...(n.pkg ? [n.pkg] : []), ...[...n.kids.values()].flatMap(under)];
  const MANY = 14;
  const regroup = (n, again) => {
    if (!again) for (const k of [...n.kids.values()]) regroup(k);
    if (n.kids.size <= MANY) return;
    const box = (name, label, kids, why) => { const g = { name: label, kids: new Map(kids.map(k => [k.name, k])), pkg: null, rel: `${n.rel}/~${name}`, made: true, why }; for (const k of kids) n.kids.delete(k.name); n.kids.set('~' + name, g); return g; };
    const names = [...n.kids.keys()], cands = new Map();
    for (const nm of names) for (let l = 3; l <= Math.min(8, nm.length); l++) { const pre = nm.slice(0, l); cands.set(pre, (cands.get(pre) || 0) + 1); }
    const taken = new Set();
    for (const [pre] of [...cands].filter(c => c[1] >= 3).sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)) {
      const mine2 = names.filter(nm => nm.startsWith(pre) && !taken.has(nm));
      if (mine2.length < 3) continue;
      // the longest start all of them share, so the box is named cnq, not cn
      let full = mine2[0]; for (const nm of mine2) while (!nm.startsWith(full)) full = full.slice(0, -1);
      for (const nm of mine2) taken.add(nm);
      box(full, full + '…', mine2.map(nm => n.kids.get(nm)));
    }
    const loose = [...n.kids.values()].filter(k => !k.made);
    if (n.kids.size <= MANY || loose.length < 6) return;
    // by place in this directory's import graph; a Middle that is still large is split the same way again
    const inside = new Set(under(n).map(p => p.ImportPath)), tier = { base: [], mid: [], top: [] };
    for (const k of loose) {
      const own = new Set(under(k).map(p => p.ImportPath));
      const uses = under(k).some(p => (p.Imports || []).some(i => inside.has(i) && !own.has(i)));
      const used = under(n).some(p => !own.has(p.ImportPath) && (p.Imports || []).some(i => own.has(i)));
      tier[!uses ? 'base' : !used ? 'top' : 'mid'].push(k);
    }
    if (tier.mid.length === loose.length) return; // nothing to tell apart
    if (tier.base.length >= 2) box('base', 'Foundations', tier.base, 'import nothing else here');
    if (tier.top.length >= 2) box('top', 'Tops', tier.top, 'nothing else here imports them');
    if (tier.mid.length >= 2 && n.kids.size > MANY / 2) regroup(box('mid', 'Middle', tier.mid, 'import and are imported'), true);
  };
  regroup(tree);
  const idFor = new Map(); // import path -> the id of the box that stands for the package
  const lines = [];
  const leaf = (p, label, ind) => {
    const own = (p.Imports || []).filter(i => mine.has(i)).length, other = (p.Imports || []).length - own;
    const doc = (p.Doc || '').replace(/\s+/g, ' ').trim();
    lines.push(`${ind}- id: ${idOf(p.rel)}`, `${ind}  label: ${q(label)}`);
    if (p.Name !== label.split('/').pop()) lines.push(`${ind}  sub: ${q('package ' + p.Name)}`);
    if (p.Name === 'main') lines.push(`${ind}  kind: service`);
    lines.push(`${ind}  detail:`);
    if (doc) lines.push(`${ind}    - ${q(doc.length > 64 ? doc.slice(0, 61) + '...' : doc)}`);
    lines.push(`${ind}    - ${q(`${p.GoFiles.length} file${p.GoFiles.length === 1 ? '' : 's'} · used by ${usedBy.get(p.ImportPath) || 0}`)}`);
    lines.push(`${ind}    - ${q(`imports ${own} here, ${other} outside`)}`);
    idFor.set(p.ImportPath, idOf(p.rel));
  };
  const emit = (n, ind) => {
    // a chain of directories with nothing else in them is one box: internal/x/y, not three nested boxes
    let label = n.name;
    while (!n.pkg && !n.made && n.kids.size === 1 && ![...n.kids.values()][0].made) { n = [...n.kids.values()][0]; label += '/' + n.name; }
    if (!n.kids.size) return leaf(n.pkg, label, ind);
    lines.push(`${ind}- id: ${idOf(n.rel)}_dir`, `${ind}  label: ${q(label)}`, `${ind}  sub: ${q(`${count(n)} packages${n.why ? ' · ' + n.why : ''}`)}`, `${ind}  nodes:`);
    if (n.pkg) leaf(n.pkg, n.name, ind + '    ');
    for (const k of [...n.kids.values()].sort((a, b) => a.name.localeCompare(b.name))) emit(k, ind + '    ');
  };
  const count = n => (n.pkg ? 1 : 0) + [...n.kids.values()].reduce((s, k) => s + count(k), 0);
  if (tree.pkg) leaf(tree.pkg, base.length ? base[base.length - 1] : mod.split('/').pop(), '  ');
  for (const k of [...tree.kids.values()].sort((a, b) => a.name.localeCompare(b.name))) emit(k, '  ');

  const edges = [];
  for (const p of pkgs) for (const i of p.Imports || []) if (mine.has(i) && i !== p.ImportPath) edges.push(`  - [ ${idFor.get(p.ImportPath)}, ${idFor.get(i)} ]`);
  const head = [
    `# GENERATED by "strata gen go" (experimental) from ${mod}${only ? ' (' + only + ')' : ''}: ${pkgs.length} packages, ${edges.length} imports.`,
    '# An arrow is an import: from the package that imports to the one it imports. Edit freely, or generate again.',
    `title: ${q(mod.split('/').pop() + (only ? ' / ' + only : ''))}`,
    `subtitle: ${q('Go packages and their imports')}`,
    'nodes:',
  ];
  return { yaml: [...head, ...lines, 'edges:', ...edges, ''].join('\n'), packages: pkgs.length, imports: edges.length, module: mod };
}
