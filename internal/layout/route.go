package layout

import (
	"math"
	"slices"
	"sort"

	"github.com/Nodstuff/strata/internal/jsx"
	"github.com/Nodstuff/strata/internal/model"
)

// The router: a right-angle path between two sets of points, round every box.
// A port-for-port translation of route() in layout.js. Floating-point products that feed a sum are
// wrapped in float64() so Go cannot fuse them (see layered.go).

const (
	closedW = 230.0 // the box a closed container is drawn as
	closedH = 180.0
	fit     = 0.3 // a closed container must stay under this share of its parent, so it is still closed when the parent fills the screen
	side    = 38.0
	bottom  = 38.0
	cross   = 10.0 // what crossing another arrow costs the router; raising it was measured and does not lower the count
	clear   = 13.0 // how far a routed line stays from a box
	lane    = 9.0  // and from the next line in the same channel
)

// wide and stretch are variables, not constants, so that sums such as wide+0.3 are computed in
// float64 at run time exactly as the JavaScript does (constant arithmetic in Go is exact).
var (
	wide    = 1.55
	stretch = [4]float64{1.5, 2.1, 2.8, 3.6} // a level narrower than a screen has its gaps widened sideways until it is about screen-shaped
	gapOf   = map[string]float64{"none": 0, "tight": 24, "normal": 58, "wide": 112}
)

type pt = [2]float64

// endpoint is a place an arrow may start or end: a point on a border, the point `clear` beyond it, and what using it costs.
type endpoint struct {
	at, out pt
	cost    float64
	tail    []pt
	head    []pt
	joined  bool
}

// seg is a drawn segment of an arrow, kept so later arrows can keep clear of it.
type seg struct {
	a, b pt
	tag  string
	grp  []string
}

type join struct{ into, outof [][]pt }

// sidesOf is where an arrow may meet a box: the middle and the quarter points of each side, and also the
// points in line with where the arrow is going (toward), so an arrow to something straight below leaves straight down.
func sidesOf(b *model.Node, toward []pt) []endpoint {
	var out []endpoint
	add := func(hasX bool, x float64, hasY bool, y float64, cost float64) {
		if hasX {
			out = append(out, endpoint{at: pt{x, b.Y}, out: pt{x, b.Y - clear}, cost: cost}, endpoint{at: pt{x, b.Y + b.H}, out: pt{x, b.Y + b.H + clear}, cost: cost})
		}
		if hasY {
			out = append(out, endpoint{at: pt{b.X, y}, out: pt{b.X - clear, y}, cost: cost}, endpoint{at: pt{b.X + b.W, y}, out: pt{b.X + b.W + clear, y}, cost: cost})
		}
	}
	fs := [][2]float64{{0.5, 0}, {0.25, 6}, {0.75, 6}}
	if b.Shape == "diamond" {
		fs = fs[:1]
	}
	for _, fc := range fs {
		add(true, b.X+float64(b.W*fc[0]), true, b.Y+float64(b.H*fc[0]), fc[1])
	}
	if b.Shape != "diamond" {
		for _, t := range toward {
			m := math.Min(16, math.Min(b.W/4, b.H/4))
			hasX := t[0] > b.X+m && t[0] < b.X+b.W-m
			hasY := t[1] > b.Y+m && t[1] < b.Y+b.H-m
			var x, y float64
			if hasX {
				x = jsx.R1(t[0])
			}
			if hasY {
				y = jsx.R1(t[1])
			}
			add(hasX, x, hasY, y, 2)
		}
	}
	return out
}

func centre(b *model.Node) pt { return pt{b.X + b.W/2, b.Y + b.H/2} }

// portAt: a port on side 0 top, 1 bottom, 2 left, 3 right of a W x H space, u along the side; the route arrives square on.
func portAt(sd int, u, W, H float64) pt {
	switch sd {
	case 0:
		return pt{u, 0}
	case 1:
		return pt{u, H}
	case 2:
		return pt{0, u}
	}
	return pt{W, u}
}

func portGoal(sd int, u, W, H, cost float64) endpoint {
	var out pt
	switch sd {
	case 0:
		out = pt{u, clear}
	case 1:
		out = pt{u, H - clear}
	case 2:
		out = pt{clear, u}
	default:
		out = pt{W - clear, u}
	}
	return endpoint{at: portAt(sd, u, W, H), cost: cost, out: out}
}

func sideOfPort(p pt, W, H float64) int {
	d := [4]float64{math.Abs(p[1]), math.Abs(H - p[1]), math.Abs(p[0]), math.Abs(W - p[0])}
	best := 0
	for i := 1; i < 4; i++ {
		if d[i] < d[best] {
			best = i
		}
	}
	return best
}

func far(p, q pt) float64 { return math.Abs(p[0]-q[0]) + math.Abs(p[1]-q[1]) }

func along(m []pt) float64 {
	n := 0.0
	for i := 0; i+1 < len(m); i++ {
		n += far(m[i], m[i+1])
	}
	return n
}

func anyShared(a, b []string) bool {
	for _, g := range a {
		if slices.Contains(b, g) {
			return true
		}
	}
	return false
}

type lineSet struct{ near, over, kin []seg }

func lap(a0, a1, b0, b1 float64) float64 {
	return math.Max(0, math.Min(math.Max(a0, a1), math.Max(b0, b1))-math.Max(math.Min(a0, a1), math.Min(b0, b1)))
}

const bendCost = 40.0

// route finds a right-angle path from any of starts to any of goals round walls, or nil. occ holds the
// segments already drawn in this container; running along one that belongs to a different arrow is
// expensive, so parallel arrows take neighbouring lanes instead of one line.
func route(starts, goals []endpoint, walls []*model.Node, W, H float64, occ []seg, tag string, grp []string, jn *join) []pt {
	inside := func(x, y float64, w *model.Node) bool {
		return x > w.X-clear+1 && x < w.X+w.W+clear-1 && y > w.Y-clear+1 && y < w.Y+w.H+clear-1
	}
	ok := func(x, y float64) bool {
		for _, w := range walls {
			if inside(x, y, w) {
				return false
			}
		}
		return true
	}
	lanes := func(lo, hi float64) []float64 {
		var out []float64
		for k := 0.0; k < 3; k++ {
			out = append(out, lo-clear-float64(k*lane), hi+clear+float64(k*lane))
		}
		return out
	}
	axis := func(vals []float64, max float64) []float64 {
		seen := map[float64]bool{}
		var out []float64
		for _, v := range vals {
			v = jsx.R1(v)
			if seen[v] {
				continue
			}
			seen[v] = true
			if v >= clear-1 && v <= max-clear+1 {
				out = append(out, v)
			}
		}
		sort.Float64s(out)
		return out
	}
	ends := append(slices.Clone(starts), goals...)
	// Arrows of one family (same style, into the same box or out of the same box) may share a line:
	// running along a relative is cheaper than a lane of its own, so they gather into one trunk near the box.
	kin := func(s seg) bool { return grp != nil && s.grp != nil && anyShared(s.grp, grp) }
	var rest, others, mates []seg
	for _, s := range occ {
		if s.tag != tag {
			rest = append(rest, s)
		}
	}
	for _, s := range rest {
		if kin(s) {
			mates = append(mates, s)
		} else {
			others = append(others, s)
		}
	}
	var hor, ver, mhor, mver []seg
	for _, s := range others {
		if s.a[1] == s.b[1] {
			hor = append(hor, s)
		}
		if s.a[0] == s.b[0] {
			ver = append(ver, s)
		}
	}
	for _, s := range mates {
		if s.a[1] == s.b[1] {
			mhor = append(mhor, s)
		}
		if s.a[0] == s.b[0] {
			mver = append(mver, s)
		}
	}
	var kinLines []pt
	if jn != nil {
		for _, m := range jn.into {
			kinLines = append(kinLines, m...)
		}
		for _, m := range jn.outof {
			kinLines = append(kinLines, m...)
		}
	}
	xv := []float64{clear, W - clear}
	yv := []float64{clear, H - clear}
	for _, s := range ends {
		xv = append(xv, s.out[0])
		yv = append(yv, s.out[1])
	}
	for _, w := range walls {
		xv = append(xv, lanes(w.X, w.X+w.W)...)
	}
	for _, s := range mver {
		xv = append(xv, s.a[0])
	}
	for _, p := range kinLines {
		xv = append(xv, p[0])
	}
	for _, w := range walls {
		yv = append(yv, lanes(w.Y, w.Y+w.H)...)
	}
	for _, s := range mhor {
		yv = append(yv, s.a[1])
	}
	for _, p := range kinLines {
		yv = append(yv, p[1])
	}
	xs, ys := axis(xv, W), axis(yv, H)
	xi, yi := make(map[float64]int, len(xs)), make(map[float64]int, len(ys))
	for i, v := range xs {
		xi[v] = i
	}
	for i, v := range ys {
		yi[v] = i
	}
	NY := len(ys)
	// A hub's arrows form a tree. An arrow into a box may end on a relative's line and ride it the
	// rest of the way in; an arrow out of a box may begin on a relative's line. Not on the stretch
	// next to the relative's own far end, where it would read as coming from that box.
	onLine := func(m []pt, i int) []pt { // the grid points on segment i of a relative's route
		a, b := m[i], m[i+1]
		var out []pt
		if math.Abs(a[1]-b[1]) < 0.05 {
			for _, x := range xs {
				if x >= math.Min(a[0], b[0])-0.05 && x <= math.Max(a[0], b[0])+0.05 {
					out = append(out, pt{x, jsx.R1(a[1])})
				}
			}
		} else {
			for _, y := range ys {
				if y >= math.Min(a[1], b[1])-0.05 && y <= math.Max(a[1], b[1])+0.05 {
					out = append(out, pt{jsx.R1(a[0]), y})
				}
			}
		}
		return out
	}
	starts, goals = slices.Clone(starts), slices.Clone(goals)
	if jn != nil {
		for _, m := range jn.into {
			for i := 0; i < len(m)-1; i++ {
				for _, P := range onLine(m, i) {
					if i == 0 {
						continue // the stretch that leaves the relative's own box: a line joining there reads as going to that box
					}
					tail := append([]pt{P}, m[i+1:]...)
					goals = append(goals, endpoint{at: P, out: P, cost: float64(0.3*along(tail)) - 14, tail: m[i+1:], joined: true})
				}
			}
		}
		for _, m := range jn.outof {
			for i := 0; i < len(m)-1; i++ {
				for _, P := range onLine(m, i) {
					n := len(m) - 1
					if i == n-1 {
						continue
					}
					head := append([]pt(nil), m[:i+1]...)
					starts = append(starts, endpoint{at: P, out: P, cost: float64(0.3*along(append(slices.Clone(head), P))) - 14, head: head, joined: true})
				}
			}
		}
	}
	// The lines that can matter to a step along one row (or one column) are picked out once per row (column).
	rowOf, colOf := map[float64]*lineSet{}, map[float64]*lineSet{}
	alongRow := func(y float64) *lineSet {
		r := rowOf[y]
		if r == nil {
			r = &lineSet{}
			for _, s := range hor {
				if math.Abs(s.a[1]-y) < lane-2 {
					r.near = append(r.near, s)
				}
			}
			for _, s := range ver {
				if y > math.Min(s.a[1], s.b[1]) && y < math.Max(s.a[1], s.b[1]) {
					r.over = append(r.over, s)
				}
			}
			for _, s := range mhor {
				if math.Abs(s.a[1]-y) < 0.06 {
					r.kin = append(r.kin, s)
				}
			}
			rowOf[y] = r
		}
		return r
	}
	alongCol := func(x float64) *lineSet {
		r := colOf[x]
		if r == nil {
			r = &lineSet{}
			for _, s := range ver {
				if math.Abs(s.a[0]-x) < lane-2 {
					r.near = append(r.near, s)
				}
			}
			for _, s := range hor {
				if x > math.Min(s.a[0], s.b[0]) && x < math.Max(s.a[0], s.b[0]) {
					r.over = append(r.over, s)
				}
			}
			for _, s := range mver {
				if math.Abs(s.a[0]-x) < 0.06 {
					r.kin = append(r.kin, s)
				}
			}
			colOf[x] = r
		}
		return r
	}
	stepCost := func(x0, y0, x1, y1 float64) float64 { // length, plus riding on or crossing another arrow's line
		c := math.Abs(x1-x0) + math.Abs(y1-y0)
		if y0 == y1 {
			r, lo, hi := alongRow(y0), math.Min(x0, x1), math.Max(x0, x1)
			for _, s := range r.near {
				c += float64(4 * lap(x0, x1, s.a[0], s.b[0]))
			}
			for _, s := range r.over {
				if s.a[0] > lo && s.a[0] < hi {
					c += cross
				}
			}
			on := 0.0
			for _, s := range r.kin {
				on = math.Max(on, lap(x0, x1, s.a[0], s.b[0]))
			}
			c -= float64(0.62 * on)
		} else {
			r, lo, hi := alongCol(x0), math.Min(y0, y1), math.Max(y0, y1)
			for _, s := range r.near {
				c += float64(4 * lap(y0, y1, s.a[1], s.b[1]))
			}
			for _, s := range r.over {
				if s.a[1] > lo && s.a[1] < hi {
					c += cross
				}
			}
			on := 0.0
			for _, s := range r.kin {
				on = math.Max(on, lap(y0, y1, s.a[1], s.b[1]))
			}
			c -= float64(0.62 * on)
		}
		return c
	}
	meets := func(s endpoint) bool {
		for _, m := range mates {
			if (math.Abs(m.a[0]-s.at[0]) < 0.06 && math.Abs(m.a[1]-s.at[1]) < 0.06) || (math.Abs(m.b[0]-s.at[0]) < 0.06 && math.Abs(m.b[1]-s.at[1]) < 0.06) {
				return true
			}
		}
		return false
	}
	stub := func(s endpoint) float64 {
		if s.joined {
			return s.cost
		}
		extra := 0.0
		if meets(s) {
			extra = -45
		}
		return s.cost + extra + stepCost(s.at[0], s.at[1], s.out[0], s.out[1]) - math.Abs(s.at[0]-s.out[0]) - math.Abs(s.at[1]-s.out[1]) // leaving a box on another arrow's line; a relative's meeting point is the place to join
	}
	heading := func(f, t pt) int { // 0 up, 1 right, 2 down, 3 left
		switch {
		case t[1] < f[1]:
			return 0
		case t[1] > f[1]:
			return 2
		case t[0] < f[0]:
			return 3
		}
		return 1
	}
	goalAt := map[int][]int{}
	for gi, g := range goals {
		i, iok := xi[jsx.R1(g.out[0])]
		j, jok := yi[jsx.R1(g.out[1])]
		if iok && jok && ok(g.out[0], g.out[1]) {
			k := i*NY + j
			goalAt[k] = append(goalAt[k], gi)
		}
	}
	if len(goalAt) == 0 {
		return nil
	}
	NX := len(xs)
	DONE := NX * NY * 4 // keys from here up stand for "arrived at goal n"
	// What the search asks again and again is worked out once per grid point and per grid step:
	// whether it is clear of every box, and what the step costs (the same in both directions).
	free, openH, openV := make([]int8, NX*NY), make([]int8, NX*NY), make([]int8, NX*NY)
	costH, costV := make([]float64, NX*NY), make([]float64, NX*NY)
	for i := range costH {
		costH[i], costV[i] = math.NaN(), math.NaN()
	}
	isClear := func(i, j int) bool {
		c := i*NY + j
		if free[c] == 0 {
			if ok(xs[i], ys[j]) {
				free[c] = 1
			} else {
				free[c] = 2
			}
		}
		return free[c] == 1
	}
	open := func(i, j, ni, nj int) bool { // the step between two neighbouring grid points: its middle and its far end are clear
		c := min(i, ni)*NY + min(j, nj)
		a := openH
		if i == ni {
			a = openV
		}
		if a[c] == 0 {
			if ok((xs[i]+xs[ni])/2, (ys[j]+ys[nj])/2) {
				a[c] = 1
			} else {
				a[c] = 2
			}
		}
		return a[c] == 1 && isClear(ni, nj)
	}
	step := func(i, j, ni, nj int) float64 {
		c := min(i, ni)*NY + min(j, nj)
		a := costH
		if i == ni {
			a = costV
		}
		if math.IsNaN(a[c]) {
			a[c] = stepCost(xs[i], ys[j], xs[ni], ys[nj])
		}
		return a[c]
	}
	// Dijkstra over (column, row, heading) with a binary heap; a bend costs as much as a long detour
	total := DONE + len(goals)
	dist, prev := make([]float64, total), make([]int, total)
	for i := range dist {
		dist[i] = math.Inf(1)
	}
	hc, hk, hn := make([]float64, 1024), make([]int, 1024), 0 // the heap: costs and keys side by side
	push := func(c float64, k, from int) {
		if dist[k] <= c {
			return
		}
		dist[k] = c
		prev[k] = from
		if hn == len(hc) {
			hc = append(hc, make([]float64, hn)...)
			hk = append(hk, make([]int, hn)...)
		}
		n := hn
		hn++
		for n > 0 {
			p := (n - 1) >> 1
			if hc[p] <= c {
				break
			}
			hc[n], hk[n] = hc[p], hk[p]
			n = p
		}
		hc[n], hk[n] = c, k
	}
	var topC float64
	var topK int
	pop := func() { // leaves the least entry in topC, topK
		topC, topK = hc[0], hk[0]
		hn--
		if hn > 0 {
			c, k := hc[hn], hk[hn]
			n := 0
			for {
				m := 2*n + 1
				if m >= hn {
					break
				}
				if m+1 < hn && hc[m+1] < hc[m] {
					m++
				}
				if hc[m] >= c {
					break
				}
				hc[n], hk[n] = hc[m], hk[m]
				n = m
			}
			hc[n], hk[n] = c, k
		}
	}
	for si, s := range starts {
		i, iok := xi[jsx.R1(s.out[0])]
		j, jok := yi[jsx.R1(s.out[1])]
		if !iok || !jok || !ok(s.out[0], s.out[1]) {
			continue
		}
		if s.joined {
			for h := 0; h < 4; h++ {
				push(stub(s), (i*NY+j)*4+h, -1-si)
			}
			continue
		}
		push(stub(s), (i*NY+j)*4+heading(s.at, s.out), -1-si)
	}
	dx, dy := [4]int{0, 1, 0, -1}, [4]int{-1, 0, 1, 0}
	end := -1
	var goal *endpoint
	found := false
	for hn > 0 {
		pop()
		c, k := topC, topK
		if c > dist[k] {
			continue
		}
		if k >= DONE {
			goal = &goals[k-DONE]
			end = prev[k]
			found = true
			break
		}
		cell, d := k>>2, k&3
		i, j := cell/NY, cell%NY
		for _, gi := range goalAt[cell] {
			g := &goals[gi]
			b := bendCost
			if g.joined || heading(g.out, g.at) == d {
				b = 0
			}
			push(c+stub(*g)+b, DONE+gi, k)
		}
		for nd := 0; nd < 4; nd++ {
			if (nd+2)%4 == d {
				continue
			}
			ni, nj := i+dx[nd], j+dy[nd]
			if ni < 0 || nj < 0 || ni >= NX || nj >= NY {
				continue
			}
			if !open(i, j, ni, nj) {
				continue
			}
			b := bendCost
			if nd == d {
				b = 0
			}
			push(c+step(i, j, ni, nj)+b, (ni*NY+nj)*4+nd, k)
		}
	}
	if !found {
		return nil
	}
	var from *endpoint
	pts := []pt{goal.at, goal.out}
	for k := end; ; {
		cell := k >> 2
		pts = append(pts, pt{xs[cell/NY], ys[cell%NY]})
		p := prev[k]
		if p < 0 {
			from = &starts[-1-p]
			pts = append(pts, from.at)
			break
		}
		k = p
	}
	slices.Reverse(pts)
	out := []pt{pts[0]} // drop points that lie on a straight run
	for i := 1; i < len(pts); i++ {
		a, b := out[len(out)-1], pts[i]
		if math.Abs(a[0]-b[0]) < 0.05 && math.Abs(a[1]-b[1]) < 0.05 {
			continue
		}
		if i+1 < len(pts) {
			c := pts[i+1]
			if (math.Abs(a[0]-b[0]) < 0.05 && math.Abs(b[0]-c[0]) < 0.05) || (math.Abs(a[1]-b[1]) < 0.05 && math.Abs(b[1]-c[1]) < 0.05) {
				continue
			}
		}
		out = append(out, b)
	}
	var whole []pt
	if from != nil {
		whole = append(whole, from.head...)
	}
	whole = append(whole, out...)
	whole = append(whole, goal.tail...)
	for i, p := range whole {
		whole[i] = pt{jsx.R1(p[0]), jsx.R1(p[1])}
	}
	var tidy []pt // no repeated points, and no point in the middle of a straight run
	for i := range whole {
		b := whole[i]
		if len(tidy) > 0 {
			a := tidy[len(tidy)-1]
			if far(a, b) < 0.06 {
				continue
			}
			if i+1 < len(whole) {
				c := whole[i+1]
				if (math.Abs(a[0]-b[0]) < 0.06 && math.Abs(b[0]-c[0]) < 0.06) || (math.Abs(a[1]-b[1]) < 0.06 && math.Abs(b[1]-c[1]) < 0.06) {
					continue
				}
			}
		}
		tidy = append(tidy, b)
	}
	return tidy
}

func occupy(occ []seg, pts []pt, tag string, grp []string) []seg {
	for i := 0; i+1 < len(pts); i++ {
		occ = append(occ, seg{a: pts[i], b: pts[i+1], tag: tag, grp: grp})
	}
	return occ
}
