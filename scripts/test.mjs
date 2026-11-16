// The checks that must pass before a commit is shared:
//   1. the checked-in command (skills/strata/strata.mjs) is what the sources build today
//   2. it runs from a folder with no node_modules, and builds each example into a page
//   3. each example's arrows are as clean as recorded in test/expected.json (run with --record to accept new numbers)
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, copyFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const at = p => fileURLToPath(new URL('../' + p, import.meta.url));
const run = (args, cwd) => new Promise((ok, fail) => execFile(process.execPath, args, { cwd, maxBuffer: 64 << 20 }, (err, out, errOut) => (err ? fail(new Error(errOut || err.message)) : ok(out))));
const sha = async f => createHash('sha256').update(await readFile(f)).digest('hex');
const record = process.argv.includes('--record');
const dir = await mkdtemp(join(tmpdir(), 'strata-test-'));
let failed = 0;
const say = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
try {
  await run([at('scripts/bundle.mjs'), join(dir, 'fresh.mjs')]);
  say(await sha(join(dir, 'fresh.mjs')) === await sha(at('skills/strata/strata.mjs')), 'the checked-in command matches the sources (if not: npm run bundle)');

  const cli = join(dir, 'strata.mjs');
  await copyFile(at('skills/strata/strata.mjs'), cli);
  say(/^\d+\.\d+\.\d+/.test(await run([cli, '--version'], dir)), 'the command runs with no node_modules beside it');

  const expected = JSON.parse(await readFile(at('test/expected.json'), 'utf8').catch(() => '{}')), seen = {};
  for (const f of (await readdir(at('examples'))).filter(f => f.endsWith('.yaml')).sort()) {
    await copyFile(at('examples/' + f), join(dir, f));
    const total = (await run([cli, 'check', f, '--stats'], dir)).trim().split('\n').pop();
    seen[f] = total;
    const page = await run([cli, 'build', f, '-o', f + '.html'], dir).then(() => readFile(join(dir, f + '.html'), 'utf8'));
    say(page.startsWith('<!doctype html>') && page.includes('lineDashOffset') && !/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org)/.test(page), `${f}: builds one page that loads nothing from outside`);
    if (!record) say(expected[f] === total, `${f}: arrows as recorded (${total}${expected[f] === total ? '' : ' · recorded: ' + expected[f]})`);
  }
  if (record) { await writeFile(at('test/expected.json'), JSON.stringify(seen, null, 2) + '\n'); console.log('recorded test/expected.json'); }
} finally { await rm(dir, { recursive: true, force: true }); }
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
