// strata in a browser: the same model, layout and page as the command, with the viewer's source
// carried in the bundle (scripts/bundle.mjs). Nothing here touches the network.
import { load } from './model.js';
import { layout } from './layout.js';
import { html, legibility, busy, outline } from './build.js';

// YAML text in, one self-contained HTML page out. Throws an Error whose message lists the problems.
export async function render(text, { twice = false } = {}) {
  const model = await layout(load(text), { twice });
  const o = outline(model);
  return { html: await html(model), title: model.title, boxes: o.boxes, arrows: o.arrows, depth: o.depth,
    warnings: [...model.warnings, ...legibility(model), ...busy(model)] };
}
