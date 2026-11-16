// Builds the two single-file forms of strata from src/:
//   skills/strata/strata.mjs the command, for Node 22+, with its dependencies inside (no npm install).
//                            It is checked in, so installing the skill or the plugin needs no build.
//   dist/strata.browser.js   the renderer as one ES module for a browser (the playground)
// Both carry the viewer's source and the Go reader as text, in place of src/assets.js.
import { build } from 'esbuild';
import { readFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const at = p => fileURLToPath(new URL('../' + p, import.meta.url));
const { version } = JSON.parse(await readFile(at('package.json'), 'utf8'));
const carried = { name: 'carried', setup(b) {
  b.onLoad({ filter: /[\\/]src[\\/]assets\.js$/ }, async () => ({ loader: 'js', contents:
    `export const viewerSource = async () => ${JSON.stringify(await readFile(at('src/viewer.js'), 'utf8'))};\n` +
    `export const gofactsSource = async () => ${JSON.stringify(await readFile(at('src/gofacts/main.go'), 'utf8'))};\n` }));
} };
const out = process.argv[2] ? resolve(process.argv[2]) : at('skills/strata/strata.mjs'); // a path argument builds the command somewhere else (the test uses it)
const common = { bundle: true, format: 'esm', target: 'es2022', minify: true, legalComments: 'eof', plugins: [carried], define: { STRATA_VERSION: JSON.stringify(version) } };

await build({ ...common, entryPoints: [at('bin/strata.js')], outfile: out, platform: 'node',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } }); // the YAML library is CommonJS inside
await chmod(out, 0o755);
await build({ ...common, entryPoints: [at('src/browser.js')], outfile: at('dist/strata.browser.js'), platform: 'browser', external: ['node:*'] });
console.log(`ok · strata ${version} · ${relative(process.cwd(), out)} · dist/strata.browser.js`);
