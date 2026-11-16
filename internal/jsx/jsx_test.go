package jsx

import (
	"math"
	"testing"
)

func TestNumStr(t *testing.T) {
	for in, want := range map[float64]string{0: "0", math.Copysign(0, -1): "0", 1: "1", 1.5: "1.5", 100: "100", 0.1: "0.1", 1e21: "1e+21", 1.5e-7: "1.5e-7", 123456789012345680000: "123456789012345680000", -2.5: "-2.5", 0.000001: "0.000001"} {
		if got := NumStr(in); got != want {
			t.Errorf("NumStr(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestRound(t *testing.T) {
	for in, want := range map[float64]float64{2.5: 3, -2.5: -2, -0.5: 0, 0.4: 0, 1.5: 2, -1.5: -1, 0.49999999999999994: 0} {
		if got := Round(in); got != want {
			t.Errorf("Round(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestLenTrim(t *testing.T) {
	if Len("a😀") != 3 {
		t.Error("an astral character counts as two UTF-16 units")
	}
	if Trim("\ufeff x \u0085") != "x \u0085" {
		t.Error("U+FEFF is JavaScript whitespace and U+0085 is not")
	}
}

func TestJSKeys(t *testing.T) {
	o := NewOMap[int]()
	for i, k := range []string{"b", "10", "a", "2", "01", "-1"} {
		o.Set(k, i)
	}
	want := []string{"2", "10", "b", "a", "01", "-1"}
	got := o.JSKeys()
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("JSKeys = %v, want %v", got, want)
		}
	}
}

func TestAppendString(t *testing.T) {
	if got := string(AppendString(nil, "a\"b\\<\n\x01é ")); got != "\"a\\\"b\\\\<\\n\\u0001é \"" {
		t.Errorf("got %s", got)
	}
}
