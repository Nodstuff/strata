package jsx

import (
	"bufio"
	"encoding/json"
	"os"
	"testing"
)

// localecompare.jsonl holds [a, b, sign] triples written by Node's String.localeCompare.
func TestLocaleCompareMatchesNode(t *testing.T) {
	f, err := os.Open("testdata/localecompare.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	n := 0
	for sc.Scan() {
		var row [3]any
		if err := json.Unmarshal(sc.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		a, b, want := row[0].(string), row[1].(string), int(row[2].(float64))
		if got := LocaleCompare(a, b); got != want {
			t.Errorf("LocaleCompare(%q, %q) = %d, want %d", a, b, got, want)
		}
		n++
	}
	if n == 0 {
		t.Fatal("no cases")
	}
}

func TestCmp16AndSlice16(t *testing.T) {
	if Cmp16("\U0001F600", "￿") >= 0 { // a surrogate pair sorts before U+FFFF in UTF-16
		t.Error("UTF-16 order")
	}
	if Slice16("ab\U0001F600", 3) != "ab�" || Slice16("abc", 5) != "abc" {
		t.Error("Slice16")
	}
}
