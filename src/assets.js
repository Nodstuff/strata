// The two source files strata carries as text: the viewer pasted into every page, and the Go reader
// that `facts go` runs. Run from a checkout they are read from beside this file; a bundle
// (scripts/bundle.mjs) replaces this module with one that holds both as strings.
export async function viewerSource() {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('./viewer.js', import.meta.url), 'utf8');
}
export async function gofactsSource() {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('./gofacts/main.go', import.meta.url), 'utf8');
}
