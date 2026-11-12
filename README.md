# strata (working name)

One YAML file becomes one self-contained HTML page: a diagram you zoom into. A box that has boxes inside it is a single labelled box when small and opens to show its contents as you zoom in. Arrows are declared once and merge on their own while their ends are closed.

```
node bin/strata.js check examples/shop.yaml            # validate and print the tree
node bin/strata.js build examples/shop.yaml -o shop.html
node bin/strata.js shot  examples/shop.yaml --at ord -o ord.png   # a picture of one level (needs Chrome)
```

## Where things are

| Path | What it is |
|---|---|
| `src/model.js` | Reads and checks the YAML; every problem is reported at once. |
| `src/layout.js` | Automatic layout, one container at a time, deepest first (ELK). Runs at build time only. |
| `src/viewer.js` | The viewer: plain browser JavaScript, no dependencies, pasted into every page. |
| `src/build.js` | Assembles the HTML page; also the text outline `check` prints. |
| `bin/strata.js` | The command line. |
| `skill/SKILL.md` | What Claude reads to write diagrams: the file format and how to structure one. |
| `examples/` | Diagrams that are safe to share. |
| `private/` | Diagrams that are not (git-ignored). |

## How it works

- **Layout** runs bottom-up. Each container gets its own inner space; ELK places its children as closed boxes and routes the arrows between them. A closed container is then drawn in its parent as a box of the same shape as its inner space, so opening it is a pure zoom.
- **Opening** depends on one number: the share of the viewport a container covers (closed below 34%, open above 46%). Layout keeps every closed container under 30% of its parent, so it is still closed when the parent fills the screen.
- **Arrows** resolve, every frame, to the deepest visible box at each end. Arrows that end up between the same two boxes merge and take the highest-ranked style among them.
- **Routes** are built from pieces made at build time. Between two boxes in one container the piece is ELK's. Where that piece meets a container's border is the container's port for the arrow, and inside the container a right-angle route (a small Dijkstra search in `layout.js`) runs from the port to the box the arrow is really for, round every other box. The viewer strings the pieces for whatever is open into one line.
- **Layout choice**: each container is laid out up to six ways (down or right, with the file's order held firmly, loosely or not at all) and the least busy result is kept, scored on arrow length, bends, crossings and how screen-shaped it is.

## State

Version 0.1, view only, no git repository yet. Dependencies: `elkjs` and `yaml`, both build-time.
