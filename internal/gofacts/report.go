package gofacts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"strata/internal/jsx"
)

// ErrNoToolchain is returned when the `go` command cannot be run.
var ErrNoToolchain = errors.New("this command needs the Go toolchain (the `go` command) on your PATH")

type listed struct {
	ImportPath, Name, Dir, Doc string
	Imports, GoFiles           []string
	Module                     *struct{ Path string }
	rel                        string
}

// goList runs `go list` as the JavaScript did: offline (GOPROXY=off), and it accepts the output
// of a run that exited with an error as long as it printed something.
func goList(dir string) ([]*listed, error) {
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return nil, ErrNoToolchain // node reports a missing directory as a failed spawn of `go`
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		return nil, ErrNoToolchain
	}
	cmd := exec.Command(goBin, "list", "-e", "-json=ImportPath,Name,Dir,Imports,GoFiles,Doc,Module", "./...")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOPROXY=off")
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	runErr := cmd.Run()
	if runErr != nil && out.Len() == 0 {
		msg := errOut.String()
		if msg == "" {
			msg = runErr.Error()
		}
		first, _, _ := strings.Cut(strings.TrimSpace(msg), "\n")
		return nil, fmt.Errorf("go list failed in %s: %s", dir, first)
	}
	var all []*listed
	dec := json.NewDecoder(&out)
	for {
		var p listed
		if err := dec.Decode(&p); err != nil {
			if err != io.EOF {
				return nil, fmt.Errorf("go list failed in %s: %v", dir, err)
			}
			break
		}
		all = append(all, &p)
	}
	return all, nil
}

// A URL written in the code says what it calls when there is no SDK to import.
var hosts = [][2]string{{"slack.com", "Slack"}, {"workos.com", "WorkOS"}, {"workato.com", "Workato"}, {"anthropic.com", "Anthropic API"}, {"openai.com", "OpenAI API"},
	{"api.github.com", "GitHub API"}, {"pagerduty.com", "PagerDuty"}, {"opsgenie.com", "Opsgenie"}, {"datadoghq.com", "Datadog"}, {"sentry.io", "Sentry"},
	{"stripe.com", "Stripe"}, {"twilio.com", "Twilio"}, {"sendgrid.com", "SendGrid"}, {"googleapis.com", "Google APIs"}, {"microsoftonline.com", "Microsoft Entra"},
	{"graph.microsoft.com", "Microsoft Graph"}, {"okta.com", "Okta"}, {"auth0.com", "Auth0"}, {"atlassian.net", "Jira"}, {"atlassian.com", "Atlassian API"},
	{"salesforce.com", "Salesforce"}, {"zendesk.com", "Zendesk"}, {"hubapi.com", "HubSpot"}, {"telegram.org", "Telegram"}, {"discord.com", "Discord"}}

var notACall = regexp.MustCompile(`(^|\.)(example\.(com|org|net)|localhost|amazonaws\.com|w3\.org|json-schema\.org|golang\.org|go\.dev|githubusercontent\.com|github\.com|schema\.org|ietf\.org|apache\.org|mozilla\.org|wikipedia\.org)$`)

func hostSystem(h string) string {
	for _, m := range hosts {
		if h == m[0] || strings.HasSuffix(h, "."+m[0]) {
			return m[1]
		}
	}
	return ""
}

// under says whether a subject falls under a pattern, the way NATS reads "*" and ">".
func under(pat, name string) bool {
	if pat == name {
		return true
	}
	a, b := strings.Split(pat, "."), strings.Split(name, ".")
	for i := range a {
		if a[i] == ">" {
			return len(b) > i
		}
		if i >= len(b) || (a[i] != "*" && a[i] != b[i]) {
			return false
		}
	}
	return len(a) == len(b)
}

// What a third-party import says the code talks to: a package that imports the ClickHouse driver
// talks to ClickHouse. Longest match wins.
var systemList = [][3]string{
	{"github.com/ClickHouse/clickhouse-go", "ClickHouse", "store"}, {"github.com/nats-io/nats.go", "NATS", "store"},
	{"github.com/jackc/pgx", "Postgres", "store"}, {"github.com/lib/pq", "Postgres", "store"}, {"github.com/go-sql-driver/mysql", "MySQL", "store"},
	{"github.com/redis/go-redis", "Redis", "store"}, {"github.com/go-redis/redis", "Redis", "store"}, {"go.mongodb.org/mongo-driver", "MongoDB", "store"},
	{"github.com/segmentio/kafka-go", "Kafka", "store"}, {"github.com/IBM/sarama", "Kafka", "store"}, {"github.com/confluentinc/confluent-kafka-go", "Kafka", "store"},
	{"github.com/elastic/go-elasticsearch", "Elasticsearch", "store"}, {"github.com/opensearch-project/opensearch-go", "OpenSearch", "store"},
	{"github.com/minio/minio-go", "S3-compatible storage", "store"}, {"go.etcd.io/etcd/client", "etcd", "store"},
	{"k8s.io/client-go", "Kubernetes API", "cloud"}, {"sigs.k8s.io/controller-runtime", "Kubernetes API", "cloud"},
	{"github.com/hashicorp/vault", "Vault", "cloud"}, {"go.opentelemetry.io/otel/exporters", "OpenTelemetry collector", "cloud"},
	{"github.com/anthropics/anthropic-sdk-go", "Anthropic API", "api"}, {"github.com/openai/openai-go", "OpenAI API", "api"}, {"github.com/sashabaranov/go-openai", "OpenAI API", "api"},
	{"github.com/slack-go/slack", "Slack", "api"}, {"github.com/workos/workos-go", "WorkOS", "api"}, {"github.com/stripe/stripe-go", "Stripe", "api"},
	{"github.com/coreos/go-oidc", "OIDC provider", "api"}, {"github.com/google/go-github", "GitHub API", "api"}, {"github.com/twilio/twilio-go", "Twilio", "api"},
	{"net/smtp", "SMTP server", "api"},
}

var (
	awsRe    = regexp.MustCompile(`^github\.com/aws/aws-sdk-go(?:-v2)?/service/([a-z0-9]+)`)
	gcpRe    = regexp.MustCompile(`^cloud\.google\.com/go/([a-z0-9]+)`)
	awsNames = map[string]string{"secretsmanager": "Secrets Manager", "dynamodb": "DynamoDB", "cloudwatch": "CloudWatch", "cloudwatchlogs": "CloudWatch Logs", "cloudformation": "CloudFormation", "lambda": "Lambda", "kinesis": "Kinesis", "route53": "Route 53", "eventbridge": "EventBridge", "sesv2": "SES", "bedrockruntime": "Bedrock", "servicequotas": "Service Quotas", "organizations": "Organizations", "cloudtrail": "CloudTrail", "elasticloadbalancingv2": "Load Balancing", "autoscaling": "Auto Scaling", "pricing": "Pricing"}
	// GCP helper modules, not services
	notASystem = map[string]bool{"internal": true, "iam": true, "compute": true, "auth": true, "longrunning": true}
)

func systemOf(imp string) (name, kind string, ok bool) {
	if m := awsRe.FindStringSubmatch(imp); m != nil {
		n, known := awsNames[m[1]]
		if !known {
			if len(m[1]) <= 4 {
				n = strings.ToUpper(m[1])
			} else {
				n = strings.ToUpper(m[1][:1]) + m[1][1:]
			}
		}
		return "AWS " + n, "cloud", true
	}
	if m := gcpRe.FindStringSubmatch(imp); m != nil && !notASystem[m[1]] {
		return "GCP " + m[1], "cloud", true
	}
	var best *[3]string
	for i := range systemList {
		s := &systemList[i]
		if (imp == s[0] || strings.HasPrefix(imp, s[0]+"/") || strings.HasPrefix(imp, s[0]+".")) && (best == nil || len(s[0]) > len(best[0])) {
			best = s
		}
	}
	if best != nil {
		return best[1], best[2], true
	}
	return "", "", false
}

// strset is a JavaScript Set of strings: insertion order, no repeats.
type strset struct {
	keys []string
	has  map[string]bool
}

func newSet() *strset { return &strset{has: map[string]bool{}} }
func (s *strset) add(k string) {
	if !s.has[k] {
		s.has[k] = true
		s.keys = append(s.keys, k)
	}
}
func (s *strset) sorted() []string {
	out := slices.Clone(s.keys)
	slices.SortFunc(out, jsx.Cmp16)
	return out
}

// space is what JavaScript's \s matches.
var space = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

func oneLine(s string) string { return jsx.Trim(space.ReplaceAllString(s, " ")) }

type part struct {
	name, kind string
	subjects   *strset
	roleOrder  []string
	roles      map[string]*strset
}

func (p *part) role(ip, r string) {
	if p.roles[ip] == nil {
		p.roles[ip] = newSet()
		p.roleOrder = append(p.roleOrder, ip)
	}
	p.roles[ip].add(r)
}

// Report reads the Go module under dir and returns the facts as text with file and line: each
// program and the outside systems it reaches, which packages hold a client for which system, the
// NATS streams and buckets the code names, the HTTP routes each package serves, and the packages
// that are only shared code. only limits it to a path inside the module.
func Report(dir, only string) (string, error) {
	all, err := goList(dir)
	if err != nil {
		return "", err
	}
	if len(all) == 0 {
		return "", fmt.Errorf("no Go packages under %s", dir)
	}
	mod := ""
	for _, p := range all {
		if p.Module != nil {
			mod = p.Module.Path
			break
		}
	}
	var pkgs []*listed
	for _, p := range all {
		switch {
		case p.ImportPath == mod:
			p.rel = ""
		case strings.HasPrefix(p.ImportPath, mod+"/"):
			p.rel = p.ImportPath[len(mod)+1:]
		default:
			continue
		}
		if len(p.GoFiles) == 0 {
			continue
		}
		if only != "" && !(p.rel == only || strings.HasPrefix(p.rel, strings.TrimSuffix(only, "/")+"/")) {
			continue
		}
		pkgs = append(pkgs, p)
	}
	if len(pkgs) == 0 {
		if only != "" {
			return "", fmt.Errorf("no packages under \"%s\" in %s", only, mod)
		}
		return "", fmt.Errorf("no packages with Go files in %s", mod)
	}
	mine := map[string]*listed{}
	for _, p := range pkgs {
		mine[p.ImportPath] = p
	}
	usedBy := map[string]int{}
	for _, p := range pkgs {
		for _, i := range p.Imports {
			if mine[i] != nil {
				usedBy[i]++
			}
		}
	}
	// A package nearly everything imports (a model, a logger) says nothing by being imported.
	wide := int(math.Max(6, math.Ceil(0.12*float64(len(pkgs)))))
	var shared []string
	for _, p := range pkgs {
		if usedBy[p.ImportPath] >= wide {
			shared = append(shared, p.ImportPath)
		}
	}
	// what each package talks to, from the drivers and SDKs it imports itself
	systems := map[string]string{}
	var systemOrder []string
	setSystem := func(n, k string) {
		if _, ok := systems[n]; !ok {
			systemOrder = append(systemOrder, n)
		}
		systems[n] = k
	}
	talks := map[string]*strset{}
	var talkOrder []string
	say := func(ip, name, kind string) {
		setSystem(name, kind)
		if talks[ip] == nil {
			talks[ip] = newSet()
			talkOrder = append(talkOrder, ip)
		}
		talks[ip].add(name)
	}
	for _, p := range pkgs {
		for _, i := range p.Imports {
			if n, k, ok := systemOf(i); ok {
				say(p.ImportPath, n, k)
			}
		}
	}

	// facts from the syntax tree
	in := make([]Pkg, len(pkgs))
	for i, p := range pkgs {
		in[i] = Pkg{ImportPath: p.ImportPath, Name: p.Name, Dir: p.Dir, GoFiles: p.GoFiles}
	}
	var facts []Fact
	for _, f := range Read(in) {
		if mine[f.Pkg] != nil {
			facts = append(facts, f)
		}
	}
	otherHosts := newSet()
	for _, f := range facts {
		if f.Kind == "host" {
			if sys := hostSystem(f.Name); sys != "" {
				say(f.Pkg, sys, "api")
			} else if !notACall.MatchString(f.Name) {
				otherHosts.add(f.Name)
			}
		}
	}
	// routes each package serves
	routes := map[string][]Fact{}
	var routeOrder []string
	for _, f := range facts {
		if f.Kind == "route" {
			if routes[f.Pkg] == nil {
				routeOrder = append(routeOrder, f.Pkg)
			}
			routes[f.Pkg] = append(routes[f.Pkg], f)
		}
	}
	// the streams and buckets the code names, and who defines, publishes to or reads each
	parts := map[string]*part{}
	var partOrder []*part
	getPart := func(name, kind string) *part {
		if parts[name] == nil {
			parts[name] = &part{name: name, kind: kind, subjects: newSet(), roles: map[string]*strset{}}
			partOrder = append(partOrder, parts[name])
		}
		return parts[name]
	}
	for _, f := range facts {
		switch {
		case f.Kind == "bucket":
			getPart(f.Name, "bucket").role(f.Pkg, "uses")
		case f.Kind == "stream":
			getPart(f.Name, "stream").role(f.Pkg, "defines")
		case f.Kind == "subject" && f.Of != "":
			getPart(f.Of, "stream").subjects.add(f.Name)
		}
	}
	for _, f := range facts {
		if f.Kind == "pub" || f.Kind == "sub" {
			for _, pt := range partOrder {
				if pt.kind != "stream" {
					continue
				}
				for _, sj := range pt.subjects.keys {
					if under(sj, f.Name) || under(f.Name, sj) {
						r := "consumes"
						if f.Kind == "pub" {
							r = "publishes"
						}
						pt.role(f.Pkg, r)
						break
					}
				}
			}
		}
	}
	for _, pt := range partOrder {
		for _, ip := range pt.roleOrder {
			say(ip, "NATS", "store")
		}
	}
	// what each program reaches: the systems any package it imports, directly or not, holds a client for
	closure := map[string]*strset{}
	var reachOf func(ip string) *strset
	reachOf = func(ip string) *strset {
		if c := closure[ip]; c != nil {
			return c
		}
		got := newSet()
		closure[ip] = got // set first: Go has no import cycles, but be safe
		if t := talks[ip]; t != nil {
			for _, s := range t.keys {
				got.add(s)
			}
		}
		for _, i := range mine[ip].Imports {
			if mine[i] != nil {
				for _, s := range reachOf(i).keys {
					got.add(s)
				}
			}
		}
		return got
	}

	rel := func(ip string) string {
		if r := mine[ip].rel; r != "" {
			return r
		}
		return "."
	}
	where := func(f Fact) string { return rel(f.Pkg) + "/" + f.File + ":" + strconv.Itoa(f.Line) }
	label := ""
	if only != "" {
		label = " (" + only + ")"
	}
	rep := []string{"# Facts read from " + mod + label, "", "Read from the code, offline. Each line is a fact, not a judgement: what it means for the architecture is for the reader to decide.", ""}
	rep = append(rep, "## Programs (package main) and the outside systems each one reaches through its imports", "")
	var mains []*listed
	for _, p := range pkgs {
		if p.Name == "main" {
			mains = append(mains, p)
		}
	}
	sort.SliceStable(mains, func(i, j int) bool { return jsx.LocaleCompare(mains[i].rel, mains[j].rel) < 0 })
	for _, p := range mains {
		list := strings.Join(reachOf(p.ImportPath).sorted(), ", ")
		if list == "" {
			list = "none found"
		}
		doc := ""
		if p.Doc != "" {
			doc = " · " + jsx.Slice16(oneLine(p.Doc), 100)
		}
		rep = append(rep, "- "+rel(p.ImportPath)+": "+list+doc)
	}
	rep = append(rep, "", "## Outside systems and the packages that hold a client for each", "")
	// [...systems].sort() sorts the "name,kind" strings
	type sysEntry struct{ n, k, key string }
	var sysList []sysEntry
	for _, n := range systemOrder {
		sysList = append(sysList, sysEntry{n, systems[n], n + "," + systems[n]})
	}
	sort.SliceStable(sysList, func(i, j int) bool { return jsx.Cmp16(sysList[i].key, sysList[j].key) < 0 })
	for _, s := range sysList {
		var users []string
		for _, ip := range talkOrder {
			if talks[ip].has[s.n] {
				users = append(users, rel(ip))
			}
		}
		slices.SortFunc(users, jsx.Cmp16)
		rep = append(rep, "- "+s.n+" ("+s.k+"): "+strings.Join(users, ", "))
	}
	if len(partOrder) > 0 {
		rep = append(rep, "", "## NATS streams and key-value buckets named in the code", "")
		sp := slices.Clone(partOrder)
		sort.SliceStable(sp, func(i, j int) bool {
			if c := jsx.LocaleCompare(sp[i].kind, sp[j].kind); c != 0 {
				return c < 0
			}
			return jsx.LocaleCompare(sp[i].name, sp[j].name) < 0
		})
		for _, pt := range sp {
			var at *Fact
			for i := range facts {
				if (facts[i].Kind == "stream" || facts[i].Kind == "bucket") && facts[i].Name == pt.name {
					at = &facts[i]
					break
				}
			}
			line := "- " + pt.kind + " " + pt.name
			if len(pt.subjects.keys) > 0 {
				line += " [" + strings.Join(pt.subjects.sorted(), ", ") + "]"
			}
			var who []string
			for _, ip := range pt.roleOrder {
				who = append(who, rel(ip)+" ("+strings.Join(pt.roles[ip].sorted(), ", ")+")")
			}
			line += " · " + strings.Join(who, "; ")
			if at != nil {
				line += " · " + where(*at)
			}
			rep = append(rep, line)
		}
	}
	if len(routeOrder) > 0 {
		rep = append(rep, "", "## HTTP routes by package, grouped by the start of the path (count, first place registered)", "")
		ro := slices.Clone(routeOrder)
		sort.SliceStable(ro, func(i, j int) bool { return len(routes[ro[i]]) > len(routes[ro[j]]) })
		for _, ip := range ro {
			rs := routes[ip]
			rep = append(rep, fmt.Sprintf("- %s: %d routes", rel(ip), len(rs)))
			by := map[string][]Fact{}
			var byOrder []string
			for _, r := range rs {
				k := strings.Join(firstN(strings.Split(r.Name, "/"), 4), "/")
				if k == "" {
					k = "/"
				}
				if by[k] == nil {
					byOrder = append(byOrder, k)
				}
				by[k] = append(by[k], r)
			}
			sort.SliceStable(byOrder, func(i, j int) bool { return len(by[byOrder[i]]) > len(by[byOrder[j]]) })
			for _, k := range byOrder {
				list := by[k]
				ms := newSet()
				for _, r := range list {
					if r.Method != "" {
						ms.add(r.Method)
					}
				}
				methods := strings.Join(ms.sorted(), " ")
				if methods == "" {
					methods = "any method"
				}
				rep = append(rep, fmt.Sprintf("  - %s (%d; %s) %s", k, len(list), methods, where(list[0])))
			}
		}
	}
	sh := make([]string, len(shared))
	for i, ip := range shared {
		sh[i] = fmt.Sprintf("%s (%d)", rel(ip), usedBy[ip])
	}
	slices.SortFunc(sh, jsx.Cmp16)
	list := strings.Join(sh, ", ")
	if list == "" {
		list = "none"
	}
	rep = append(rep, "", "## Packages most of the module imports (shared code, not architecture)", "", list)
	if len(otherHosts.keys) > 0 {
		rep = append(rep, "", "## Hosts written in the code that are not a known service", "", strings.Join(otherHosts.sorted(), ", "))
	}
	rep = append(rep, "", "## What this cannot see", "", "- Anything decided at run time: a subject or URL built from variables, a host that comes from configuration.", "- Which program runs where, how many copies, and what the network allows: read the deployment files for that.", "- A system called over plain HTTP with no SDK and no URL in the code.", "")
	return strings.Join(rep, "\n"), nil
}

func firstN(s []string, n int) []string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
