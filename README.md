# strata (working name)

One YAML file becomes one self-contained HTML page: a diagram you zoom into. A box that has boxes inside it is a single labelled box when small and opens to show its contents as you zoom in. Arrows are declared once and merge on their own while their ends are closed.

## Use it with Claude Code

strata is a Claude Code plugin: a skill that teaches Claude the file format and how to structure a diagram, and the command that draws it. You need Node 22 or newer. Chrome or Chromium is used when Claude takes pictures to check its own work, and Go only for reading a Go repository.

```
claude plugin marketplace add <owner>/strata      # or a path to a local clone
claude plugin install strata@strata
```

Then ask for what you want, in Claude Code, inside the repository you want drawn or anywhere else:

- "Draw a strata diagram of this repository's architecture."
- "Make a zoomable diagram of the checkout flow: gateway, orders, payments, and what each talks to."

Claude writes `<name>.yaml`, checks it, looks at pictures of it, and gives you `<name>.html`. The page is one file with nothing loaded from outside: open it, send it, or put it on a share. Scroll or pinch to zoom, click a box for its links, double-click to dive in, `/` to find a box.

To update: `claude plugin update strata@strata`. Without plugins, copy the folder `skills/strata` to `~/.claude/skills/strata`; it holds the skill and the command.

## Use it by hand

There are two forms of the same command:

- **A standalone program**, one per platform (`strata-macos-arm64`, `strata-macos-x64`, `strata-linux-x64`, `strata-linux-arm64`, `strata-windows-x64.exe`), attached to each release with a `SHA256SUMS` file. Nothing else needs installing. Rename it to `strata`, make it executable and put it on your `PATH`. It is built without network permission: it reads and writes files, starts a browser for `shot` and Go for `facts go`, and cannot open a connection.
- **One script**, `skills/strata/strata.mjs`, for Node 22 or newer (`node strata.mjs ...`) or Deno (`deno run --allow-read --allow-write --allow-env --allow-run --allow-sys strata.mjs ...`).

From a clone, `node bin/strata.js` runs the sources (after `npm install`).

```
strata check examples/shop.yaml                    # validate and print the tree
strata build examples/shop.yaml -o shop.html       # the page
strata shot  examples/shop.yaml --at ord -o ord.png   # a picture of one level (needs Chrome)
strata facts go <dir>                              # what a Go module's code says about its architecture (needs Go)
```

The file format is described in [`skills/strata/SKILL.md`](skills/strata/SKILL.md). `examples/shop.yaml` is a good one to copy from.

## Working on strata

`npm install`, then `npm test` before sharing a commit: it checks that the checked-in command matches the sources, that it runs on its own, and that the examples still build with arrows as clean as recorded. After changing anything under `src/` or `bin/`, run `npm run bundle` and commit `skills/strata/strata.mjs` with the change. `npm run release` builds the standalone programs into `dist/release/` (needs Deno); they are not checked in.

## Where things are

| Path | What it is |
|---|---|
| `src/model.js` | Reads and checks the YAML; every problem is reported at once. |
| `src/layout.js` | Layout, one container at a time, deepest first: sizes, the arrow router, ports, stated placement. Runs at build time only. |
| `src/layered.js` | Where boxes go on a level that is not placed by hand. |
| `src/viewer.js` | The viewer: plain browser JavaScript, no dependencies, pasted into every page. |
| `src/build.js` | Assembles the HTML page; also the text outline `check` prints. |
| `bin/strata.js` | The command line. |
| `skills/strata/SKILL.md` | What Claude reads to write diagrams: the file format and how to structure one. |
| `skills/strata/strata.mjs` | The command as one file, built by `scripts/bundle.mjs` from `src/` and `bin/`. Checked in so that installing needs no build. |
| `.claude-plugin/` | What makes the repository a Claude Code plugin and its own marketplace. |
| `playground/` | A page that draws in the browser as you type (see "In a browser"). |
| `examples/` | Diagrams that are safe to share: `shop.yaml` (automatic layout, three levels) and `placed.yaml` (stated placement). |
| `private/` | Diagrams that are not (git-ignored). |

## How it works

- **Layout** runs bottom-up. Each container gets its own inner space; its children are placed as closed boxes and the arrows are routed between them. A closed container is then drawn in its parent as a box of the same shape as its inner space, so opening it is a pure zoom.
- **Opening** depends on one number: the share of the viewport a container covers (closed below 34%, open above 46%). Layout keeps every closed container under 30% of its parent, so it is still closed when the parent fills the screen.
- **Arrows** resolve, every frame, to the deepest visible box at each end. Arrows that end up between the same two boxes merge and take the highest-ranked style among them.
- **Routes** are built from pieces made at build time. Between two boxes in one container the piece is the router's path round the other boxes. Where that piece meets a container's border is the container's port for the arrow, and inside the container a right-angle route (a small Dijkstra search in `layout.js`) runs from the port to the box the arrow is really for, round every other box. The viewer strings the pieces for whatever is open into one line.
- **Ports** are chosen top down, one container at a time. A piece that has a bend may slide its last leg along the side it meets; a straight piece stays where it is. Every allowed position (in line with the target box, or with the lane beside any box) is a goal for one search from the target, so the port lands where the inside route is shortest. A position is not allowed if it puts a box in the way, adds a crossing in the picture above, or sits on another arrow's port.
- **Meeting a container**: when the router draws an arrow to a container, a point far from the box the arrow is really for costs what the detour inside would, so the arrow arrives near that box and on the side facing it.
- **Second opinion**: a route much longer than the direct distance is routed again once every other arrow on the level is drawn, and the shorter line is kept.
- **Stated placement**: a container whose boxes carry `place` is not arranged automatically. `placeStated` in `layout.js` turns the statements into minimum-distance constraints per axis, solves them by longest path, and reports anything ambiguous as an error. Its arrows are drawn by the same router as the cross-container pieces.
- **Lanes**: the router knows which segments are already drawn in a container and charges for running along another arrow's line, so parallel arrows take neighbouring lanes 9 units apart.
- **Layout choice**: each container is laid out up to six ways (down or right, with the file's order held firmly, loosely or not at all) and the least busy result is kept, scored on arrow length, bends, crossings and how large the boxes come out once the picture is fitted to a screen.
- **Using the room**: a level narrower than a screen has its sideways gaps widened, and a short wide one its row gaps, until it is about screen-shaped or fills the room it has anyway. Boxes keep their size. Stated levels get the same treatment.
- **Gutter**: fitting a container leaves a margin on every side, where the labels of arrows that leave it sit clear of its boxes. A label on the left or right edge drops leading names until it fits.
- **Quiet and lit**: arrows that leave the level being read are drawn faint. Pointing at a box, or at an edge label, lights that box's arrows and dims every other one; `#hot=<id>` (or `shot --hot <id>`) opens with a box lit. A label is never drawn on top of another.
- **Pin and filter**: a click (or a tap) pins a box, so its arrows stay lit and the boxes they do not reach step back; click it again, click empty space or press Esc to let go. Each arrow style in the legend is a filter: click one or more and every other arrow goes faint (`#only=<style>`, `shot --only <style>`). Where two lines cross, one visibly passes over the other.
- **Panel**: a pinned box opens a panel with its text and every arrow it has, by name and label, in both directions; clicking a row goes to the other end. The pinned box's arrows move in the direction they point (not when the system asks for reduced motion).
- **Find**: `/` opens a search over every box's name; Enter goes to the first match and pins it.
- **Links**: the page address follows the view (level, tags, pinned box), so a copied link opens on the same picture. `‹` and `›` beside the tags step through them, as `p` and `n` do.
- **Trunks**: arrows of the same style that go into the same box, or come out of the same box, may share a line and a meeting point. Each is labelled on the stretch that is its own. Inside a container, the boxes that share one arrow out of it are drawn as one tree to the point where the arrow leaves.
- **Exit points**: an arrow meets a container on the side nearest the boxes it is for, when that does not add crossings on the level above.
- **Arranged toward the exits**: the first layout finds which side of each container every outgoing arrow leaves by. A second arranges each level toward those sides: a level is turned over across its flow when that brings its boxes nearer, its unconnected parts are ordered toward the sides they leave by, and boxes whose arrows leave along the flow move to the first or last row. Not every level is better for it, so a third layout keeps the new arrangement only on the levels whose arrows came out calmer, and the best of the three pictures by measurement is the one kept. Levels placed by hand (`place`) are never moved. `--once` skips the second and third.
- **Measuring the arrows**: `strata check file.yaml --stats` prints, per level and in total, how often arrows cross, how many bends there are and how much line is drawn. Use it to judge a change to a diagram or to the router.
- **Room for titles**: on a level that is a tall column, plain boxes grow wider so their titles are larger once the level fits a screen; on a strip they grow taller.
- **Busy levels**: `check` and `build` warn when one level holds more than 16 boxes or 30 arrows, and name the boxes with the most arrows.
- **Tags**: a tag is a named set of boxes and arrows with a colour. Each is a chip in the top bar; switching one on fades its members in and makes them glow for a moment. `until: <tag>` on a box or arrow retires it when that tag comes on. `n` and `p` step through the tags in file order. Layout is fixed at build time, so a hidden box keeps its place.

## State

Version 0.1, view only. Local git repository, no remote. Dependencies: `elkjs` and `yaml`, both build-time.

## Facts from Go code

`strata facts go <dir> [--only internal/x] [-o facts.md]` prints what a Go module's code says about its architecture, as text with file and line: each program and the outside systems it reaches, which packages hold a client for which system, the NATS streams and buckets the code names, the HTTP routes each package serves, and the packages that are only shared code. It runs offline and writes nothing in the module. It is meant as input for a person or Claude drawing the architecture, not as a diagram: see the skill.

## Experimental: a diagram from Go code

`strata gen go <dir> --experimental [--only internal/x] [-o out.yaml]` writes a strata file of a Go module's packages: one box per package, nested the way the directories are, and an arrow for every import between two of the module's own packages. It is what `go list` reports, run offline and read-only; nothing is guessed. A directory with more than 14 packages is grouped mechanically: packages whose names share a start go in one box (`cnq…`), and the rest are split into Foundations (import nothing else there), Tops (nothing else there imports them) and Middle. The output is an ordinary strata file: edit it, or generate it again. Two things keep it high signal. The systems the code talks to (databases, queues, cloud services, outside APIs) are found from the drivers and SDKs each package imports, and drawn as boxes with an arrow from every package that holds a client. And a package that most of the module imports (a model, a logger) keeps its box but loses its incoming arrows, which removes most of the import noise. A third thing comes from the syntax tree, read by a small Go program (`src/gofacts`, standard library only, run from a temporary directory with the network off): the HTTP routes each package serves, listed on its box by path; the NATS streams, subjects and key-value buckets the code names, drawn inside the NATS box with an arrow from each package that defines, publishes to or reads one; and outside services called by URL with no SDK (Slack, for one), from a list of known hosts. Hosts it does not know are printed, not drawn. Last, each program (`package main`) gets a dashed arrow to every system it reaches through the packages it imports, so the `cmd` level shows what each binary depends on. Limits: a subject or route built at run time is missed or shown with `*` for the unknown part; one binary that runs as several services is one box; only NATS is read for messaging. Code flows are not generated yet. The command may change or go away.

## In a browser

`node scripts/bundle.mjs` builds `dist/strata.browser.js`: the whole renderer as one ES module. `render(yamlText)` returns `{ html, title, boxes, arrows, depth, warnings }`, where `html` is the same self-contained page `strata build` writes; a bad file throws an error whose message lists the problems. Nothing touches the network.

`playground/index.html` is a small page built on it: YAML on the left, the live diagram on the right, and a button that downloads the page. Serve the repository folder with any static file server and open `/playground/`. The diagram is shown in a sandboxed frame. Layout runs on the page's main thread, so a very large diagram (300 boxes) holds the page for several seconds.

## Placement

Boxes are placed by `src/layered.js`, strata's own layered placement: rows by flow, order within a row by fewest crossings, positions that keep a flow's spine straight, unconnected parts packed into a screen-shaped block. Every arrow is drawn by the router in `src/layout.js`. `--elk` places boxes with the ELK library instead; it is kept for comparison while the two are measured against each other, and is the only reason the command still carries ELK.
