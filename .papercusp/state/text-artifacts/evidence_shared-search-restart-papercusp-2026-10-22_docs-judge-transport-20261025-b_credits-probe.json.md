---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/docs-judge-transport-20261025-b/credits-probe.json"
updated_at: 1792927099398
_body: "content"
---

{"ok":true,"probed":1,"provider":"claude","unwalled":[],"serving":[],"reserveNotProjected":[],"confirmedWalled":[],"failed":["anthropic-console-credits"],"applied":[],"burnTransitions":[],"dryRun":true,"gatewayConverged":false,"gatewayReadmitted":[],"gatewayHealthyAccounts":null,"rows":[{"accountId":"anthropic-console-credits","ok":false,"status":400,"before":{},"upstream":{},"verdict":"no-reading","error":"default-egress: HTTP 400 carried no anthropic-ratelimit-unified-* header","httpRefusal":{"status":400,"bodyState":"parsed","requestId":"req_011CgNs2D8XNNqUp11AaNXsp","errorType":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}],"_meta":{"explicitFullRequest":true,"format":"json","_seeAlso":[{"tool":"accounts:status (the projection this tool corrects)"},{"tool":"accounts:reset-rate (clears the PAUSE meter; resetWindows is the manual unwall override)"},{"tool":"accounts:test-egress (the network-level probe — exit IP, not budget)"}]}}
