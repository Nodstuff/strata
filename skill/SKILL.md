---
name: strata
description: Build a zoomable, nested architecture or flow diagram with strata (one YAML file becomes one self-contained HTML page where boxes open as you zoom in). Use when the user asks for a strata diagram, a "zoomable" or "nested" diagram, or one picture that holds a system at several levels (cluster, service, feature, flow). NOT for a single flat diagram in a README or PR (use Mermaid there) and NOT for charts of data.
---

# strata

strata turns one YAML file into one HTML page. The page shows a tree of boxes: zoomed out you see the top level, and a box that has boxes inside it opens when you zoom into it. Arrows are declared once, between the deepest boxes that exist, and merge automatically when their ends are closed. You never write coordinates; layout is automatic.

The tool lives in `~/personal/strata`. Run it as `node ~/personal/strata/bin/strata.js <command> <file.yaml>`.

## The loop

1. Write `<name>.yaml` (format below).
2. `strata check <name>.yaml`: fix every problem it lists. It prints the tree, so read it and confirm the nesting is what you meant.
3. `strata shot <name>.yaml -o top.png`, then `strata shot <name>.yaml --at <id> -o <id>.png` for each container that matters. **Look at the pictures** (Read the PNG). Fix what reads badly, usually by reordering nodes or nesting more.
4. `strata build <name>.yaml -o <name>.html` and give the user the path. The HTML is self-contained and can be sent to anyone.

`shot` takes `--size 1600x1000` (the default) and always renders the dark theme. `--at <id>` opens the picture fitted to that container. The same works in a link: `<name>.html#at=<id>`, and `#hide=<state>` starts with a state switched off.

## The file

```yaml
title: Shop platform
subtitle: production            # optional
flow: down                      # optional: down | right, for the top level

styles:                         # optional: line styles for arrows
  mtls:  {color: green, rank: 4, label: mTLS}
  plain: {color: red, dash: dashed, rank: 9, label: plaintext}
states:                         # optional: things the viewer can switch off
  phase2: {label: Phase 2, color: green}

nodes:
  - id: gw                      # ids are global and must be unique
    label: API gateway
    sub: ingress · auth         # one short line under the title
    kind: service
  - id: orders
    label: Orders
    kind: service
    detail:                     # shown only when the box is big enough to read
      - 3-5 pods (HPA)
      - REST API, saga engine
    nodes:                      # boxes inside this box
      - id: orders_api
        label: HTTP API
      - id: checkout
        label: Checkout
        flow: right             # lay this box's contents out left to right
        nodes:
          - {id: ck_validate, label: Validate cart}
          - {id: ck_ok, label: "Has\nstock?", shape: diamond}
          - {id: ck_pay, label: Payments, ref: payments}
  - id: payments
    label: Payments
    kind: service
    state: phase2

edges:
  - [gw, orders_api, REST, plain]        # [from, to, label, style]; label and style optional
  - [orders_api, ck_validate]
  - [ck_validate, ck_ok]
  - [ck_ok, ck_pay, "Yes", yes]
  - {from: ck_pay, to: payments, label: authorise, style: mtls}
```

### Node keys

| Key | Meaning |
|---|---|
| `id` | Required, unique across the whole file. Letters, digits, `_`. |
| `label` | The title. `\n` makes a second line. Defaults to the id. |
| `sub` | One short muted line (a role, a tech, a count). |
| `detail` | A list of short lines (about 30 characters each). Appears when zoomed in enough. |
| `note` | Makes the box an annotation with wrapped body text; `label` is its heading. A note cannot contain nodes. |
| `kind` | Colour by meaning: `service` (blue), `store` (orange), `infra` (purple), `external` (grey, dashed), `step` (default), `frame`, `note`. Any colour name also works: `blue green red orange purple yellow grey violet teal slate`. Add your own under top-level `kinds:`. |
| `shape` | `box` (default), `diamond` (a decision), `cylinder` (a database or queue), `actor` (a person). |
| `state` | Name from `states:` (each state takes a `label` and a `color` from the same colour names as kinds). The box and everything inside it is drawn dashed in the state's colour, and the viewer gets a button to hide it. Use it for "new in phase 2", "deprecated", "planned". |
| `ref` | The id of another box. This box becomes a reference: a stand-in that names the real thing, and one click flies there. A reference is only a picture. If the dependency is real, also declare an arrow between the reference box and the real box (`[ck_pay, payments, authorise, mtls]`): it is not drawn inside the flow, where the reference box already says it, but it appears as a proper arrow at every level above. |
| `group` | `true` on a box with nodes: draw it as an always-open frame at its parent's scale (an AWS account, a VPC, a swimlane) instead of a box you zoom into. |
| `flow` | `down` or `right`: the direction this box's contents are laid out. **Leave it out by default**, at the top level too: strata then tries both and keeps the one that fits a screen better. Set it only when the picture shows the direction is wrong. A flow with a declared direction that comes out as a very thin strip is folded onto extra rows, which adds long loop-back arrows. |
| `place` | Where this box sits relative to another box in the same container: `right of api`, `left of api`, `above api`, `below api`, `level with api`. A list gives several. See "Stating the arrangement". |
| `about` | On a note: the id of the box in the same container that the note is about. The note is laid out next to it. |
| `widths` | `match` on a box with nodes: the plain boxes inside it all take the width of the widest. Also allowed at the top of the file for the top level. |
| `nodes` | The boxes inside this box. |

### Arrow styles

`flow` (default, neutral), `yes` (green) and `no` (red) are built in. If the diagram has decisions, do not give one of your own styles green or red, or a Yes branch will read as that style; redefine `yes` and `no` under `styles:` instead if you need those colours. In the array form, write `""` for the label when you want a style and no text: `[a, b, "", mtls]`. Declare others under `styles:` with `color`, optional `dash: dashed | dotted`, `width`, `arrow: none`, a `label` for the legend, and a `rank`. **Rank decides which style a merged arrow takes: the highest rank wins.** Give the worst case the highest rank (plaintext above TLS above mTLS), so a closed box never hides a bad link: seven arrows merge into "7 links · 5 plaintext", drawn red.

## Stating the arrangement

By default strata arranges each level itself. When a level should look a particular way (a request path left to right, a tier diagram, a page someone already knows from a whiteboard), say where the boxes go. Placement is per container: the levels you say nothing about stay automatic.

```yaml
nodes:
  - {id: browser, label: Browser}
  - {id: api, label: API server, place: right of browser}
  - {id: db, label: Postgres, place: right of api wide}
  - {id: worker, label: Worker, place: below api}
  - {id: cache, label: Redis, place: [below db, level with worker]}
```

- **A gap is a minimum, never an exact distance.** Everything ends up as close together as the statements allow. An optional last word sets the gap: `none`, `tight`, `normal` (default) or `wide`.
- **One direction on its own also lines the box up.** `right of api` puts the box on api's row; `below api` puts it in api's column. That half drops away once another placement says something about that axis: `[below db, level with worker]` is db's column and worker's row.
- **Once one box in a container has `place`, every box in it but one must have it.** The one without is what the rest are placed against, directly or through each other. Notes count as boxes.
- **Nothing is guessed.** Two boxes that would overlap, a box that names two columns and no row, a circle of placements: each is an error naming the boxes. Fix it by placing one box against the other.
- Targets must be boxes in the same container. Arrows are still routed for you, round the boxes.

Do not reach for this by default. For most levels the automatic arrangement is good and costs nothing to maintain; state the arrangement where the picture has a shape people expect.

## How to structure a diagram

- **Think in levels, not pages.** Each box with `nodes` is one screen. Aim for 4 to 10 boxes per level; `check` warns past 16. If a level is crowded, group related boxes into a new box.
- **Declare each arrow once, at the deepest ends you know.** `gateway → orders_api`, not `gateway → orders`. strata draws `gateway → orders` by itself while Orders is closed. Only point an arrow at a container when you genuinely do not know which part inside is the end.
- **File order steers screen order.** Within a level, nodes are placed roughly in the order written (arrows can override it), and an arrow that points back to an earlier node is treated as a loop-back. Write a flow's steps in the order they happen, and write a decision's branches right after the decision.
- **A flow that touches several systems lives in one home box.** Put the flow inside the component that runs it. Where it touches another system, add a small box with `ref: <that system's id>` as a step in the flow, and one arrow from that box to the real system so the dependency shows at the levels above.
- **Use `group` for boundaries, nesting for depth.** Accounts, VPCs and trust zones are groups (always visible). Things with internals worth hiding (a cluster, a namespace, a service, a feature) are plain nested boxes.
- **Heed the legibility warning.** `check` says when a level's titles will be too small to read on an ordinary screen and names the boxes. Shorten those labels or move boxes into a nested box.
- **Keep text short.** Labels of one to three words, `sub` a few words, `detail` lines about 30 characters. Long prose belongs in a `note`.
- **Arrow labels are optional.** Label the protocol or the reason, not the obvious ("calls").

## What to check in the pictures

- Does the top level read in five seconds? If not, there are too many boxes or too many arrows at that level.
- Does each container, opened with `--at`, show its boxes at a readable size? A long chain wraps onto extra rows; if it still reads badly, split it into two nested boxes.
- Every arrow is routed with right angles and goes round boxes. An arrow to something outside the container leaves through the container's frame and ends in a label at the screen edge naming where it goes; that is expected. A label ending in `+1` stands for two boxes at the end of the same line.

## Limits today

- View only. People who open the HTML can zoom, pan, dive, toggle states and follow references; they cannot edit.
- A route never passes behind a box and each arrow meets a container at its own point, but strata does not rearrange a container to suit what is outside it, so an arrow can still take a long way to the side its target sits on.
- Arrow labels only show once you are zoomed in far enough for them to fit the room the layout kept for them, so a top level can show no labels.
- A decision diamond's arrows attach to its bounding box, so they can stop slightly short of the point.
