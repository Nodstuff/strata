// EXPERIMENTAL. Reads a Go module and writes a strata file of its packages: a box per package,
// nested the way the directories are, and an arrow for every import between two of the module's
// own packages. Nothing here guesses: it is what `go list` reports. Standard-library and
// third-party imports are counted on each box, not drawn.
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { gofactsSource } from './assets.js';

const run = (cmd, args, cwd) => new Promise((ok, fail) => execFile(cmd, args, { cwd, maxBuffer: 256 << 20, env: { ...process.env, GOPROXY: 'off' } }, // GOPROXY off: never the network, only what is already on disk
  (err, out, errOut) => (err && !out ? fail(new Error(errOut || err.message)) : ok(out))));

// `go list -json` prints one JSON object after another with nothing between them
function objects(text) {
  const out = []; let depth = 0, start = 0, str = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') { if (!depth) start = i; depth++; }
    else if (c === '}' && !--depth) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out;
}

// The facts only the syntax tree holds (routes, subjects, streams, buckets, hosts), read by a small
// Go program that uses the standard library's parser. It is run from a temporary directory with the
// network and the workspace off, so it cannot touch the module it reads.
const goFacts = async pkgs => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-gofacts-'));
  try {
    await writeFile(join(dir, 'main.go'), await gofactsSource());
    return await new Promise((ok, fail) => {
      const child = execFile('go', ['run', 'main.go'], { cwd: dir, maxBuffer: 256 << 20, env: { ...process.env, GOPROXY: 'off', GOWORK: 'off', GOFLAGS: '' } },
        (err, out, errOut) => { if (err) return fail(new Error((errOut || err.message).trim().split('\n')[0])); try { ok(JSON.parse(out)); } catch (e) { fail(e); } });
      child.stdin.end(JSON.stringify(pkgs.map(p => ({ ImportPath: p.ImportPath, Name: p.Name, Dir: p.Dir, GoFiles: p.GoFiles }))));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
};

// A URL written in the code says what it calls when there is no SDK to import.
const HOSTS = [['slack.com', 'Slack'], ['workos.com', 'WorkOS'], ['workato.com', 'Workato'], ['anthropic.com', 'Anthropic API'], ['openai.com', 'OpenAI API'],
  ['api.github.com', 'GitHub API'], ['pagerduty.com', 'PagerDuty'], ['opsgenie.com', 'Opsgenie'], ['datadoghq.com', 'Datadog'], ['sentry.io', 'Sentry'],
  ['stripe.com', 'Stripe'], ['twilio.com', 'Twilio'], ['sendgrid.com', 'SendGrid'], ['googleapis.com', 'Google APIs'], ['microsoftonline.com', 'Microsoft Entra'],
  ['graph.microsoft.com', 'Microsoft Graph'], ['okta.com', 'Okta'], ['auth0.com', 'Auth0'], ['atlassian.net', 'Jira'], ['atlassian.com', 'Atlassian API'],
  ['salesforce.com', 'Salesforce'], ['zendesk.com', 'Zendesk'], ['hubapi.com', 'HubSpot'], ['telegram.org', 'Telegram'], ['discord.com', 'Discord']];
const NOT_A_CALL = /(^|\.)(example\.(com|org|net)|localhost|amazonaws\.com|w3\.org|json-schema\.org|golang\.org|go\.dev|githubusercontent\.com|github\.com|schema\.org|ietf\.org|apache\.org|mozilla\.org|wikipedia\.org)$/;
const hostSystem = h => { const m = HOSTS.find(([d]) => h === d || h.endsWith('.' + d)); return m ? m[1] : null; };
// does a subject fall under a pattern, the way NATS reads "*" and ">"
const under = (pat, name) => { if (pat === name) return true; const a = pat.split('.'), b = name.split('.'); for (let i = 0; i < a.length; i++) { if (a[i] === '>') return b.length > i; if (i >= b.length || (a[i] !== '*' && a[i] !== b[i])) return false; } return a.length === b.length; };

// What a third-party import says the code talks to. This is the signal in an architecture picture:
// a package that imports the ClickHouse driver talks to ClickHouse. Longest match wins.
const SYSTEMS = [
  ['github.com/ClickHouse/clickhouse-go', 'ClickHouse', 'store'], ['github.com/nats-io/nats.go', 'NATS', 'store'],
  ['github.com/jackc/pgx', 'Postgres', 'store'], ['github.com/lib/pq', 'Postgres', 'store'], ['github.com/go-sql-driver/mysql', 'MySQL', 'store'],
  ['github.com/redis/go-redis', 'Redis', 'store'], ['github.com/go-redis/redis', 'Redis', 'store'], ['go.mongodb.org/mongo-driver', 'MongoDB', 'store'],
  ['github.com/segmentio/kafka-go', 'Kafka', 'store'], ['github.com/IBM/sarama', 'Kafka', 'store'], ['github.com/confluentinc/confluent-kafka-go', 'Kafka', 'store'],
  ['github.com/elastic/go-elasticsearch', 'Elasticsearch', 'store'], ['github.com/opensearch-project/opensearch-go', 'OpenSearch', 'store'],
  ['github.com/minio/minio-go', 'S3-compatible storage', 'store'], ['go.etcd.io/etcd/client', 'etcd', 'store'],
  ['k8s.io/client-go', 'Kubernetes API', 'cloud'], ['sigs.k8s.io/controller-runtime', 'Kubernetes API', 'cloud'],
  ['github.com/hashicorp/vault', 'Vault', 'cloud'], ['go.opentelemetry.io/otel/exporters', 'OpenTelemetry collector', 'cloud'],
  ['github.com/anthropics/anthropic-sdk-go', 'Anthropic API', 'api'], ['github.com/openai/openai-go', 'OpenAI API', 'api'], ['github.com/sashabaranov/go-openai', 'OpenAI API', 'api'],
  ['github.com/slack-go/slack', 'Slack', 'api'], ['github.com/workos/workos-go', 'WorkOS', 'api'], ['github.com/stripe/stripe-go', 'Stripe', 'api'],
  ['github.com/coreos/go-oidc', 'OIDC provider', 'api'], ['github.com/google/go-github', 'GitHub API', 'api'], ['github.com/twilio/twilio-go', 'Twilio', 'api'],
  ['net/smtp', 'SMTP server', 'api'],
];
const AWS = /^github\.com\/aws\/aws-sdk-go(?:-v2)?\/service\/([a-z0-9]+)/, GCP = /^cloud\.google\.com\/go\/([a-z0-9]+)/;
const AWS_NAMES = { secretsmanager: 'Secrets Manager', dynamodb: 'DynamoDB', cloudwatch: 'CloudWatch', cloudwatchlogs: 'CloudWatch Logs', cloudformation: 'CloudFormation', lambda: 'Lambda', kinesis: 'Kinesis', route53: 'Route 53', eventbridge: 'EventBridge', sesv2: 'SES', bedrockruntime: 'Bedrock', servicequotas: 'Service Quotas', organizations: 'Organizations', cloudtrail: 'CloudTrail', elasticloadbalancingv2: 'Load Balancing', autoscaling: 'Auto Scaling', pricing: 'Pricing' };
const NOT_A_SYSTEM = new Set(['internal', 'iam', 'compute', 'auth', 'longrunning']); // GCP helper modules, not services
function systemOf(imp) {
  let m = AWS.exec(imp); if (m) return ['AWS ' + (AWS_NAMES[m[1]] || (m[1].length <= 4 ? m[1].toUpperCase() : m[1][0].toUpperCase() + m[1].slice(1))), 'cloud'];
  m = GCP.exec(imp); if (m && !NOT_A_SYSTEM.has(m[1])) return ['GCP ' + m[1], 'cloud'];
  let best = null; for (const s of SYSTEMS) if ((imp === s[0] || imp.startsWith(s[0] + '/') || imp.startsWith(s[0] + '.')) && (!best || s[0].length > best[0].length)) best = s;
  return best ? [best[1], best[2]] : null;
}

const q = s => JSON.stringify(String(s)); // a JSON string is a valid YAML double-quoted string
const idOf = rel => 'p_' + (rel || 'root').replace(/[^A-Za-z0-9]+/g, '_');

export async function genGo(dir, { only = null } = {}) {
  let listed;
  try { listed = objects(await run('go', ['list', '-e', '-json=ImportPath,Name,Dir,Imports,GoFiles,Doc,Module', './...'], dir)); }
  catch (e) { throw new Error(`go list failed in ${dir}: ${e.message.trim().split('\n')[0]}`); }
  if (!listed.length) throw new Error(`no Go packages under ${dir}`);
  const mod = (listed.find(p => p.Module) || {}).Module?.Path || '';
  const relOf = ip => (ip === mod ? '' : ip.startsWith(mod + '/') ? ip.slice(mod.length + 1) : null);
  let pkgs = listed.map(p => ({ ...p, rel: relOf(p.ImportPath) })).filter(p => p.rel != null && (p.GoFiles || []).length);
  if (only) pkgs = pkgs.filter(p => p.rel === only || p.rel.startsWith(only.replace(/\/$/, '') + '/'));
  if (!pkgs.length) throw new Error(only ? `no packages under "${only}" in ${mod}` : `no packages with Go files in ${mod}`);
  const mine = new Map(pkgs.map(p => [p.ImportPath, p]));
  const usedBy = new Map();
  for (const p of pkgs) for (const i of p.Imports || []) if (mine.has(i)) usedBy.set(i, (usedBy.get(i) || 0) + 1);
  // A package nearly everything imports (a model, a logger) says nothing by being imported. Its box
  // says how widely it is used; the arrows to it are left out, which is most of the noise gone.
  const WIDE = Math.max(6, Math.ceil(0.12 * pkgs.length));
  const shared = new Set(pkgs.filter(p => (usedBy.get(p.ImportPath) || 0) >= WIDE).map(p => p.ImportPath));
  // what each package talks to, from the drivers and SDKs it imports itself
  const systems = new Map(), talks = new Map();
  for (const p of pkgs) for (const i of p.Imports || []) { const s = systemOf(i); if (!s) continue; systems.set(s[0], s[1]); if (!talks.has(p.ImportPath)) talks.set(p.ImportPath, new Set()); talks.get(p.ImportPath).add(s[0]); }

  // facts from the syntax tree; without them (no Go toolchain run possible) the picture is still drawn
  let facts = [], factsError = null;
  try { facts = (await goFacts(pkgs)).filter(f => mine.has(f.pkg)); } catch (e) { factsError = e.message; }
  const say = (ip, name, kind) => { systems.set(name, kind); if (!talks.has(ip)) talks.set(ip, new Set()); talks.get(ip).add(name); };
  const otherHosts = new Set();
  for (const f of facts) if (f.kind === 'host') { const sys = hostSystem(f.name); if (sys) say(f.pkg, sys, 'api'); else if (!NOT_A_CALL.test(f.name)) otherHosts.add(f.name); }
  // routes each package serves, by the first three parts of the path
  const routes = new Map();
  for (const f of facts) if (f.kind === 'route') { if (!routes.has(f.pkg)) routes.set(f.pkg, []); routes.get(f.pkg).push(f); }
  // the streams and buckets the code names, and who defines, publishes to or reads each
  const parts = new Map(), part = (name, kind) => { if (!parts.has(name)) parts.set(name, { name, kind, subjects: new Set(), roles: new Map() }); return parts.get(name); };
  const role = (pt, ip, r) => { if (!pt.roles.has(ip)) pt.roles.set(ip, new Set()); pt.roles.get(ip).add(r); };
  for (const f of facts) {
    if (f.kind === 'bucket') role(part(f.name, 'bucket'), f.pkg, 'uses');
    else if (f.kind === 'stream') role(part(f.name, 'stream'), f.pkg, 'defines');
    else if (f.kind === 'subject' && f.of) part(f.of, 'stream').subjects.add(f.name);
  }
  for (const f of facts) if (f.kind === 'pub' || f.kind === 'sub') for (const pt of parts.values()) if (pt.kind === 'stream' && [...pt.subjects].some(sj => under(sj, f.name) || under(f.name, sj))) role(pt, f.pkg, f.kind === 'pub' ? 'publishes' : 'consumes');
  if (parts.size) for (const pt of parts.values()) for (const ip of pt.roles.keys()) say(ip, 'NATS', 'store');
  // what each program reaches: the systems any package it imports, directly or not, holds a client for
  const closure = new Map(), reachOf = ip => {
    if (closure.has(ip)) return closure.get(ip);
    const got = new Set(); closure.set(ip, got); // set first: Go has no import cycles, but be safe
    for (const s of talks.get(ip) || []) got.add(s);
    for (const i of mine.get(ip).Imports || []) if (mine.has(i)) for (const s of reachOf(i)) got.add(s);
    return got;
  };

  // the directory tree: a directory that is a package and also holds packages becomes a box with the package inside it
  const base = only ? only.replace(/\/$/, '').split('/') : [];
  const tree = { name: '', kids: new Map(), pkg: null, rel: base.join('/') };
  for (const p of pkgs) {
    let at = tree; const parts = p.rel ? p.rel.split('/').slice(base.length) : [];
    parts.forEach((name, i) => { if (!at.kids.has(name)) at.kids.set(name, { name, kids: new Map(), pkg: null, rel: [...base, ...parts.slice(0, i + 1)].join('/') }); at = at.kids.get(name); });
    at.pkg = p;
  }
  // A directory with many packages is unreadable as one level. Two mechanical groupings, in order:
  // packages whose names share a start (cnqtrack, cnqclaim, cnqphase) go in one box; what is left, if
  // still many, is split by where it sits in the import graph of the module.
  const below = n => [...(n.pkg ? [n.pkg] : []), ...[...n.kids.values()].flatMap(below)];
  const MANY = 14;
  const regroup = (n, again) => {
    if (!again) for (const k of [...n.kids.values()]) regroup(k);
    if (n.kids.size <= MANY) return;
    const box = (name, label, kids, why) => { const g = { name: label, kids: new Map(kids.map(k => [k.name, k])), pkg: null, rel: `${n.rel}/~${name}`, made: true, why }; for (const k of kids) n.kids.delete(k.name); n.kids.set('~' + name, g); return g; };
    const names = [...n.kids.keys()], cands = new Map();
    for (const nm of names) for (let l = 3; l <= Math.min(8, nm.length); l++) { const pre = nm.slice(0, l); cands.set(pre, (cands.get(pre) || 0) + 1); }
    const taken = new Set();
    for (const [pre] of [...cands].filter(c => c[1] >= 3).sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)) {
      const mine2 = names.filter(nm => nm.startsWith(pre) && !taken.has(nm));
      if (mine2.length < 3) continue;
      // the longest start all of them share, so the box is named cnq, not cn
      let full = mine2[0]; for (const nm of mine2) while (!nm.startsWith(full)) full = full.slice(0, -1);
      for (const nm of mine2) taken.add(nm);
      box(full, full + '…', mine2.map(nm => n.kids.get(nm)));
    }
    const loose = [...n.kids.values()].filter(k => !k.made);
    if (n.kids.size <= MANY || loose.length < 6) return;
    // by place in this directory's import graph; a Middle that is still large is split the same way again
    const inside = new Set(below(n).map(p => p.ImportPath)), tier = { base: [], mid: [], top: [] };
    for (const k of loose) {
      const own = new Set(below(k).map(p => p.ImportPath));
      const uses = below(k).some(p => (p.Imports || []).some(i => inside.has(i) && !own.has(i)));
      const used = below(n).some(p => !own.has(p.ImportPath) && (p.Imports || []).some(i => own.has(i)));
      tier[!uses ? 'base' : !used ? 'top' : 'mid'].push(k);
    }
    if (tier.mid.length === loose.length) return; // nothing to tell apart
    if (tier.base.length >= 2) box('base', 'Foundations', tier.base, 'import nothing else here');
    if (tier.top.length >= 2) box('top', 'Tops', tier.top, 'nothing else here imports them');
    if (tier.mid.length >= 2 && n.kids.size > MANY / 2) regroup(box('mid', 'Middle', tier.mid, 'import and are imported'), true);
  };
  regroup(tree);
  const idFor = new Map(); // import path -> the id of the box that stands for the package
  const lines = [];
  const leaf = (p, label, ind) => {
    const own = (p.Imports || []).filter(i => mine.has(i)).length, other = (p.Imports || []).length - own;
    const doc = (p.Doc || '').replace(/\s+/g, ' ').trim();
    lines.push(`${ind}- id: ${idOf(p.rel)}`, `${ind}  label: ${q(label)}`);
    const rs = routes.get(p.ImportPath) || [], subs = [p.Name !== label.split('/').pop() ? 'package ' + p.Name : null, rs.length ? `${rs.length} HTTP route${rs.length === 1 ? '' : 's'}` : null].filter(Boolean);
    if (subs.length) lines.push(`${ind}  sub: ${q(subs.join(' · '))}`);
    if (p.Name === 'main') lines.push(`${ind}  kind: service`);
    lines.push(`${ind}  detail:`);
    if (doc) lines.push(`${ind}    - ${q(doc.length > 64 ? doc.slice(0, 61) + '...' : doc)}`);
    lines.push(`${ind}    - ${q(`${p.GoFiles.length} file${p.GoFiles.length === 1 ? '' : 's'} · used by ${usedBy.get(p.ImportPath) || 0}`)}`);
    lines.push(`${ind}    - ${q(shared.has(p.ImportPath) ? `shared: imported by ${usedBy.get(p.ImportPath)} packages (arrows not drawn)` : `imports ${own} here, ${other} outside`)}`);
    if (talks.has(p.ImportPath)) lines.push(`${ind}    - ${q('talks to ' + [...talks.get(p.ImportPath)].join(', '))}`);
    if (p.Name === 'main') { const far = [...reachOf(p.ImportPath)].filter(x => !(talks.get(p.ImportPath) || new Set()).has(x)).sort(); if (far.length) lines.push(`${ind}    - ${q('reaches through its imports: ' + far.join(', '))}`); }
    if (rs.length) {
      const by = new Map(); for (const r of rs) { const k = r.name.split('/').slice(0, 4).join('/') || '/'; by.set(k, (by.get(k) || 0) + 1); }
      const top = [...by].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
      for (const [k, n] of top.slice(0, 6)) lines.push(`${ind}    - ${q(`serves ${k}${n > 1 ? ' (' + n + ')' : ''}`)}`);
      if (top.length > 6) lines.push(`${ind}    - ${q(`and ${top.length - 6} more path groups`)}`);
    }
    idFor.set(p.ImportPath, idOf(p.rel));
  };
  const emit = (n, ind) => {
    // a chain of directories with nothing else in them is one box: internal/x/y, not three nested boxes
    let label = n.name;
    while (!n.pkg && !n.made && n.kids.size === 1 && ![...n.kids.values()][0].made) { n = [...n.kids.values()][0]; label += '/' + n.name; }
    if (!n.kids.size) return leaf(n.pkg, label, ind);
    lines.push(`${ind}- id: ${idOf(n.rel)}_dir`, `${ind}  label: ${q(label)}`, `${ind}  sub: ${q(`${count(n)} packages${n.why ? ' · ' + n.why : ''}`)}`, `${ind}  nodes:`);
    if (n.pkg) leaf(n.pkg, n.name, ind + '    ');
    for (const k of [...n.kids.values()].sort((a, b) => a.name.localeCompare(b.name))) emit(k, ind + '    ');
  };
  const count = n => (n.pkg ? 1 : 0) + [...n.kids.values()].reduce((s, k) => s + count(k), 0);
  if (tree.pkg) leaf(tree.pkg, base.length ? base[base.length - 1] : mod.split('/').pop(), '  ');
  for (const k of [...tree.kids.values()].sort((a, b) => a.name.localeCompare(b.name))) emit(k, '  ');

  const edges = [];
  let dropped = 0;
  for (const p of pkgs) for (const i of p.Imports || []) if (mine.has(i) && i !== p.ImportPath) { if (shared.has(i)) dropped++; else edges.push(`  - [ ${idFor.get(p.ImportPath)}, ${idFor.get(i)} ]`); }
  // the systems the code talks to, one box each, by kind; an arrow from each package that holds the client
  const pid = pt => 'nats_' + pt.name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
  const sid = n => 'sys_' + n.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
  for (const [kind, label, look] of [['store', 'Data stores', ['kind: store', 'shape: cylinder']], ['cloud', 'Cloud services', ['kind: infra']], ['api', 'External APIs', ['kind: external']]]) {
    const names = [...systems].filter(s => s[1] === kind).map(s => s[0]).sort(); if (!names.length) continue;
    lines.push(`  - id: sysgrp_${kind}`, `    label: ${q(label)}`, `    sub: ${q('found from the clients the code imports')}`, '    nodes:');
    for (const n of names) {
      const users = [...talks].filter(t => t[1].has(n)).length;
      const inside = n === 'NATS' ? [...parts.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)) : [];
      lines.push(`      - id: ${sid(n)}`, `        label: ${q(n)}`, ...look.filter(l => !inside.length || !l.startsWith('shape')).map(l => '        ' + l), `        detail:`, `          - ${q(`used by ${users} package${users === 1 ? '' : 's'}`)}`);
      if (!inside.length) continue;
      lines.push('        nodes:');
      for (const [kind2, title] of [['stream', 'Streams'], ['bucket', 'Key-value buckets']]) {
        const these = inside.filter(pt => pt.kind === kind2); if (!these.length) continue;
        lines.push(`          - id: ${sid(n)}_${kind2}s`, `            label: ${q(title)}`, `            sub: ${q(kind2 === 'stream' ? 'with the subjects each one holds' : 'named in the code')}`, '            nodes:');
        for (const pt of these) {
          lines.push(`              - id: ${pid(pt)}`, `                label: ${q(pt.name)}`, '                kind: store');
          if (pt.subjects.size) lines.push('                detail:', ...[...pt.subjects].sort().map(sj => `                  - ${q(sj)}`));
        }
      }
    }
  }
  let calls = 0;
  const named = new Set(); // packages with an arrow to a named stream or bucket need no arrow to NATS as a whole
  for (const pt of parts.values()) for (const [ip, rl] of pt.roles) {
    const words = [...rl].filter(r => r !== 'uses' && r !== 'defines').sort().join(' + ');
    edges.push(`  - [ ${idFor.get(ip)}, ${pid(pt)}, ${q(words)}, talk ]`); calls++; named.add(ip);
  }
  for (const [ip, set] of talks) for (const n of set) { if (n === 'NATS' && named.has(ip)) continue; edges.push(`  - [ ${idFor.get(ip)}, ${sid(n)}, "", talk ]`); calls++; }
  let reaches = 0;
  for (const p of pkgs) if (p.Name === 'main') for (const n of reachOf(p.ImportPath)) if (!(talks.get(p.ImportPath) || new Set()).has(n)) { edges.push(`  - [ ${idFor.get(p.ImportPath)}, ${sid(n)}, "", reach ]`); reaches++; }
  const head = [
    `# GENERATED by "strata gen go" (experimental) from ${mod}${only ? ' (' + only + ')' : ''}: ${pkgs.length} packages, ${edges.length - calls - reaches} imports drawn, ${dropped} to shared packages left out, ${calls} links to ${systems.size} outside systems.`,
    '# A grey arrow is an import. A blue arrow says a package holds a client for that system, or names that stream or bucket.',
    '# A dashed blue arrow says a program (package main) reaches that system through the packages it imports. Edit freely, or generate again.',
    `title: ${q(mod.split('/').pop() + (only ? ' / ' + only : ''))}`,
    `subtitle: ${q('Go packages, their imports, and what they talk to')}`,
    'styles:',
    '  talk: {color: blue, width: 2, rank: 5, label: talks to}',
    '  reach: {color: blue, width: 1.3, dash: dashed, rank: 3, label: reaches through its imports}',
    'nodes:',
  ];
  // The same facts as plain text with file and line, for a person or Claude drawing the architecture by hand.
  const where = f => `${mine.get(f.pkg).rel || '.'}/${f.file}:${f.line}`, relOfPkg = ip => mine.get(ip).rel || '.';
  const rep = [`# Facts read from ${mod}${only ? ' (' + only + ')' : ''}`, '', 'Read from the code, offline. Each line is a fact, not a judgement: what it means for the architecture is for the reader to decide.', ''];
  rep.push('## Programs (package main) and the outside systems each one reaches through its imports', '');
  for (const p of pkgs.filter(x => x.Name === 'main').sort((a, b) => a.rel.localeCompare(b.rel))) rep.push(`- ${p.rel || '.'}: ${[...reachOf(p.ImportPath)].sort().join(', ') || 'none found'}${p.Doc ? ' · ' + p.Doc.replace(/\s+/g, ' ').trim().slice(0, 100) : ''}`);
  rep.push('', '## Outside systems and the packages that hold a client for each', '');
  for (const [n, kind] of [...systems].sort()) rep.push(`- ${n} (${kind}): ${[...talks].filter(t => t[1].has(n)).map(t => relOfPkg(t[0])).sort().join(', ')}`);
  if (parts.size) {
    rep.push('', '## NATS streams and key-value buckets named in the code', '');
    for (const pt of [...parts.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
      const at = facts.find(f => (f.kind === 'stream' || f.kind === 'bucket') && f.name === pt.name);
      rep.push(`- ${pt.kind} ${pt.name}${pt.subjects.size ? ' [' + [...pt.subjects].sort().join(', ') + ']' : ''} · ${[...pt.roles].map(([ip, rl]) => relOfPkg(ip) + ' (' + [...rl].sort().join(', ') + ')').join('; ')}${at ? ' · ' + where(at) : ''}`);
    }
  }
  if (routes.size) {
    rep.push('', '## HTTP routes by package, grouped by the start of the path (count, first place registered)', '');
    for (const [ip, rs] of [...routes].sort((a, b) => b[1].length - a[1].length)) {
      rep.push(`- ${relOfPkg(ip)}: ${rs.length} routes`);
      const by = new Map(); for (const r of rs) { const k = r.name.split('/').slice(0, 4).join('/') || '/'; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
      for (const [k, list] of [...by].sort((a, b) => b[1].length - a[1].length)) rep.push(`  - ${k} (${list.length}; ${[...new Set(list.map(r => r.method).filter(Boolean))].sort().join(' ') || 'any method'}) ${where(list[0])}`);
    }
  }
  rep.push('', '## Packages most of the module imports (shared code, not architecture)', '', [...shared].map(ip => `${relOfPkg(ip)} (${usedBy.get(ip)})`).sort().join(', ') || 'none');
  if (otherHosts.size) rep.push('', '## Hosts written in the code that are not a known service', '', [...otherHosts].sort().join(', '));
  if (factsError) rep.push('', `Could not read the syntax tree (${factsError}): routes, streams, buckets and hosts are missing.`);
  rep.push('', '## What this cannot see', '', '- Anything decided at run time: a subject or URL built from variables, a host that comes from configuration.', '- Which program runs where, how many copies, and what the network allows: read the deployment files for that.', '- A system called over plain HTTP with no SDK and no URL in the code.', '');
  return { report: rep.join('\n'), yaml: [...head, ...lines, 'edges:', ...edges, ''].join('\n'), packages: pkgs.length, imports: edges.length - calls - reaches, dropped, calls, reaches, systems: systems.size, module: mod,
    routes: facts.filter(f => f.kind === 'route').length, streams: [...parts.values()].filter(x => x.kind === 'stream').length, buckets: [...parts.values()].filter(x => x.kind === 'bucket').length, otherHosts: [...otherHosts].sort(), factsError };
}
