#!/usr/bin/env node
// strata check <file.yaml>                      validate, lay out, print the tree
// strata build <file.yaml> [-o out.html]        one self-contained HTML page
// strata shot  <file.yaml> [--at id] [--hide tag] [--show tag] [--size 1600x1000] [-o out.png]   a picture of one level
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from '../src/model.js';
import { layout } from '../src/layout.js';
import { html, outline, legibility, busy, quality } from '../src/build.js';

const [cmd, file, ...rest] = process.argv.slice(2);
// strata facts go <dir> [--only internal/x] [-o facts.md]   what a Go module's code says about its architecture, as text with file and line
if (cmd === 'facts') {
  const [lang, dir, ...more] = [file, ...rest], o = n => { const i = more.indexOf(n); return i >= 0 ? more[i + 1] : null; };
  if (lang !== 'go' || !dir) { console.error('usage: strata facts go <dir> [--only <path inside the module>] [-o facts.md]'); process.exit(2); }
  const { genGo } = await import('../src/gen-go.js');
  try { const g = await genGo(resolve(dir), { only: o('--only') }); if (o('-o')) { await writeFile(o('-o'), g.report); console.log(`ok · ${resolve(o('-o'))}`); } else process.stdout.write(g.report); }
  catch (e) { console.error(e.message); process.exit(1); }
  process.exit(0);
}
// strata gen go <dir> --experimental [--only internal/x] [-o out.yaml]   EXPERIMENTAL: a strata file of a Go module's packages and imports
if (cmd === 'gen') {
  const [lang, dir, ...more] = [file, ...rest], o = n => { const i = more.indexOf(n); return i >= 0 ? more[i + 1] : null; };
  if (lang !== 'go' || !dir) { console.error('usage: strata gen go <dir> --experimental [--only <path inside the module>] [-o out.yaml]'); process.exit(2); }
  if (!more.includes('--experimental')) { console.error('strata gen is experimental and may change or go away: pass --experimental to use it'); process.exit(2); }
  const { genGo } = await import('../src/gen-go.js');
  try {
    const g = await genGo(resolve(dir), { only: o('--only') }), out = o('-o') || basename(resolve(dir)) + '.yaml';
    await writeFile(out, g.yaml);
    console.log(`ok · ${g.packages} packages · ${g.imports} imports drawn (${g.dropped} to shared packages left out) · ${g.calls} links to ${g.systems} outside systems · ${g.routes} routes, ${g.streams} streams, ${g.buckets} buckets · ${g.reaches} program-to-system reaches · ${resolve(out)}`);
    if (g.factsError) console.error(`warning: could not read the syntax tree (${g.factsError}); routes, streams, buckets and hosts are missing`);
    if (g.otherHosts.length) console.log(`hosts in the code that are not drawn (unknown): ${g.otherHosts.join(', ')}`);
  } catch (e) { console.error(e.message); process.exit(1); }
  process.exit(0);
}
const opt = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
const usage = () => { console.error('usage: strata check|build|shot <file.yaml> [--stats] [--twice] [-o out] [--at id] [--hide tag] [--show tag] [--hot id] [--only style] [--size WxH]'); process.exit(2); };
if (!cmd || !file || !['check', 'build', 'shot'].includes(cmd)) usage();

let model;
try { model = await layout(load(await readFile(file, 'utf8')), { twice: rest.includes('--twice') }); } // --twice: a second layout that arranges each level toward where its arrows leave; slower
catch (e) { console.error(`${file}: ${e.problems ? e.problems.length + ' problem(s)' : 'error'}\n${e.message}`); process.exit(1); }
for (const w of [...model.warnings, ...legibility(model), ...busy(model)]) console.error('warning: ' + w);
const stem = basename(file).replace(/\.ya?ml$/, '');

if (cmd === 'check' && rest.includes('--stats')) { // how clean the arrows are, per level: for judging a change to the router
  const ql = quality(model);
  for (const r of ql.levels.filter(r => r.lines).sort((p, q) => q.crossings - p.crossings)) console.log(`${r.id.padEnd(22)} ${String(r.lines).padStart(4)} lines ${String(r.crossings).padStart(4)} crossings ${String(r.bends).padStart(4)} bends ${String(r.length).padStart(7)} length${r.slanted ? '  ' + r.slanted + ' slanted' : ''}`);
  console.log(`total · ${ql.total.lines} lines · ${ql.total.crossings} crossings · ${ql.total.bends} bends · ${ql.total.length} length · ${ql.total.slanted} slanted`);
} else if (cmd === 'check') {
  const o = outline(model);
  console.log(o.text);
  console.log(`\nok · ${o.boxes} boxes · ${o.arrows} arrows · ${o.depth} levels deep`);
} else if (cmd === 'build') {
  const out = opt('-o') || stem + '.html';
  await writeFile(out, await html(model));
  console.log(`ok · ${resolve(out)}`);
} else {
  const chrome = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
  if (!chrome) { console.error('shot needs Chrome or Chromium; set CHROME to its path'); process.exit(1); }
  const at = opt('--at'), hide = opt('--hide'), show = opt('--show'), hot = opt('--hot'), only = opt('--only'), size = (opt('--size') || '1600x1000').replace('x', ',');
  if (at && !JSON.stringify(model.root).includes(`"id":"${at}"`)) { console.error(`--at ${at}: no node has that id`); process.exit(1); }
  const out = resolve(opt('-o') || `${stem}${at ? '-' + at : ''}.png`);
  const dir = await mkdtemp(join(tmpdir(), 'strata-'));
  const page = join(dir, 'page.html');
  await writeFile(page, await html(model));
  const hash = new URLSearchParams({ ...(at ? { at } : {}), ...(hide ? { hide } : {}), ...(show ? { show } : {}), ...(hot ? { hot } : {}), ...(only ? { only } : {}) }).toString();
  await new Promise((ok, fail) => execFile(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${size}`, '--virtual-time-budget=2000', `--screenshot=${out}`, pathToFileURL(page).href + (hash ? '#' + hash : '')],
    { timeout: 60000 }, err => (err ? fail(err) : ok())));
  await rm(dir, { recursive: true, force: true });
  console.log(`ok · ${out}`);
}
