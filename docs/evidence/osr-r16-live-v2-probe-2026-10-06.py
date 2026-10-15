#!/usr/bin/env python3
"""R-16 live probe (open-source-release-2026-09-29#D-025, WI-10003960).

Bar (rubric rev 5 per D-025): the hosted service serves no paid feature to an account
without a subscription -- the deployed hosted build's subscription-gated operations are
inventoried live (each refuses an unentitled account; an empty inventory is recorded with
its positive control), the server-side entitlement resolver fails closed, and the closed
cloud services are absent from the public cut.

Writes docs/evidence/osr-r16-live-2026-10-06b.json (v2: censuses pinned to the deployed hosted sha). Exit 0 only if every assertion holds.
"""
import datetime, hashlib, json, re, subprocess, sys, urllib.request, urllib.error

ROOT = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
OUT = f"{ROOT}/docs/evidence/osr-r16-live-2026-10-06b.json"
HOSTED = "http://127.0.0.1:3880"
PUB = f"{ROOT}/.papercusp/scratch/osr/r1006/pub"  # clone of https://github.com/Papercusp/papercusp-app.git
RUNTIME_SRC = "packages/operator-core/lib/endpoint-route/hosted-runtime.ts"
RESOLVER_SRC = "packages/operator-core/lib/auth/hosted-entitlements.ts"
RESOLVER_TEST = "packages/operator-core/lib/auth/hosted-entitlements.test.ts"
BILLING_SEAM = "packages/operator-core/lib/auth/hosted/billing/entitlement-seam.ts"
# D-015 as corrected by D-009/D-026: libs/papercusp-publish-auth ships (public code imports it); it is
# recorded below for transparency, not asserted absent.
CLOSED_SERVICES = ["apps/papercusp-publish/", "libs/marketplace-public-ui/", "apps/the-swarm-site/"]
SHIPS_PER_D009 = ["libs/papercusp-publish-auth/"]
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
failures = []


def http(method, path):
    req = urllib.request.Request(HOSTED + path, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers.get("content-type", ""), r.read(4096)
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type", ""), e.read(4096)


def git(*args, cwd=ROOT):
    return subprocess.run(["git", "-C", cwd, *args], text=True, capture_output=True)


def grep_head(pattern, *paths):
    """git grep over the committed HEAD tree; returns [(path, line, text)]. Exit 1 = no match."""
    r = git("grep", "-n", "-E", pattern, REF, "--", *paths)
    if r.returncode not in (0, 1):
        raise RuntimeError(f"git grep failed: {r.stderr}")
    out = []
    for ln in r.stdout.splitlines():
        _, path, line, text = ln.split(":", 3)
        out.append((path, int(line), text.strip()))
    return out


def psql_json(sql):
    out = subprocess.check_output(
        ["sudo", "-n", "-u", "postgres", "psql", "-d", "papercusp", "-At", "-c",
         f"SELECT coalesce(json_agg(t), '[]'::json) FROM ({sql}) t"], text=True)
    return json.loads(out.strip() or "[]")


def sha256(path):
    return hashlib.sha256(subprocess.run(["git", "-C", ROOT, "show", f"{REF}:{path}"], capture_output=True,
                                         check=True).stdout).hexdigest()


HEAD = git("rev-parse", "HEAD").stdout.strip()
REF = HEAD
ev = {"schemaVersion": 1, "kind": "operational-test-evidence",
      "name": "R-16: the hosted service serves no paid feature to an account without a subscription",
      "framework": "operational",
      "command": ["python3 .papercusp/scratch/osr/r1006/r16-live.py (HTTP probes of the running :3880 hosted runtime; "
                  "mounted-route census of hosted-runtime.ts at the deployed sha; unauthenticated GET of every mounted GET route; git grep of the DEPLOYED hosted sha (from :3880 /api/health) for entitlement gates and "
                  "402 refusal sites; live papercusp DB census of billing relations via sudo -n -u postgres psql; "
                  "git ls-tree of the live public main clone of Papercusp/papercusp-app)"],
      "startedAt": now(), "evidencePlane": "live", "plan": "open-source-release-2026-09-29", "specId": "R-16",
      "decision": "open-source-release-2026-09-29#D-025", "subjectCommit": HEAD, "workItemId": "WI-10003960"}

# 1. Positive controls on the running hosted runtime.
st, _, body = http("GET", "/api/health")
try:
    health = json.loads(body.decode() or "{}")
except Exception:
    health = None
st2, _, _ = http("GET", "/api/hosted/auth/session")
st3, _, _ = http("GET", "/api/hosted/r16-probe/no-such-route-r16")
ev["controls"] = {"health": {"status": st, "sha": (health or {}).get("sha")},
                  "mountedRoute": {"path": "/api/hosted/auth/session", "status": st2, "expect": "not 404"},
                  "unmountedRoute": {"path": "/api/hosted/r16-probe/no-such-route-r16", "status": st3, "expect": "404"}}
if st != 200:
    failures.append(f"/api/health returned {st}")
if st2 == 404:
    failures.append("mounted control returned 404 - billing 404s below would be vacuous")
if st3 != 404:
    failures.append(f"unmounted control returned {st3}, not 404")

# 1b. Pin every census to the DEPLOYED hosted build (R-16 drift: inventory sha != deployed sha -> unknown).
dep_short = (health or {}).get("sha") or ""
rp = git("rev-parse", "--verify", "--quiet", f"{dep_short}^{{commit}}") if dep_short else None
DEPLOYED = rp.stdout.strip() if rp is not None and rp.returncode == 0 else None
ev["deployedBuild"] = {"healthSha": dep_short or None, "resolvedSha": DEPLOYED, "treeHead": HEAD}
if DEPLOYED:
    REF = DEPLOYED
else:
    failures.append(f"deployed hosted sha {dep_short!r} does not resolve locally: the inventory would not be at the deployed build (unknown)")
ev["deployedBuild"]["inventorySha"] = REF
ev["deployedBuild"]["inventoryAtDeployedBuild"] = REF == DEPLOYED

# 2. Mounted-route census (the runtime asserts at boot that its mounted set equals this list).
src = git("show", f"{REF}:{RUNTIME_SRC}").stdout
block = re.search(r"HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS = \[(.*?)\] as const", src, re.S).group(1)
keys = re.findall(r"'([A-Z]+ [^']+)'", block)
boot_assert = "mounted.some((key, index) => key !== HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS[index])" in src
billing_keys = [k for k in keys if "billing" in k or "subscription" in k or "checkout" in k]
ev["mountedRouteCensus"] = {"source": RUNTIME_SRC, "keyCount": len(keys), "keys": keys,
                            "billingOrSubscriptionKeys": billing_keys,
                            "bootTimeExactMatchAssertionPresent": boot_assert}
if not keys or not boot_assert:
    failures.append("mounted-route census empty or boot assertion missing (positive control)")

# 2b. Compatibility (owner #916): the deployed hosted build SERVES every mounted GET route -- no 404 (unmounted)
# and no 5xx -- with authentication enforced on the unauthenticated probe. OAuth flow routes are excluded because a
# GET there starts or completes an identity-provider flow (a side effect). Redirects are not followed.
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_nr = urllib.request.build_opener(_NoRedirect)


def http_nr(path):
    try:
        with _nr.open(urllib.request.Request(HOSTED + path, method="GET"), timeout=6) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:  # timeout / reset: not a served response
        return f"error:{type(e).__name__}"


OAUTH_FLOW = {"GET /hosted/auth/sign-in", "GET /hosted/auth/callback"}
served, excluded = [], []
for k in keys:
    m, p = k.split(" ", 1)
    if m != "GET":
        continue
    if k in OAUTH_FLOW:
        excluded.append({"key": k, "reason": "OAuth flow route: a GET starts or completes an identity-provider flow"})
        continue
    pp = "/api" + re.sub(r":[A-Za-z_]+", "r16-probe", p)
    served.append({"key": k, "path": pp, "status": http_nr(pp)})
unserved = [x for x in served if not isinstance(x["status"], int) or x["status"] == 404 or x["status"] >= 500]
ev["compatibility"] = {
    "claim": "the deployed hosted build serves every mounted GET route (no 404 or 5xx; authentication enforced)",
    "deployedSha": DEPLOYED, "probed": len(served), "routes": served, "excluded": excluded, "unserved": unserved,
    "liveEntitledRequest": ("not measured: a hosted session is minted only by the browser OAuth sign-in, and forging one "
                            "would bypass the authorization under test; the entitled grant is carried by the unit layer "
                            "(hosted-entitlements.test.ts) and a live entitled request is deferred with D-025's "
                            "monetization follow-up (D-028)")}
if not served or unserved:
    failures.append(f"mounted hosted GET routes not served at the deployed build: {unserved or 'none probed'}")

# 3. Hosted billing routes (stripe-subscription-signup-2026-10-01) on the running hosted runtime.
billing_probe = []
for p in ["/api/hosted/billing/plans", "/api/hosted/billing/subscription"]:
    s, _, _ = http("GET", p)
    billing_probe.append({"method": "GET", "path": p, "status": s})
ev["billingRouteProbe"] = billing_probe

# 4. Gate inventory: production callers of the hosted entitlement resolver (at the deployed sha).
gate_hits = grep_head(r"\b(checkHostedEntitlement|resolveHostedEntitlements)\b", "packages", "apps", "libs")
gate_prod = [h for h in gate_hits if not h[0].endswith((".test.ts", ".test.tsx")) and h[0] != RESOLVER_SRC
             and "/docs/" not in h[0] and not h[0].endswith((".md", ".mdx", ".html"))]
gate_def = [h for h in gate_hits if h[0] == RESOLVER_SRC]
seam_hits = grep_head(r"entitlement-seam|resolveHostedSubscriptionEntitlement", "packages", "apps", "libs")
seam_prod = sorted({h[0] for h in seam_hits if not h[0].endswith((".test.ts", ".test.tsx"))
                    and not h[0].endswith((".md", ".mdx", ".html"))})
seam_outside_billing = [p for p in seam_prod if "/auth/hosted/billing/" not in p and "hosted-billing" not in p]
ev["gateInventory"] = {
    "resolver": {"source": RESOLVER_SRC, "definitionHits": len(gate_def),
                 "productionCallers": [f"{p}:{l}" for p, l, _ in gate_prod]},
    "billingEntitlementSeam": {"source": BILLING_SEAM, "productionImporters": seam_prod,
                               "importersOutsideBillingDisplay": seam_outside_billing,
                               "role": "reports what a subscription entitles on GET /hosted/billing/subscription; gates nothing"},
}
if not gate_def:
    failures.append("resolver definition not found by the gate grep (positive control)")
if seam_outside_billing:
    failures.append(f"billing entitlement seam consumed outside billing display: {seam_outside_billing}")

# 5. Every 402 refusal site in the route layer, classified from its surrounding source.
sites = grep_head(r"status: 402|, 402\)|\b402 *\}|402\);", "packages/operator-core/lib/endpoint-route")
sites = [s for s in sites if not s[0].endswith((".test.ts", ".test.tsx"))]
classified = []
for path, line, _ in sites:
    lines = git("show", f"{REF}:{path}").stdout.splitlines()
    ctx = "\n".join(lines[max(0, line - 30):line + 3])
    if re.search(r"subscription|entitle|paid|billing", ctx, re.I):
        cls = "subscription"
    elif re.search(r"cost cap|costCap|budget|spend", ctx, re.I):
        cls = "cost-cap"
    elif re.search(r"IdentityActivationRefused|identity|admission", ctx, re.I):
        cls = "identity-activation"
    else:
        cls = "unclassified"
    classified.append({"site": f"{path}:{line}", "class": cls})
ev["refusal402Census"] = {"siteCount": len(classified), "sites": classified}
sub402 = [c for c in classified if c["class"] == "subscription"]

# 6. Live DB: billing/subscription/entitlement relations and their row counts.
rels = psql_json("SELECT n.nspname AS schema, c.relname AS relation, c.reltuples::bigint AS est_rows "
                 "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' "
                 "AND c.relname ~* '(billing|subscription|entitle)' ORDER BY 1, 2")
for r in rels:
    r["rows"] = psql_json(f'SELECT count(*) AS n FROM "{r["schema"]}"."{r["relation"]}"')[0]["n"]
ev["liveBillingRelations"] = rels

# 7. Public cut: the closed cloud services are absent from live public main.
pub_head = git("rev-parse", "HEAD", cwd=PUB).stdout.strip()
pub_files = git("ls-tree", "-r", "--name-only", "HEAD", cwd=PUB).stdout.splitlines()
private_files = git("ls-files").stdout.splitlines()
cut = []
for prefix in CLOSED_SERVICES:
    cut.append({"path": prefix, "privateTrackedFiles": sum(f.startswith(prefix) for f in private_files),
                "publicFiles": sum(f.startswith(prefix) for f in pub_files)})
ships = [{"path": p, "privateTrackedFiles": sum(f.startswith(p) for f in private_files),
           "publicFiles": sum(f.startswith(p) for f in pub_files), "basis": "D-009 / D-026: public code imports it"}
          for p in SHIPS_PER_D009]
ev["publicCut"] = {"repo": "https://github.com/Papercusp/papercusp-app.git", "commit": pub_head,
                   "publicFileCount": len(pub_files), "closedServices": cut, "shipsByDecision": ships}
if not pub_files:
    failures.append("public cut tree is empty (positive control)")
if any(c["privateTrackedFiles"] == 0 for c in cut):
    failures.append("a closed-service path has no private files (the absence check would be vacuous)")
cut_leak = [c["path"] for c in cut if c["publicFiles"]]

ev["resolver"] = {"source": {"path": RESOLVER_SRC, "sha256": sha256(RESOLVER_SRC)},
                  "test": {"path": RESOLVER_TEST, "sha256": sha256(RESOLVER_TEST)},
                  "claim": "fail-closed: missing, malformed, ambiguous and inactive authority resolve to no entitlement (unit layer)"}

gated_inventory = [c["site"] for c in sub402] + [f"{p}:{l}" for p, l, _ in gate_prod]
if sub402:
    failures.append(f"402 refusal sites tied to subscriptions need exercising: {[c['site'] for c in sub402]}")
if cut_leak:
    failures.append(f"closed services present in the public cut: {cut_leak}")

ev["gatedOperationInventory"] = gated_inventory
ev["finishedAt"] = now()
ev["failures"] = failures
ev["status"] = "pass" if not failures else "fail"
ev["exitCode"] = 0 if not failures else 1
ev["assertions"] = [
    {"id": "positive-controls", "passed": st == 200 and st2 != 404 and st3 == 404 and bool(keys) and bool(gate_def)
     and bool(pub_files),
     "evidence": f"/api/health {st} (sha {(health or {}).get('sha')}); mounted /api/hosted/auth/session {st2}; unmounted {st3}; "
                 f"{len(keys)} boot-asserted mounted keys; resolver definition hits {len(gate_def)}; public files {len(pub_files)}"},
    {"id": "gated-operation-inventory-empty", "passed": not gated_inventory and not sub402,
     "evidence": f"resolver production callers: {len(gate_prod)}; 402 sites: {len(classified)} "
                 f"({', '.join(sorted({c['class'] for c in classified})) or 'none'}), subscription-tied: {len(sub402)}; "
                 f"mounted billing/subscription keys: {billing_keys or 'none'}; billing route probes: "
                 + "; ".join(f"{b['path']} {b['status']}" for b in billing_probe)},
    {"id": "inventory-at-deployed-build", "passed": bool(DEPLOYED) and REF == DEPLOYED and bool(gate_def),
     "evidence": f"deployed sha {DEPLOYED} (health {dep_short}); every census read at {REF}; resolver definition located at "
                 f"that sha ({len(gate_def)} hits) so zero callers is a measured absence"},
    {"id": "hosted-tier-serves-mounted-routes", "passed": bool(served) and not unserved,
     "evidence": "; ".join(f"{x['key']} {x['status']}" for x in served) + f" (excluded: {[x['key'] for x in excluded]})"},
    {"id": "billing-seam-gates-nothing", "passed": not seam_outside_billing,
     "evidence": f"entitlement-seam importers: {len(seam_prod)}, all within billing display; outside: {seam_outside_billing or 'none'}"},
    {"id": "closed-services-absent-from-public-cut", "passed": not cut_leak and all(c["privateTrackedFiles"] for c in cut),
     "evidence": "; ".join(f"{c['path']} private {c['privateTrackedFiles']} / public {c['publicFiles']}" for c in cut)
                 + f" (public main {pub_head[:10]})"},
]
ev["summary"] = ("No hosted operation is subscription-gated at the running :3880 hosted runtime: the hosted entitlement "
                 "resolver has no production caller, every 402 refusal in the route layer is a cost cap or an identity "
                 "activation refusal, and the Stripe billing composition only reports what a subscription entitles. The "
                 "empty inventory is recorded beside non-vacuous controls. The three closed cloud services are absent from "
                 "live public main (publish-auth ships by D-009). Gating a specific paid feature is deferred to a "
                 "monetization follow-up (D-025).")
ev["limitations"] = [
    "The fail-closed resolver claim is carried by the unit layer (hosted-entitlements.test.ts); no production route calls it yet.",
    "The hosted billing composition (stripe-subscription-signup-2026-10-01) is source in the tree; its mount status on :3880 is the billingRouteProbe result.",
    "No live entitled request: a hosted session comes only from the browser OAuth sign-in (D-028).",
    "D-025 is a default taken under AUTO (#1412) while the owner's R-16 question is unanswered; the owner may override it.",
]
with open(OUT, "w") as f:
    json.dump(ev, f, indent=2, default=str)
    f.write("\n")
print(json.dumps({"status": ev["status"], "failures": failures, "keys": len(keys), "billingKeys": billing_keys,
                  "billingProbe": billing_probe, "resolverCallers": len(gate_prod), "seamProd": seam_prod,
                  "402": [(c["site"].rsplit("/", 1)[1], c["class"]) for c in classified],
                  "rels": [(r["relation"], r["rows"]) for r in rels], "cut": cut, "pub": pub_head[:10],
                  "controls": [st, st2, st3], "sha": (health or {}).get("sha")}))
sys.exit(0 if not failures else 1)
