package page

import (
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"

	"strata/internal/jsx"
	"strata/internal/model"
)

// Legibility says which titles will be too small to read when their container fills an ordinary
// window. The viewer shrinks text to fit its box, so a crowded level stays correct but becomes illegible.
func Legibility(m *model.Model, vw, vh float64) []string {
	var out []string
	model.Walk(m.Root, func(nd, parent *model.Node, _ int) {
		if len(nd.Children) == 0 {
			return
		}
		// the same fit the viewer makes: a gutter on each side of a container, a thin margin round the top level
		top := parent == nil
		var gx, gy float64
		if top {
			gx, gy = vw*0.04, (vh-100)*0.04
		} else {
			gx, gy = math.Max(70, math.Min(170, vw*0.1)), 34
		}
		k := math.Min((vw-float64(2*gx))/nd.IW, (vh-100-float64(2*gy))/nd.IH)
		var small []string
		for _, c := range nd.Children {
			if c.Shape == "actor" {
				continue // a name under a figure: there is nothing to shorten
			}
			lines := strings.Split(c.Label, "\n")
			rows := float64(float64(len(lines)) * 1.2)
			if c.Sub != nil && *c.Sub != "" {
				rows += 0.85
			}
			if len(c.Children) > 0 {
				rows++
			}
			diamond := c.Shape == "diamond"
			wf, hf := 0.86, 0.7
			if diamond {
				wf, hf = 0.6, 0.5
			}
			longest := math.Inf(-1)
			for _, l := range lines {
				longest = math.Max(longest, float64(jsx.Len(l)))
			}
			px := math.Min(22, math.Min(c.W*k*wf/(longest*0.6), c.H*k*hf/rows))
			if px < 7.5 {
				small = append(small, c.ID)
			}
		}
		if len(small) > 0 {
			who := `"` + nd.ID + `"`
			if nd.ID == "__root" {
				who = "the top level"
			}
			out = append(out, fmt.Sprintf("when %s fills a %sx%s window, %d of its %d titles are too small to read (%s): use shorter labels or fewer boxes at this level",
				who, jsx.NumStr(vw), jsx.NumStr(vh), len(small), len(nd.Children), strings.Join(small, ", ")))
		}
	})
	return out
}

// Busy lists the levels that will look busy: many boxes, or many separate arrows between them. Says
// which boxes carry the most arrows, since grouping those (or the things they all talk to) is the usual cure.
func Busy(m *model.Model, maxBoxes, maxArrows int) []string {
	path := map[string][]*model.Node{}
	model.Walk(m.Root, func(nd, parent *model.Node, _ int) {
		if parent != nil {
			path[nd.ID] = append(slices.Clone(path[parent.ID]), nd)
		} else {
			path[nd.ID] = []*model.Node{nd}
		}
	})
	type stat struct {
		pairs map[string]bool
		deg   []*model.Node // insertion order
		count map[*model.Node]int
	}
	per := map[*model.Node]*stat{}
	for _, e := range m.Edges {
		pa, pb := path[e.A], path[e.B]
		i := 0
		for i < len(pa) && i < len(pb) && pa[i] == pb[i] {
			i++
		}
		if i >= len(pa) || i >= len(pb) { // one end is inside the other
			continue
		}
		at, a, b := pa[i-1], pa[i], pb[i]
		s := per[at]
		if s == nil {
			s = &stat{pairs: map[string]bool{}, count: map[*model.Node]int{}}
			per[at] = s
		}
		key := a.ID + ">" + b.ID
		if s.pairs[key] {
			continue
		}
		s.pairs[key] = true
		for _, x := range []*model.Node{a, b} {
			if _, ok := s.count[x]; !ok {
				s.deg = append(s.deg, x)
			}
			s.count[x]++
		}
	}
	var out []string
	model.Walk(m.Root, func(nd, _ *model.Node, _ int) {
		if len(nd.Children) == 0 {
			return
		}
		s := per[nd]
		arrows := 0
		if s != nil {
			arrows = len(s.pairs)
		}
		boxes := 0
		for _, c := range nd.Children {
			if c.Note == nil || *c.Note == "" {
				boxes++
			}
		}
		if boxes <= maxBoxes && arrows <= maxArrows {
			return
		}
		hubs := ""
		if s != nil {
			d := slices.Clone(s.deg)
			sort.SliceStable(d, func(i, j int) bool { return s.count[d[j]]-s.count[d[i]] < 0 })
			var parts []string
			for _, x := range d[:min(3, len(d))] {
				parts = append(parts, fmt.Sprintf("%s (%d)", x.ID, s.count[x]))
			}
			hubs = strings.Join(parts, ", ")
		}
		who := `"` + nd.ID + `"`
		if nd.ID == "__root" {
			who = "the top level"
		}
		extra := ""
		if hubs != "" {
			extra = "; most arrows: " + hubs
		}
		out = append(out, fmt.Sprintf("%s is busy: %d boxes and %d arrows on one level%s. Put boxes that talk to the same things inside one box, or move detail a level down", who, boxes, arrows, extra))
	})
	return out
}

// Totals are the arrow-quality numbers of one level, or of the whole picture.
type Totals struct{ Lines, Crossings, Bends, Length, Slanted float64 }

// Level is Totals for the container ID.
type Level struct {
	ID string
	Totals
}

// Stats is the result of Quality.
type Stats struct {
	Total  Totals
	Levels []Level
}

type tagSeen struct {
	runKeys []string
	runs    map[string][][4]float64
	loose   [][2][2]float64
	corners map[[2]float64]bool
}

// Quality measures how clean the arrows are, in numbers, so a change to the router can be judged: per
// level and in total, how often two different arrows cross, how many bends there are, how much line is
// drawn (in widths of that level), and how many pieces are not at right angles.
func Quality(m *model.Model) Stats {
	var st Stats
	model.Walk(m.Root, func(nd, _ *model.Node, _ int) {
		if len(nd.Children) == 0 {
			return
		}
		var tagOrder []string
		raw := map[string]*tagSeen{}
		bends, length, slanted, lines := 0.0, 0.0, 0.0, 0.0
		take := func(p [][2]float64, tag string) {
			if p == nil {
				return
			}
			lines++
			seen := raw[tag]
			if seen == nil {
				seen = &tagSeen{runs: map[string][][4]float64{}, corners: map[[2]float64]bool{}}
				raw[tag] = seen
				tagOrder = append(tagOrder, tag)
			}
			for i := 1; i < len(p)-1; i++ {
				seen.corners[p[i]] = true
			}
			for i := 0; i < len(p)-1; i++ {
				a, b := p[i], p[i+1]
				flat, up := math.Abs(a[1]-b[1]) <= 0.15, math.Abs(a[0]-b[0]) <= 0.15
				if !flat && !up {
					slanted++
					seen.loose = append(seen.loose, [2][2]float64{a, b})
					continue
				}
				k := 1
				ch := "v"
				if flat {
					k, ch = 0, "h"
				}
				key := ch + jsx.NumStr(jsx.Round(float64(a[1-k]*10)))
				if _, ok := seen.runs[key]; !ok {
					seen.runKeys = append(seen.runKeys, key)
				}
				seen.runs[key] = append(seen.runs[key], [4]float64{math.Min(a[k], b[k]), math.Max(a[k], b[k]), a[1-k], float64(k)})
			}
		}
		if nd.Routes != nil {
			for _, id := range nd.Routes.JSKeys() {
				take(nd.Routes.At(id).P, id)
			}
		}
		if nd.XR != nil {
			for _, g := range nd.XR.JSKeys() {
				x := nd.XR.At(g)
				for _, kid := range x.R.JSKeys() {
					if pc := x.R.At(kid); pc != nil {
						take(pc.P, "x:"+g)
					}
				}
			}
		}
		// boxes that share one arrow out of this level share a trunk: a stretch drawn twice counts once
		type sg struct {
			a, b pt2
			tag  string
		}
		var segs []sg
		for _, tag := range tagOrder {
			seen := raw[tag]
			bends += float64(len(seen.corners))
			for _, ab := range seen.loose {
				segs = append(segs, sg{ab[0], ab[1], tag})
				length += math.Abs(ab[0][0]-ab[1][0]) + math.Abs(ab[0][1]-ab[1][1])
			}
			for _, key := range seen.runKeys {
				runs := seen.runs[key]
				sort.SliceStable(runs, func(i, j int) bool { return runs[i][0]-runs[j][0] < 0 })
				var cur *[4]float64
				flush := func() {
					if cur == nil {
						return
					}
					length += cur[1] - cur[0]
					if cur[3] == 0 {
						segs = append(segs, sg{pt2{cur[0], cur[2]}, pt2{cur[1], cur[2]}, tag})
					} else {
						segs = append(segs, sg{pt2{cur[2], cur[0]}, pt2{cur[2], cur[1]}, tag})
					}
				}
				for _, r := range runs {
					if cur != nil && r[0] <= cur[1]+0.05 {
						cur[1] = math.Max(cur[1], r[1])
					} else {
						flush()
						c := r
						cur = &c
					}
				}
				flush()
			}
		}
		crossings := 0.0
		o := func(p, q, r pt2) float64 {
			return jsx.Sign(float64((q[0]-p[0])*(r[1]-p[1])) - float64((q[1]-p[1])*(r[0]-p[0])))
		}
		for i := 0; i < len(segs); i++ {
			for j := i + 1; j < len(segs); j++ {
				a, b, t := segs[i].a, segs[i].b, segs[i].tag
				c, d, u := segs[j].a, segs[j].b, segs[j].tag
				if t != u && o(a, b, c)*o(a, b, d) < 0 && o(c, d, a)*o(c, d, b) < 0 {
					crossings++
				}
			}
		}
		row := Level{ID: nd.ID, Totals: Totals{Lines: lines, Crossings: crossings, Bends: bends, Length: jsx.Round(float64(length/nd.IW*10)) / 10, Slanted: slanted}}
		st.Levels = append(st.Levels, row)
		st.Total.Crossings += row.Crossings
		st.Total.Bends += row.Bends
		st.Total.Length += row.Length
		st.Total.Slanted += row.Slanted
		st.Total.Lines += row.Lines
	})
	st.Total.Length = jsx.Round(float64(st.Total.Length*10)) / 10
	return st
}

type pt2 = [2]float64

// Outline is a text picture of the tree, for people and for Claude to check its own work.
func Outline(m *model.Model) (text string, boxes, depth, arrows int) {
	var lines []string
	model.Walk(m.Root, func(nd, parent *model.Node, d int) {
		if parent == nil {
			return
		}
		boxes++
		depth = max(depth, d)
		var bits []string
		if len(nd.Children) > 0 {
			s := fmt.Sprintf("%d inside", len(nd.Children))
			if nd.Group {
				s += ", group"
			}
			bits = append(bits, s)
		}
		if nd.Shape != "" {
			bits = append(bits, nd.Shape)
		}
		if nd.Note != nil && *nd.Note != "" {
			bits = append(bits, "note")
		}
		if nd.State != nil && *nd.State != "" {
			bits = append(bits, *nd.State)
		}
		if nd.Ref != nil && *nd.Ref != "" {
			bits = append(bits, "→ "+*nd.Ref)
		}
		line := strings.Repeat("  ", d-1) + nd.ID + `  "` + strings.ReplaceAll(nd.Label, "\n", " ") + `"`
		if len(bits) > 0 {
			line += "  (" + strings.Join(bits, ", ") + ")"
		}
		lines = append(lines, line)
	})
	return strings.Join(lines, "\n"), boxes, depth, len(m.Edges)
}
