---
rel_path: "runtime-migration/p006-tsc-nested-redgreen-501c.json"
updated_at: 1792819910772
_body: "content"
---

{
  "schemaVersion": 1,
  "scope": "Local source repair proof for nested sidecar compiler metadata; packaged candidate acceptance remains pending.",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "item": "P-006",
  "workItem": "WI-6554700010022072",
  "bug": "EI-26829199892882425",
  "rootCause": "Generic installation-relative source fallback let a sidecar nested inside a builder checkout certify the builder's TypeScript service assets, then eagerly resolve the optional native compiler outside the bundle.",
  "fix": "Only the actual scripts/lib source module or maintained apps/operator/dist-host installation layout may measure service sources. Other bundles import metadata without optional native compiler lookup; certification remains fail-closed.",
  "sources": {
    "scripts/lib/tsc-service.mjs": "ee53aeead77a84f0955885c7a41f721fd150ab9072da2ef5b3f1e016e56cdff1",
    "packages/operator-core/lib/tsc-service.test.ts": "f312a5effa0ef4b1c92e4547e2689359373da60eb4c1e7a68e654672a5d9a972"
  },
  "red": {
    "task": "0mvly5t27ymo9fv1fc7",
    "exitCode": 1,
    "log": "/tmp/bun-p006-tsc-nested-red-501c.log",
    "sha256": "71040a865bd586e3d7f46e65930ce174c96ac5e5b0d889cc7c6836ae95e10202",
    "observed": "Actual nested-layout regression preserved ESCAPED_BUNDLE; filtered source run, not full population."
  },
  "green": {
    "task": "0mvlya25i1mkclp1u7r",
    "exitCode": 0,
    "testsPassed": 52,
    "skippedTests": 0,
    "childSubstituted": 0,
    "log": "/tmp/bun-p006-tsc-nested-green-501c.log",
    "sha256": "6e47153a51bfba85d9873715e1f93fabf790c5e20f8883d1d24b33302d01fd54",
    "testedHead": "4fd59cac27",
    "provenance": "local dirty"
  },
  "types": {
    "task": "0mvlyatmosrgtea1nv6",
    "exitCode": 0,
    "result": "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean",
    "log": "/tmp/bun-p006-tsc-nested-types-501c.log",
    "sha256": "93494bf9252c9503d80d858f68fa9867ece883e9c3bc300377d017b625aba6b2"
  },
  "limitations": [
    "No immutable rebuilt GUI/package acceptance yet",
    "No default switch or migration shipment",
    "Node remains active"
  ]
}
