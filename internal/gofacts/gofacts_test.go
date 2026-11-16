package gofacts

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// The fixture is an invented shop module. The expected reports were written by the JavaScript
// implementation of `strata facts go`; the port must reproduce them byte for byte.
func TestReportMatchesJavaScript(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("needs the go command")
	}
	dir, err := filepath.Abs("testdata/shop")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ only, golden string }{{"", "testdata/shop.expected.txt"}, {"internal/orders", "testdata/shop.only.expected.txt"}} {
		want, err := os.ReadFile(c.golden)
		if err != nil {
			t.Fatal(err)
		}
		got, err := Report(dir, c.only)
		if err != nil {
			t.Fatal(err)
		}
		if got != string(want) {
			t.Errorf("only=%q: report differs from %s\n%s", c.only, c.golden, got)
		}
	}
}

func TestErrors(t *testing.T) {
	if _, err := Report("/nonexistent-dir-for-strata", ""); err == nil || err == ErrNoToolchain {
		// a missing directory is its own problem, not a missing toolchain
		t.Errorf("got %v", err)
	}
	dir, err := filepath.Abs("testdata/shop")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("go"); err == nil {
		if _, err := Report(dir, "nope"); err == nil || err.Error() != `no packages under "nope" in example.com/shop` {
			t.Errorf("got %v", err)
		}
	}
}
