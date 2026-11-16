// Package model reads a diagram file (YAML) and turns it into the checked, normalised model that
// layout and the viewer work from. Every problem is collected and reported at once.
package model

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/Nodstuff/strata/internal/jsx"
)

// Colour is an RGB triple.
type Colour = [3]int

// Palette maps colour names to RGB; Names lists them in the order the error message does.
var Palette = map[string]Colour{
	"blue": {76, 124, 240}, "green": {34, 160, 90}, "red": {220, 70, 70}, "orange": {224, 122, 48}, "purple": {154, 107, 224},
	"yellow": {200, 160, 30}, "grey": {130, 134, 146}, "gray": {130, 134, 146}, "violet": {130, 110, 240}, "teal": {47, 168, 150}, "slate": {120, 130, 200},
}

const paletteList = "blue, green, red, orange, purple, yellow, grey, violet, teal, slate"

// Kind is how a kind of box is drawn.
type Kind struct {
	C      *Colour
	Dashed bool
}

// Style is how a kind of arrow is drawn. W, Rank and Label are whatever the file said, because the
// page passes them through untouched.
type Style struct {
	C      *Colour
	W      any
	Dash   any // nil or a list
	Rank   any
	Label  any
	NoHead bool
}

// RankNum is the rank as a number (a rank that is not a number counts as 0).
func (s Style) RankNum() float64 {
	if f, ok := s.Rank.(float64); ok {
		return f
	}
	return 0
}

// State is a tag: a named set of boxes and arrows the viewer can switch on and off.
type State struct {
	Label any
	C     *Colour
	Shown bool
}

// Place is one statement of stated placement: "right of x wide".
type Place struct{ Rel, Target, Gap string }

// Edge is one arrow.
type Edge struct {
	A, B, Label, Style string
	Tag, Until         *string
}

// Route is one drawn arrow between two boxes of a container: its points, and where its label sits
// (L), or the stretch that is its own on a shared trunk (M).
type Route struct {
	P [][2]float64
	L *[2]float64
	M *[3]float64
}

// Piece is one box's line to a container's port; a nil *Piece is a null in the payload.
type Piece struct{ P [][2]float64 }

// XRGroup is a container's port for one arrow group, and the piece inside it for each box the arrow is for.
type XRGroup struct {
	Port *[2]float64
	R    *jsx.OMap[*Piece]
}

// Node is a box. The layout fields (X.. IH, Routes, XR) are filled in by package layout.
type Node struct {
	ID, Label string
	Sub, Note *string
	Detail    []string // nil: none; non-nil but empty: all lines were blank
	Kind      string
	Shape     string // "" for a plain box
	State     *string
	Until     *string
	Ref       *string
	Group     bool
	Flow      string
	Place     []Place
	About     *string
	Widths    string
	Children  []*Node

	X, Y, W, H, IW, IH float64
	HasXY, HasInner    bool
	Routes             *jsx.OMap[*Route]
	XR                 *jsx.OMap[*XRGroup]
}

// Model is a checked diagram.
type Model struct {
	Title    string
	Kinds    *jsx.OMap[Kind]
	Styles   *jsx.OMap[Style]
	States   *jsx.OMap[State]
	Root     *Node
	Edges    []Edge
	Warnings []string
}

// ProblemsError carries every problem found in a file, one per line of its message.
type ProblemsError struct{ Problems []string }

func (e *ProblemsError) Error() string { return strings.Join(e.Problems, "\n") }

// Problems returns the list when err is (or wraps) a ProblemsError.
func Problems(err error) []string {
	if pe, ok := errors.AsType[*ProblemsError](err); ok {
		return pe.Problems
	}
	return nil
}

// Walk calls fn for nd and everything inside it, parents first.
func Walk(nd *Node, fn func(nd, parent *Node, depth int)) { walk(nd, nil, 0, fn) }
func walk(nd, parent *Node, depth int, fn func(nd, parent *Node, depth int)) {
	fn(nd, parent, depth)
	for _, c := range nd.Children {
		walk(c, nd, depth+1, fn)
	}
}

// Clone copies the tree (what structuredClone does); kinds, styles, states and edges are never
// changed after loading, so they are shared.
func (m *Model) Clone() *Model {
	c := *m
	c.Root = cloneNode(m.Root)
	c.Warnings = append([]string(nil), m.Warnings...)
	return &c
}

func cloneNode(n *Node) *Node {
	c := *n
	c.Children = nil
	for _, k := range n.Children {
		c.Children = append(c.Children, cloneNode(k))
	}
	// layout has not run on a tree that is cloned, so there is nothing else to copy
	return &c
}

func sp(s string) *string { return &s }

var (
	nodeKeys = []string{"id", "label", "sub", "detail", "note", "kind", "shape", "state", "tag", "until", "ref", "group", "flow", "place", "about", "widths", "nodes"}
	rePlace  = regexp.MustCompile(`^(above|below|left of|right of|level with)\s+([\w.-]+)(?:\s+(none|tight|normal|wide))?$`)
	reHexCol = regexp.MustCompile(`^#([0-9a-fA-F]{6})$`)
	shapes   = map[string]string{"box": "box", "diamond": "diamond", "cylinder": "cylinder", "cyl": "cylinder", "actor": "actor"}
)

func builtinKinds() [][2]any {
	return [][2]any{{"service", "blue"}, {"store", "orange"}, {"infra", "purple"}, {"external", "grey"}, {"step", "slate"}, {"frame", "grey"}, {"note", "yellow"}, {"ref", "violet"}}
}

type loader struct {
	errors, warnings []string
	kinds            *jsx.OMap[Kind]
	styles           *jsx.OMap[Style]
	states           *jsx.OMap[State]
	byID             *jsx.OMap[*Node]
}

func (l *loader) errf(format string, a ...any) {
	l.errors = append(l.errors, fmt.Sprintf(format, a...))
}

func get(m any, key string) any {
	if o, ok := m.(*jsx.OMap[any]); ok {
		if v, ok := o.Get(key); ok {
			return v
		}
	}
	return jsx.Undefined
}

func (l *loader) colour(v any, where string) *Colour {
	if jsx.IsNullish(v) {
		return nil
	}
	s := jsx.String(v)
	if c, ok := Palette[s]; ok {
		return &c
	}
	if m := reHexCol.FindStringSubmatch(s); m != nil {
		var c Colour
		for i := range 3 {
			n, _ := strconv.ParseInt(m[1][2*i:2*i+2], 16, 32)
			c[i] = int(n)
		}
		return &c
	}
	l.errf(`%s: unknown colour "%s" (use %s or "#rrggbb")`, where, s, paletteList)
	g := Palette["grey"]
	return &g
}

// asMap: a bare string is a colour name; a map stays as it is; anything else is a problem.
func (l *loader) asMap(v any, where string) any {
	switch x := v.(type) {
	case string:
		o := jsx.NewOMap[any]()
		o.Set("color", x)
		return o
	case *jsx.OMap[any]:
		return x
	case []any:
		return jsx.NewOMap[any]() // an array is an object to JavaScript, with none of the keys we read
	}
	l.errf("%s: expected a colour name or a map", where)
	return jsx.NewOMap[any]()
}

// or is `a || b`.
func or(a, b any) any {
	if jsx.Truthy(a) {
		return a
	}
	return b
}

// nn is `a ?? b`.
func nn(a, b any) any {
	if !jsx.IsNullish(a) {
		return a
	}
	return b
}

// Load reads and checks a diagram file.
func Load(text string) (*Model, error) {
	l := &loader{kinds: jsx.NewOMap[Kind](), styles: jsx.NewOMap[Style](), states: jsx.NewOMap[State](), byID: jsx.NewOMap[*Node]()}
	docv, err := ParseYAML(text)
	if err != nil {
		return nil, errors.New("not valid YAML: " + err.Error())
	}
	doc, ok := docv.(*jsx.OMap[any])
	if !ok {
		return nil, errors.New("the file must be a YAML map with at least `nodes`")
	}

	// kinds: the built-in ones, then the file's (which add to or override them)
	kindDefs := jsx.NewOMap[any]()
	for _, kv := range builtinKinds() {
		d := jsx.NewOMap[any]()
		d.Set("color", kv[1])
		if kv[0] == "external" {
			d.Set("dashed", true)
		}
		kindDefs.Set(kv[0].(string), d)
	}
	if o, ok := get(doc, "kinds").(*jsx.OMap[any]); ok {
		for _, k := range o.JSKeys() {
			kindDefs.Set(k, o.At(k))
		}
	}
	for _, name := range kindDefs.JSKeys() {
		d := l.asMap(kindDefs.At(name), "kinds."+name)
		c := l.colour(or(get(d, "color"), "grey"), "kinds."+name)
		l.kinds.Set(name, Kind{C: c, Dashed: jsx.Truthy(get(d, "dashed"))})
	}

	// styles
	styleDefs := jsx.NewOMap[any]()
	for _, n := range []struct {
		name string
		def  []any
	}{{"flow", []any{"rank", 1.0}}, {"yes", []any{"color", "green", "rank", 2.0, "width", 1.6}}, {"no", []any{"color", "red", "rank", 2.0, "width", 1.6}}} {
		d := jsx.NewOMap[any]()
		for i := 0; i < len(n.def); i += 2 {
			d.Set(n.def[i].(string), n.def[i+1])
		}
		styleDefs.Set(n.name, d)
	}
	if o, ok := get(doc, "styles").(*jsx.OMap[any]); ok {
		for _, k := range o.JSKeys() {
			styleDefs.Set(k, o.At(k))
		}
	}
	for _, name := range styleDefs.JSKeys() {
		d := l.asMap(styleDefs.At(name), "styles."+name)
		dv := get(d, "dash")
		var dash any
		switch {
		case dv == true || dv == "dashed":
			dash = []any{7.0, 5.0}
		case dv == "dotted":
			dash = []any{2.0, 4.0}
		default:
			if a, ok := dv.([]any); ok {
				dash = a
			}
		}
		col := get(d, "color")
		width := or(get(d, "width"), func() any {
			if jsx.Truthy(col) {
				return 1.7
			}
			return 1.3
		}())
		var label any
		if lv := get(d, "label"); jsx.Truthy(lv) {
			label = lv
		}
		arrow := get(d, "arrow")
		l.styles.Set(name, Style{
			C: l.colour(col, "styles."+name), W: width, Dash: dash, Rank: nn(get(d, "rank"), 1.0), Label: label,
			NoHead: arrow == "none" || arrow == false,
		})
	}

	// tags (the older name, states, still works)
	stateDefs := jsx.NewOMap[any]()
	for _, src := range []string{"states", "tags"} {
		if o, ok := get(doc, src).(*jsx.OMap[any]); ok {
			for _, k := range o.JSKeys() {
				stateDefs.Set(k, o.At(k))
			}
		}
	}
	for _, name := range stateDefs.JSKeys() {
		d := l.asMap(stateDefs.At(name), "tags."+name)
		show := get(d, "show")
		l.states.Set(name, State{
			Label: or(get(d, "label"), name), C: l.colour(or(get(d, "color"), "green"), "tags."+name),
			Shown: !(show == false || show == "off" || show == "no"),
		})
	}

	nodesv := get(doc, "nodes")
	list, isList := nodesv.([]any)
	if !isList || len(list) == 0 {
		l.errf("nodes: the file needs a non-empty list of nodes")
	}
	root := &Node{ID: "__root", Label: jsx.String(or(get(doc, "title"), "Untitled diagram")), Kind: "frame", Group: true}
	if isList {
		for i, k := range list {
			if c := l.node(k, fmt.Sprintf("nodes[%d]", i)); c != nil {
				root.Children = append(root.Children, c)
			}
		}
	}
	if v := get(doc, "subtitle"); !jsx.IsNullish(v) {
		root.Sub = sp(jsx.String(v))
	}
	if f := get(doc, "flow"); f == "right" || f == "down" {
		root.Flow = f.(string)
	}
	if get(doc, "widths") == "match" {
		root.Widths = "match"
	}

	for _, id := range l.byID.Keys() {
		nd := l.byID.At(id)
		if nd.Ref != nil && *nd.Ref != "" && !l.byID.Has(*nd.Ref) {
			l.errf(`node "%s": ref points at "%s", which does not exist`, nd.ID, *nd.Ref)
		}
	}
	Walk(root, func(nd, _ *Node, _ int) { // a placement, and a note's subject, must name a box in the same container
		here := map[string]bool{}
		for _, c := range nd.Children {
			here[c.ID] = true
		}
		for _, c := range nd.Children {
			for _, p := range c.Place {
				if p.Target == c.ID || !here[p.Target] {
					l.errf(`node "%s": place names "%s", which is not another box in the same container`, c.ID, p.Target)
				}
			}
			if c.About != nil && *c.About != "" && (*c.About == c.ID || !here[*c.About]) {
				l.errf(`node "%s": about names "%s", which is not another box in the same container`, c.ID, *c.About)
			}
		}
	})

	var edges []Edge
	var rawEdges []any
	switch ev := get(doc, "edges").(type) {
	case []any:
		rawEdges = ev
	default:
		if !jsx.IsNullish(ev) {
			l.errf("edges must be a list")
		}
	}
	for i, raw := range rawEdges {
		var from, to, label, style, tag, until, state any = jsx.Undefined, jsx.Undefined, jsx.Undefined, jsx.Undefined, jsx.Undefined, jsx.Undefined, jsx.Undefined
		switch r := raw.(type) {
		case []any:
			at := func(i int) any {
				if i < len(r) {
					return r[i]
				}
				return jsx.Undefined
			}
			from, to, label, style, tag = at(0), at(1), at(2), at(3), at(4)
		case *jsx.OMap[any]:
			from, to, label, style, tag, until, state = get(r, "from"), get(r, "to"), get(r, "label"), get(r, "style"), get(r, "tag"), get(r, "until"), get(r, "state")
		}
		where := fmt.Sprintf("edges[%d] (%s → %s)", i, jsx.String(from), jsx.String(to))
		for _, end := range []struct {
			name string
			v    any
		}{{"from", from}, {"to", to}} {
			if jsx.IsNullish(end.v) || !l.byID.Has(jsx.String(end.v)) {
				l.errf(`%s: %s "%s" is not a node id`, where, end.name, jsx.String(end.v))
			}
		}
		st := "flow"
		if !jsx.IsNullish(style) {
			st = jsx.String(style)
		}
		if !l.styles.Has(st) {
			l.errf(`%s: unknown style "%s" (known: %s)`, where, st, strings.Join(l.styles.JSKeys(), ", "))
		}
		tg := nn(tag, state)
		if !jsx.IsNullish(tg) && !l.states.Has(jsx.String(tg)) {
			l.errf(`%s: unknown tag "%s" (declare it under tags)`, where, jsx.String(tg))
		}
		if !jsx.IsNullish(until) && !l.states.Has(jsx.String(until)) {
			l.errf(`%s: until names "%s", which is not a tag`, where, jsx.String(until))
		}
		e := Edge{A: jsx.String(from), B: jsx.String(to), Style: st}
		if !jsx.IsNullish(label) {
			e.Label = jsx.String(label)
		}
		if !jsx.IsNullish(tg) {
			e.Tag = sp(jsx.String(tg))
		}
		if !jsx.IsNullish(until) {
			e.Until = sp(jsx.String(until))
		}
		edges = append(edges, e)
	}

	if len(l.errors) > 0 {
		return nil, &ProblemsError{Problems: l.errors}
	}
	return &Model{Title: root.Label, Kinds: l.kinds, Styles: l.styles, States: l.states, Root: root, Edges: edges, Warnings: l.warnings}, nil
}

func (l *loader) node(rawv any, where string) *Node {
	raw, ok := rawv.(*jsx.OMap[any])
	if !ok {
		l.errf("%s: a node must be a map with an id", where)
		return nil
	}
	idv := get(raw, "id")
	hasID := !jsx.IsNullish(idv)
	id := ""
	if hasID {
		id = jsx.String(idv)
	}
	at := where
	if id != "" {
		at = fmt.Sprintf(`node "%s"`, id)
	}
	if id == "" {
		l.errf("%s: missing id", where)
	} else if l.byID.Has(id) {
		l.errf("%s: the id is used twice; ids are global", at)
	}
	for _, k := range raw.JSKeys() {
		if !slicesContains(nodeKeys, k) {
			l.errf(`%s: unknown key "%s" (known: %s)`, at, k, strings.Join(nodeKeys, ", "))
		}
	}
	var kids []any
	hasKids := false
	if nv := get(raw, "nodes"); !jsx.IsNullish(nv) {
		if a, ok := nv.([]any); ok {
			kids, hasKids = a, true
		} else {
			l.errf("%s: nodes must be a list", at)
		}
	}
	nd := &Node{ID: id}
	switch lv := get(raw, "label"); {
	case !jsx.IsNullish(lv):
		nd.Label = jsx.String(lv)
	case hasID:
		nd.Label = id
	default:
		nd.Label = "?"
	}
	if id != "" {
		l.byID.Set(id, nd)
	}
	if v := get(raw, "sub"); !jsx.IsNullish(v) {
		nd.Sub = sp(jsx.String(v))
	}
	if v := get(raw, "detail"); !jsx.IsNullish(v) {
		var lines []string
		if a, ok := v.([]any); ok {
			for _, e := range a {
				lines = append(lines, jsx.String(e))
			}
		} else {
			lines = strings.Split(jsx.String(v), "\n")
		}
		nd.Detail = []string{}
		for _, s := range lines {
			if jsx.Trim(s) != "" {
				nd.Detail = append(nd.Detail, s)
			}
		}
	}
	if v := get(raw, "note"); !jsx.IsNullish(v) {
		nd.Note = sp(jsx.Trim(jsx.String(v)))
	}
	hasNote := nd.Note != nil && *nd.Note != ""
	if hasNote && hasKids {
		l.errf("%s: a note cannot have nodes inside it", at)
	}
	if hasNote && nd.Detail != nil {
		l.errf("%s: use either note or detail, not both", at)
	}
	switch kv := get(raw, "kind"); {
	case !jsx.IsNullish(kv):
		nd.Kind = jsx.String(kv)
	case hasNote:
		nd.Kind = "note"
	case jsx.Truthy(get(raw, "ref")):
		nd.Kind = "ref"
	case hasKids:
		nd.Kind = "frame"
	default:
		nd.Kind = "step"
	}
	if !l.kinds.Has(nd.Kind) {
		if c, ok := Palette[nd.Kind]; ok { // a bare colour works as a kind
			l.kinds.Set(nd.Kind, Kind{C: &c})
		} else {
			l.errf(`%s: unknown kind "%s" (known: %s, or any colour name)`, at, nd.Kind, strings.Join(l.kinds.JSKeys(), ", "))
			nd.Kind = "step"
		}
	}
	if sv := get(raw, "shape"); !jsx.IsNullish(sv) {
		shape, known := shapes[jsx.String(sv)]
		if !known {
			l.errf(`%s: unknown shape "%s" (box, diamond, cylinder, actor)`, at, jsx.String(sv))
		} else if shape != "box" {
			nd.Shape = shape
		}
		if hasKids && nd.Shape != "" {
			l.errf("%s: a node with nodes inside it must be a plain box", at)
		}
	}
	tag := nn(get(raw, "tag"), get(raw, "state"))
	if !jsx.IsNullish(tag) {
		if !l.states.Has(jsx.String(tag)) {
			l.errf(`%s: unknown tag "%s" (declare it under tags)`, at, jsx.String(tag))
		} else {
			nd.State = sp(jsx.String(tag))
		}
	}
	if u := get(raw, "until"); !jsx.IsNullish(u) {
		if !l.states.Has(jsx.String(u)) {
			l.errf(`%s: until names "%s", which is not a tag (declare it under tags)`, at, jsx.String(u))
		} else {
			nd.Until = sp(jsx.String(u))
		}
	}
	if v := get(raw, "ref"); !jsx.IsNullish(v) {
		nd.Ref = sp(jsx.String(v))
	}
	if jsx.Truthy(get(raw, "group")) {
		if hasKids {
			nd.Group = true
		} else {
			l.errf("%s: group only makes sense on a node with nodes inside it", at)
		}
	}
	if f := get(raw, "flow"); !jsx.IsNullish(f) {
		if f != "down" && f != "right" {
			l.errf("%s: flow must be down or right", at)
		} else {
			nd.Flow = f.(string)
		}
	}
	if pv := get(raw, "place"); !jsx.IsNullish(pv) {
		nd.Place = []Place{}
		items, isArr := pv.([]any)
		if !isArr {
			items = []any{pv}
		}
		for _, text := range items {
			m := rePlace.FindStringSubmatch(jsx.Trim(jsx.String(text)))
			if m == nil {
				l.errf(`%s: cannot read place "%s" (write: above X, below X, left of X, right of X or level with X, optionally followed by none, tight, normal or wide)`, at, jsx.String(text))
			} else {
				gap := m[3]
				if gap == "" {
					gap = "normal"
				}
				nd.Place = append(nd.Place, Place{Rel: strings.Split(m[1], " ")[0], Target: m[2], Gap: gap})
			}
		}
	}
	if v := get(raw, "about"); !jsx.IsNullish(v) {
		if !hasNote {
			l.errf("%s: about only makes sense on a note", at)
		} else {
			nd.About = sp(jsx.String(v))
		}
	}
	if v := get(raw, "widths"); !jsx.IsNullish(v) {
		if v != "match" || !hasKids {
			l.errf(`%s: widths takes only "match", on a node with nodes inside it`, at)
		} else {
			nd.Widths = "match"
		}
	}
	if hasKids {
		for i, k := range kids {
			if c := l.node(k, fmt.Sprintf("%s › nodes[%d]", at, i)); c != nil {
				nd.Children = append(nd.Children, c)
			}
		}
		if len(nd.Children) == 0 {
			l.errf("%s: nodes is empty", at)
			nd.Children = nil
		} else if len(nd.Children) > 16 {
			l.warnings = append(l.warnings, fmt.Sprintf("%s has %d boxes inside it; more than 16 is hard to read at one level, consider nesting", at, len(nd.Children)))
		}
	}
	return nd
}

func slicesContains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
