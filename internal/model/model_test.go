package model

import (
	"strings"
	"testing"
)

func TestScalarsFollowYAML12(t *testing.T) {
	m, err := Load("nodes:\n  - {id: 1, label: 0o17, sub: yes, detail: [0x10, 007, 1e3, null, true]}\n  - {id: 2}\nedges:\n  - [1, 2, .5]\n")
	if err != nil {
		t.Fatal(err)
	}
	n := m.Root.Children[0]
	if n.ID != "1" || n.Label != "15" || *n.Sub != "yes" {
		t.Errorf("got id %q label %q sub %q", n.ID, n.Label, *n.Sub)
	}
	if got := strings.Join(n.Detail, "|"); got != "16|7|1000|null|true" {
		t.Errorf("detail %q", got)
	}
	if m.Edges[0].Label != "0.5" {
		t.Errorf("edge label %q", m.Edges[0].Label)
	}
}

func TestEveryProblemIsReported(t *testing.T) {
	_, err := Load("nodes:\n  - {id: a, shape: blob, kind: nope}\n  - {id: a}\nedges:\n  - [a, zzz]\n")
	ps := Problems(err)
	if len(ps) != 4 {
		t.Fatalf("want 4 problems, got %d: %v", len(ps), ps)
	}
	if !strings.Contains(ps[0], `unknown kind "nope"`) || !strings.Contains(ps[3], `"zzz" is not a node id`) {
		t.Errorf("problems out of order or reworded: %v", ps)
	}
}

func TestNotAMap(t *testing.T) {
	for _, in := range []string{"", "- a\n", "just text"} {
		if _, err := Load(in); err == nil || !strings.HasPrefix(err.Error(), "the file must be a YAML map") {
			t.Errorf("%q: %v", in, err)
		}
	}
}
