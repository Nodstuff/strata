---
name: strata
description: Build a zoomable, nested architecture or flow diagram with strata (one YAML file becomes one self-contained HTML page where boxes open as you zoom in). Use when the user asks for a strata diagram, a "zoomable" or "nested" diagram, one picture that holds a system at several levels (cluster, service, feature, flow), or an architecture diagram drawn from a repository. NOT for a single flat diagram in a README or PR (use Mermaid there) and NOT for charts of data.
---

# strata

strata turns one YAML file into one HTML page. The page shows a tree of boxes: zoomed out you see the top level, and a box that has boxes inside it opens when you zoom into it. Arrows are declared once, between the deepest boxes that exist, and merge automatically when their ends are closed. You never write coordinates; layout is automatic.

First run `strata --version`. If it prints a version, the standalone program is installed: use `strata <command>` exactly as this page writes it. If not, the same command ships beside this file as one script, `strata.mjs`, which needs Node 22 or newer, or Deno: run `node ${CLAUDE_SKILL_DIR}/strata.mjs <command>`, or `deno run --allow-read --allow-write --allow-env --allow-run --allow-sys ${CLAUDE_SKILL_DIR}/strata.mjs <command>`. `strata.mjs` is the file in the same folder as this page: if the path in that command still shows a `${...}` placeholder, your tool did not fill it in, so use the real path of that folder. `shot` also needs Chrome or Chromium, and `facts go` needs the Go toolchain; say so plainly if one is missing and carry on without that step.

## The loop

1. Write `<name>.yaml` (format below).
2. `strata check <name>.yaml`: fix every problem it lists. It prints the tree, so read it and confirm the nesting is what you meant. While drafting, `strata check <name>.yaml --summary` prints only the box count and the fullest levels: check it early, because cutting a diagram down after it is written costs a rewrite.
3. `strata shot <name>.yaml -o top.png`, then `strata shot <name>.yaml --at <id> -o <id>.png` for each container that matters. **Look at the pictures** (Read the PNG). Fix what reads badly, usually by reordering nodes or nesting more.
4. `strata build <name>.yaml -o <name>.html` and give the user the path. The HTML is self-contained and can be sent to anyone.

`shot` takes `--size 1600x1000` (the default) and always renders the dark theme. A picture takes 5 to 20 seconds, so take a few per command, not twenty. `--only <style>` lights the arrows of one style and dims the rest. `--at <id>` opens the picture fitted to that container; `--show <tag,tag>` and `--hide <tag>` set tags; `--hot <id>` lights one box's arrows and dims the rest, which is how a reader untangles a busy level by pointing at a box. The same works in a link: `<name>.html#at=<id>&show=<tag>`.

Two more commands help judge a result. `strata check <name>.yaml --stats` prints how often arrows cross, per level: use it to compare two ways of grouping a busy level. `--twice` on `check`, `build` or `shot` lays the picture out a second time with each level arranged toward where its arrows leave; it takes twice as long and helps a little on crowded levels.

## Drawing a system from its repository

The diagram is made by judgement, not generated. What a reader needs (which things are one service, what a box is called, which flows matter) is not written in the code. Your job is to read the sources, decide, and keep every claim tied to where you read it.

**1. Collect, before drawing anything.**

| Level of the picture | Where the truth is | How to read it |
|---|---|---|
| Accounts, networks, clusters, managed services | Infrastructure code (Terraform, OpenTofu, CloudFormation) | Read the modules and the per-environment variables |
| Namespaces, workloads, replicas, what may talk to what | Deployment files (Helm charts and values, Kubernetes manifests, network policies) | Read the templates and the values for the environment being drawn |
| What each program talks to, serves and stores | The code | `strata facts go <dir>` for Go, then read the files it points at. For other languages, see below |
| Flows inside a feature | The code | Read the handler and follow the calls; nothing extracts this |
| What people already call things | Existing diagrams, design docs, the wiki | Ask the user for them; reuse their names |

`strata facts go <dir> [--only <path>] [-o facts.md]` prints, with file and line: each program and the outside systems it reaches, which packages hold a client for which system, the NATS streams and buckets the code names, the HTTP routes each package serves, and the packages that are only shared code. It runs offline and writes nothing in the repository. It is a list of facts: it cannot see anything decided at run time, and it does not know which program runs where.

For a repository that is not Go, collect the same facts by reading: start at each program's entry point (`main`), which shows the run modes, what is wired together and the background loops; sweep for where routes are registered and where RPC methods or tools are declared; find the client constructors and connection strings for what it talks to; and read the comment at the top of each module before its body. Say in your report which parts you read in full and which you took from comments or docs.

**2. Decide the levels top down.** Boundaries first (account, cluster, namespace), then what runs, then what each running thing is made of, then flows. A package is rarely a box: several packages are one feature, and one binary can be several services. Name boxes the way the team does.

**3. Draw one level at a time and check it**, with the loop above. For a large system, write one YAML fragment per service and join them with a small script, so a level can be redone without touching the rest.

**4. Keep the evidence.**

- Put the source of each box in a YAML comment above it: `# deploy/helm/app/values.yaml:210`, `# internal/saga/engine.go:88`.
- Put the package path in `sub` on a box that stands for code (`sub: internal/saga`), so a reader can find it.
- Draw only what you read. Where the sources disagree (a design doc says one thing, the chart another), draw what is deployed and say so in a `note`.
- Mark what is planned with a tag, never as if it exists.
- Tell the user what you could not verify, and ask instead of guessing about anything that decides the shape of the picture.

**5. Check the picture against the facts before handing it over.** Every outside system in the facts should be in the picture or left out on purpose; every arrow to a database or queue in the picture should have a client in the facts. Say which of these you checked.

An architecture file usually holds details of a private system. Keep it where the user says, and never put it in a public repository or send it to an outside service.

## The file

```yaml
title: Shop platform
subtitle: production            # optional
flow: down                      # optional: down | right, for the top level

styles:                         # optional: line styles for arrows
  mtls:  {color: teal, rank: 4, label: mTLS}
  plain: {color: orange, dash: dashed, rank: 9, label: plaintext}
tags:                           # optional: sets of boxes and arrows the viewer switches on and off
  phase2: {label: Phase 2, color: green, show: false}

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
    tag: phase2

edges:
  - [gw, orders_api, REST, plain]        # [from, to, label, style]; label and style optional
  - [orders_api, ck_validate]
  - [ck_validate, ck_ok]
  - [ck_ok, ck_pay, "Yes", yes]
  - {from: ck_pay, to: payments, label: authorise, style: mtls}
  - [gw, payments, direct, plain, phase2]      # fifth item: the arrow belongs to a tag
```

### Node keys

| Key | Meaning |
|---|---|
| `id` | Required, unique across the whole file. Letters, digits, `_`. |
| `label` | The title. `\n` makes a second line. Defaults to the id. |
| `sub` | One short muted line (a role, a tech, a count, the code path). It stays as the first line when `detail` shows. On a `ref` box it is replaced by the name of the box referred to, so put anything else in the label. |
| `detail` | A list of short lines (about 30 characters each). Appears when zoomed in enough. A box with `nodes` may have it too: it shows while the box is closed. |
| `note` | Makes the box an annotation with wrapped body text; `label` is its heading. A note cannot contain nodes. |
| `kind` | Colour by meaning: `service` (blue), `store` (orange), `infra` (purple), `external` (grey, dashed), `step` (default), `frame`, `note`. Any colour name also works: `blue green red orange purple yellow grey violet teal slate`. Add your own under top-level `kinds:`. |
| `shape` | `box` (default), `diamond` (a decision), `cylinder` (a database or queue), `actor` (a person). |
| `tag` | Name from `tags:`. The box and everything inside it is drawn dashed in the tag's colour, and the viewer gets a chip to switch it on and off. See "Tags". (`state` and `states:` are the older names and still work.) |
| `until` | Name from `tags:`. The box is shown until that tag is switched on, then fades out: what a later phase replaces. |
| `ref` | The id of another box. This box becomes a reference: a stand-in that names the real thing, and one click flies there. A reference is only a picture. If the dependency is real, also declare an arrow between the reference box and the real box (`[ck_pay, payments, authorise, mtls]`): it is not drawn inside the flow, where the reference box already says it, but it appears as a proper arrow at every level above. |
| `group` | `true` on a box with nodes: draw it as an always-open frame at its parent's scale (an AWS account, a VPC, a swimlane) instead of a box you zoom into. |
| `flow` | `down` or `right`: the direction this box's contents are laid out. **Leave it out by default**, at the top level too: strata then tries both and keeps the one that fits a screen better. Set it only when the picture shows the direction is wrong. A flow with a declared direction that comes out as a very thin strip is folded onto extra rows, which adds long loop-back arrows. |
| `place` | Where this box sits relative to another box in the same container: `right of api`, `left of api`, `above api`, `below api`, `level with api`. A list gives several. See "Stating the arrangement". |
| `about` | On a note: the id of the box in the same container that the note is about. The note is laid out next to it. |
| `widths` | `match` on a box with nodes: the plain boxes inside it all take the width of the widest. Also allowed at the top of the file for the top level. |
| `nodes` | The boxes inside this box. |

### Arrow styles

`flow` (default, neutral), `yes` (green) and `no` (red) are built in. In a diagram with decisions, green and red already mean Yes and No, so give your own styles other colours (teal for the safest link, orange for the worst), or a Yes branch will read as that style. If the worst case must be red, redefine `yes` and `no` under `styles:` in other colours. A diagram with no decisions may use green and red freely. An arrow has one style: when it carries two meanings (how it is authenticated, and what it may see), pick the one the diagram is about for the style and put the other in the label. In the array form, write `""` for the label when you want a style and no text: `[a, b, "", mtls]`. Declare others under `styles:` with `color`, optional `dash: dashed | dotted`, `width`, `arrow: none`, a `label` for the legend, and a `rank`. **Rank decides which style a merged arrow takes: the highest rank wins.** Give the worst case the highest rank (plaintext above TLS above mTLS), so a closed box never hides a bad link: seven arrows merge into "7 links · 5 plaintext", drawn red.

## Tags: proposals and phases

A tag is a named set of boxes and arrows the reader switches on and off with a chip in the top bar. Use it to show a proposal against what exists, or phases one after another.

```yaml
tags:
  phase1: {label: Phase 1, color: teal, show: false}    # show: false starts hidden
  phase2: {label: Phase 2, color: yellow, show: false}
nodes:
  - {id: cache, label: Read cache, tag: phase1}
  - {id: old_note, label: Not built yet, note: "...", until: phase1}   # retires when phase1 comes on
edges:
  - [api, cache, read-through]                           # hidden while either end is hidden
  - [gw, bus, audit events, flow, phase2]                # an arrow between existing boxes, in a tag
  - {from: gw, to: legacy, style: plain, until: phase2}  # an arrow phase2 removes
```

- **Colour:** pick one no `kind` on the page uses, so tagged things stand out. An arrow carrying a tag is drawn dashed in the tag's colour.
- **Order matters:** `n` switches on the next tag in file order and `p` switches the last one off, so declare phases in the order they are presented.
- **Layout does not move:** a hidden box keeps its place, so nothing jumps when a tag comes on. Check the picture with every tag on (`--show a,b,c`) and with none.
- **Keep what exists untagged.** Tag only what is proposed; use `until` for what a phase takes away.

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

The one level where it usually pays is a top level made of groups. Left alone, a chain of groups becomes a strip. Stack who uses the system on the left, put the system in the middle, and stack what it depends on to the right, and the level fills the screen:

```yaml
nodes:
  - {id: people, label: People, group: true, nodes: [...]}
  - {id: clients, label: Clients, group: true, place: below people, nodes: [...]}
  - {id: system, label: Server, group: true, place: right of clients, nodes: [...]}
  - {id: cloud, label: AWS account, group: true, place: right of system, nodes: [...]}
  - {id: outside, label: Outside, group: true, place: above cloud, nodes: [...]}
```

## How to structure a diagram

- **Think in levels, not pages.** Each box with `nodes` is one screen. Aim for 4 to 10 boxes per level; `check` warns past 16. If a level is crowded, group related boxes into a new box.
- **Declare each arrow once, at the deepest ends you know.** `gateway → orders_api`, not `gateway → orders`. strata draws `gateway → orders` by itself while Orders is closed. Only point an arrow at a container when you genuinely do not know which part inside is the end.
- **File order steers screen order.** Within a level, nodes are placed roughly in the order written (arrows can override it), and an arrow that points back to an earlier node is treated as a loop-back. Write a flow's steps in the order they happen, and write a decision's branches right after the decision.
- **A flow that touches several systems lives in one home box.** Put the flow inside the component that runs it. Where it touches another system, add a small box with `ref: <that system's id>` as a step in the flow, and one arrow from that box to the real system so the dependency shows at the levels above.
- **Use `group` for boundaries, nesting for depth.** Accounts, VPCs and trust zones are groups (always visible). Things with internals worth hiding (a cluster, a namespace, a service, a feature) are plain nested boxes.
- **Heed the legibility warning.** `check` says when a level's titles will be too small to read on an ordinary screen and names the boxes. Shorten those labels or move boxes into a nested box.
- **Keep text short.** Labels of one to three words, `sub` a few words, `detail` lines about 30 characters. Long prose belongs in a `note`.
- **Arrow labels are optional.** Label the protocol or the reason, not the obvious ("calls"). Labels, a decision's Yes and No included, show only when zoomed in far enough; at a distance the colour carries the branch.
- **When a flow step stands for another part of the picture** (a `ref` box), point its arrow at the box where that part begins: the first step of the other flow, or the component itself if it has no flow.

## What to check in the pictures

- Does the top level read in five seconds? If not, there are too many boxes or too many arrows at that level.
- Does each container, opened with `--at`, show its boxes at a readable size? A long chain wraps onto extra rows; if it still reads badly, split it into two nested boxes. A container that comes out as a thin column or strip, using a third of the screen, is the case for setting `flow` on it.
- Is a level still tangled after regrouping? `check --stats` names the levels with the most crossings; try `--twice` on those, and keep it only if the picture is visibly better.
- Every arrow is routed with right angles and goes round boxes. An arrow to something outside the container leaves through the container's frame and ends in a label at the screen edge naming where it goes; that is expected. A label ending in `+1` stands for two boxes at the end of the same line.

## Limits today

- View only. People who open the HTML can zoom, pan, dive, toggle states and follow references; they cannot edit.
- A route never passes behind a box and each arrow meets a container at its own point. By default strata does not rearrange a container to suit what is outside it, so an arrow can still take a long way to the side its target sits on; `--twice` rearranges, within limits.
- `strata facts` reads Go only.
- A top level that is a chain of groups (people, clients, the system, what it depends on) comes out on its own as a wide strip or a tall column using half the screen. State its arrangement instead: see "Stating the arrangement".
- Arrow labels only show once you are zoomed in far enough for them to fit the room the layout kept for them, so a top level can show no labels.
- A decision diamond's arrows attach to its bounding box, so they can stop slightly short of the point.
