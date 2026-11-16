package model

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"strata/internal/jsx"

	"go.yaml.in/yaml/v4"
)

// The YAML is read into plain values the way the JavaScript `yaml` package reads it with its
// default (YAML 1.2 core) schema: nil, bool, float64, string, []any and *jsx.OMap[any]. Plain
// scalars are typed here rather than by the Go library, whose rules differ (underscores in
// numbers, leading-zero octals, and yes/no/on/off handling are the usual surprises).

var (
	reNull  = regexp.MustCompile(`^(?:~|[Nn]ull|NULL)?$`)
	reBool  = regexp.MustCompile(`^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$`)
	reOct   = regexp.MustCompile(`^0o[0-7]+$`)
	reInt   = regexp.MustCompile(`^[-+]?[0-9]+$`)
	reHex   = regexp.MustCompile(`^0x[0-9a-fA-F]+$`)
	reFloat = regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$`)
	reInf   = regexp.MustCompile(`^([-+]?)\.(?:inf|Inf|INF)$`)
	reNaN   = regexp.MustCompile(`^\.(?:nan|NaN|NAN)$`)
)

func resolvePlain(s string) any {
	switch {
	case reNull.MatchString(s):
		return nil
	case reBool.MatchString(s):
		return s[0] == 't' || s[0] == 'T'
	case reOct.MatchString(s):
		n, err := strconv.ParseUint(s[2:], 8, 64)
		if err != nil {
			f, _ := strconv.ParseFloat(s, 64)
			return f
		}
		return float64(n)
	case reHex.MatchString(s):
		n, err := strconv.ParseUint(s[2:], 16, 64)
		if err != nil {
			return math.Inf(1)
		}
		return float64(n)
	case reInt.MatchString(s), reFloat.MatchString(s):
		f, err := strconv.ParseFloat(s, 64)
		if err != nil && !math.IsInf(f, 0) {
			return s
		}
		return f
	case reNaN.MatchString(s):
		return math.NaN()
	}
	if m := reInf.FindStringSubmatch(s); m != nil {
		if m[1] == "-" {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	return s
}

const quoted = yaml.DoubleQuotedStyle | yaml.SingleQuotedStyle | yaml.LiteralStyle | yaml.FoldedStyle

func convert(n *yaml.Node, depth int) (any, error) {
	if depth > 200 {
		return nil, fmt.Errorf("the YAML is nested too deeply")
	}
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil, nil
		}
		return convert(n.Content[0], depth+1)
	case yaml.AliasNode:
		return convert(n.Alias, depth+1)
	case yaml.ScalarNode:
		if n.Style&quoted != 0 || (n.Style&yaml.TaggedStyle != 0 && n.Tag == "!!str") {
			return n.Value, nil
		}
		return resolvePlain(n.Value), nil
	case yaml.SequenceNode:
		out := make([]any, 0, len(n.Content))
		for _, c := range n.Content {
			v, err := convert(c, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	case yaml.MappingNode:
		out := jsx.NewOMap[any]()
		for i := 0; i+1 < len(n.Content); i += 2 {
			kv, err := convert(n.Content[i], depth+1)
			if err != nil {
				return nil, err
			}
			k := jsx.String(kv)
			if out.Has(k) {
				return nil, fmt.Errorf("Map keys must be unique; %q is repeated (line %d)", k, n.Content[i].Line)
			}
			v, err := convert(n.Content[i+1], depth+1)
			if err != nil {
				return nil, err
			}
			out.Set(k, v)
		}
		return out, nil
	}
	return nil, nil
}

// ParseYAML reads one YAML document into plain values.
func ParseYAML(text string) (any, error) {
	var n yaml.Node
	if err := yaml.Unmarshal([]byte(text), &n); err != nil {
		return nil, fmt.Errorf("%s", strings.TrimPrefix(err.Error(), "yaml: "))
	}
	return convert(&n, 0)
}
