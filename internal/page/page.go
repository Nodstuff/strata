// Package page turns a laid-out model into one self-contained HTML page, and holds the text
// reports (outline, legibility, busy, quality) the command prints.
package page

import (
	_ "embed"
	"strings"

	"github.com/Nodstuff/strata/internal/jsx"
	"github.com/Nodstuff/strata/internal/model"
)

//go:embed shell.html
var shell string

// viewer is the browser JavaScript pasted into every page: the zooming, the arrows, the panel.
// It is the only part of strata that is not Go, because it runs in the reader's browser.
//
//go:embed viewer.js
var viewer string

func esc(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "&", "&amp;"), "<", "&lt;")
}

func appendColour(b []byte, c *model.Colour) []byte {
	if c == nil {
		return append(b, "null"...)
	}
	b = append(b, '[')
	for i, v := range c {
		if i > 0 {
			b = append(b, ',')
		}
		b = jsx.AppendNum(b, float64(v))
	}
	return append(b, ']')
}

func appendPts(b []byte, pts [][2]float64) []byte {
	b = append(b, '[')
	for i, p := range pts {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '[')
		b = jsx.AppendNum(b, p[0])
		b = append(b, ',')
		b = jsx.AppendNum(b, p[1])
		b = append(b, ']')
	}
	return append(b, ']')
}

func appendNode(b []byte, nd *model.Node) []byte {
	// The keys the page keeps, in the order the JavaScript keeps them (KEEP in build.js).
	b = append(b, '{')
	first := true
	key := func(k string) {
		if !first {
			b = append(b, ',')
		}
		first = false
		b = jsx.AppendString(b, k)
		b = append(b, ':')
	}
	str := func(k string, v *string) {
		if v != nil {
			key(k)
			b = jsx.AppendString(b, *v)
		}
	}
	num := func(k string, v float64) { key(k); b = jsx.AppendNum(b, v) }
	key("id")
	b = jsx.AppendString(b, nd.ID)
	key("label")
	b = jsx.AppendString(b, nd.Label)
	str("sub", nd.Sub)
	if nd.Detail != nil {
		key("detail")
		b = append(b, '[')
		for i, l := range nd.Detail {
			if i > 0 {
				b = append(b, ',')
			}
			b = jsx.AppendString(b, l)
		}
		b = append(b, ']')
	}
	str("note", nd.Note)
	key("kind")
	b = jsx.AppendString(b, nd.Kind)
	if nd.Shape != "" {
		key("shape")
		b = jsx.AppendString(b, nd.Shape)
	}
	str("state", nd.State)
	str("until", nd.Until)
	str("ref", nd.Ref)
	if nd.Group {
		key("group")
		b = append(b, "true"...)
	}
	if nd.HasXY {
		num("x", nd.X)
		num("y", nd.Y)
	}
	num("w", nd.W)
	num("h", nd.H)
	if nd.HasInner {
		num("iw", nd.IW)
		num("ih", nd.IH)
	}
	if nd.Routes != nil {
		key("routes")
		b = append(b, '{')
		for i, id := range nd.Routes.JSKeys() {
			r := nd.Routes.At(id)
			if i > 0 {
				b = append(b, ',')
			}
			b = jsx.AppendString(b, id)
			b = append(b, `:{"p":`...)
			b = appendPts(b, r.P)
			if r.M != nil {
				b = append(b, `,"m":[`...)
				for j, v := range r.M {
					if j > 0 {
						b = append(b, ',')
					}
					b = jsx.AppendNum(b, v)
				}
				b = append(b, ']')
			}
			if r.L != nil {
				b = append(b, `,"l":[`...)
				b = jsx.AppendNum(b, r.L[0])
				b = append(b, ',')
				b = jsx.AppendNum(b, r.L[1])
				b = append(b, ']')
			}
			b = append(b, '}')
		}
		b = append(b, '}')
	}
	if nd.XR != nil {
		key("xr")
		b = append(b, '{')
		for i, group := range nd.XR.JSKeys() {
			g := nd.XR.At(group)
			if i > 0 {
				b = append(b, ',')
			}
			b = jsx.AppendString(b, group)
			b = append(b, `:{"port":`...)
			if g.Port == nil {
				b = append(b, "null"...)
			} else {
				b = append(b, '[')
				b = jsx.AppendNum(b, g.Port[0])
				b = append(b, ',')
				b = jsx.AppendNum(b, g.Port[1])
				b = append(b, ']')
			}
			b = append(b, `,"r":{`...)
			for j, kid := range g.R.JSKeys() {
				if j > 0 {
					b = append(b, ',')
				}
				b = jsx.AppendString(b, kid)
				b = append(b, ':')
				if pc := g.R.At(kid); pc == nil {
					b = append(b, "null"...)
				} else {
					b = appendPts(b, pc.P)
				}
			}
			b = append(b, "}}"...)
		}
		b = append(b, '}')
	}
	if len(nd.Children) > 0 {
		key("children")
		b = append(b, '[')
		for i, c := range nd.Children {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendNode(b, c)
		}
		b = append(b, ']')
	}
	return append(b, '}')
}

// Payload is JSON.stringify(payload(model)): the data the page embeds.
func Payload(m *model.Model) []byte {
	b := []byte(`{"title":`)
	b = jsx.AppendString(b, m.Title)
	b = append(b, `,"kinds":{`...)
	for i, k := range m.Kinds.JSKeys() {
		kd := m.Kinds.At(k)
		if i > 0 {
			b = append(b, ',')
		}
		b = jsx.AppendString(b, k)
		b = append(b, `:{"c":`...)
		b = appendColour(b, kd.C)
		b = append(b, `,"dashed":`...)
		b = jsx.AppendAny(b, kd.Dashed)
		b = append(b, '}')
	}
	b = append(b, `},"styles":{`...)
	for i, k := range m.Styles.JSKeys() {
		s := m.Styles.At(k)
		if i > 0 {
			b = append(b, ',')
		}
		b = jsx.AppendString(b, k)
		b = append(b, `:{"c":`...)
		b = appendColour(b, s.C)
		b = append(b, `,"w":`...)
		b = jsx.AppendAny(b, s.W)
		b = append(b, `,"dash":`...)
		b = jsx.AppendAny(b, s.Dash)
		b = append(b, `,"rank":`...)
		b = jsx.AppendAny(b, s.Rank)
		b = append(b, `,"label":`...)
		b = jsx.AppendAny(b, s.Label)
		b = append(b, `,"noHead":`...)
		b = jsx.AppendAny(b, s.NoHead)
		b = append(b, '}')
	}
	b = append(b, `},"states":{`...)
	for i, k := range m.States.JSKeys() {
		s := m.States.At(k)
		if i > 0 {
			b = append(b, ',')
		}
		b = jsx.AppendString(b, k)
		b = append(b, `:{"label":`...)
		b = jsx.AppendAny(b, s.Label)
		b = append(b, `,"c":`...)
		b = appendColour(b, s.C)
		b = append(b, `,"shown":`...)
		b = jsx.AppendAny(b, s.Shown)
		b = append(b, '}')
	}
	b = append(b, `},"root":`...)
	b = appendNode(b, m.Root)
	b = append(b, `,"edges":[`...)
	for i, e := range m.Edges {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"a":`...)
		b = jsx.AppendString(b, e.A)
		b = append(b, `,"b":`...)
		b = jsx.AppendString(b, e.B)
		b = append(b, `,"label":`...)
		b = jsx.AppendString(b, e.Label)
		b = append(b, `,"style":`...)
		b = jsx.AppendString(b, e.Style)
		if e.Tag != nil {
			b = append(b, `,"tag":`...)
			b = jsx.AppendString(b, *e.Tag)
		}
		if e.Until != nil {
			b = append(b, `,"until":`...)
			b = jsx.AppendString(b, *e.Until)
		}
		b = append(b, '}')
	}
	return append(b, "]}"...)
}

// HTML is the whole page: the data and the viewer in the one template.
func HTML(m *model.Model) string {
	data := strings.ReplaceAll(string(Payload(m)), "<", "\\u"+"003c") // no "</script>" inside the page
	// the shell is cut at its three marks and joined, so the viewer's own text is never searched
	title, rest, _ := strings.Cut(shell, "{{TITLE}}")
	mid, rest, _ := strings.Cut(rest, "{{DATA}}")
	between, after, _ := strings.Cut(rest, "{{VIEWER}}")
	return title + esc(m.Title) + mid + data + between + viewer + after
}
