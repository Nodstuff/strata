// strata check <file.yaml>                      validate, lay out, print the tree
// strata build <file.yaml> [-o out.html]        one self-contained HTML page
// strata shot  <file.yaml> [--at id] [--hide tag] [--show tag] [--size 1600x1000] [-o out.png]   a picture of one level
//
// The Go port of bin/strata.js: the same flags, text and exit codes. `facts` and `gen` are not in
// the Go build yet. `dump` (hidden) prints the payload the page embeds, to compare with the JavaScript.
package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Nodstuff/strata/internal/gofacts"
	"github.com/Nodstuff/strata/internal/jsx"
	"github.com/Nodstuff/strata/internal/layout"
	"github.com/Nodstuff/strata/internal/model"
	"github.com/Nodstuff/strata/internal/page"
)

// ver is the version this build reports. A release sets it with -ldflags "-X main.ver=1.2.3".
var ver = "0.2.0-dev"

func version() string { return ver }

func usage() {
	fmt.Fprintln(os.Stderr, "usage: strata --version\n       strata facts go <dir> [--only path] [-o facts.md]\n       strata check|build|shot <file.yaml> [--summary] [--stats] [--once] [-o out] [--at id] [--hide tag] [--show tag] [--hot id] [--only style] [--size WxH]")
	os.Exit(2)
}

func main() { os.Exit(run(os.Args[1:])) }

var yamlExt = regexp.MustCompile(`\.ya?ml$`)

func run(args []string) int {
	var cmd, file string
	var rest []string
	if len(args) > 0 {
		cmd = args[0]
	}
	if len(args) > 1 {
		file = args[1]
	}
	if len(args) > 2 {
		rest = args[2:]
	}
	if cmd == "--version" || cmd == "-v" || cmd == "version" {
		fmt.Println(version())
		return 0
	}
	if cmd == "gen" {
		fmt.Fprintln(os.Stderr, "strata gen was removed: use `strata facts go` and draw the diagram from the facts")
		return 2
	}
	if cmd == "facts" {
		return facts(args[1:])
	}
	has := func(name string) bool {
		for _, a := range rest {
			if a == name {
				return true
			}
		}
		return false
	}
	opt := func(name string) string {
		for i, a := range rest {
			if a == name {
				if i+1 < len(rest) {
					return rest[i+1]
				}
				return ""
			}
		}
		return ""
	}
	if cmd == "" || file == "" || (cmd != "check" && cmd != "build" && cmd != "shot" && cmd != "dump") {
		usage()
	}

	m, err := loadAndLayout(file, !has("--once"))
	if err != nil {
		kind := "error"
		if ps := model.Problems(err); ps != nil {
			kind = fmt.Sprintf("%d problem(s)", len(ps))
		}
		fmt.Fprintf(os.Stderr, "%s: %s\n%s\n", file, kind, err.Error())
		return 1
	}
	var warnings []string
	warnings = append(warnings, m.Warnings...)
	warnings = append(warnings, page.Legibility(m, 1440, 800)...)
	warnings = append(warnings, page.Busy(m, 16, 30)...)
	for _, w := range warnings {
		fmt.Fprintln(os.Stderr, "warning: "+w)
	}
	stem := yamlExt.ReplaceAllString(filepath.Base(file), "")

	switch {
	case cmd == "dump":
		os.Stdout.Write(page.Payload(m))
	case cmd == "check" && has("--stats"): // how clean the arrows are, per level: for judging a change to the router
		ql := page.Quality(m)
		var rows []page.Level
		for _, r := range ql.Levels {
			if r.Lines != 0 {
				rows = append(rows, r)
			}
		}
		sort.SliceStable(rows, func(i, j int) bool { return rows[j].Crossings-rows[i].Crossings < 0 })
		for _, r := range rows {
			slanted := ""
			if r.Slanted != 0 {
				slanted = "  " + jsx.NumStr(r.Slanted) + " slanted"
			}
			fmt.Printf("%s %s lines %s crossings %s bends %s length%s\n", jsx.PadEnd(r.ID, 22), jsx.PadStart(jsx.NumStr(r.Lines), 4), jsx.PadStart(jsx.NumStr(r.Crossings), 4),
				jsx.PadStart(jsx.NumStr(r.Bends), 4), jsx.PadStart(jsx.NumStr(r.Length), 7), slanted)
		}
		t := ql.Total
		fmt.Printf("total · %s lines · %s crossings · %s bends · %s length · %s slanted\n", jsx.NumStr(t.Lines), jsx.NumStr(t.Crossings), jsx.NumStr(t.Bends), jsx.NumStr(t.Length), jsx.NumStr(t.Slanted))
	case cmd == "check":
		text, boxes, depth, arrows := page.Outline(m)
		if has("--summary") { // the count, and the levels that hold the most, without the tree
			type big struct {
				id string
				n  int
			}
			var bigs []big
			var see func(nd *model.Node)
			see = func(nd *model.Node) {
				if len(nd.Children) > 0 {
					id := nd.ID
					if id == "__root" {
						id = "top level"
					}
					bigs = append(bigs, big{id, len(nd.Children)})
					for _, c := range nd.Children {
						see(c)
					}
				}
			}
			see(m.Root)
			sort.SliceStable(bigs, func(i, j int) bool { return bigs[j].n < bigs[i].n })
			var lines []string
			for _, b := range bigs[:min(8, len(bigs))] {
				lines = append(lines, fmt.Sprintf("%3d boxes in %s", b.n, b.id))
			}
			fmt.Println(strings.Join(lines, "\n"))
		} else {
			fmt.Println(text)
		}
		fmt.Printf("\nok · %d boxes · %d arrows · %d levels deep\n", boxes, arrows, depth)
	case cmd == "build":
		out := opt("-o")
		if out == "" {
			out = stem + ".html"
		}
		if err := os.WriteFile(out, []byte(page.HTML(m)), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		abs, _ := filepath.Abs(out)
		fmt.Println("ok · " + abs)
	default:
		return shot(m, stem, opt)
	}
	return 0
}

// facts prints what a Go module's code says about its architecture: strata facts go <dir> [--only path] [-o facts.md].
func facts(args []string) int {
	opt := func(name string) string {
		for i, a := range args {
			if i > 1 && a == name && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	if len(args) < 2 || args[0] != "go" || args[1] == "" {
		fmt.Fprintln(os.Stderr, "usage: strata facts go <dir> [--only <path inside the module>] [-o facts.md]")
		return 2
	}
	dir, err := filepath.Abs(args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	report, err := gofacts.Report(dir, opt("--only"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if out := opt("-o"); out != "" {
		if err := os.WriteFile(out, []byte(report), 0o644); err != nil {
			if os.IsNotExist(err) {
				err = fmt.Errorf("cannot write %s: no such directory", out)
			}
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		abs, _ := filepath.Abs(out)
		fmt.Println("ok · " + abs)
		return 0
	}
	fmt.Print(report)
	return 0
}

func loadAndLayout(file string, twice bool) (*model.Model, error) {
	text, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no such file")
		}
		return nil, err
	}
	m, err := model.Load(string(text))
	if err != nil {
		return nil, err
	}
	return layout.Layout(m, twice) // twice=false (--once) skips the layouts that arrange each level toward where its arrows leave
}

// formEscape is how URLSearchParams writes a value: letters, digits and *-._ stay, a space is +.
func formEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '*', c == '-', c == '.', c == '_':
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func shot(m *model.Model, stem string, opt func(string) string) int {
	candidates := []string{os.Getenv("CHROME"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
		`C:\Program Files\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`}
	chrome := ""
	for _, p := range candidates {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			chrome = p
			break
		}
	}
	if chrome == "" {
		fmt.Fprintln(os.Stderr, "shot needs Chrome, Chromium or Edge; none was found. Set CHROME to the path of one")
		return 1
	}
	at, hide, show, hot, only := opt("--at"), opt("--hide"), opt("--show"), opt("--hot"), opt("--only")
	size := opt("--size")
	if size == "" {
		size = "1600x1000"
	}
	size = strings.Replace(size, "x", ",", 1)
	if at != "" {
		found := false
		model.Walk(m.Root, func(nd, _ *model.Node, _ int) {
			if nd.ID == at {
				found = true
			}
		})
		if !found {
			fmt.Fprintf(os.Stderr, "--at %s: no node has that id\n", at)
			return 1
		}
	}
	out := opt("-o")
	if out == "" {
		out = stem
		if at != "" {
			out += "-" + at
		}
		out += ".png"
	}
	out, _ = filepath.Abs(out)
	dir, err := os.MkdirTemp("", "strata-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer os.RemoveAll(dir)
	pagePath := filepath.Join(dir, "page.html")
	if err := os.WriteFile(pagePath, []byte(page.HTML(m)), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var parts []string
	for _, kv := range [][2]string{{"at", at}, {"hide", hide}, {"show", show}, {"hot", hot}, {"only", only}} {
		if kv[1] != "" {
			parts = append(parts, kv[0]+"="+formEscape(kv[1]))
		}
	}
	href := (&url.URL{Scheme: "file", Path: pagePath}).String()
	if len(parts) > 0 {
		href += "#" + strings.Join(parts, "&")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size="+size, "--virtual-time-budget=2000", "--screenshot="+out, href)
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println("ok · " + out)
	return 0
}
