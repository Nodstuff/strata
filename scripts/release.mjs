// Builds the standalone binaries: the command with its runtime inside, so nothing needs installing.
//   dist/release/strata-<os>-<arch>[.exe]  and  dist/release/SHA256SUMS
// Needs Deno (`deno compile`). The binaries are compiled WITHOUT network permission: they can read
// and write files and start Chrome (shot) and Go (facts go), and cannot open a connection.
// Run: node scripts/release.mjs [target ...]   (no targets = all five)
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const at = p => fileURLToPath(new URL('../' + p, import.meta.url));
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { maxBuffer: 64 << 20 }, (err, out, errOut) => (err ? fail(new Error(errOut || err.message)) : ok(out))));
const TARGETS = { 'aarch64-apple-darwin': 'macos-arm64', 'x86_64-apple-darwin': 'macos-x64', 'x86_64-unknown-linux-gnu': 'linux-x64', 'aarch64-unknown-linux-gnu': 'linux-arm64', 'x86_64-pc-windows-msvc': 'windows-x64.exe' };
const PERMS = ['--allow-read', '--allow-write', '--allow-env', '--allow-run', '--allow-sys', '--no-prompt']; // no --allow-net, on purpose

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);
for (const t of want) if (!TARGETS[t]) { console.error(`unknown target ${t}; known: ${Object.keys(TARGETS).join(', ')}`); process.exit(2); }
await run(process.execPath, [at('scripts/bundle.mjs')]);
await rm(at('dist/release'), { recursive: true, force: true });
await mkdir(at('dist/release'), { recursive: true });
for (const t of want) {
  const out = at(`dist/release/strata-${TARGETS[t]}`);
  await run('deno', ['compile', ...PERMS, '--no-check', '--target', t, '-o', out, at('skills/strata/strata.mjs')]);
  console.log(`ok · ${t}`);
}
const sums = [];
for (const f of (await readdir(at('dist/release'))).sort()) sums.push(`${createHash('sha256').update(await readFile(at('dist/release/' + f))).digest('hex')}  ${f}`);
await writeFile(at('dist/release/SHA256SUMS'), sums.join('\n') + '\n');
console.log(sums.join('\n'));
