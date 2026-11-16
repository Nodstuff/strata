package layout

// Where boxes go on a level the file does not place by hand: a layered placement.
// It places boxes only; every arrow is then drawn by the router in route.go, as on a level whose
// boxes are placed by hand. The method is the usual one for layered pictures:
//   1. an arrow that points to an earlier box in the file is a loop-back, and is turned round
//   2. each box takes the row after its latest predecessor, then moves toward the side it has more arrows on
//   3. an arrow that skips rows gets a small unseen point in each row it passes, so it keeps a lane
//   4. within each row the order is chosen to cross as few arrows as possible (barycentre sweeps, then swaps)
//   5. sideways positions put each box as near the middle of its neighbours as the order allows
//   6. parts with no arrow between them are laid out one by one and packed into a screen-shaped block
// Everything is worked out as if the flow ran down; a flow to the right is the same picture turned.
//
// This is a line-for-line port of layered.js. Where a product is added to something the code
// wraps the product in float64(): Go may otherwise fuse the two into one rounding on arm64 and
// the numbers would differ from the JavaScript in the last bit.

import (
	"fmt"
	"math"
	"slices"
	"sort"

	"strata/internal/jsx"
)

const dummyW = 14

// Box is a box to place, in file order.
type Box struct {
	ID            string
	Width, Height float64
}

// Arrow joins two boxes; Label is the width of its label, or 0.
type Arrow struct {
	A, B  string
	Label float64
}

// Pull says arrows leave the level by Side (0 top, 1 bottom, 2 left, 3 right) for these boxes.
type Pull struct {
	Side int
	Kids []string
}

// Opts are the options of Layered. Zero Aspect and Unit take their JavaScript defaults.
type Opts struct {
	Dir      string // "DOWN" or "RIGHT"
	Ord      string // NODES_AND_EDGES, PREFER_EDGES or NONE
	Wrap     bool
	Aspect   float64
	Unit     float64
	Pulls    []Pull
	Centre   float64
	LayerGap float64
	NodeGap  float64
	CompGap  float64
}

// Rect is a placed box.
type Rect struct {
	ID                  string
	X, Y, Width, Height float64
}

// Placed is what a level's placement returns: the size of the level, where its boxes are, and for
// the layered placement a score (lower is a calmer picture) and how it was made.
type Placed struct {
	Width, Height float64
	Children      []Rect
	Score         float64
	Dir, Ord      string
	Wrap          bool
}

type lnode struct {
	id             string
	key            float64
	w, h, x, y     float64
	dummy, virtual bool
	layer          int
	ins, outs      []*lnode
	up, down       []wedge
	pos            int
	bary           float64
	hasBary        bool
}

type wedge struct {
	n  *lnode
	wt float64
}

type llink struct {
	k     string
	a, b  *lnode
	label float64
}

type lseg struct {
	a, b  *lnode
	label float64
}

type copts struct {
	ord               string
	layerGap, nodeGap float64
	centre            float64
	right             bool
	fold              int
}

func (o copts) labelRoom(w float64) float64 {
	if o.right {
		return math.Min(w, 130)
	}
	return 16
}

// isotonic is least squares with an order to keep: the values closest to t (weights w) that never decrease.
func isotonic(t, w []float64) []float64 {
	type block struct {
		s, w float64
		n    int
	}
	var blocks []block
	for i := range t {
		blocks = append(blocks, block{float64(t[i] * w[i]), w[i], 1})
		for len(blocks) > 1 && blocks[len(blocks)-2].s/blocks[len(blocks)-2].w > blocks[len(blocks)-1].s/blocks[len(blocks)-1].w {
			b := blocks[len(blocks)-1]
			blocks = blocks[:len(blocks)-1]
			a := &blocks[len(blocks)-1]
			a.s += b.s
			a.w += b.w
			a.n += b.n
		}
	}
	var out []float64
	for _, b := range blocks {
		v := b.s / b.w
		for range b.n {
			out = append(out, v)
		}
	}
	return out
}

type compResult struct {
	nodes   []*lnode
	w, h    float64
	wrapped bool
}

func component(nodes []*lnode, links []*llink, o copts) compResult {
	nodes = slices.Clone(nodes)
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].key-nodes[j].key < 0 })
	// 2. rows. nodes are in file order and every link runs from an earlier node to a later one.
	n := len(nodes)
	for _, nd := range nodes {
		nd.layer = 0
		nd.ins, nd.outs = nil, nil
	}
	for _, l := range links {
		l.a.outs = append(l.a.outs, l.b)
		l.b.ins = append(l.b.ins, l.a)
	}
	for _, nd := range nodes {
		for _, p := range nd.ins {
			nd.layer = max(nd.layer, p.layer+1)
		}
	}
	for pass := 0; pass < 4; pass++ {
		for i := n - 1; i >= 0; i-- {
			nd := nodes[i]
			lo, hi := 0, nd.layer
			if len(nd.ins) > 0 {
				m := math.MinInt
				for _, p := range nd.ins {
					m = max(m, p.layer)
				}
				lo = m + 1
			}
			if len(nd.outs) > 0 {
				m := math.MaxInt
				for _, s := range nd.outs {
					m = min(m, s.layer)
				}
				hi = m - 1
			}
			if hi < lo {
				continue
			}
			switch {
			case len(nd.outs) > len(nd.ins):
				nd.layer = hi
			case len(nd.ins) > len(nd.outs):
				nd.layer = lo
			default:
				nd.layer = min(hi, max(lo, nd.layer))
			}
		}
	}
	L := 0
	for _, nd := range nodes {
		L = max(L, nd.layer+1)
	}

	// 3. unseen points on arrows that skip rows; segs are the pieces between neighbouring rows
	all := slices.Clone(nodes)
	var segs []*lseg
	for _, l := range links {
		prev := l.a
		for k := l.a.layer + 1; k < l.b.layer; k++ {
			d := &lnode{dummy: true, key: l.a.key + float64(float64(k-l.a.layer)/float64(l.b.layer-l.a.layer)*(l.b.key-l.a.key)), w: dummyW, h: 0, layer: k}
			all = append(all, d)
			segs = append(segs, &lseg{prev, d, 0})
			prev = d
		}
		segs = append(segs, &lseg{prev, l.b, l.label})
	}
	for _, nd := range all {
		nd.up, nd.down = nil, nil
	}
	// How hard an arrow holds its two ends in line: an arrow that skips rows most, then an arrow in the middle
	// of a flow (something leads to it and something follows), then one at a flow's start or end. So the spine of a flow runs straight and the boxes that end a branch hang beside it.
	const SPINE = 6.0 // measured at 1, 3, 6 and with simpler rules: 6 gave the fewest crossings and the most compact levels
	for _, s := range segs {
		var wt float64
		switch {
		case s.a.dummy && s.b.dummy:
			wt = 8
		case s.a.dummy || s.b.dummy:
			wt = 2
		case len(s.b.outs) > 0 && len(s.a.ins) > 0:
			wt = SPINE
		case len(s.b.outs) > 0 || len(s.a.ins) > 0:
			wt = (SPINE + 1) / 2
		default:
			wt = 1
		}
		s.a.down = append(s.a.down, wedge{s.b, wt})
		s.b.up = append(s.b.up, wedge{s.a, wt})
	}
	rows := make([][]*lnode, L)
	for _, nd := range all {
		rows[nd.layer] = append(rows[nd.layer], nd)
	}
	for _, r := range rows {
		sort.SliceStable(r, func(i, j int) bool { return r[i].key-r[j].key < 0 })
	}
	index := func(rs [][]*lnode) {
		for _, r := range rs {
			for i, nd := range r {
				nd.pos = i
			}
		}
	}
	index(rows)

	// 4. order within rows
	segsAt := make([][]*lseg, L)
	for _, sg := range segs {
		segsAt[sg.a.layer] = append(segsAt[sg.a.layer], sg)
	}
	crossAt := func(k int) int {
		ss := segsAt[k]
		c := 0
		for i := 0; i < len(ss); i++ {
			for j := i + 1; j < len(ss); j++ {
				if (ss[i].a.pos-ss[j].a.pos)*(ss[i].b.pos-ss[j].b.pos) < 0 {
					c++
				}
			}
		}
		return c
	}
	crossings := func() int {
		c := 0
		for k := 0; k < L-1; k++ {
			c += crossAt(k)
		}
		return c
	}
	firm := o.ord == "NODES_AND_EDGES"
	sweep := func(k int, up bool) {
		r := rows[k]
		for _, nd := range r {
			nb := nd.down
			if up {
				nb = nd.up
			}
			if len(nb) > 0 {
				s := 0.0
				for _, e := range nb {
					s += float64(e.n.pos)
				}
				nd.bary, nd.hasBary = s/float64(len(nb)), true
			} else {
				nd.bary, nd.hasBary = 0, false
			}
		}
		// a box with no arrow on this side keeps its place between its neighbours in the row
		for i, nd := range r {
			if !nd.hasBary {
				a := i - 1
				for a >= 0 && !r[a].hasBary {
					a--
				}
				if a >= 0 {
					nd.bary = r[a].bary + 1e-3
				} else {
					nd.bary = -1
				}
				nd.hasBary = true
			}
		}
		sorted := slices.Clone(r)
		sort.SliceStable(sorted, func(i, j int) bool {
			d := sorted[i].bary - sorted[j].bary
			if d == 0 {
				d = sorted[i].key - sorted[j].key
			}
			return d < 0
		})
		if firm { // the file's order stands among the boxes; only the unseen points move between them
			var reals []*lnode
			for _, nd := range r {
				if !nd.dummy {
					reals = append(reals, nd)
				}
			}
			sort.SliceStable(reals, func(i, j int) bool { return reals[i].key-reals[j].key < 0 })
			i := 0
			out := make([]*lnode, len(sorted))
			for x, nd := range sorted {
				if nd.dummy {
					out[x] = nd
				} else {
					out[x] = reals[i]
					i++
				}
			}
			rows[k] = out
		} else {
			rows[k] = sorted
		}
		for i, nd := range rows[k] {
			nd.pos = i
		}
	}
	copyRows := func() [][]*lnode {
		out := make([][]*lnode, len(rows))
		for i, r := range rows {
			out[i] = slices.Clone(r)
		}
		return out
	}
	settleOrder := func() { // sweeps, then neighbour swaps, from the order the rows are in now; leaves the best it saw
		bestC, bestRows := crossings(), copyRows()
		keep := func() {
			if c := crossings(); c < bestC {
				bestC, bestRows = c, copyRows()
			}
		}
		rounds := 4
		switch o.ord {
		case "NONE":
			rounds = 24
		case "PREFER_EDGES":
			rounds = 8
		}
		for it := 0; it < rounds && bestC > 0; it++ {
			if it%2 == 0 {
				for k := 1; k < L; k++ {
					sweep(k, true)
				}
			} else {
				for k := L - 2; k >= 0; k-- {
					sweep(k, false)
				}
			}
			keep()
		}
		rows = bestRows
		index(rows)
		if !firm {
			for again, guard := true, 0; again && guard < 30; guard++ { // swap neighbours while that removes a crossing
				again = false
				for k := 0; k < L; k++ {
					for i := 0; i < len(rows[k])-1; i++ {
						cnt := func() int {
							c := 0
							if k > 0 {
								c += crossAt(k - 1)
							}
							if k < L-1 {
								c += crossAt(k)
							}
							return c
						}
						before := cnt()
						a, b := rows[k][i], rows[k][i+1]
						rows[k][i], rows[k][i+1] = b, a
						a.pos, b.pos = i+1, i
						after := cnt()
						if after < before {
							again = true
						} else {
							rows[k][i], rows[k][i+1] = a, b
							a.pos, b.pos = i, i+1
						}
					}
				}
			}
		}
	}
	settleOrder() // (starting again from shuffled rows was measured: it changes the result and does not improve it)

	// 5. sideways positions (centres)
	for _, r := range rows {
		x := 0.0
		for _, nd := range r {
			nd.x = x + nd.w/2
			x += nd.w + o.nodeGap
		}
		mid := (x - o.nodeGap) / 2
		for _, nd := range r {
			nd.x -= mid
		}
	}
	settle := func(r []*lnode, up, down bool) {
		if len(r) == 0 {
			return
		}
		off := []float64{0}
		for i := 1; i < len(r); i++ {
			gap := o.nodeGap
			if r[i-1].dummy && r[i].dummy {
				gap = 16
			}
			off = append(off, off[i-1]+r[i-1].w/2+r[i].w/2+gap)
		}
		t := make([]float64, 0, len(r))
		w := make([]float64, 0, len(r))
		for i, nd := range r {
			s, ws := 0.0, 0.0
			if up { // the sides in the order the JavaScript lists them: up, then down

				for _, e := range nd.up {
					s += float64(e.n.x * e.wt)
					ws += e.wt
				}
			}
			if down {
				for _, e := range nd.down {
					s += float64(e.n.x * e.wt)
					ws += e.wt
				}
			}
			C := o.centre // a light pull toward the middle keeps a chain from wandering off in a staircase
			if ws != 0 {
				t = append(t, s/(ws+C)-off[i])
				w = append(w, ws+C)
			} else {
				t = append(t, nd.x-off[i])
				w = append(w, 0.05)
			}
		}
		for i, v := range isotonic(t, w) {
			r[i].x = v + off[i]
		}
	}
	for it := 0; it < 8; it++ {
		for k := 1; k < L; k++ {
			settle(rows[k], true, false)
		}
		for k := L - 2; k >= 0; k-- {
			settle(rows[k], false, true)
		}
	}
	for it := 0; it < 4; it++ {
		for k := 0; k < L; k++ {
			settle(rows[k], true, true)
		}
	}

	// rows from top to bottom; an arrow's label needs room between the rows it joins
	tall := make([]float64, L)
	room := make([]float64, L)
	for k, r := range rows {
		m := 0.0
		for _, nd := range r {
			m = math.Max(m, nd.h)
		}
		tall[k] = m
	}
	for _, s := range segs {
		if s.label != 0 {
			room[s.a.layer] = math.Max(room[s.a.layer], o.labelRoom(s.label))
		}
	}
	y := 0.0
	top := make([]float64, 0, L)
	for k := 0; k < L; k++ {
		top = append(top, y)
		y += tall[k] + o.layerGap + room[k]
	}
	for _, nd := range nodes {
		nd.y = top[nd.layer] + tall[nd.layer]/2
	}
	real := nodes[:0:0]
	for _, nd := range nodes {
		if !nd.virtual { // the unseen points of a pull have done their work
			real = append(real, nd)
		}
	}
	nodes = real

	// a long chain folds: the rows are cut into runs and the runs set side by side (o.fold = how many runs)
	wrapped := false
	if o.fold > 1 && L >= 2*o.fold {
		per := int(math.Ceil(float64(L) / float64(o.fold)))
		shift := 0.0
		for c := 0; c*per < L; c++ {
			var mine []*lnode
			for _, nd := range nodes {
				if nd.layer/per == c {
					mine = append(mine, nd)
				}
			}
			if len(mine) == 0 {
				continue
			}
			x0, x1 := math.Inf(1), math.Inf(-1)
			for _, nd := range mine {
				x0 = math.Min(x0, nd.x-nd.w/2)
				x1 = math.Max(x1, nd.x+nd.w/2)
			}
			y0 := top[c*per]
			for _, nd := range mine {
				nd.x += shift - x0
				nd.y -= y0
			}
			shift += x1 - x0 + o.layerGap + 24
		}
		wrapped = true
	}
	x0, y0 := math.Inf(1), math.Inf(1)
	for _, nd := range nodes {
		x0 = math.Min(x0, nd.x-nd.w/2)
		y0 = math.Min(y0, nd.y-nd.h/2)
	}
	w, h := math.Inf(-1), math.Inf(-1)
	for _, nd := range nodes {
		nd.x -= x0
		nd.y -= y0
	}
	for _, nd := range nodes {
		w = math.Max(w, nd.x+nd.w/2)
		h = math.Max(h, nd.y+nd.h/2)
	}
	return compResult{nodes, w, h, wrapped}
}

type extraSet struct {
	nodes []*lnode
	links []*llink
}

type part struct {
	nodes []*lnode
	w, h  float64
	turn  bool
	x, y  float64
	lean  [2]float64
}

// Layered places boxes (in file order) joined by arrows. It returns what the layout engine would,
// with a score. pulls are arrows that leave this level by a side, and the boxes they are for.
func Layered(boxes []Box, arrows []Arrow, op Opts) *Placed {
	aspect, unit := op.Aspect, op.Unit
	if aspect == 0 {
		aspect = 1.7
	}
	if unit == 0 {
		unit = 100
	}
	pulls := op.Pulls
	right := op.Dir == "RIGHT"
	nodes := make([]*lnode, len(boxes))
	by := map[string]*lnode{}
	for i, b := range boxes {
		nd := &lnode{id: b.ID, key: float64(i), w: b.Width, h: b.Height}
		if right {
			nd.w, nd.h = b.Height, b.Width
		}
		nodes[i] = nd
		by[b.ID] = nd
	}
	seen := map[string]*llink{}
	var links []*llink
	for _, e := range arrows {
		a, b := by[e.A], by[e.B]
		if a == nil || b == nil || a == b {
			continue
		}
		if a.key > b.key { // 1. a loop-back
			a, b = b, a
		}
		k := fmt.Sprintf("%d>%d", int(a.key), int(b.key))
		if l, ok := seen[k]; ok {
			l.label = math.Max(l.label, e.Label)
			continue
		}
		l := &llink{k: k, a: a, b: b, label: e.Label}
		seen[k] = l
		links = append(links, l)
	}
	// 6. parts with no arrow between them
	root := map[*lnode]*lnode{}
	for _, nd := range nodes {
		root[nd] = nd
	}
	find := func(nd *lnode) *lnode {
		for root[nd] != nd {
			root[nd] = root[root[nd]]
			nd = root[nd]
		}
		return nd
	}
	for _, l := range links {
		ra := find(l.a)
		rb := find(l.b)
		root[ra] = rb
	}
	var groupOrder []*lnode
	groups := map[*lnode][]*lnode{}
	for _, nd := range nodes {
		r := find(nd)
		if _, ok := groups[r]; !ok {
			groupOrder = append(groupOrder, r)
		}
		groups[r] = append(groups[r], nd)
	}
	o := copts{ord: op.Ord, layerGap: op.LayerGap, nodeGap: op.NodeGap, centre: op.Centre, right: right}
	// A pull along the flow is an unseen point before the first row or after the last, tied to its boxes.
	// (Sides are turned for a flow to the right.)
	extra := map[*lnode]*extraSet{}
	vk := 0
	for _, p := range pulls {
		side := p.Side
		if right {
			side = [4]int{2, 3, 0, 1}[p.Side]
		}
		var kids []*lnode
		for _, id := range p.Kids {
			if k := by[id]; k != nil {
				kids = append(kids, k)
			}
		}
		if len(kids) == 0 {
			continue
		}
		if side >= 2 { // across the flow: settled at the end, by turning the whole picture over if that brings the boxes nearer
			continue
		}
		var partOrder []*lnode
		byPart := map[*lnode][]*lnode{}
		for _, k := range kids {
			r := find(k)
			if _, ok := byPart[r]; !ok {
				partOrder = append(partOrder, r)
			}
			byPart[r] = append(byPart[r], k)
		}
		for _, r := range partOrder {
			ks := byPart[r]
			id := fmt.Sprintf("pull:%d", vk)
			vk++
			key := 1e6 + float64(vk)
			if side == 0 {
				key = -1 - float64(vk)
			}
			v := &lnode{id: id, virtual: true, key: key, w: 1, h: 0}
			ex := extra[r]
			if ex == nil {
				ex = &extraSet{}
				extra[r] = ex
			}
			ex.nodes = append(ex.nodes, v)
			for _, k := range ks {
				if side == 0 {
					ex.links = append(ex.links, &llink{a: v, b: k})
				} else {
					ex.links = append(ex.links, &llink{a: k, b: v})
				}
			}
		}
	}
	parts := make([]*part, 0, len(groupOrder))
	for _, gr := range groupOrder {
		g := groups[gr]
		var mine []*llink
		for _, l := range links {
			if find(l.a) == find(g[0]) {
				mine = append(mine, l)
			}
		}
		ex := extra[find(g[0])]
		if ex == nil {
			ex = &extraSet{}
		}
		fo := o
		fo.fold = 1
		p := component(append(slices.Clone(g), ex.nodes...), append(slices.Clone(mine), ex.links...), fo)
		if op.Wrap { // fold a strip onto the number of runs that comes nearest a screen's shape
			shape := func(q compResult) float64 {
				w, h := q.w, q.h
				if right {
					w, h = q.h, q.w
				}
				return math.Abs(math.Log(w / h / aspect))
			}
			for fold := 2; fold <= 4; fold++ {
				snap := make([][2]float64, len(g))
				for i, nd := range g {
					snap[i] = [2]float64{nd.x, nd.y}
				}
				fo.fold = fold
				q := component(g, mine, fo)
				if q.wrapped && shape(q) < shape(p) {
					p = q
				} else {
					for i, nd := range g {
						nd.x, nd.y = snap[i][0], snap[i][1]
					}
				}
			}
		}
		if right {
			parts = append(parts, &part{nodes: g, w: p.h, h: p.w, turn: true})
		} else {
			parts = append(parts, &part{nodes: g, w: p.w, h: p.h})
		}
	}
	for _, p := range parts {
		if p.turn {
			for _, nd := range p.nodes {
				nd.x, nd.y = nd.y, nd.x
				nd.w, nd.h = nd.h, nd.w
			}
		}
	}
	// pack the parts in rows, the widest row about `aspect` times as wide as the block is tall
	area := 0.0
	maxW := math.Inf(-1)
	for _, p := range parts {
		area += float64((p.w + op.CompGap) * (p.h + op.CompGap))
		maxW = math.Max(maxW, p.w)
	}
	limit := math.Max(maxW, math.Sqrt(area*aspect))
	// Parts that arrows leave upward go in the first rows and those that leave downward in the last; within a
	// row, leftward first. With no pulls every part leans 0 and the file's order stands.
	for _, pl := range pulls {
		for _, id := range pl.Kids {
			k := by[id]
			if k == nil {
				continue
			}
			for _, p := range parts {
				if slices.Contains(p.nodes, k) {
					i := 0
					if pl.Side < 2 {
						i = 1
					}
					if pl.Side%2 != 0 {
						p.lean[i]++
					} else {
						p.lean[i]--
					}
					break
				}
			}
		}
	}
	queue := slices.Clone(parts)
	sort.SliceStable(queue, func(i, j int) bool { return jsx.Sign(queue[i].lean[1])-jsx.Sign(queue[j].lean[1]) < 0 })
	// Several row widths are tried and the block that needs the least of a screen is kept.
	type packing struct {
		at   map[*part][2]float64
		need float64
	}
	packAt := func(lim float64) packing {
		rowsOf := [][]*part{{}}
		x := 0.0
		for _, p := range queue {
			if x > 0 && x+p.w > lim {
				x = 0
				rowsOf = append(rowsOf, nil)
			}
			rowsOf[len(rowsOf)-1] = append(rowsOf[len(rowsOf)-1], p)
			x += p.w + op.CompGap
		}
		y, W := 0.0, 0.0
		at := map[*part][2]float64{}
		for _, row := range rowsOf {
			sort.SliceStable(row, func(i, j int) bool { return jsx.Sign(row[i].lean[0])-jsx.Sign(row[j].lean[0]) < 0 })
			x = 0
			rowH := 0.0
			for _, p := range row {
				at[p] = [2]float64{x, y}
				x += p.w + op.CompGap
				rowH = math.Max(rowH, p.h)
			}
			W = math.Max(W, x-op.CompGap)
			y += rowH + op.CompGap
		}
		return packing{at, math.Max(W/aspect, y-op.CompGap)}
	}
	widths := []float64{limit}
	{
		x := 0.0
		for _, p := range queue {
			x += p.w
			if !slices.Contains(widths, x+1) {
				widths = append(widths, x+1)
			}
			x += op.CompGap
		}
	}
	var pack *packing
	for _, lim := range widths {
		if lim < maxW {
			continue
		}
		t := packAt(lim)
		if pack == nil || t.need < pack.need-0.5 {
			pack = &t
		}
	}
	for _, p := range parts {
		xy := pack.at[p]
		for _, nd := range p.nodes {
			nd.x += xy[0]
			nd.y += xy[1]
		}
	}
	width, height := math.Inf(-1), math.Inf(-1)
	for _, nd := range nodes {
		width = math.Max(width, nd.x+nd.w/2)
		height = math.Max(height, nd.y+nd.h/2)
	}

	// How calm the picture is, judged before any arrow is drawn. A straight line stands in for each arrow,
	// and for each arrow that leaves the level, a straight line from its box to the side it leaves by.
	type line struct {
		a, b   *lnode // b is nil for a line that leaves the level
		bx, by float64
		ends   []*lnode
		away   bool
	}
	judge := func() float64 {
		var lines []line
		for _, l := range links {
			lines = append(lines, line{a: l.a, b: l.b, bx: l.b.x, by: l.b.y, ends: []*lnode{l.a, l.b}})
		}
		for _, p := range pulls {
			for _, id := range p.Kids {
				k := by[id]
				if k == nil {
					continue
				}
				pts := [4][2]float64{{k.x, 0}, {k.x, height}, {0, k.y}, {width, k.y}}
				lines = append(lines, line{a: k, bx: pts[p.Side][0], by: pts[p.Side][1], ends: []*lnode{k}, away: true})
			}
		}
		length, bends, crossings := 0.0, 0, 0
		hit := func(l line, c *lnode) bool { // does the straight line pass through box c (not one of its ends)?
			for t := 0.1; t < 1; t += 0.1 {
				px := l.a.x + float64((l.bx-l.a.x)*t)
				py := l.a.y + float64((l.by-l.a.y)*t)
				if px > c.x-c.w/2 && px < c.x+c.w/2 && py > c.y-c.h/2 && py < c.y+c.h/2 {
					return true
				}
			}
			return false
		}
		for _, l := range lines {
			if l.away {
				d := l.a.w
				if l.a.x == l.bx {
					d = l.a.h
				}
				length += math.Abs(l.a.x-l.bx) + math.Abs(l.a.y-l.by) - d/2
			} else {
				dx := math.Max(0, math.Abs(l.a.x-l.bx)-(l.a.w+l.b.w)/2)
				dy := math.Max(0, math.Abs(l.a.y-l.by)-(l.a.h+l.b.h)/2)
				length += dx + dy
				if dx > 0 && dy > 0 {
					bends += 2
				}
			}
			for _, c := range nodes {
				if !slices.Contains(l.ends, c) && hit(l, c) {
					bends += 2
					length += math.Min(c.w, c.h)
				}
			}
		}
		side := func(px, py, qx, qy, rx, ry float64) float64 {
			return jsx.Sign(float64((qx-px)*(ry-py)) - float64((qy-py)*(rx-px)))
		}
		for i := 0; i < len(lines); i++ {
			for j := i + 1; j < len(lines); j++ {
				p, q := lines[i], lines[j]
				shared := false
				for _, e := range p.ends {
					if slices.Contains(q.ends, e) {
						shared = true
						break
					}
				}
				if shared {
					continue
				}
				if side(p.a.x, p.a.y, p.bx, p.by, q.a.x, q.a.y)*side(p.a.x, p.a.y, p.bx, p.by, q.bx, q.by) < 0 &&
					side(q.a.x, q.a.y, q.bx, q.by, p.a.x, p.a.y)*side(q.a.x, q.a.y, q.bx, q.by, p.bx, p.by) < 0 {
					crossings++
				}
			}
		}
		need := math.Max(width/1.7, height)
		s := length / unit
		s += float64(0.7 * float64(bends))
		s += float64(5 * float64(crossings))
		s += float64((8 + float64(1.3*float64(len(links)))) * math.Log(need/unit))
		return s
	}
	// Left and right mean nothing to a flow that runs down (nor up and down to one that runs right), so the
	// picture may be turned over across its flow. It is, when the arrows that leave make that the calmer picture.
	score := judge()
	if len(pulls) > 0 {
		flip := func() {
			for _, nd := range nodes {
				if right {
					nd.y = height - nd.y
				} else {
					nd.x = width - nd.x
				}
			}
		}
		flip()
		if turned := judge(); turned < score-0.01 {
			score = turned
		} else {
			flip()
		}
	}
	children := make([]Rect, len(nodes))
	for i, nd := range nodes {
		children[i] = Rect{ID: nd.id, X: nd.x - nd.w/2, Y: nd.y - nd.h/2, Width: nd.w, Height: nd.h}
	}
	return &Placed{Width: width, Height: height, Children: children, Score: score}
}
