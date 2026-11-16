// Builds dist/strata.browser.js: the renderer as one ES module for a browser (the playground, or an app that embeds strata).
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
await build({
  entryPoints: [new URL('src/browser.js', root).pathname],
  outfile: new URL('dist/strata.browser.js', root).pathname,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof',
  external: ['node:*'],
  plugins: [{ name: 'viewer', setup(b) {
    b.onResolve({ filter: /^strata:viewer$/ }, () => ({ path: 'viewer', namespace: 'strata' }));
    b.onLoad({ filter: /.*/, namespace: 'strata' }, async () => ({ contents: 'export default ' + JSON.stringify(await readFile(new URL('src/viewer.js', root), 'utf8')), loader: 'js' }));
  } }],
});
console.log('ok · dist/strata.browser.js');
