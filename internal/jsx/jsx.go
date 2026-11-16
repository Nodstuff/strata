// Package jsx holds the small pieces of JavaScript behaviour the port has to reproduce so that
// its output matches the JavaScript implementation: number formatting, Math.round, UTF-16
// string lengths, object key order, truthiness and JSON.stringify.
package jsx

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type undefinedT struct{}

// Undefined stands for a property that is not there (JavaScript's undefined), as opposed to a YAML
// null (Go nil). Messages print them differently ("undefined" and "null").
var Undefined any = undefinedT{}

// IsNullish is `v == null` in JavaScript: null or undefined.
func IsNullish(v any) bool { return v == nil || v == Undefined }

// Truthy is JavaScript's truthiness of a value read from YAML.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case undefinedT:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true // arrays and maps
}

// String is JavaScript's String(v) for a value read from YAML.
func String(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case undefinedT:
		return "undefined"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return NumStr(x)
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if IsNullish(e) {
				continue
			}
			parts[i] = String(e)
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// NumStr is Number.prototype.toString for a double.
func NumStr(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde+XX
	mant, exps, _ := strings.Cut(e, "e")
	exp, _ := strconv.Atoi(exps)
	digits := strings.Replace(mant, ".", "", 1)
	k, n := len(digits), exp+1 // the value is 0.digits x 10^n
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	es := "+"
	if n-1 < 0 {
		es = "-"
	}
	ea := n - 1
	if ea < 0 {
		ea = -ea
	}
	if k == 1 {
		return sign + digits + "e" + es + strconv.Itoa(ea)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + es + strconv.Itoa(ea)
}

// Round is Math.round: halves go toward +infinity (Go's math.Round sends them away from zero).
func Round(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// R1 rounds to one decimal the way layout.js's r1 does.
func R1(v float64) float64 { return Round(float64(v*10)) / 10 }

// Len is String.prototype.length: UTF-16 code units, so a character outside the basic plane counts twice.
func Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r >= 0x10000 {
			n++
		}
	}
	return n
}

func isSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// Trim is String.prototype.trim (not strings.TrimSpace: U+0085 is not space to JavaScript, U+FEFF is).
func Trim(s string) string { return strings.TrimFunc(s, isSpace) }

// PadStart and PadEnd pad with spaces to a length counted in UTF-16 units.
func PadStart(s string, n int) string {
	if l := Len(s); l < n {
		return strings.Repeat(" ", n-l) + s
	}
	return s
}
func PadEnd(s string, n int) string {
	if l := Len(s); l < n {
		return s + strings.Repeat(" ", n-l)
	}
	return s
}

// Max and Min are Math.max and Math.min over a list: -Infinity and +Infinity when it is empty.
func Max(v ...float64) float64 {
	m := math.Inf(-1)
	for _, x := range v {
		if math.IsNaN(x) {
			return x
		}
		if x > m {
			m = x
		}
	}
	return m
}
func Min(v ...float64) float64 {
	m := math.Inf(1)
	for _, x := range v {
		if math.IsNaN(x) {
			return x
		}
		if x < m {
			m = x
		}
	}
	return m
}

// Sign is Math.sign.
func Sign(x float64) float64 {
	switch {
	case x > 0:
		return 1
	case x < 0:
		return -1
	}
	return x
}

// Cmp turns a JavaScript sort comparator's number into a Go three-way result.
func Cmp(d float64) int {
	switch {
	case d < 0:
		return -1
	case d > 0:
		return 1
	}
	return 0
}

// ---------- ordered maps ----------

// OMap is a map that remembers insertion order. Keys gives a JavaScript Map's order; JSKeys gives a
// plain object's order, where keys that look like array indexes come first, in numeric order.
type OMap[V any] struct {
	keys []string
	m    map[string]V
}

func NewOMap[V any]() *OMap[V] { return &OMap[V]{m: map[string]V{}} }

// Set replaces the value of an existing key without moving it, as a JavaScript Map and object do.
func (o *OMap[V]) Set(k string, v V) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
}
func (o *OMap[V]) Get(k string) (V, bool) { v, ok := o.m[k]; return v, ok }
func (o *OMap[V]) Has(k string) bool      { _, ok := o.m[k]; return ok }
func (o *OMap[V]) Len() int               { return len(o.keys) }
func (o *OMap[V]) Keys() []string         { return o.keys }

// At returns the value or its zero value (a nil pointer for pointer types).
func (o *OMap[V]) At(k string) V { return o.m[k] }

func arrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n >= 4294967295 || strconv.FormatUint(n, 10) != k {
		return 0, false
	}
	return n, true
}

// JSKeys is Object.keys order.
func (o *OMap[V]) JSKeys() []string {
	var idx []string
	hasIdx := false
	for _, k := range o.keys {
		if _, ok := arrayIndex(k); ok {
			hasIdx = true
			break
		}
	}
	if !hasIdx {
		return o.keys
	}
	var rest []string
	for _, k := range o.keys {
		if _, ok := arrayIndex(k); ok {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.SliceStable(idx, func(i, j int) bool { a, _ := arrayIndex(idx[i]); b, _ := arrayIndex(idx[j]); return a < b })
	return append(idx, rest...)
}

// ---------- JSON.stringify ----------

// AppendString writes a JSON string the way JSON.stringify does: only quotes, backslashes and control
// characters are escaped (encoding/json also escapes <, > and &, which would change the page).
func AppendString(b []byte, s string) []byte {
	const hex = "0123456789abcdef"
	b = append(b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"':
				b = append(b, '\\', '"')
			case c == '\\':
				b = append(b, '\\', '\\')
			case c == '\n':
				b = append(b, '\\', 'n')
			case c == '\r':
				b = append(b, '\\', 'r')
			case c == '\t':
				b = append(b, '\\', 't')
			case c == '\b':
				b = append(b, '\\', 'b')
			case c == '\f':
				b = append(b, '\\', 'f')
			case c < 0x20:
				b = append(b, '\\', 'u', '0', '0', hex[c>>4], hex[c&15])
			default:
				b = append(b, c)
			}
			i++
			continue
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		b = append(b, s[i:i+size]...)
		i += size
	}
	return append(b, '"')
}

// AppendNum writes a number as JSON.stringify does (NaN and infinities become null; -0 becomes 0).
func AppendNum(b []byte, f float64) []byte {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return append(b, "null"...)
	}
	return append(b, NumStr(f)...)
}

// AppendAny writes a value read from YAML.
func AppendAny(b []byte, v any) []byte {
	switch x := v.(type) {
	case nil, undefinedT:
		return append(b, "null"...)
	case bool:
		if x {
			return append(b, "true"...)
		}
		return append(b, "false"...)
	case float64:
		return AppendNum(b, x)
	case string:
		return AppendString(b, x)
	case []any:
		b = append(b, '[')
		for i, e := range x {
			if i > 0 {
				b = append(b, ',')
			}
			b = AppendAny(b, e)
		}
		return append(b, ']')
	case *OMap[any]:
		b = append(b, '{')
		first := true
		for _, k := range x.JSKeys() {
			e := x.At(k)
			if e == Undefined {
				continue
			}
			if !first {
				b = append(b, ',')
			}
			first = false
			b = AppendString(b, k)
			b = append(b, ':')
			b = AppendAny(b, e)
		}
		return append(b, '}')
	}
	return append(b, "null"...)
}
