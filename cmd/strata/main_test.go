package main

import (
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

// capture runs the command and returns what it printed to stdout and its exit code.
func capture(t *testing.T, args ...string) (string, int) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	code := run(args)
	os.Stdout = old
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out), code
}

// The two shareable examples must come out with the arrow statistics recorded in test/expected.json.
func TestExamplesStats(t *testing.T) {
	raw, err := os.ReadFile("../../test/expected.json")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) == 0 {
		t.Fatal("test/expected.json holds no examples")
	}
	for name, line := range want {
		t.Run(name, func(t *testing.T) {
			out, code := capture(t, "check", "../../examples/"+name, "--stats")
			if code != 0 {
				t.Fatalf("exit code %d", code)
			}
			lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
			if got := lines[len(lines)-1]; got != line {
				t.Errorf("total line\n got: %s\nwant: %s", got, line)
			}
		})
	}
}

func TestCheckOutline(t *testing.T) {
	out, code := capture(t, "check", "../../examples/placed.yaml")
	if code != 0 || !strings.Contains(out, "\nok · ") {
		t.Fatalf("code %d, output %q", code, out)
	}
}

func TestVersionAndStubs(t *testing.T) {
	if out, code := capture(t, "--version"); code != 0 || !strings.HasPrefix(out, "0.") {
		t.Errorf("--version gave %q (exit %d)", out, code)
	}
	if _, code := capture(t, "gen", "go", "."); code != 2 {
		t.Errorf("gen: exit code %d, want 2", code)
	}
	if _, code := capture(t, "facts", "rust", "."); code != 2 {
		t.Errorf("facts rust: exit code %d, want 2", code)
	}
}

func TestFormEscape(t *testing.T) {
	for in, want := range map[string]string{"a b": "a+b", "x-y_z.*": "x-y_z.*", "~é": "%7E%C3%A9", "a&b=c": "a%26b%3Dc"} {
		if got := formEscape(in); got != want {
			t.Errorf("formEscape(%q) = %q, want %q", in, got, want)
		}
	}
}
