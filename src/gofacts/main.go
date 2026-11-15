// gofacts reads Go source with the standard library's parser and prints, as JSON, the facts an
// architecture picture is made of: the HTTP routes a package serves, the message subjects, streams
// and key-value buckets it names, and the outside hosts it calls. It reads files and nothing else:
// no network, no build, no writes. Input on stdin: [{"ImportPath","Name","Dir","GoFiles"}].
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type pkgIn struct {
	ImportPath, Name, Dir string
	GoFiles               []string
}

type fact struct {
	Pkg    string `json:"pkg"`
	Kind   string `json:"kind"` // route | host | bucket | stream | subject | pub | sub
	Name   string `json:"name"`
	Method string `json:"method,omitempty"`
	Of     string `json:"of,omitempty"` // the stream a subject belongs to
	File   string `json:"file"`
	Line   int    `json:"line"`
}

type file struct {
	ast     *ast.File
	name    string
	imports map[string]string // local name -> import path
	nats    bool
}

type pkg struct {
	in     pkgIn
	files  []*file
	consts map[string]ast.Expr
	owner  map[string]*file
}

var (
	fset    = token.NewFileSet()
	pkgs    = map[string]*pkg{}
	names   = map[string]string{} // import path -> package name, for the module's own packages
	routeRe = regexp.MustCompile(`^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) )?(/\S*|\*/\S*)$`)
	hostRe  = regexp.MustCompile(`^https?://([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,})(?::\d+)?(?:/|$)`)
	subjRe  = regexp.MustCompile(`^[A-Za-z0-9_$*>-]+(\.[A-Za-z0-9_$*>-]+)*$`)
	verbs   = map[string]string{"Get": "GET", "Post": "POST", "Put": "PUT", "Patch": "PATCH", "Delete": "DELETE", "Head": "HEAD", "Options": "OPTIONS",
		"GET": "GET", "POST": "POST", "PUT": "PUT", "PATCH": "PATCH", "DELETE": "DELETE", "HEAD": "HEAD", "OPTIONS": "OPTIONS"}
	pubs = map[string]bool{"Publish": true, "PublishAsync": true, "Request": true, "RequestWithContext": true}
	subs = map[string]bool{"Subscribe": true, "QueueSubscribe": true, "ChanSubscribe": true, "SubscribeSync": true, "PullSubscribe": true, "QueueSubscribeSync": true}
	out  = []fact{}
)

func main() {
	var in []pkgIn
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		os.Stderr.WriteString("gofacts: " + err.Error() + "\n")
		os.Exit(1)
	}
	for _, p := range in {
		names[p.ImportPath] = p.Name
	}
	for _, p := range in {
		pk := &pkg{in: p, consts: map[string]ast.Expr{}, owner: map[string]*file{}}
		pkgs[p.ImportPath] = pk
		for _, name := range p.GoFiles {
			a, err := parser.ParseFile(fset, filepath.Join(p.Dir, name), nil, parser.SkipObjectResolution)
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
	for _, pk := range pkgs {
		for _, f := range pk.files {
			walk(pk, f)
		}
	}
	json.NewEncoder(os.Stdout).Encode(out)
}

// value works out a string from literals, the module's own constants and "+". With loose set, a
// part it cannot know becomes "*", so "GET "+prefix+"/login" is still a route.
func value(e ast.Expr, pk *pkg, f *file, loose bool, depth int) (string, bool) {
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
		return value(x.X, pk, f, loose, depth+1)
	case *ast.Ident:
		if v, ok := pk.consts[x.Name]; ok {
			return value(v, pk, pk.owner[x.Name], false, depth+1)
		}
	case *ast.SelectorExpr:
		if id, ok := x.X.(*ast.Ident); ok {
			if path := f.imports[id.Name]; path != "" {
				if path == "net/http" && strings.HasPrefix(x.Sel.Name, "Method") {
					return strings.ToUpper(strings.TrimPrefix(x.Sel.Name, "Method")), true
				}
				if other := pkgs[path]; other != nil {
					if v, ok := other.consts[x.Sel.Name]; ok {
						return value(v, other, other.owner[x.Sel.Name], false, depth+1)
					}
				}
			}
		}
	case *ast.BinaryExpr:
		if x.Op == token.ADD {
			a, okA := value(x.X, pk, f, loose, depth+1)
			b, okB := value(x.Y, pk, f, loose, depth+1)
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

func add(pk *pkg, f *file, at token.Pos, kind, name, method, of string) {
	out = append(out, fact{Pkg: pk.in.ImportPath, Kind: kind, Name: name, Method: method, Of: of, File: f.name, Line: fset.Position(at).Line})
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

func walk(pk *pkg, f *file) {
	ast.Inspect(f.ast, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.ImportSpec:
			return false
		case *ast.BasicLit:
			if x.Kind == token.STRING {
				if s, err := strconv.Unquote(x.Value); err == nil {
					if m := hostRe.FindStringSubmatch(s); m != nil {
						add(pk, f, x.Pos(), "host", strings.ToLower(m[1]), "", "")
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
				if s, ok := value(x.Args[0], pk, f, true, 0); ok {
					if m := routeRe.FindStringSubmatch(s); m != nil && len(x.Args) >= 2 {
						add(pk, f, x.Pos(), "route", m[2], m[1], "")
					}
				}
			case verbs[name] != "" && len(x.Args) >= 2:
				if s, ok := value(x.Args[0], pk, f, true, 0); ok && strings.HasPrefix(s, "/") && !strings.Contains(s, " ") {
					add(pk, f, x.Pos(), "route", s, verbs[name], "")
				}
			case f.nats && (pubs[name] || subs[name]):
				if s, ok := value(x.Args[0], pk, f, true, 0); ok && subjRe.MatchString(s) && s != "*" {
					kind := "sub"
					if pubs[name] {
						kind = "pub"
					}
					add(pk, f, x.Pos(), kind, s, "", "")
				}
			case f.nats && (name == "KeyValue" || name == "ObjectStore"):
				if s, ok := value(x.Args[0], pk, f, false, 0); ok && s != "" {
					add(pk, f, x.Pos(), "bucket", s, "", "")
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
					if s, ok := value(e, pk, f, true, 0); ok {
						return s
					}
				}
				return ""
			}
			switch {
			case t == "KeyValueConfig" || t == "ObjectStoreConfig":
				if s := get("Bucket"); s != "" {
					add(pk, f, x.Pos(), "bucket", s, "", "")
				}
			case t == "StreamConfig":
				stream := get("Name")
				if stream != "" {
					add(pk, f, x.Pos(), "stream", stream, "", "")
				}
				if lit, ok := fields["Subjects"].(*ast.CompositeLit); ok {
					for _, el := range lit.Elts {
						if s, ok := value(el, pk, f, true, 0); ok {
							add(pk, f, el.Pos(), "subject", s, "", stream)
						}
					}
				}
			case t == "ConsumerConfig":
				if s := get("FilterSubject"); s != "" {
					add(pk, f, x.Pos(), "sub", s, "", "")
				}
			default:
				path := get("Pattern")
				if path == "" {
					path = get("Path")
				}
				if m := get("Method"); m != "" && strings.HasPrefix(path, "/") && verbs[m] != "" {
					add(pk, f, x.Pos(), "route", path, m, "")
				}
			}
		}
		return true
	})
}
