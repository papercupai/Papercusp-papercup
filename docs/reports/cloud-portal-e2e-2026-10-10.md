# Cloud portal E2E test report — 2026-10-10

Avi, this pass does **not** support a clean end-to-end verdict. Real hosted tutorial narration, Lesson Help and account/Billing guide acceptance failed. Most component and database checks passed, but several test fixtures and source guards also failed.

Work item: WI-10008219. You approved direct execution in this session. This is a testing assessment, not a shipment or complete production certification.

## Scope and identity

The actual checkout is the managed `portal` app in workspace `papercusp-workspace`. The maintained browser and unit runs recorded Portal source `30e9489887f8f8a9f7b9898be4989283fa63a464`; the browser checkout was dirty. Source continued changing during the pass. Final source hashes are retained, so this report does not claim the latest shared tree is green.

Both public `https://app.papercusp.com` and loopback `:3081` served build `Gv90RmF90lrmLL5Q9kyMn`, published at 2026-10-10T05:56:46.504Z. Real hosted checks used genuine WorkOS TEST accounts and the existing admission path. They did not exercise the upstream AuthKit signup/MFA UI.

## Measured results

| Execution | Result | Durable evidence |
| --- | --- | --- |
| Full Portal Chromium profile | 187 collected: 149 passed, 3 failed, 21 opt-in skipped, 14 did not run after Billing setup failed | 21008869–21008883 |
| Focused unchanged Billing browser suite | 15 passed; recovered the blocked Billing cases | 21009099 |
| Focused Settings browser diagnosis | Both cases failed; traces identify a missing fixture import | settings-diag-results; original 21008876 |
| Full Portal unit suite | 152 files: 146 passed, 6 failed; 1,789 tests passed, 12 failed, 1 skipped | 21008912–21009063 |
| Portal database integration suite | 4 files, 18 passed, zero failures/skips | 21008889–21008892 |
| Admission, session vault, billing store and tutorial boundary checks | 4 files, 31 passed, zero failures/skips | 21009145/146/147/150 |
| Assembled two-tenant and billing-receipt integration | 10 passed, 1 failed; receipt isolation passed, session-revocation notification failed | 21009233/234 |
| Real public Docs browser journeys | Navigation/reload, Pagefind search, mobile/keyboard: 3 passed; HTTP boundary sweep timed out | 21008901; repeated failure 21009110 |
| Same Docs HTTP boundary suite on served loopback | 1 passed in 2.0 seconds | 21009220 |
| Real hosted narration | 1 failed: HTTP 400 | 21008886 |
| Real hosted Help, Billing guide and account guide | 3 failed | 21009115 |

Repeated runs are not additional unique coverage. The recorder stores the 14 Billing cases that did not run as skipped; the browser's separate “did not run” count is preserved above. Passing fixtures do not establish real hosted provider behavior.

## Findings and accountable follow-up

All 13 findings below are assigned to this session. No product fix or successful re-verification is claimed.

| Item | Observed failure and interpretation |
| --- | --- |
| WI-10008224 | Authenticated **Speak lesson** returned HTTP 400. Guide rendering and progress reads succeeded first. Request/provider validation cause remains unconfirmed. |
| WI-10008235 | **Ask AI Help** produced no matching response within the maintained 10-second deadline. Backend/provider cause remains unconfirmed. |
| WI-10008236 | New-account guide navigation left two writes pending for 15 seconds. Logs include workspace-selection POST 404 and repeated desktop-telemetry GET 403. |
| WI-10008234 | Served Billing controls and guide Help/resume were reached, but the final assertion that every recorded write was tutorial-progress POST 200 failed. Exact mismatching write was not retained by this case. |
| WI-10008241 | The private two-tenant revocation case attempted sync notification through the protected live PostgreSQL pool. The integration safety guard blocked access. Pool-binding cause needs repair; this is not evidence of an actual tenant-data leak. |
| WI-10008223 | Settings fixtures render blank because their extracted `PortalSettingsAdditions` omits `useOperatorWorkspaceLocation`. Both traces report that exact ReferenceError. Production imports the hook. |
| WI-10008226 | Reporter discovery succeeds and lists nine cases; a stale assertion expects six. The recorder itself works. |
| WI-10008222 | Full-run Billing esbuild setup exceeded 30 seconds. The unchanged focused suite passed all 15 cases; the setup failure's cause is unresolved. |
| WI-10008225 | Public Docs HTTP sweep timed out twice at `/docs/plugins`; the identical loopback suite passed. Separate Node fetch returned public 200 in 384ms. Public request-path cause remains unconfirmed. |
| WI-10008227 | Thirteen mounted-surface URL keys lack ownership registration, including HUD, tutorial, usage and integration-source keys. |
| WI-10008229 | Two voice-turn refusal codes use generic error text: invalid input and overlong turn. |
| WI-10008228 | Eager-import guard measured 29 modules against 28, and 664,171 bytes against 643,414. This is a source-budget failure, not a measured latency claim. |
| WI-10008230 | Disabled chat-history styling and five static rail guards failed. Mounted rail/layout browser checks passed; stale parser versus product defect remains unresolved. |

A guarded Portal build holds the source files needed for the small fixture repairs. The lock refusal was respected; no application or test source was edited. Adjacent cloud/tutorial owners received the evidence.

## Coverage limits

The executed profiles cover chat search/reopen/continuation, rail navigation and persistence, workspace form validation, roster message/wake/stop refusal and retry, stale searches, tutorial reload/recovery, narrow layouts and theme/contrast checks. Database suites cover persistence, admission, session storage, billing, tenant boundaries and relay policies with simulated providers.

**Still unverified:** real authenticated workspace switching and task/file/PTY/desktop journeys; all enabled app workflows; real voice/reconnect and upstream signup/MFA; additional browser engines; Stripe TEST checkout/webhooks; actual GCP/AWS lifecycle; and final promotion/shipment. Twenty-one opt-in browser cases were skipped. These gaps are owned by WI-10008242 and reuse the existing cloud campaign WI-10007600. Real provisioning, purchases and external communications were outside the approved pass.

## Cleanup and retained evidence

Independent database and WorkOS TEST reads verified all four accounts from the exact run windows: every session was revoked and each provider account was absent. No cloud resources or purchases were created. Every launched command and the detached recovery reached a terminal result; queued redundant wrappers were cancelled before admission.

Evidence directory: `/mnt/backup/portal-e2e-20261010-wi10008219`. It contains original logs, failure screenshots, Settings traces, full test-ledger exports, source hashes, two-tenant recovery output, and database/provider cleanup receipts.

The two-tenant router initially failed before collection, then hit its foreground cap and created a detached recovery. That recovery was read to its actual terminal verdict. No infrastructure refusal was counted as a product test result. A mistaken cleanup-bypass filing, WI-10008238, was immediately retracted and dropped after the exact source read falsified it; independent cleanup checks confirm absence.

The passing results are useful regression evidence. The hosted failures and explicit gaps prevent a blanket pass.

