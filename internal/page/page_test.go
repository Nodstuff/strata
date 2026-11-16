package page_test

import (
	"os"
	"strings"
	"testing"

	"github.com/Nodstuff/strata/internal/layout"
	"github.com/Nodstuff/strata/internal/model"
	"github.com/Nodstuff/strata/internal/page"
)

func laid(t *testing.T, name string, twice bool) *model.Model {
	t.Helper()
	text, err := os.ReadFile("../../examples/" + name + ".yaml")
	if err != nil {
		t.Fatal(err)
	}
	m, err := model.Load(string(text))
	if err != nil {
		t.Fatal(err)
	}
	m, err = layout.Layout(m, twice)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// The testdata files are the reference output: the payload and page of each example, as first
// produced by the JavaScript implementation this code was translated from (the page is kept as
// .txt because built .html files are git-ignored). A layout change shows up here as a difference.
func TestMatchesJavaScript(t *testing.T) {
	for _, name := range []string{"placed", "shop"} {
		for _, twice := range []bool{true, false} {
			golden := "testdata/" + name + ".payload.json"
			if !twice {
				golden = "testdata/" + name + ".once.payload.json"
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatal(err)
			}
			m := laid(t, name, twice)
			if got := page.Payload(m); string(got) != string(want) {
				t.Errorf("%s (twice=%v): payload differs from %s", name, twice, golden)
			}
			if twice {
				html, err := os.ReadFile("testdata/" + name + ".page.txt")
				if err != nil {
					t.Fatal(err)
				}
				if page.HTML(m) != string(html) {
					t.Errorf("%s: page differs from the JavaScript build", name)
				}
			}
		}
	}
}

// A label may hold any text. Inside the page's script block a "<" is written as an escape, so
// that no label can end the block ("</script>") and break the page.
func TestNoRawAngleBracketInData(t *testing.T) {
	m, err := model.Load("title: t\nnodes:\n  - {id: a, label: \"</script><b>x\"}\n  - {id: b, label: B}\nedges:\n  - [a, b, \"<i>\"]\n")
	if err != nil {
		t.Fatal(err)
	}
	if m, err = layout.Layout(m, true); err != nil {
		t.Fatal(err)
	}
	html := page.HTML(m)
	if strings.Contains(html, "</script><b>x") || strings.Contains(html, `"<i>"`) {
		t.Fatal("a label's \"<\" reached the page unescaped")
	}
	if !strings.Contains(html, `</script>`) {
		t.Fatal("expected the label's \"<\" as \\u003c in the page data")
	}
}
