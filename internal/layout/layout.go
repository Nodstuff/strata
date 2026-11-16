// Package layout lays the diagram out. Nothing here runs in the browser: the viewer only reads the
// numbers this writes (x, y, w, h, iw, ih, routes, xr).
//
// Pass 1, deepest container first: each container gets its own inner space (iw x ih) holding
// its children as closed boxes. If the file states where the boxes go (`place`), those
// statements are solved; otherwise the boxes are placed in layers (layered.go), several ways, and the
// calmest result is kept. Every arrow is then drawn by the router (route.go).
//
// Pass 2, top down: an arrow whose ends are in different containers is built from pieces. The
// piece between the two outermost boxes comes from pass 1. Where it meets a container's border
// is that container's *port* for the arrow, and inside the container a right-angle route runs
// from the port to the box the arrow is really for, going round every other box. So an arrow
// never passes behind a box, at any zoom. A port may move along its side when that keeps the
// picture above clean; the route inside decides where it lands, and no two arrows share one.
//
// This is a translation of layout.js and keeps its order of operations; see layered.go for why
// products that feed a sum are wrapped in float64().
package layout

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"

	"strata/internal/jsx"
	"strata/internal/model"
	"strata/internal/page"
)

func hasNote(c *model.Node) bool { return c.Note != nil && *c.Note != "" }
func hasSub(c *model.Node) bool  { return c.Sub != nil && *c.Sub != "" }

func leafSize(nd *model.Node) (float64, float64) {
	lines := strings.Split(nd.Label, "\n")
	longest := math.Inf(-1)
	for _, l := range lines {
		longest = math.Max(longest, float64(jsx.Len(l)))
	}
	tW := float64(longest * 8.2)
	if nd.Shape == "actor" {
		return math.Max(80, tW*0.8), 104
	}
	if nd.Shape == "diamond" {
		w := math.Max(150, float64(tW*1.6)+24)
		return w, math.Max(96, float64(len(lines)*22+62))
	}
	if hasNote(nd) { // sized for about 60 characters a line
		body := 0
		for _, p := range strings.Split(*nd.Note, "\n") {
			body += max(1, int(math.Ceil(float64(jsx.Len(p))/60)))
		}
		return math.Max(400, math.Min(520, tW+40)), float64(44+int(math.Ceil(float64(jsx.Len(nd.Label))/46))*20) + float64(float64(body)*15.5)
	}
	dW, sW := 0.0, 0.0
	if nd.Detail != nil {
		m := math.Inf(-1)
		for _, l := range nd.Detail {
			m = math.Max(m, float64(jsx.Len(l)))
		}
		dW = float64(m * 5.7)
	}
	if hasSub(nd) {
		sW = float64(float64(jsx.Len(*nd.Sub)) * 6.4)
	}
	w := math.Min(470, jsx.Max(150, tW+36, dW+28, sW+30))
	extra := 0.0
	if nd.Detail != nil {
		extra = float64(len(nd.Detail)*15 + 6)
	} else if hasSub(nd) {
		extra = 17
	}
	h := math.Max(66, float64(28+len(lines)*20)+extra)
	if nd.Shape == "cylinder" {
		h += 18
	}
	return w, h
}

type hintEntry struct {
	side int
	kids []string
}

// hintsFor is what the level above said about one container: which side each arrow out of it leaves by.
type hintsFor struct {
	entries []hintEntry
	was     float64
}

type port struct {
	sd  int
	v   float64
	fam []string
}

type label struct{ width float64 }

type wanted struct {
	id     string
	a, b   *model.Node
	labels []label
	grp    []string
}

type need struct {
	group   string
	kids    []*model.Node
	tag     string
	pts     *[]pt // the piece in the level where the arrow meets; nil for a piece deeper down
	atStart bool
	other   *model.Node
}

type needSet struct {
	order   []*need
	byGroup map[string]*need
}

type engine struct {
	m        *model.Model
	hints    *jsx.OMap[*hintsFor]
	parentOf map[*model.Node]*model.Node
	byID     map[string]*model.Node
	problems []string
	famOf    map[string][]string
	deep     map[string][]*model.Node
	occ      map[*model.Node][]seg
	ports    map[*model.Node][]*port
	need     map[*model.Node]float64
	unrouted int
}

func (e *engine) pathOf(nd *model.Node) []*model.Node {
	var p []*model.Node
	for c := nd; c != nil; c = e.parentOf[c] {
		p = append([]*model.Node{c}, p...)
	}
	return p
}

// childUnder is the direct child of container that holds nd, if any.
func (e *engine) childUnder(container, nd *model.Node) *model.Node {
	cur := nd
	for cur != nil && e.parentOf[cur] != container {
		cur = e.parentOf[cur]
	}
	return cur
}

// aim is the space inside b taken by the boxes this arrow is for.
func (e *engine) aim(b *model.Node, group string) *model.Node {
	set := e.deep[b.ID+"|"+group]
	if set == nil {
		return nil
	}
	x, y := math.Inf(1), math.Inf(1)
	r, bt := math.Inf(-1), math.Inf(-1)
	for _, c := range set {
		x, y = math.Min(x, c.X), math.Min(y, c.Y)
		r, bt = math.Max(r, c.X+c.W), math.Max(bt, c.Y+c.H)
	}
	return &model.Node{X: x, Y: y, W: r - x, H: bt - y}
}

// within is what the line inside b will cost if the arrow meets b at p (a point on b's border, in the level's own units).
func (e *engine) within(b *model.Node, group string, p pt, share float64) float64 {
	c := e.aim(b, group)
	if c == nil {
		return 0
	}
	cc := centre(c)
	u, v := p[0]-b.X, p[1]-b.Y
	u, v = float64(u/b.W*b.IW), float64(v/b.H*b.IH)
	flat := math.Abs(p[1]-b.Y) < 0.05 || math.Abs(p[1]-b.Y-b.H) < 0.05
	var d float64
	if flat {
		d = math.Abs(u-cc[0]) + math.Min(math.Abs(v-c.Y), math.Abs(v-c.Y-c.H))
	} else {
		d = math.Abs(v-cc[1]) + math.Min(math.Abs(u-c.X), math.Abs(u-c.X-c.W))
	}
	return d * 0.5 * share / b.IW
}

// exits is where an arrow may meet b. For a container, a point far from the box the arrow is really
// for costs what the detour inside will cost, so the arrow meets the container near that box and on
// the side facing it. `share` turns a length inside b into the same share of the screen out here.
func (e *engine) exits(b *model.Node, group string, toward []pt, share float64) []endpoint {
	c := e.aim(b, group)
	if c == nil {
		return sidesOf(b, toward)
	}
	cc := centre(c)
	f := 0.5 * share / b.IW
	t := append(slices.Clone(toward), pt{b.X + float64(cc[0]/b.IW*b.W), b.Y + float64(cc[1]/b.IH*b.H)})
	out := sidesOf(b, t)
	for i, s := range out {
		u, v := float64((s.at[0]-b.X)/b.W*b.IW), float64((s.at[1]-b.Y)/b.H*b.IH)
		flat := math.Abs(s.at[1]-b.Y) < 0.05 || math.Abs(s.at[1]-b.Y-b.H) < 0.05 // on the top or the bottom
		var inside float64
		if flat {
			inside = math.Abs(u-cc[0]) + math.Min(math.Abs(v-c.Y), math.Abs(v-c.Y-c.H))
		} else {
			inside = math.Abs(v-cc[1]) + math.Min(math.Abs(u-c.X), math.Abs(u-c.X-c.W))
		}
		out[i].cost = s.cost + float64(inside*f)
	}
	return out
}

func segsOf(pts []pt) [][2]pt {
	out := make([][2]pt, 0, len(pts))
	for i := 0; i+1 < len(pts); i++ {
		out = append(out, [2]pt{pts[i], pts[i+1]})
	}
	return out
}

func boxHit(a, b pt, w *model.Node, m float64) bool {
	return math.Max(a[0], b[0]) > w.X-m && math.Min(a[0], b[0]) < w.X+w.W+m && math.Max(a[1], b[1]) > w.Y-m && math.Min(a[1], b[1]) < w.Y+w.H+m
}

// clash counts how often a line crosses, or rides along, the other arrows in its container.
func clash(pts []pt, occ []seg, tag string, fam []string) int {
	n := 0
	lo := func(p, q pt, k int) float64 { return math.Min(p[k], q[k]) }
	hi := func(p, q pt, k int) float64 { return math.Max(p[k], q[k]) }
	for _, ab := range segsOf(pts) {
		a, b := ab[0], ab[1]
		for _, s := range occ {
			if s.tag == tag || (fam != nil && s.grp != nil && anyShared(s.grp, fam)) {
				continue
			}
			h1, h2 := math.Abs(a[1]-b[1]) < 0.05, math.Abs(s.a[1]-s.b[1]) < 0.05
			if h1 == h2 {
				k := 1
				if h1 {
					k = 0
				}
				if math.Abs(a[1-k]-s.a[1-k]) < lane-2 && math.Min(hi(a, b, k), hi(s.a, s.b, k))-math.Max(lo(a, b, k), lo(s.a, s.b, k)) > 1 {
					n++
				}
			} else {
				h, v := [2]pt{a, b}, [2]pt{s.a, s.b}
				if !h1 {
					h, v = v, h
				}
				if v[0][0] > lo(h[0], h[1], 0) && v[0][0] < hi(h[0], h[1], 0) && h[0][1] > lo(v[0], v[1], 1) && h[0][1] < hi(v[0], v[1], 1) {
					n++
				}
			}
		}
	}
	return n
}

type maker func(fx, fy float64) (*Placed, error)

func (e *engine) lay(nd *model.Node) {
	m := e.m
	if len(nd.Children) == 0 {
		nd.W, nd.H = leafSize(nd)
		return
	}
	for _, c := range nd.Children {
		e.lay(c)
	}
	if nd.Widths == "match" { // plain boxes at this level all take the widest one's width
		var plain []*model.Node
		w := 0.0
		for _, c := range nd.Children {
			if len(c.Children) == 0 && !hasNote(c) && (c.Shape == "" || c.Shape == "cylinder") {
				plain = append(plain, c)
				w = math.Max(w, c.W)
			}
		}
		for _, c := range plain {
			c.W = w
		}
	}

	// arrows that, at this level, run between two of this container's children
	type pairItem struct {
		i      int
		direct bool
	}
	type pair struct {
		a, b  *model.Node
		items []pairItem
	}
	var pairOrder []string
	pairs := map[string]*pair{}
	for i, ed := range m.Edges {
		a, b := e.childUnder(nd, e.byID[ed.A]), e.childUnder(nd, e.byID[ed.B])
		if a == nil || b == nil || a == b {
			continue
		}
		key := a.ID + ">" + b.ID
		p := pairs[key]
		if p == nil {
			p = &pair{a: a, b: b}
			pairs[key] = p
			pairOrder = append(pairOrder, key)
		}
		p.items = append(p.items, pairItem{i, a.ID == ed.A && b.ID == ed.B})
	}
	var wants []*wanted // one route per entry
	for _, key := range pairOrder {
		p := pairs[key]
		lab := func(text string) []label {
			if text == "" {
				return nil
			}
			return []label{{width: float64(float64(jsx.Len(text))*6.2) + 12}}
		}
		// the text the viewer will show on this arrow, so the room held for it is the room it needs: one arrow's own
		// label, or for several "N links" (or the label they share, with a count)
		// (The JavaScript also appends " · all <style>" when the worst style has a label and a `color`
		// field, but styles carry `c`, never `color`, so that suffix is never added; it is left out here.)
		var merged string
		if len(p.items) == 1 {
			merged = m.Edges[p.items[0].i].Label
		} else {
			l0 := m.Edges[p.items[0].i].Label
			same := true
			for _, it := range p.items {
				if l := m.Edges[it.i].Label; l == "" || l != l0 {
					same = false
				}
			}
			if same {
				merged = l0 + " xNN"
			} else {
				merged = "NN links"
			}
		}
		// several arrows declared between the same two boxes (a decision's Yes and No) each keep their own route
		// the family an arrow belongs to, for sharing a trunk: the style it will be drawn in, and the box at either end
		sty := m.Edges[p.items[0].i].Style
		for _, it := range p.items[1:] {
			if n := m.Edges[it.i].Style; m.Styles.At(n).RankNum() > m.Styles.At(sty).RankNum() {
				sty = n
			}
		}
		grp := []string{"i:" + p.b.ID + ":" + sty, "o:" + p.a.ID + ":" + sty}
		allDirect := true
		for _, it := range p.items {
			if !it.direct {
				allDirect = false
			}
		}
		if len(p.items) > 1 && allDirect {
			for _, it := range p.items {
				wants = append(wants, &wanted{id: fmt.Sprintf("%s#%d", key, it.i), a: p.a, b: p.b, labels: lab(m.Edges[it.i].Label)})
			}
		} else {
			wants = append(wants, &wanted{id: key, a: p.a, b: p.b, labels: lab(merged), grp: grp})
			e.famOf[nd.ID+"|"+key] = grp
		}
	}
	order := map[string]int{}
	stated := false
	for i, c := range nd.Children {
		order[c.ID] = i
		if c.Place != nil {
			stated = true
		}
	}
	var res *Placed
	var mk maker
	// Use the room a screen has: while the level is taller than a screen is, widen its sideways
	// gaps; while it is a long strip, widen the gaps between its rows. Boxes keep their size.
	shape := func(r *Placed) float64 { return (r.Width + 2*side) / (r.Height + 46 + bottom) }
	var closedCh []*model.Node
	for _, c := range nd.Children {
		if len(c.Children) > 0 && !c.Group {
			closedCh = append(closedCh, c)
		}
	}
	roomW, roomH := 0.0, 0.0 // room the level has anyway: a closed container must stay small beside it
	for _, c := range closedCh {
		roomW, roomH = math.Max(roomW, c.W/fit), math.Max(roomH, c.H/fit)
	}
	roomW, roomH = roomW-2*side, roomH-46-bottom
	widen := func(mk maker) (*Placed, error) {
		r, err := mk(1, 1)
		if err != nil {
			return nil, err
		}
		fx := 1.0
		if len(nd.Children) < 2 {
			return r, nil
		}
		for _, f := range stretch {
			if r.Width >= 0.92*roomW && shape(r) >= wide {
				break
			}
			t, err := mk(f, 1)
			if err != nil {
				return nil, err
			}
			if t.Width <= r.Width+1 || (t.Width > 1.04*roomW && shape(t) > wide+0.3) {
				break
			}
			r, fx = t, f
		}
		for _, f := range stretch {
			if r.Height >= 0.92*roomH && shape(r) <= 1.9 {
				break
			}
			t, err := mk(fx, f)
			if err != nil {
				return nil, err
			}
			if t.Height <= r.Height+1 || (t.Height > 1.04*roomH && shape(t) < wide-0.1) {
				break
			}
			r = t
		}
		return r, nil
	}

	if stated {
		mk = func(fx, fy float64) (*Placed, error) { return placeStated(nd, fx, fy) }
		r, err := widen(mk)
		if err != nil {
			e.problems = append(e.problems, err.Error())
			res, mk = nil, nil
		} else {
			res = r
		}
	}
	var hint *hintsFor
	if e.hints != nil {
		hint = e.hints.At(nd.ID)
	}
	for res == nil {
		var arrows []Arrow
		for _, w := range wants {
			lw := 0.0
			if len(w.labels) > 0 {
				lw = w.labels[0].width
			}
			arrows = append(arrows, Arrow{A: w.a.ID, B: w.b.ID, Label: lw})
		}
		// a note that is about a box sits next to it: an unseen arrow ties the two together
		for _, c := range nd.Children {
			if c.About != nil && *c.About != "" {
				if _, ok := order[*c.About]; ok {
					arrows = append(arrows, Arrow{A: *c.About, B: c.ID})
				}
			}
		}
		// Second time round (see Layout): the level above has said which side each arrow out of this
		// level leaves by, and the placement arranges the boxes toward those sides.
		var pulls []Pull
		if hint != nil {
			for _, h := range hint.entries {
				var kids []string
				for _, k := range h.kids {
					if _, ok := order[k]; ok {
						kids = append(kids, k)
					}
				}
				pulls = append(pulls, Pull{Side: h.side, Kids: kids})
			}
		}
		sum := 0.0
		for _, c := range nd.Children {
			sum = sum + c.W + c.H
		}
		unit := sum / float64(2*len(nd.Children))
		run := func(dir, ord string, wrap bool, fx, fy float64) *Placed {
			boxes := make([]Box, len(nd.Children))
			for i, c := range nd.Children {
				boxes[i] = Box{ID: c.ID, Width: c.W, Height: c.H}
			}
			lg, ng := fx, fy
			if dir == "DOWN" {
				lg, ng = fy, fx
			}
			r := Layered(boxes, arrows, Opts{Dir: dir, Ord: ord, Wrap: wrap, Unit: unit, Pulls: pulls,
				LayerGap: jsx.Round(float64(64 * lg)), NodeGap: jsx.Round(float64(44 * ng)), CompGap: jsx.Round(float64(54 * math.Max(fx, fy)))})
			r.Dir, r.Ord, r.Wrap = dir, ord, wrap
			return r
		}
		// Try the directions the file allows, each with the file's order held firmly, loosely and
		// not at all, and keep the least busy picture. Holding the order firmly wins ties, so the
		// author's order stands unless ignoring it is clearly cleaner. A declared flow that comes
		// out as a thin strip is also tried folded onto extra rows.
		dirs := []string{"DOWN", "RIGHT"}
		if nd.Flow != "" {
			dirs = []string{"DOWN"}
			if nd.Flow == "right" {
				dirs = []string{"RIGHT"}
			}
		}
		best := math.Inf(1)
		for _, dir := range dirs {
			for _, oh := range []struct {
				ord      string
				handicap float64
			}{{"NODES_AND_EDGES", 0}, {"PREFER_EDGES", 1.5}, {"NONE", 3}} {
				tries := []*Placed{run(dir, oh.ord, false, 1, 1)}
				thin := math.Max(tries[0].Width/tries[0].Height, tries[0].Height/tries[0].Width)
				if nd.Flow != "" && thin > 3.5 {
					tries = []*Placed{run(dir, oh.ord, true, 1, 1)} // a strip this thin is unreadable: fold it
				} else if thin > 2.6 {
					tries = append(tries, run(dir, oh.ord, true, 1, 1)) // borderline, or no direction was asked for: let the score decide
				}
				for _, r := range tries {
					if score := r.Score + oh.handicap; score < best {
						best, res = score, r
					}
				}
			}
		}
		{
			dir, ord, wrap, first := res.Dir, res.Ord, res.Wrap, res
			r, _ := widen(func(fx, fy float64) (*Placed, error) {
				if fx == 1 && fy == 1 {
					return first, nil
				}
				return run(dir, ord, wrap, fx, fy), nil
			})
			res = r
			mk = func(fx, fy float64) (*Placed, error) { return run(dir, ord, wrap, fx, fy), nil }
		}
		// A level pulled toward its exits must not come out smaller on a screen than it was without the pulls.
		nd2 := math.Max(res.Width/1.7, res.Height)
		if hint != nil && nd2 > 1.06*hint.was {
			hint, res = nil, nil
			continue
		}
		e.need[nd] = nd2
	}

	// A level that is still a tall column has width to spare, and one that is still a strip has
	// height to spare. Plain boxes grow into it: a wider box shows a larger title once the level is
	// fitted to a screen, a taller one shows its detail lines. Kept only if the level gets no longer.
	if mk != nil && len(nd.Children) > 1 {
		var plain []*model.Node
		for _, c := range nd.Children {
			if len(c.Children) == 0 && !hasNote(c) && (c.Shape == "" || c.Shape == "cylinder") {
				plain = append(plain, c)
			}
		}
		sh := shape(res)
		tall, strip := sh < 1.2, sh > 2.4
		if len(plain) > 0 && (tall || strip) {
			var f float64
			if tall {
				f = math.Min(1.7, 1.5/sh)
			} else {
				f = math.Min(1.45, sh/2)
			}
			was := make([][2]float64, len(plain))
			for i, c := range plain {
				was[i] = [2]float64{c.W, c.H}
			}
			for _, c := range plain {
				if tall {
					c.W = math.Min(math.Max(c.W, closedW*1.25), c.W*f)
				} else {
					c.H *= f
				}
			}
			t, err := widen(mk)
			if err != nil {
				t = nil
			}
			if t != nil && ((tall && t.Height <= res.Height*1.02) || (!tall && t.Width <= res.Width*1.02)) {
				res = t
			} else {
				for i, c := range plain {
					c.W, c.H = was[i][0], was[i][1]
				}
			}
		}
	}

	// the inner space: content, padding, a header band, and room so closed containers stay closed at fit
	var closable []*model.Node
	for _, c := range nd.Children {
		if len(c.Children) > 0 && !c.Group {
			closable = append(closable, c)
		}
	}
	W := res.Width + 2*side
	for _, c := range closable {
		W = math.Max(W, c.W/fit)
	}
	H, top := 0.0, 0.0
	for pass := 0; pass < 3; pass++ {
		if nd.ID == "__root" { // the top level has no title band to leave room for
			top = side
		} else {
			band := 46.0
			if nd.Group {
				band = 62
			}
			top = math.Max(band, math.Max(0.07*W, 0.11*H))
		}
		H = top + res.Height + bottom
		for _, c := range closable {
			H = math.Max(H, c.H/fit)
		}
		if !nd.Group {
			if W/H > 2.3 {
				H = W / 2.3
			} else if W/H < 1.15 {
				W = float64(H * 1.15)
			}
		}
	}
	ox, oy := (W-res.Width)/2, top+(H-top-bottom-res.Height)/2
	nd.IW, nd.IH, nd.HasInner = W, H, true
	pos := map[string]Rect{}
	for _, c := range res.Children {
		pos[c.ID] = c
	}
	for _, c := range nd.Children {
		p := pos[c.ID]
		c.X, c.Y, c.HasXY = p.X+ox, p.Y+oy, true
	}
	nd.Routes = jsx.NewOMap[*model.Route]()
	e.occ[nd] = nil
	// every arrow is drawn here, shortest first; a hub's arrows form one tree
	apart := func(w *wanted) float64 {
		a, b := centre(w.a), centre(w.b)
		return math.Abs(a[0]-b[0]) + math.Abs(a[1]-b[1])
	}
	// A box with three or more arrows of one style coming in (or going out) is a hub: those arrows are drawn as one tree.
	size := map[string]int{}
	for _, w := range wants {
		for _, g := range w.grp {
			size[g]++
		}
	}
	joinOf := func(w *wanted) *join {
		if w.grp == nil {
			return nil
		}
		var into, outof [][]pt
		for _, o := range wants {
			if o == w || o.grp == nil || !nd.Routes.Has(o.id) {
				continue
			}
			if o.grp[0] == w.grp[0] && size[w.grp[0]] >= 3 {
				into = append(into, nd.Routes.At(o.id).P)
			}
			if o.grp[1] == w.grp[1] && size[w.grp[1]] >= 3 {
				outof = append(outof, nd.Routes.At(o.id).P)
			}
		}
		if len(into) > 0 || len(outof) > 0 {
			return &join{into, outof}
		}
		return nil
	}
	byApart := slices.Clone(wants)
	sort.SliceStable(byApart, func(i, j int) bool { return apart(byApart[i])-apart(byApart[j]) < 0 }) // short arrows first: they get the straight lines
	for _, w := range byApart {
		if nd.Routes.Has(w.id) {
			continue
		}
		p := route(e.exits(w.a, "o:"+w.b.ID, []pt{centre(w.b)}, W), e.exits(w.b, "i:"+w.a.ID, []pt{centre(w.a)}, W), nd.Children, W, H, e.occ[nd], w.id, w.grp, joinOf(w))
		if p != nil {
			nd.Routes.Set(w.id, &model.Route{P: p})
			e.occ[nd] = occupy(e.occ[nd], p, w.id, w.grp)
		}
	}

	// An arrow that goes a long way round gets a second opinion from this file's own router, which
	// knows only boxes and the other arrows. The shorter, straighter line wins.
	weight := func(p []pt) float64 {
		n := 0.0
		for i := 0; i+1 < len(p); i++ {
			n = n + math.Abs(p[i+1][0]-p[i][0]) + math.Abs(p[i+1][1]-p[i][1])
		}
		return n + float64(40*(len(p)-2))
	}
	notTag := func(occ []seg, tag string) []seg {
		var out []seg
		for _, s := range occ {
			if s.tag != tag {
				out = append(out, s)
			}
		}
		return out
	}
	for _, w := range wants {
		old := nd.Routes.At(w.id)
		if old == nil {
			continue
		}
		a, b := centre(w.a), centre(w.b)
		direct := math.Max(0, math.Abs(a[0]-b[0])-(w.a.W+w.b.W)/2) + math.Max(0, math.Abs(a[1]-b[1])-(w.a.H+w.b.H)/2)
		inner := func(q []pt) float64 {
			return e.within(w.a, "o:"+w.b.ID, q[0], W) + e.within(w.b, "i:"+w.a.ID, q[len(q)-1], W)
		}
		far := inner(old.P)
		if weight(old.P) < float64(1.6*direct)+120 && far < 0.12*W {
			continue
		}
		p := route(e.exits(w.a, "o:"+w.b.ID, []pt{b}, W), e.exits(w.b, "i:"+w.a.ID, []pt{a}, W), nd.Children, W, H, notTag(e.occ[nd], w.id), w.id, w.grp, nil)
		const X = 150.0
		rest := notTag(e.occ[nd], w.id) // a new crossing on this level costs more than a long line inside
		if p == nil {
			continue
		}
		cand := float64(X*float64(clash(p, rest, w.id, w.grp))) + weight(p) + inner(p)
		cur := float64(X*float64(clash(old.P, rest, w.id, w.grp))) + weight(old.P) + far
		if cand > float64(0.8*cur) {
			continue
		}
		nd.Routes.Set(w.id, &model.Route{P: p})
		e.occ[nd] = occupy(notTag(e.occ[nd], w.id), p, w.id, w.grp)
	}
	// An arrow that shares a trunk is labelled on the longest stretch that is its own.
	for _, w := range wants {
		r := nd.Routes.At(w.id)
		if r == nil || r.L != nil || w.grp == nil {
			continue
		}
		var mates []seg
		for _, s := range e.occ[nd] {
			if s.tag != w.id && s.grp != nil && anyShared(s.grp, w.grp) {
				mates = append(mates, s)
			}
		}
		shared := false
		var best *[3]float64
		for i := 0; i+1 < len(r.P); i++ {
			a, b := r.P[i], r.P[i+1]
			k := 1
			if math.Abs(a[1]-b[1]) < 0.05 {
				k = 0
			}
			ln := math.Abs(a[k] - b[k])
			on := false
			for _, s := range mates {
				if math.Abs(s.a[1-k]-s.b[1-k]) < 0.05 && math.Abs(s.a[1-k]-a[1-k]) < 0.06 &&
					math.Min(math.Max(a[k], b[k]), math.Max(s.a[k], s.b[k]))-math.Max(math.Min(a[k], b[k]), math.Min(s.a[k], s.b[k])) > 1 {
					on = true
					break
				}
			}
			if on {
				shared = true
			} else if best == nil || ln > best[2] {
				best = &[3]float64{jsx.R1((a[0] + b[0]) / 2), jsx.R1((a[1] + b[1]) / 2), jsx.R1(ln)}
			}
		}
		if shared && best != nil {
			r.M = best
		}
	}
	// A label sits where it is clear of every box and of the labels already placed, on its arrow's
	// longest stretch if it can and as near that stretch's middle as it can. (The viewer's fallback,
	// the middle of the longest stretch, puts a label half behind a box when the stretch runs beside one.)
	{
		var taken [][4]float64
		hitBox := func(x, y, w, h float64) bool {
			for _, c := range nd.Children {
				if x < c.X+c.W+3 && c.X < x+w+3 && y < c.Y+c.H+3 && c.Y < y+h+3 {
					return true
				}
			}
			return false
		}
		hitLabel := func(x, y, w, h float64) bool {
			for _, t := range taken {
				if x < t[0]+t[2]+4 && t[0] < x+w+4 && y < t[1]+t[3]+3 && t[1] < y+h+3 {
					return true
				}
			}
			return false
		}
		for _, w := range wants {
			r := nd.Routes.At(w.id)
			if r == nil || r.L != nil || r.M != nil || len(w.labels) == 0 {
				continue
			}
			lw, lh := w.labels[0].width, 16.0
			var best *[3]float64
			lines := notTag(e.occ[nd], w.id)
			for i := 0; i+1 < len(r.P); i++ {
				a, b := r.P[i], r.P[i+1]
				flat := math.Abs(a[1]-b[1]) < 0.05
				k := 1
				if flat {
					k = 0
				}
				lo, hi := math.Min(a[k], b[k]), math.Max(a[k], b[k])
				ln := hi - lo
				half := lh/2 + 3
				if flat {
					half = lw/2 + 3
				}
				if ln < 2*half {
					continue
				}
				mid := (lo + hi) / 2
				room := ln/2 - half
				for step := 0; step <= 8; step++ {
					signs := []float64{1, -1}
					if step == 0 {
						signs = []float64{1}
					}
					for _, sign := range signs {
						at := mid + sign*room*float64(step)/8
						cx, cy := a[0], at
						if flat {
							cx, cy = at, a[1]
						}
						x, y := cx-lw/2, cy-lh/2
						if x < 2 || y < 2 || x+lw > W-2 || y+lh > H-2 || hitBox(x, y, lw, lh) || hitLabel(x, y, lw, lh) {
							continue
						}
						over := 0 // other arrows' lines under the label
						for _, o := range lines {
							if math.Min(o.a[0], o.b[0]) < x+lw && math.Max(o.a[0], o.b[0]) > x && math.Min(o.a[1], o.b[1]) < y+lh && math.Max(o.a[1], o.b[1]) > y {
								over++
							}
						}
						cost := float64(60*float64(over)) + room*float64(step)/8 - float64(0.2*ln)
						if flat {
							cost -= 12
						}
						if best == nil || cost < best[2] {
							best = &[3]float64{cx, cy, cost}
						}
					}
				}
			}
			if best != nil {
				r.L = &[2]float64{jsx.R1(best[0]), jsx.R1(best[1])}
				taken = append(taken, [4]float64{best[0] - lw/2, best[1] - lh/2, lw, lh})
			}
		}
	}
	// the box this container is drawn as inside its parent
	if nd.Group { // a group is a frame at its parent's own scale
		nd.W, nd.H = W, H
	} else {
		a := W / H
		nd.W = closedW
		nd.H = closedW / a
		if nd.H > closedH {
			nd.H = closedH
			nd.W = float64(closedH * a)
		}
	}
}

// layoutOnce runs both passes on m (which it changes) and returns it with each container's `need`.
func layoutOnce(m *model.Model, hints *jsx.OMap[*hintsFor]) (*model.Model, map[*model.Node]float64, error) {
	e := &engine{m: m, hints: hints, parentOf: map[*model.Node]*model.Node{}, byID: map[string]*model.Node{},
		famOf: map[string][]string{}, deep: map[string][]*model.Node{}, occ: map[*model.Node][]seg{}, ports: map[*model.Node][]*port{}, need: map[*model.Node]float64{}}
	model.Walk(m.Root, func(nd, parent *model.Node, _ int) { e.parentOf[nd] = parent; e.byID[nd.ID] = nd })

	// An arrow that ends inside a closed-looking container still has a box it is really for. Which
	// one, per container and per arrow group ("o:<other end>" going out, "i:<other end>" coming in).
	for _, ed := range m.Edges {
		pa, pb := e.pathOf(e.byID[ed.A]), e.pathOf(e.byID[ed.B])
		n := 0
		for n < len(pa) && n < len(pb) && pa[n] == pb[n] {
			n++
		}
		if n >= len(pa) || n >= len(pb) {
			continue
		}
		for _, cg := range []struct {
			chain []*model.Node
			group string
		}{{pa[n:], "o:" + pb[n].ID}, {pb[n:], "i:" + pa[n].ID}} {
			for i := 0; i < len(cg.chain)-1; i++ {
				k := cg.chain[i].ID + "|" + cg.group
				if !slices.Contains(e.deep[k], cg.chain[i+1]) {
					e.deep[k] = append(e.deep[k], cg.chain[i+1])
				}
			}
		}
	}
	e.lay(m.Root)
	if len(e.problems) > 0 {
		return nil, nil, &model.ProblemsError{Problems: e.problems}
	}

	// ---------- pass 2 ----------
	// For an arrow a -> b whose ends meet at container L (A and B are L's children holding a and b):
	// every container X between A and a gets a port for the group "o:B", and a route from the child
	// on the way to a, to that port. The same on b's side with "i:A". The viewer strings the pieces
	// together. Containers are done top down, because where an arrow meets X is decided by the
	// piece one level up, and that piece has to exist first.
	needs := map[*model.Node]*needSet{}
	for _, ed := range m.Edges {
		pa, pb := e.pathOf(e.byID[ed.A]), e.pathOf(e.byID[ed.B])
		n := 0
		for n < len(pa) && n < len(pb) && pa[n] == pb[n] {
			n++
		}
		if n >= len(pa) || n >= len(pb) { // one end holds the other, or it is a self loop
			continue
		}
		L, A, B := pa[n-1], pa[n], pb[n]
		key := A.ID + ">" + B.ID
		id := ""
		if L.Routes.Has(key) {
			id = key
		} else {
			for _, k := range L.Routes.Keys() {
				if strings.HasPrefix(k, key+"#") {
					id = k
					break
				}
			}
		}
		if id == "" {
			continue
		}
		chainOf := func(chain []*model.Node, group string, atStart bool, other *model.Node) {
			for i := 0; i < len(chain)-1; i++ {
				X := chain[i]
				ns := needs[X]
				if ns == nil {
					ns = &needSet{byGroup: map[string]*need{}}
					needs[X] = ns
				}
				d := ns.byGroup[group]
				if d == nil {
					if i == 0 {
						d = &need{group: group, tag: id, pts: &L.Routes.At(id).P, atStart: atStart, other: other}
					} else {
						d = &need{group: group, tag: group, atStart: true}
					}
					ns.byGroup[group] = d
					ns.order = append(ns.order, d)
				}
				if !slices.Contains(d.kids, chain[i+1]) {
					d.kids = append(d.kids, chain[i+1])
				}
			}
		}
		chainOf(pa[n:], "o:"+B.ID, true, B)
		chainOf(pb[n:], "i:"+A.ID, false, A)
	}

	reoccupy := func(L *model.Node, tag string) { // a piece in L changed shape: tell the lanes
		var occ []seg
		for _, s := range e.occ[L] {
			if s.tag != tag {
				occ = append(occ, s)
			}
		}
		if r := L.Routes.At(tag); r != nil {
			occ = occupy(occ, r.P, tag, nil)
		} else if L.XR != nil {
			if g := L.XR.At(tag); g != nil {
				for _, k := range g.R.JSKeys() {
					if r := g.R.At(k); r != nil {
						occ = occupy(occ, r.P, tag, nil)
					}
				}
			}
		}
		e.occ[L] = occ
	}

	// Where an arrow meets X. The piece above arrives somewhere on one side of X; it may meet that
	// side anywhere that keeps the picture above clean (no box in the way, no new crossing, not on
	// top of another arrow's meeting point). Among those places, the route inside X picks: every
	// candidate is a goal for one search from the box the arrow is for, so the port lands where
	// the inside route is shortest and straightest.
	meet := func(X, L *model.Node, d *need, ptsP *[]pt) {
		pts := *ptsP
		at := func(i int) (pt, bool) {
			if i < 0 || i >= len(pts) {
				return pt{}, false
			}
			return pts[i], true
		}
		ei, st := len(pts)-1, -1
		if d.atStart {
			ei, st = 0, 1
		}
		p, _ := at(ei)
		q, _ := at(ei + st)
		r, hasR := at(ei + 2*st)
		sd := sideOfPort(pt{p[0] - X.X, p[1] - X.Y}, X.W, X.H)
		k := 1
		if sd < 2 {
			k = 0
		}
		var lo, span, inner float64
		if k == 1 {
			lo, span, inner = X.Y, X.H, X.IH
		} else {
			lo, span, inner = X.X, X.W, X.IW
		}
		toIn := func(v float64) float64 {
			return math.Max(2*clear, math.Min(inner-2*clear, (v-lo)/span*inner))
		}
		toOut := func(u float64) float64 { return jsx.R1(lo + float64(u/inner*span)) }
		// arrows of one family may meet the container at the same place: one trunk, which parts inside
		var fam []string
		if d.pts != nil {
			fam = e.famOf[L.ID+"|"+d.tag]
		}
		kin := func(o *port) bool { return fam != nil && o.fam != nil && anyShared(o.fam, fam) }
		var taken []float64
		for _, o := range e.ports[X] {
			if o.sd == sd && !kin(o) {
				taken = append(taken, o.v)
			}
		}
		sep := math.Max(4.5, math.Min(0.04*span, 30))
		free := func(v float64) bool {
			for _, t := range taken {
				if !(math.Abs(t-v) >= sep-0.01) {
					return false
				}
			}
			return true
		}
		base := clash(pts, e.occ[L], d.tag, fam)
		fine := func(np []pt) bool {
			for _, ab := range segsOf(np) {
				for _, w := range L.Children {
					mg := 3.0
					if w == X || w == d.other {
						mg = -1
					}
					if boxHit(ab[0], ab[1], w, mg) {
						return false
					}
				}
			}
			return clash(np, e.occ[L], d.tag, fam) <= base
		}
		type cand struct {
			u, cost float64
			pts     []pt
		}
		c0 := 500.0
		if free(p[k]) {
			c0 = 0
		}
		cands := []cand{{u: toIn(p[k]), cost: c0}}
		// a straight line in the picture above stays straight; a line with a bend can slide its last leg along the side,
		// unless it is part of a hub's tree: its relatives end on the same point, and the tree would come apart
		twin := false
		for _, id := range L.Routes.Keys() {
			o := L.Routes.At(id)
			if id == d.tag {
				continue
			}
			j := 0
			if !d.atStart {
				j = len(o.P) - 1
			}
			if math.Abs(o.P[j][0]-p[0])+math.Abs(o.P[j][1]-p[1]) < 0.2 {
				twin = true
				break
			}
		}
		if hasR && !twin && math.Abs(p[k]-q[k]) < 0.05 && math.Abs(q[1-k]-r[1-k]) < 0.05 {
			kid := d.kids[0]
			klo, kspan := kid.X, kid.W
			if k == 1 {
				klo, kspan = kid.Y, kid.H
			}
			for _, o := range e.ports[X] {
				if o.sd == sd && kin(o) { // where a relative already meets this side is the best place of all
					if math.Abs(o.v-p[k]) < 1 {
						cands[0].cost = -70
						continue
					}
					np := slices.Clone(pts)
					np[ei][k] = o.v
					np[ei+st][k] = o.v
					if fine(np) {
						cands = append(cands, cand{u: toIn(o.v), cost: -70, pts: np})
					}
				}
			}
			us := []float64{klo + kspan/2, klo + kspan/4, klo + float64(kspan*0.75)} // in line with the box, or with the lane beside any box
			for _, w := range X.Children {
				if k == 1 {
					us = append(us, w.Y-clear, w.Y+w.H+clear)
				} else {
					us = append(us, w.X-clear, w.X+w.W+clear)
				}
			}
			for _, u0 := range us {
				u := jsx.R1(math.Max(float64(0.06*inner), math.Max(2*clear, math.Min(float64(0.94*inner), math.Min(inner-2*clear, u0)))))
				v := toOut(u)
				dup := false
				for _, c := range cands {
					if math.Abs(c.u-u) < 1 {
						dup = true
						break
					}
				}
				if math.Abs(v-p[k]) < 1 || !free(v) || dup {
					continue
				}
				np := slices.Clone(pts) // slide the last leg along the side
				np[ei][k] = v
				np[ei+st][k] = v
				if fine(np) {
					cands = append(cands, cand{u: u, cost: 4, pts: np})
				}
			}
		}
		goals := make([]endpoint, len(cands))
		outs := make([]pt, len(cands))
		for i, c := range cands {
			goals[i] = portGoal(sd, c.u, X.IW, X.IH, c.cost)
			outs[i] = goals[i].out
		}
		if X.XR == nil {
			X.XR = jsx.NewOMap[*model.XRGroup]()
		}
		g := &model.XRGroup{R: jsx.NewOMap[*model.Piece]()}
		X.XR.Set(d.group, g)
		first := route(e.exits(d.kids[0], d.group, outs, X.IW), goals, X.Children, X.IW, X.IH, e.occ[X], d.group, fam, nil)
		pick := cands[0]
		if first != nil {
			end := first[len(first)-1]
			for _, c := range cands {
				a := portAt(sd, c.u, X.IW, X.IH)
				if math.Abs(a[0]-end[0])+math.Abs(a[1]-end[1]) < 0.2 {
					pick = c
					break
				}
			}
		}
		if pick.pts != nil {
			*ptsP = slices.Clone(pick.pts)
			pts = *ptsP
			reoccupy(L, d.tag)
		}
		j := 0
		if !d.atStart {
			j = len(pts) - 1
		}
		e.ports[X] = append(e.ports[X], &port{sd: sd, v: pts[j][k], fam: fam})
		pp := portAt(sd, pick.u, X.IW, X.IH)
		g.Port = &pt{jsx.R1(pp[0]), jsx.R1(pp[1])}
		// Several boxes in X may share this arrow. Their lines form one tree to the port: the nearest box
		// is routed first, and each later one may end on a line already drawn and ride it the rest of the way.
		goal := portGoal(sd, pick.u, X.IW, X.IH, 0)
		gap := func(kid *model.Node) float64 {
			c := centre(kid)
			return math.Abs(c[0]-goal.at[0]) + math.Abs(c[1]-goal.at[1])
		}
		var drawn [][]pt
		rest := slices.Clone(d.kids[1:])
		sort.SliceStable(rest, func(i, j int) bool { return gap(rest[i])-gap(rest[j]) < 0 })
		for _, kid := range append([]*model.Node{d.kids[0]}, rest...) {
			var rt []pt
			if kid == d.kids[0] {
				rt = first
			} else {
				var jn *join
				if len(drawn) > 0 {
					jn = &join{into: drawn}
				}
				rt = route(e.exits(kid, d.group, []pt{goal.out}, X.IW), []endpoint{goal}, X.Children, X.IW, X.IH, e.occ[X], d.group, fam, jn)
			}
			if rt != nil {
				g.R.Set(kid.ID, &model.Piece{P: rt})
				e.occ[X] = occupy(e.occ[X], rt, d.group, fam)
				drawn = append(drawn, rt)
			} else {
				g.R.Set(kid.ID, nil)
				e.unrouted++
			}
		}
	}
	for queue := []*model.Node{m.Root}; len(queue) > 0; {
		L := queue[0]
		queue = queue[1:]
		for _, X := range L.Children {
			if len(X.Children) == 0 {
				continue
			}
			type item struct {
				d   *need
				pts *[]pt
			}
			var todo []item
			if ns := needs[X]; ns != nil {
				for _, d := range ns.order {
					pts := d.pts
					if pts == nil && L.XR != nil {
						if g := L.XR.At(d.group); g != nil {
							if pc := g.R.At(X.ID); pc != nil {
								pts = &pc.P
							}
						}
					}
					if pts != nil {
						todo = append(todo, item{d, pts})
					}
				}
			}
			sort.SliceStable(todo, func(i, j int) bool { // straight lines cannot move, so they claim their place on the side first
				return min(len(*todo[i].pts), 3)-min(len(*todo[j].pts), 3) < 0
			})
			for _, t := range todo {
				meet(X, L, t.d, t.pts)
			}
			queue = append(queue, X)
		}
	}
	if e.unrouted > 0 {
		m.Warnings = append(m.Warnings, fmt.Sprintf("%d arrow piece(s) could not be routed round the boxes in their container and will be drawn straight", e.unrouted))
	}

	model.Walk(m.Root, func(nd, _ *model.Node, _ int) {
		nd.W, nd.H = jsx.R1(nd.W), jsx.R1(nd.H)
		if nd.HasXY {
			nd.X, nd.Y = jsx.R1(nd.X), jsx.R1(nd.Y)
		}
		if nd.HasInner {
			nd.IW, nd.IH = jsx.R1(nd.IW), jsx.R1(nd.IH)
		}
	})
	return m, e.need, nil
}

// Layout lays the model out. With twice, the picture is laid out twice: the first time, each level is
// arranged before the level above has decided which side its outgoing arrows leave by, so a box can
// end up far from the side its arrow needs. The second time, every level is told those sides and
// arranges its boxes toward them. The second picture is kept only if its arrows are cleaner by the
// numbers `check --stats` prints.
func Layout(m *model.Model, twice bool) (*model.Model, error) {
	var spare *model.Model
	if twice {
		spare = m.Clone()
	}
	first, need, err := layoutOnce(m, nil)
	if err != nil {
		return nil, err
	}
	if spare == nil {
		return first, nil
	}
	hints := jsx.NewOMap[*hintsFor]()
	model.Walk(first.Root, func(nd, _ *model.Node, _ int) {
		if len(nd.Children) == 0 || nd.XR == nil {
			return
		}
		for _, c := range nd.Children {
			if c.Place != nil {
				return
			}
		}
		h := &hintsFor{}
		for _, group := range nd.XR.JSKeys() {
			g := nd.XR.At(group)
			if g.Port != nil {
				h.entries = append(h.entries, hintEntry{side: sideOfPort(*g.Port, nd.IW, nd.IH), kids: g.R.JSKeys()})
			}
		}
		if len(h.entries) > 0 && need[nd] != 0 {
			h.was = need[nd]
			hints.Set(nd.ID, h)
		}
	})
	if hints.Len() == 0 {
		return first, nil
	}
	third := spare.Clone()
	second, _, err := layoutOnce(spare, hints)
	if err != nil {
		return first, nil
	}
	one := func(t page.Totals) float64 { return t.Crossings + float64(0.25*t.Bends) + t.Length }
	mark := func(m *model.Model) float64 { return one(page.Quality(m).Total) }
	// The pulls help some levels and hurt others. A third layout keeps them only where the level came out calmer.
	was := map[string]float64{}
	for _, r := range page.Quality(first).Levels {
		was[r.ID] = one(r.Totals)
	}
	kept := jsx.NewOMap[*hintsFor]()
	for _, r := range page.Quality(second).Levels {
		if hints.Has(r.ID) && one(r.Totals) < was[r.ID]-0.01 {
			kept.Set(r.ID, hints.At(r.ID))
		}
	}
	best := first
	if mark(second) < mark(first) {
		best = second
	}
	if kept.Len() > 0 && kept.Len() < hints.Len() {
		if t, _, err := layoutOnce(third, kept); err == nil && mark(t) < mark(best) {
			best = t
		}
	}
	return best, nil
}

// IsProblems reports whether err carries a list of problems.
func IsProblems(err error) bool { _, ok := errors.AsType[*model.ProblemsError](err); return ok }
