# strata (working name)

One YAML file becomes one self-contained HTML page: a diagram you zoom into. A box that has boxes inside it is a single labelled box when small and opens to show its contents as you zoom in. Arrows are declared once and merge on their own while their ends are closed.

## Use it with Claude Code

strata is a Claude Code plugin: a skill that teaches Claude the file format and how to structure a diagram, and the `strata` command that draws it. The command is one small program with nothing else to install. Chrome, Chromium or Edge is used when Claude takes pictures to check its own work, and the Go toolchain only for reading a Go repository.

```
claude plugin marketplace add Nodstuff/strata
claude plugin install strata@strata
```

Then ask for what you want, in Claude Code, inside the repository you want drawn or anywhere else:

- "Draw a strata diagram of this repository's architecture."
- "Make a zoomable diagram of the checkout flow: gateway, orders, payments, and what each talks to."

Claude writes `<name>.yaml`, checks it, looks at pictures of it, and gives you `<name>.html`. The page is one file with nothing loaded from outside: open it in any browser, send it, or put it on a share. Scroll or pinch to zoom, click a box for its links, double-click to dive in, `/` to find a box.

To update: `claude plugin update strata@strata`. Without plugins, copy the folder `skills/strata` to `~/.claude/skills/strata` and put the `strata` command on your `PATH`.

## The command

Any one of these gets you `strata`:

- **A release binary** for your platform (`strata-darwin-arm64`, `strata-darwin-amd64`, `strata-linux-amd64`, `strata-linux-arm64`, `strata-windows-amd64.exe`): rename it to `strata`, make it executable, put it on your `PATH`.
- **`go install github.com/Nodstuff/strata/cmd/strata@latest`**, if you have Go.
- **Nothing**, inside the plugin with Go installed: the skill's launcher (`skills/strata/strata`) builds the command from the plugin's own source the first time and keeps it in your cache.

```
strata check examples/shop.yaml                    # validate and print the tree
strata build examples/shop.yaml -o shop.html       # the page: open it in a browser
strata shot  examples/shop.yaml --at ord -o ord.png   # a picture of one level (needs a browser)
strata facts go <dir>                              # what a Go module's code says about its architecture (needs Go)
```

The command never uses the network. The file format is described in [`skills/strata/SKILL.md`](skills/strata/SKILL.md). `examples/shop.yaml` is a good one to copy from.

## Working on strata

`go test ./...` before sharing a commit. The tests build both examples and compare the arrow statistics with `test/expected.json` and the pages with the copies under `internal/page/testdata`, byte for byte, so any change to a picture shows up as a failing test: look at the new picture, and if it is better, record it. `scripts/release.sh` builds the command for every platform into `dist/`.

One thing to know before touching the layout arithmetic: on arm64, Go may fuse `a*b + c` into a single rounding, which gives a different last digit than on amd64 and moves boxes. Products that feed a sum are wrapped in `float64(...)` to stop that; keep doing it.

## Where things are

| Path | What it is |
|---|---|
| `cmd/strata` | The command line. |
| `internal/model` | Reads and checks the YAML; every problem is reported at once. |
| `internal/layout` | Layout, one container at a time, deepest first: sizes, box placement (`layered.go`), the arrow router (`route.go`), stated placement (`place.go`), ports and the three layouts (`layout.go`). |
| `internal/page` | Assembles the HTML page; also the outline, warnings and statistics `check` prints. |
| `internal/page/viewer.js` | The viewer: plain browser JavaScript, no dependencies, pasted into every page. The only part that is not Go, because it runs in the reader's browser. |
| `internal/gofacts` | `strata facts go`: reads a Go module's syntax tree for routes, streams, buckets and outside hosts. |
| `internal/jsx` | Number printing, rounding and ordering rules the layout depends on. strata was first written in JavaScript; these keep its results exactly. |
| `skills/strata/SKILL.md` | What Claude reads to write diagrams: the file format and how to structure one. |
| `skills/strata/strata` | The launcher the skill runs: finds or builds the command. |
| `.claude-plugin/` | What makes the repository a Claude Code plugin and its own marketplace. |
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
- **Stated placement**: a container whose boxes carry `place` is not arranged automatically. `placeStated` in `internal/layout/place.go` turns the statements into minimum-distance constraints per axis, solves them by longest path, and reports anything ambiguous as an error. Its arrows are drawn by the same router as the cross-container pieces.
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

Version 0.2, view only. Written in Go; one dependency, the YAML reader (`go.yaml.in/yaml/v4`).

## Facts from Go code

`strata facts go <dir> [--only internal/x] [-o facts.md]` prints what a Go module's code says about its architecture, as text with file and line: each program and the outside systems it reaches, which packages hold a client for which system, the NATS streams and buckets the code names, the HTTP routes each package serves, and the packages that are only shared code. It runs offline and writes nothing in the module. It is meant as input for a person or Claude drawing the architecture, not as a diagram: see the skill.

## Placement

Boxes are placed by `internal/layout/layered.go`, strata's own layered placement: rows by flow, order within a row by fewest crossings, positions that keep a flow's spine straight, unconnected parts packed into a screen-shaped block. Every arrow is drawn by the router in `internal/layout/route.go`.
