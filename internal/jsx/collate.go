package jsx

import (
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Cmp16 orders two strings by UTF-16 code units, which is what Array.prototype.sort does with no
// comparator (Go compares bytes, which differs for characters above U+FFFF against U+E000 to U+FFFF).
func Cmp16(a, b string) int {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			if x[i] < y[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(x) < len(y):
		return -1
	case len(x) > len(y):
		return 1
	}
	return 0
}

// Slice16 is s.slice(0, n) with n counted in UTF-16 units; a pair cut in half becomes U+FFFD, as
// it does when JavaScript writes a lone surrogate out as UTF-8.
func Slice16(s string, n int) string {
	if Len(s) <= n {
		return s
	}
	var b strings.Builder
	used := 0
	for _, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if used+w > n {
			if w == 2 && used < n {
				b.WriteRune(utf8.RuneError)
			}
			break
		}
		b.WriteRune(r)
		used += w
	}
	return b.String()
}

// order is the root collation order of the ASCII punctuation, as ICU (and so String.localeCompare) ranks it.
const punctOrder = "\t\n\v\f\r _-,;:!?.…'\"()[]{}@*/\\&#%`^+<=>|~$"

// LocaleCompare is String.localeCompare for the strings strata sorts (names, paths): punctuation
// before digits before letters, letters ignoring case first, then lower case before upper. Letters
// outside ASCII sort after the ASCII ones by code point, which is not ICU's order for accents.
func LocaleCompare(a, b string) int {
	pa, ta := collKeys(a)
	pb, tb := collKeys(b)
	for i := 0; i < len(pa) && i < len(pb); i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	if len(pa) != len(pb) {
		if len(pa) < len(pb) {
			return -1
		}
		return 1
	}
	for i := range ta {
		if ta[i] != tb[i] {
			if ta[i] < tb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func collKeys(s string) (primary []int, tertiary []int) {
	s = strings.ReplaceAll(s, "\u2026", "...") // the ellipsis collates as three full stops
	for _, r := range s {
		t := 0
		var p int
		switch {
		case r >= '0' && r <= '9':
			p = 100 + int(r-'0')
		case r >= 'a' && r <= 'z':
			p = 200 + int(r-'a')
		case r >= 'A' && r <= 'Z':
			p, t = 200+int(r-'A'), 1
		default:
			if i := strings.IndexRune(punctOrder, r); i >= 0 {
				p = i
			} else {
				p = 1000 + int(r)
			}
		}
		primary, tertiary = append(primary, p), append(tertiary, t)
	}
	return
}
