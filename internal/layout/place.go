package layout

import (
	"fmt"
	"math"
	"strings"

	"strata/internal/model"
)

// Stated placement: the file says where each box sits; this works out only the distances.
// A gap is a minimum, never an exact distance, and everything ends up as close together as the
// statements allow. Anything left ambiguous is an error that names the box, never a guess.
func placeStated(nd *model.Node, fx, fy float64) (*Placed, error) {
	kids := nd.Children
	n := len(kids)
	idx := make(map[string]int, n)
	for i, c := range kids {
		idx[c.ID] = i
	}
	where := fmt.Sprintf(`in "%s"`, nd.ID)
	if nd.ID == "__root" {
		where = "at the top level"
	}
	var free []string
	for _, c := range kids {
		if c.Place == nil {
			free = append(free, c.ID)
		}
	}
	if len(free) != 1 {
		list := strings.Join(free, ", ")
		if list == "" {
			list = "none"
		}
		return nil, fmt.Errorf("%s, %d boxes have no place (%s): once any box in a container is placed, all but one must be, and that one is what the rest are placed against", where, len(free), list)
	}
	find := func(p []int, i int) int {
		for p[i] != i {
			p[i] = p[p[i]]
			i = p[i]
		}
		return i
	}
	colOf, rowOf := make([]int, n), make([]int, n) // boxes sharing a centre line share a variable
	for i := range colOf {
		colOf[i], rowOf[i] = i, i
	}
	type sep struct {
		i, j, own int
		d         float64
		text      string
	}
	var sepX, sepY []sep
	for i, c := range kids {
		if c.Place == nil {
			continue
		}
		var xs, ys, lv []model.Place
		for _, p := range c.Place {
			switch p.Rel {
			case "left", "right":
				xs = append(xs, p)
			case "above", "below":
				ys = append(ys, p)
			case "level":
				lv = append(lv, p)
			}
		}
		if len(xs) == 0 && len(ys) == 0 {
			if len(lv) == 0 { // an empty `place: []`: the JavaScript fails reading lv[0].target
				return nil, fmt.Errorf("Cannot read properties of undefined (reading 'target')")
			}
			return nil, fmt.Errorf(`"%s" %s is level with "%s" but does not say which side of anything it sits on: add left of or right of`, c.ID, where, lv[0].Target)
		}
		if len(xs) > 0 && len(ys) == 0 && len(lv) == 0 {
			if len(xs) > 1 {
				return nil, fmt.Errorf(`"%s" %s does not say which row it sits in: add level with, above or below`, c.ID, where)
			}
			a := find(rowOf, i)
			rowOf[a] = find(rowOf, idx[xs[0].Target])
		}
		if len(ys) > 0 && len(xs) == 0 {
			if len(ys) > 1 {
				return nil, fmt.Errorf(`"%s" %s does not say which column it sits in: add left of or right of`, c.ID, where)
			}
			a := find(colOf, i)
			colOf[a] = find(colOf, idx[ys[0].Target])
		}
		for _, p := range lv {
			a := find(rowOf, i)
			rowOf[a] = find(rowOf, idx[p.Target])
		}
		for _, p := range append(append([]model.Place{}, xs...), ys...) {
			j := idx[p.Target]
			t := kids[j]
			horiz := p.Rel == "left" || p.Rel == "right"
			var d float64
			if horiz {
				d = (c.W+t.W)/2 + float64(gapOf[p.Gap]*fx)
			} else {
				d = (c.H+t.H)/2 + float64(gapOf[p.Gap]*fy)
			}
			before := j
			if !(p.Rel == "right" || p.Rel == "below") {
				before = i
			}
			after := i
			if before == i {
				after = j
			}
			text := fmt.Sprintf(`"%s" %s "%s"`, c.ID, p.Rel, p.Target)
			if horiz {
				text = fmt.Sprintf(`"%s" %s of "%s"`, c.ID, p.Rel, p.Target)
			}
			s := sep{i: before, j: after, d: d, own: i, text: text}
			if horiz {
				sepX = append(sepX, s)
			} else {
				sepY = append(sepY, s)
			}
		}
	}
	solve := func(group []int, seps []sep, axis string) ([]float64, error) {
		v := make([]float64, n)
		g := func(i int) int { return find(group, i) }
		for _, s := range seps {
			if g(s.i) == g(s.j) {
				what := "row"
				if axis == "x" {
					what = "column"
				}
				return nil, fmt.Errorf("%s %s contradicts another placement that puts the two on the same %s", s.text, where, what)
			}
		}
		for pass, moved := 0, true; moved; pass++ { // longest path: every box as far left (or up) as its statements allow
			moved = false
			for _, s := range seps {
				if v[g(s.j)] < v[g(s.i)]+s.d {
					v[g(s.j)] = v[g(s.i)] + s.d
					moved = true
				}
			}
			if pass > n+2 {
				texts := make([]string, len(seps))
				for i, s := range seps {
					texts[i] = s.text
				}
				return nil, fmt.Errorf("the placements %s go round in a circle (%s)", where, strings.Join(texts, "; "))
			}
		}
		for pass, moved := 0, true; moved && pass < 4*n; pass++ { // then pull a box that sits before its target back up against it
			moved = false
			for _, s := range seps {
				if g(s.own) != g(s.i) {
					continue
				}
				m := math.Inf(1)
				for _, o := range seps {
					if g(o.i) == g(s.i) {
						m = math.Min(m, v[g(o.j)]-o.d)
					}
				}
				room := m - v[g(s.i)]
				if room > 0.01 {
					v[g(s.i)] += room
					moved = true
				}
			}
		}
		out := make([]float64, n)
		for i := range kids {
			out[i] = v[g(i)]
		}
		return out, nil
	}
	cx, err := solve(colOf, sepX, "x")
	if err != nil {
		return nil, err
	}
	cy, err := solve(rowOf, sepY, "y")
	if err != nil {
		return nil, err
	}
	box := make([]Rect, n)
	for i, c := range kids {
		box[i] = Rect{ID: c.ID, X: cx[i] - c.W/2, Y: cy[i] - c.H/2, Width: c.W, Height: c.H}
	}
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			a, b := box[i], box[j]
			if a.X < b.X+b.Width-1 && b.X < a.X+a.Width-1 && a.Y < b.Y+b.Height-1 && b.Y < a.Y+a.Height-1 {
				return nil, fmt.Errorf(`"%s" and "%s" %s overlap, and nothing says which side of the other either one sits on: place one against the other`, a.ID, b.ID, where)
			}
		}
	}
	x0, y0 := math.Inf(1), math.Inf(1)
	for _, b := range box {
		x0, y0 = math.Min(x0, b.X), math.Min(y0, b.Y)
	}
	w, h := math.Inf(-1), math.Inf(-1)
	for i := range box {
		box[i].X -= x0
		box[i].Y -= y0
	}
	for _, b := range box {
		w, h = math.Max(w, b.X+b.Width), math.Max(h, b.Y+b.Height)
	}
	return &Placed{Width: w, Height: h, Children: box}, nil
}
