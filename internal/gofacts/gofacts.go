// Package gofacts reads Go source with the standard library's parser and returns the facts an
// architecture picture is made of: the HTTP routes a package serves, the message subjects, streams
// and key-value buckets it names, and the outside hosts it calls. It reads files and nothing else:
// no network, no build, no writes.
package gofacts

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Pkg is a package to read, as `go list` reports it.
type Pkg struct {
	ImportPath, Name, Dir string
	GoFiles               []string
}

// Fact is one thing the syntax tree says.
type Fact struct {
	Pkg    string
	Kind   string // route | host | bucket | stream | subject | pub | sub
	Name   string
	Method string
	Of     string // the stream a subject belongs to
	File   string
	Line   int
}

type file struct {
	ast     *ast.File
	name    string
	imports map[string]string // local name -> import path
	nats    bool
}

type pkg struct {
	in     Pkg
	files  []*file
	consts map[string]ast.Expr
	owner  map[string]*file
}

type reader struct {
	fset  *token.FileSet
	pkgs  map[string]*pkg
	order []*pkg // in the order given: the facts come out in a fixed order, not a map's
	out   []Fact
}

var (
	routeRe = regexp.MustCompile(`^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) )?(/\S*|\*/\S*)$`)
	hostRe  = regexp.MustCompile(`^https?://([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,})(?::\d+)?(?:/|$)`)
	subjRe  = regexp.MustCompile(`^[A-Za-z0-9_$*>-]+(\.[A-Za-z0-9_$*>-]+)*$`)
	verbs   = map[string]string{"Get": "GET", "Post": "POST", "Put": "PUT", "Patch": "PATCH", "Delete": "DELETE", "Head": "HEAD", "Options": "OPTIONS",
		"GET": "GET", "POST": "POST", "PUT": "PUT", "PATCH": "PATCH", "DELETE": "DELETE", "HEAD": "HEAD", "OPTIONS": "OPTIONS"}
	pubs = map[string]bool{"Publish": true, "PublishAsync": true, "Request": true, "RequestWithContext": true}
	subs = map[string]bool{"Subscribe": true, "QueueSubscribe": true, "ChanSubscribe": true, "SubscribeSync": true, "PullSubscribe": true, "QueueSubscribeSync": true}
)

// Read parses the packages' files and returns their facts, package by package in the order given.
func Read(in []Pkg) []Fact {
	r := &reader{fset: token.NewFileSet(), pkgs: map[string]*pkg{}, out: []Fact{}}
	names := map[string]string{} // import path -> package name, for the module's own packages
	for _, p := range in {
		names[p.ImportPath] = p.Name
	}
	for _, p := range in {
		pk := &pkg{in: p, consts: map[string]ast.Expr{}, owner: map[string]*file{}}
		r.pkgs[p.ImportPath] = pk
		r.order = append(r.order, pk)
		for _, name := range p.GoFiles {
			a, err := parser.ParseFile(r.fset, filepath.Join(p.Dir, name), nil, parser.SkipObjectResolution)
			if err != nil || a == nil {
				continue
			}
			f := &file{ast: a, name: name, imports: map[string]string{}}
			for _, im := range a.Imports {
				path, _ := strconv.Unquote(im.Path.Value)
				local := names[path]
				if local == "" {
					local = path[strings.LastIndex(path, "/")+1:]
				}
				if im.Name != nil {
					local = im.Name.Name
				}
				f.imports[local] = path
				if strings.Contains(path, "nats-io/") {
					f.nats = true
				}
			}
			for _, d := range a.Decls {
				g, ok := d.(*ast.GenDecl)
				if !ok || (g.Tok != token.CONST && g.Tok != token.VAR) {
					continue
				}
				for _, s := range g.Specs {
					v := s.(*ast.ValueSpec)
					for i, n := range v.Names {
						if i < len(v.Values) {
							pk.consts[n.Name] = v.Values[i]
							pk.owner[n.Name] = f
						}
					}
				}
			}
			pk.files = append(pk.files, f)
		}
	}
	for _, pk := range r.order {
		for _, f := range pk.files {
			r.walk(pk, f)
		}
	}
	return r.out
}

// value works out a string from literals, the module's own constants and "+". With loose set, a
// part it cannot know becomes "*", so "GET "+prefix+"/login" is still a route.
func (r *reader) value(e ast.Expr, pk *pkg, f *file, loose bool, depth int) (string, bool) {
	if depth > 8 {
		return "", false
	}
	switch x := e.(type) {
	case *ast.BasicLit:
		if x.Kind == token.STRING {
			s, err := strconv.Unquote(x.Value)
			return s, err == nil
		}
	case *ast.ParenExpr:
		return r.value(x.X, pk, f, loose, depth+1)
	case *ast.Ident:
		if v, ok := pk.consts[x.Name]; ok {
			return r.value(v, pk, pk.owner[x.Name], false, depth+1)
		}
	case *ast.SelectorExpr:
		if id, ok := x.X.(*ast.Ident); ok {
			if path := f.imports[id.Name]; path != "" {
				if path == "net/http" && strings.HasPrefix(x.Sel.Name, "Method") {
					return strings.ToUpper(strings.TrimPrefix(x.Sel.Name, "Method")), true
				}
				if other := r.pkgs[path]; other != nil {
					if v, ok := other.consts[x.Sel.Name]; ok {
						return r.value(v, other, other.owner[x.Sel.Name], false, depth+1)
					}
				}
			}
		}
	case *ast.BinaryExpr:
		if x.Op == token.ADD {
			a, okA := r.value(x.X, pk, f, loose, depth+1)
			b, okB := r.value(x.Y, pk, f, loose, depth+1)
			if okA && okB {
				return a + b, true
			}
			if loose && (okA || okB) {
				if !okA {
					a = "*"
				}
				if !okB {
					b = "*"
				}
				return strings.ReplaceAll(a+b, "**", "*"), true
			}
		}
	}
	return "", false
}

func (r *reader) add(pk *pkg, f *file, at token.Pos, kind, name, method, of string) {
	r.out = append(r.out, Fact{Pkg: pk.in.ImportPath, Kind: kind, Name: scrub(name), Method: method, Of: scrub(of), File: f.name, Line: r.fset.Position(at).Line})
}

func typeName(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.SelectorExpr:
		return x.Sel.Name
	case *ast.StarExpr:
		return typeName(x.X)
	}
	return ""
}

func (r *reader) walk(pk *pkg, f *file) {
	ast.Inspect(f.ast, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.ImportSpec:
			return false
		case *ast.BasicLit:
			if x.Kind == token.STRING {
				if s, err := strconv.Unquote(x.Value); err == nil {
					if m := hostRe.FindStringSubmatch(s); m != nil {
						r.add(pk, f, x.Pos(), "host", strings.ToLower(m[1]), "", "")
					}
				}
			}
		case *ast.CallExpr:
			sel, ok := x.Fun.(*ast.SelectorExpr)
			if !ok || len(x.Args) == 0 {
				return true
			}
			name := sel.Sel.Name
			switch {
			case name == "Handle" || name == "HandleFunc":
				if s, ok := r.value(x.Args[0], pk, f, true, 0); ok {
					if m := routeRe.FindStringSubmatch(s); m != nil && len(x.Args) >= 2 {
						r.add(pk, f, x.Pos(), "route", m[2], m[1], "")
					}
				}
			case verbs[name] != "" && len(x.Args) >= 2:
				if s, ok := r.value(x.Args[0], pk, f, true, 0); ok && strings.HasPrefix(s, "/") && !strings.Contains(s, " ") {
					r.add(pk, f, x.Pos(), "route", s, verbs[name], "")
				}
			case f.nats && (pubs[name] || subs[name]):
				if s, ok := r.value(x.Args[0], pk, f, true, 0); ok && subjRe.MatchString(s) && s != "*" {
					kind := "sub"
					if pubs[name] {
						kind = "pub"
					}
					r.add(pk, f, x.Pos(), kind, s, "", "")
				}
			case f.nats && (name == "KeyValue" || name == "ObjectStore"):
				if s, ok := r.value(x.Args[0], pk, f, false, 0); ok && s != "" {
					r.add(pk, f, x.Pos(), "bucket", s, "", "")
				}
			}
		case *ast.CompositeLit:
			t := typeName(x.Type)
			fields := map[string]ast.Expr{}
			for _, el := range x.Elts {
				if kv, ok := el.(*ast.KeyValueExpr); ok {
					if k, ok := kv.Key.(*ast.Ident); ok {
						fields[k.Name] = kv.Value
					}
				}
			}
			get := func(k string) string {
				if e, ok := fields[k]; ok {
					if s, ok := r.value(e, pk, f, true, 0); ok {
						return s
					}
				}
				return ""
			}
			switch {
			case t == "KeyValueConfig" || t == "ObjectStoreConfig":
				if s := get("Bucket"); s != "" {
					r.add(pk, f, x.Pos(), "bucket", s, "", "")
				}
			case t == "StreamConfig":
				stream := get("Name")
				if stream != "" {
					r.add(pk, f, x.Pos(), "stream", stream, "", "")
				}
				if lit, ok := fields["Subjects"].(*ast.CompositeLit); ok {
					for _, el := range lit.Elts {
						if s, ok := r.value(el, pk, f, true, 0); ok {
							r.add(pk, f, el.Pos(), "subject", s, "", stream)
						}
					}
				}
			case t == "ConsumerConfig":
				if s := get("FilterSubject"); s != "" {
					r.add(pk, f, x.Pos(), "sub", s, "", "")
				}
			default:
				path := get("Pattern")
				if path == "" {
					path = get("Path")
				}
				if m := get("Method"); m != "" && strings.HasPrefix(path, "/") && verbs[m] != "" {
					r.add(pk, f, x.Pos(), "route", path, m, "")
				}
			}
		}
		return true
	})
}

// scrub turns each byte that is not valid UTF-8 into U+FFFD, as the JSON round trip the JavaScript
// version made did.
func scrub(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && n == 1 {
			b.WriteRune(utf8.RuneError)
		} else {
			b.WriteString(s[i : i+n])
		}
		i += n
	}
	return b.String()
}
