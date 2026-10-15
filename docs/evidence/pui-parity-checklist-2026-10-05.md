# pui parity checklist — stock Claude Code and Codex vs pui (2026-10-05)

Plan `pui-chat-first-ux-2026-09-28`, item P-022 (WI-10005485). Bar, from [owner 2026-10-02 #1276]:
"as user friendly as the claude and codex tui, that should be the bar". This checklist is the source
for the amended acceptance rubric and for P-025..P-032.

## How it was measured

One scripted PTY battery, `--battery parity`, run against each CLI in a 120x40 headless xterm:
`npx tsx packages/operator-core/lib/pui-e2e/p005-side-by-side.mts --battery parity --cli <claude|codex|pui> --out <dir>`.
Each probe writes screen frames (`<probe>.txt`, timed `.t150/.t1000/...` frames) plus one row in `summary.json`.
Frames and summaries (157 files, 704 KB, emails/home paths/account handles redacted) are kept outside the
shipped tree at `~/.papercusp/evidence/pui-parity-2026-10-05/{claude,codex,pui}/` on the dev box, with the
`digest.mjs` / `diffdigest.mjs` readers used to compare them (`node diffdigest.mjs '<probe regex>' <lines>`
prints, per CLI, the lines a probe's key frame adds over its baseline frame).

| CLI | Version | Route | Notes |
|---|---|---|---|
| Claude Code | 2.1.289, Opus 5.5 | gateway (`--claude-auth env`, "API Usage Billing") | The first leg on the box's OAuth login hit its weekly limit on every turn and is discarded. |
| Codex | codex-cli 0.160.1, GPT-6.1-Sol | shared login | Complete. |
| pui | 0.1.0, release build 5d50af48, operator :3170 | box default account (OAuth) | The engine hit the same weekly limit, so every model-backed probe (hi, stream, tool, edit, interrupt, resume recall) answered "You've hit your weekly limit". Those pui cells are **not measured** this run. pui has no way to pick another account at launch; see gap G-14. UI-only probes are valid. |

Stock-CLI caveat: both stock CLIs ran in their auto / full-access permission modes (Claude "auto mode on",
Codex default sandbox), so neither showed an approval prompt (`approvals: 0`). The approval row below is
therefore specified from P-028's text, not measured here; P-028 and P-032 must capture it under the
default permission mode.

Harness defect found and fixed during this run: before P-022 only Codex tasks were checked for an answer;
Claude and pui tasks always logged `taskCompleted: true`. pui's resume recall "passed" while its resume
picker was still loading, because the expected words were in an earlier user prompt.
`taskAnsweredAfterPrompt` (`packages/operator-core/lib/pui-e2e/p005-codex-readiness.ts`) now matches the
expected answer only after the echoed prompt, for every CLI; guarded in `p005-codex-readiness.test.ts`.

## Checklist

"Gap" names the plan item that owns closing it. **Bold** = pui is behind both stock CLIs.

| # | Behaviour | Claude Code | Codex | pui today | Gap → item |
|---|---|---|---|---|---|
| 1 | Startup to usable prompt | 805 ms | 502 ms | **2108 ms** ("Type a message below and press Enter.") | **G-1** 2.6x slower than Claude → P-031 |
| 2 | "hi": feedback right after Enter | Echo + spinner verb "✶ Perambulating…" by 150 ms; footer "esc to interrupt" | Nothing new on screen until 5010 ms | Echo by 150 ms; by 1 s "⠙ Starting Claude… (0s · Esc to interrupt)" and "Sending — Enter queues your next message" | pui ahead of Codex, level with Claude (P-024 done) |
| 3 | Working indicator (spinner, elapsed, tokens, Esc hint) | Spinner + Esc hint at once; elapsed + token count on longer turns | "• Working (1s • esc to interrupt)": elapsed + Esc, no tokens | Spinner + elapsed + Esc hint; no token count | G-2 no token count → P-029 |
| 4 | Answer and turn footer | "● Hi! …" then "✻ Worked for 2s · done 7:36 PM" | "• Hi! …" then "Worked for 5s • 7:30 PM" | "● …" then "✻ Worked for 3s" (frame shape confirmed; content was the limit error) | none in shape |
| 5 | Streaming text (count 1..40) | Chunky: 2 distinct counts seen (3, 40) | Smooth: 10 distinct counts seen | Not measured (engine limit) | P-025 owns streaming; re-measure in P-032 |
| 6 | Tool call and result | "Read 1 file (ctrl+o to expand)", then answer; 18 s | "• Explored └ List rg --files … Read calc.js + Show details"; 19 s | Not measured (engine limit) | P-025 (compact verb(target) row + one-line result) |
| 7 | Edit with diff | "● Update(calc.js) ⎿ Added 2 lines, removed 2 lines" + numbered diff; then ran a node check | "• Edited calc.js (+2 -2)" + diff + "Show details"; then ran a check | Not measured (engine limit; file unchanged) | P-025 / P-028 |
| 8 | Approval prompt | Not captured (auto mode) | Not captured (full access) | Not captured | Spec from P-028: one prompt, numbered choices 1 Yes / 2 Yes, don't ask again / 3 No, tell it what to do; diff shown once. Capture under default mode in P-028/P-032 |
| 9 | Interrupt (Esc mid-reply) | Stops within 2 s; "⎿ Interrupted · What should Claude do instead?" | Stops within 2 s; "■ Conversation interrupted - use /feedback if something went wrong" | Not measured mid-reply (the reply had already ended) | re-measure in P-032 |
| 10 | Esc with nothing running | Stays in the box (double Esc clears input) | Stays in the box | **Leaves the box into "Composer — i type · v speak · j/k scroll" / "press i to talk · v PTT · V realtime voice"** | **G-3** Esc must not leave the box → P-027 |
| 11 | Slash menu | "/" lists ~100 commands with one-line descriptions; "/mo" filters to /model, /mobile, … | "/" lists commands with descriptions; "/mo" filters to /model | 7 commands: /help /resume /expand /details /copy /detach /exit; **"/mo" → "no command matches /mo"** | **G-4** no /model, /status, /clear, /compact, /approvals → P-027 (+P-026, P-029) |
| 12 | Model switch | /model picker: Default (Opus 5.5) ✔, Opus, Fable, Sonnet, Haiku with prices; effort ←/→; "alt+p to switch model" | "Select Model and Effort": 7 models, current marked, then effort | **No /model** ("No command /model") | **G-5** → P-026 (/model picker, footer model, `pui --model`) |
| 13 | ? shortcuts overlay | Two-column key list (! shell, / commands, @ paths, \⏎ newline, shift+tab modes, alt+p model, ctrl+g editor…) | "Keyboard shortcuts" in Compose / Session / Transcript columns | Overlay with Enter, Shift+Enter, /, @, ↑↓, PgUp/PgDn, wheel, drag-copy, Esc, Ctrl+R/O/Z/C | Mostly level. G-6 no permission-mode key (shift+tab) → P-027 |
| 14 | History (Up) | Recalls earlier messages | Recalls earlier entries (/model) | Up 1 → last message, Up 2 → the one before | none |
| 15 | Multiline input | Ctrl+J and `\`+Enter insert a newline | Ctrl+J newline; `\`+Enter submits | Ctrl+J, `\`+Enter and Shift+Enter all insert a newline | none (pui ahead) |
| 16 | Paste (40 lines, 2110 chars) | Collapses to "[Pasted text #1 +39 lines]" | Collapses to "[Pasted Content 2110 chars]" | **All 40 lines expanded into the composer, filling the screen** | **G-7** collapse large pastes to a chip → P-027 |
| 17 | @ file mention | Not captured cleanly (composer still held "/model", so "@cal" was typed after it) | No picker on screen in the frame | "Attach a file · 2 matches" popup (calc.js, calc.test.js); popup draws over the transcript | pui works. Re-capture Claude/Codex in P-032 (harness: clear the composer before probe 21) |
| 18 | /status, context and cost | /status: Settings › Status panel (version, session, cwd, …); /context: context-usage breakdown | /status: model, "Context window: 99% left (16.2K used / 475K)", weekly limit, credits | **"No command /status"**; no context or cost anywhere | **G-8** → P-029 |
| 19 | Idle footer | "⏵⏵ auto mode on (shift+tab to cycle)" + "◐ medium · /effort" | "GPT-6.1-Sol default · <cwd> · <session title>" + "? for shortcuts" | "? for shortcuts  Claude · <cwd>": no model, mode or context left | **G-9** footer shows model, permission mode, context % → P-029 / P-026 |
| 20 | Unknown command | Transcript line "● Unknown command: /notacommand" | "• Unrecognized command '/notacommand'. Type "/" for a list…" | Warning toast "No command /notacommand. Type / to see the commands, or start the message with a space…", but the toast box **draws over the input border** | G-10 toast overlap is a render bug → P-027 |
| 21 | Ctrl+C with a draft | 1st clears the draft, 2nd asks again, 3rd exits | 1st clears the draft, 2nd exits | **1st Ctrl+C exits pui and loses the draft** ("Conversation ended. Open pui and use /resume…") | **G-11** clear the draft first, confirm before quitting → P-027 |
| 22 | Resume | `--resume` ready in 1.1 s; recalled the earlier edit correctly | `resume` ready in 0.5 s; recalled correctly (44 s turn) | **Picker stuck on "Loading earlier conversations… — not settable" for 30 s**; recall never asked | **G-12** resume picker never loads → P-031 (offer resume on start) / P-027 (/resume) |
| 23 | Errors: usage limit | "⎿ You've hit your weekly limit · resets 1pm" + footer "⚠ Usage limit reached … /usage-credits to continue now" | (not hit) | **The limit text is shown as a normal reply ("● You've hit your weekly limit…", "✻ Worked for 3s")**, with no next step | **G-13** errors look like answers and say nothing about what to do → P-031 |
| 24 | Choosing the account/route | Login or env route; /status shows the account | Login; /status shows limits/credits | **No way to choose the engine account at launch**; an OAuth limit leaves pui unusable | **G-14** `pui --account <auto|default|name>` plus account in /status → P-026 / P-031 |
| 25 | Zellij panes | n/a | n/a | Bare `pui` is chat-only; the workbench panes are gone | P-030 [owner #1277] |

## Gaps by plan item

- **P-025 live streaming / tool rows**: rows 5–7 (re-measure once pui can reach a working engine).
- **P-026 model switching**: G-5, G-9 (model in footer), G-14 (`--account` beside `--model`).
- **P-027 slash menu and keys**: G-3 (Esc), G-4 (missing commands), G-6 (permission-mode key), G-7 (paste chip), G-10 (toast overlap), G-11 (Ctrl+C), G-12 (/resume).
- **P-028 approvals**: row 8, capture stock frames under the default permission mode first.
- **P-029 status and context**: G-2 (tokens), G-8 (/status, context %, cost), G-9 (footer).
- **P-030 zellij panes**: row 25.
- **P-031 startup and errors**: G-1 (startup 2.1 s vs 0.8 s), G-12 (offer resume), G-13 (plain error with a next step), G-14.
- **P-032 head-to-head**: rerun this battery on all three CLIs, with pui on a working route, after the above, and grade every row.

## P-027 resolution (2026-10-06, WI-10006273)

Each P-027 gap, with the code that closes it (apps/tui/src unless noted). Verified by `cargo test --bin pui`
(1319 passed, 0 failed) and the operator-core su-session engine and host tests. The frames themselves are
re-captured in P-032.

| Gap / key | Now | Where |
|---|---|---|
| G-3 Esc with nothing running | Stays in the box; Esc twice clears the draft ("Esc again to clear") | app.rs `chat_first_esc` |
| G-4 missing commands | `/` menu with one-line descriptions: /help /resume /clear /model /effort /status /compact /approvals /expand /details /copy /detach /exit; "/mo" filters to /model | chat_commands.rs |
| G-6 permission-mode key | `/approvals` opens a three-row picker (ask, auto-edit, read-only; current marked). Shift+Tab cycles. The pick rides on the next message (plan D-026); /status names it. Claude uses setPermissionMode, Codex uses turn/start approvalPolicy + sandboxPolicy; OMP says it is not available. No full-access mode | app.rs `open_approvals_picker` / `cycle_approvals`; packages/operator-core/lib/su-session-*-engine.ts |
| G-7 large paste | Collapses to a one-line `[pasted N lines]` chip; the full text is sent | app.rs, paste_chips.rs |
| G-10 toast over the input border | In the quiet chat a toast sits inside the message box | ui.rs |
| G-11 Ctrl+C with a draft | 1st clears the draft, 2nd within the window exits ("Press Ctrl+C again to exit") | app.rs |
| G-12 /resume stuck loading | The list re-fetches; a failed fetch says why and how to retry | app.rs |
| Alt+P (Claude) | Opens the model picker | app.rs composing arm |
| `?` overlay | Lists Shift+Tab and Alt+P with the other keys | ui.rs `CHAT_SHORTCUTS` |
| `!` shell (Claude) | Ruled out: bare `pui` opens a work shell pane beside the chat (P-030, D-024); a leading `!` is sent to the engine as text | — |
| Ctrl+G external editor (Claude) | Ruled out: Codex has no such key, and the box already edits multi-line text with undo | — |
| Context left and cost in /status | Not P-027: G-8 belongs to P-029 | — |

## P-025 resolution (2026-10-06, WI-10006349)

Rows 5–7, measured per engine with `--battery parity --probes 10,11,12,13` against the staging operator
(:3170, sha 335341d37a for Codex, d182bf3e2f for OMP and Claude) and a pui debug build from this tree. Claude ran
with `--account auto`: the box's default Claude account had hit its weekly limit. Frames: `/tmp/pui-p025-codex2`,
`/tmp/pui-p025-omp2`, `/tmp/pui-p025-claude3` (not durable; P-032 re-captures them).
Unit tests: `cargo test --bin pui` 1332 passed, 0 failed; `su-session-claude-engine.test.ts` 67 passed.

| Gap / row | Now | Where |
|---|---|---|
| 5 Streaming text (count 1..40) | Claude: 2 jumps, the same two-block pattern as stock Claude (3, 40). Codex: 5 distinct counts (9, 18, 30, 37, 40); stock Codex showed 10. OMP: 4 (12, 28, 36, 40). Each engine streams as fast as it delivers text | app.rs SU-session delta arm |
| 6 Tool call and result | One compact row when the call starts and a one-line result when it ends, on every engine: `⚙ Read(calc.js) ✓` / `⎿ Read 9 lines (Ctrl+R to expand)`; Codex shell calls read `⚙ Bash(cat calc.js) ✓` / `⎿ function add(a, b) { … +6 lines`. "Worked for" closes the turn below its rows | tool_display.rs, ui.rs `tool_detail_lines` |
| 7 Edit with diff | `⚙ Update(calc.js) ✓` / `⎿ Updated calc.js` (OMP) or `⎿ Added 2 lines, removed 2 lines` (Claude) after one approval card; the file changed. Codex: its approval cards render, but in this run Codex never reached the edit (see the host note below); its file-change row is covered by `codex_and_omp_tool_calls_get_claude_style_rows` | tool_display.rs, change_card.rs |
| Thinking / reasoning | One dim `∴` line (newest heading while streaming); Ctrl+R expands it | ui.rs `reasoning_lines`, app.rs `push_chat_reasoning` |
| Failed turn | A refused turn leaves one line under its prompt with the provider's sentence (`⎿ API Error 400: <reason>`, `⎿ You've hit your weekly limit · resets 1pm`), instead of nothing, and not three times | models.rs `turn_error_text`, `ChatMessage::push_turn_error`, ui.rs |
| Failed tool | `✗` on the row and the output on its `⎿` line; the fixed "SU-session tool failed" line under every failure is gone | app.rs, ui.rs |

Defects found while measuring, all fixed with tests:

- OMP ended the turn at every tool call: it marks a tool-calling message with stop reason `toolUse`, which the
  operator read as a turn end, so pui printed "Worked for" mid-turn and could send a queued draft into a running
  turn (packages/operator-core/lib/su-session-omp-adapter.ts, commit 335341d37).
- OMP edit rows had no file name (the file is named only inside the patch); they read `Update(calc.js)` now.
- Claude's "waiting for you" while an approval card is open ended the turn in pui; it is a pause now.
- A refused Claude turn showed three times: the SDK's synthetic assistant text, the adapter's error and the
  engine's error in its diagnostic wording. The engine is now the one reporter (`resultErrorSource:
  'transport'`), pui shows the sentence after the diagnostic prefix, and an assistant line that only repeats
  the error is replaced by it.
- The battery logged a step stuck on a setup or connection screen, or answered by an account limit, as a
  normal duration; it now aborts with `BATTERY_BLOCKED`.

Host notes (not pui defects):

- The operator service spawned Codex by bare name and its PATH found a stale `~/.local/bin/codex` (0.157.1),
  which the server refuses the default model for: every Codex turn failed with a 400 that pui showed as nothing.
  Mitigated on this host; the durable fix is WI-10006412.
- `~/.codex/AGENTS.md` on this host carries the papercusp-su playbook, so Codex in the scratch project tried to
  take a file lock over the network before editing and the sandbox kept asking to escalate (13-edit timed out).
- Found on the full Codex leg, outside P-025: a relaunched `pui --solo` exited after "Starting PUI…", and the
  picked backend is not carried into the next launch (WI-10006423, blocks P-032).

## P-028 resolution (2026-10-06, WI-10006466)

Row 8. The stock prompts were captured first, under each CLI's default permission mode (driver flag
`--stock-args`; frames in `~/.papercusp/evidence/pui-parity-2026-10-05/p028-stock/`): Claude Code 2.1.289
asks "Do you want to make this edit to calc.js?" with `❯ 1. Yes` / `2. Yes, and switch to accept edits …
(shift+tab)` / `3. No`; Codex 0.160.1 asks "Would you like to run the following command?" with `1. Yes,
proceed` / `2. Yes, and don't ask again for commands that start with …` / `3. No, and tell Codex what to do
differently (esc)`. The contract pui now follows is plan decision D-028. Measured with `--battery parity
--probes 13-edit-approval` against the staging operator (:3170) and a pui debug build from this tree. Frames:
`/tmp/pui-p028k-claude`, `/tmp/pui-p028j-codex`, `/tmp/pui-p028d-omp` (not durable; P-032 re-captures them).
Unit tests: `cargo test --bin pui` 1337 passed, 0 failed.

| Gap / key | Now | Where |
|---|---|---|
| One prompt, numbered choices | Every engine shows the same card: a full-width rule, the tool (`Update(calc.js)`, `Bash(…)`), the change once between dashed rules, the question, `❯ 1. Yes` / `2. Yes, and don't ask again for <this> this session (shift+tab)` / `3. No, and tell <Claude\|Codex\|OMP> what to do instead (esc)`, footer `Enter to select · ↑↓ to move · Esc to cancel` | su-session-native-cards.ts (`approval` field, option ids `yes` / `always` / `no`); ui.rs `approval_card_lines`, `draw_card` |
| The diff appears once | While the card is open the transcript row reads `⚙ Update(calc.js) ◆ waiting for your answer`; the change is only in the card | ui.rs, app.rs |
| Keys | 1 / 2 / 3 answer at once; ↑↓ + Enter; Esc = No; Shift+Tab = option 2; Ctrl+R raw arguments | app.rs card keys |
| Option 2 per engine | Claude: its allow-rule or accept-edits suggestion, scoped to the session; Codex: `acceptForSession`; OMP: remembered by pui for this run (edit tools by name, commands by exact text) | engine adapters (D-028 §3) |
| Option 3 | Rejects and stops the turn; the composer opens with "Tell <engine> what to do instead" | engine adapters, app.rs |
| Claude leg | One card, answered with 1; calc.js changed; turn finished in 33 s | `/tmp/pui-p028k-claude` |
| Codex leg | In ask mode (`--pui-approvals-ask`, i.e. `/approvals` → ask) five command cards rendered and were answered; a long Python command is cut to ` … +8 lines (Ctrl+R to expand)` with all three answers on screen | `/tmp/pui-p028j-codex` |
| OMP leg | One card, answered; the file changed | `/tmp/pui-p028d-omp` |

Defects found while measuring, all fixed with tests:

- A long command filled the card strip, so the answers were never on screen and nothing could answer it. The
  change is now cut to the strip's height with a ` … +N lines (Ctrl+R to expand)` row
  (`approval_card_keeps_answers_visible_under_a_long_command`).
- Each blank line in a command pushed one row (the footer, then the last answer) off the bottom of the card.
  ratatui 0.29 draws a whitespace-only line as two rows under `Wrap { trim: false }`, and the card's height
  counts one row per line. Blank lines are now empty, the approval card is drawn without re-wrapping (its lines
  are already wrapped to the strip), and other cards' whitespace-only lines are emptied the same way
  (`approval_card_keeps_its_footer_under_a_multi_line_title`, 4 sizes, docked and chat-first).
- A command's indentation was dropped; code lines keep it now, as a hanging indent when they wrap.
- An answer longer than the strip wrapped six columns past its edge; it wraps under its own text now.
- pui showed "Claude produced no stream frame for 114s" while a card was simply waiting; the stall timer pauses
  while a card is open.
- The hint under a card said "Esc skip"; on an approval card Esc is No, and the hint says so.
- A chat-first start whose operator answered once and then stopped answering (a restart) dropped into
  install setup; it now keeps "Starting <engine>…" and re-checks every 2 s, then says the operator "stopped
  answering; it may be restarting" (`chat_first_quick_start_rechecks_an_operator_that_stopped_answering`).

Host notes (not pui defects):

- Codex on this host reads the papercusp-su playbook from `~/.codex/AGENTS.md`, so in the scratch project it
  spent its turns on lock commands and rarely reached the edit itself (`fileChanged=false` on the Codex leg).
- Open, found here: a second back-to-back launch in a fresh project dir was refused "The conversation is
  already bound to a different engine or project" (WI-10006533, to fix before the P-032 battery);
  one run's `m` key opened no Model picker within 25 s and did not reproduce (WI-10006528).

## P-029 resolution (2026-10-06, WI-10006565)

- **G-2, G-8, G-9**: each engine's own usage and todo data now reach pui (D-029; wire shape amended by D-031).
  The Claude, Codex and OMP adapters feed context tokens, context window and cost or usage into the session
  descriptor (`host.updateUsage`), and the todo/plan list (`host.updatePlan`). pui no longer fails on an
  event type it does not know.
- The footer reads `model · approvals mode · directory`, then context left (%) and session cost or usage, and
  warns near the context limit. `/status` repeats all of it. The todo list is a checklist above the message box.
- Verified: agent-chat-pty `P-029` and `P-026` cases on the real binary, operator and PG (testing:run
  01a696ae, pass 11:17Z); `cargo test --bin pui` green.

## P-031 resolution (2026-10-06, WI-10006609)

- **G-1 startup**. Cause: `crossterm::supports_keyboard_enhancement()` waits up to 2 s for a terminal reply.
  This checklist's driver never passed the terminal's replies back, so every pui start waited the full 2 s.
  pui now enables the keyboard flags without asking; terminals without the protocol ignore the request
  (main.rs). The driver (`p005-side-by-side.mts`) now answers like a real terminal; `--silent-terminal`
  keeps the old behaviour.

  | Run | Time to a usable prompt |
  |---|---|
  | pui before the fix, silent terminal | 2,111 ms |
  | pui after the fix, silent terminal | 103 ms |
  | pui after the fix, answering terminal | 102 ms |
  | Stock Claude Code, silent terminal | 2,017 ms |
  | Stock Claude Code, answering terminal | 7,624 ms |

  The two pui builds differed only in that one probe. The Claude Code numbers are single samples on the busy
  box; the 805 ms in row 1 did not reproduce. pui is no longer slower than Claude Code in either mode. Evidence:
  `/tmp/p031-silent-{pui-ab,pui}/summary.json`, `/tmp/p031-start-answer`, `/tmp/p031-claude-*/summary.json`.
- **G-13 errors with a next step** (`App::chat_failure_sentence`), one sentence each:
  - Missing engine login: "Claude is not signed in; in a terminal on the computer running Papercusp, run
    claude and type /login, then …" (Codex: `run codex login`; OMP: `run omp and type /login`). Before, it
    said only "sign in to Claude".
  - Operator unreachable: "PUI cannot reach Papercusp; start Papercusp Server, then …". Before, it said "PUI
    lost its connection to Claude", which pointed at the engine.
  - Operator hung: "Papercusp is not answering; start or restart Papercusp Server, then …". Superseded
    2026-10-06 by WI-10006644: a connected but silent operator is usually busy, not down (the P-032
    instance had NRestarts=0 and a 10 s event-loop stall), so pui now shows "Papercusp is busy; still
    trying to send your message" and retries for 20 s before "Papercusp is busy and did not answer; your
    message is kept, …". Only a refused connection gets the start-Papercusp advice.
  - Dead session: "Claude stopped; press Enter to send your message again." This was already accurate: the
    next message reopens the conversation. The raw text kept behind details no longer says "start a new
    session".
  - Usage limit (row 23): P-025 already shows it as one failure line, not a reply. It still gives no next step,
    because switching accounts mid-conversation has no route yet (WI-10006626).
- **G-12 offer resume**: when this directory has an earlier conversation, an empty chat reads "Type a message
  below and press Enter. /resume continues an earlier conversation." It reads the same list `/resume` shows,
  and only once that list has loaded. Starting `pui` in a directory with a live or resumable conversation still
  opens it directly (D-008).
- **G-14**: closed by P-026 (`pui --account`, and the account in `/status`, D-023).
- Tests: `chat_first_missing_login_says_how_to_sign_in`,
  `chat_first_refused_launch_shows_the_operators_reason` (unreachable),
  `chat_first_slow_send_failures_say_what_was_slow` (hung),
  `chat_first_offers_resume_only_when_this_directory_has_an_earlier_conversation`, and
  `chat_first_startup_progress_is_plain_words` (the offer on screen). The agent-chat-pty hung-operator case
  checks the new sentence.

## P-032 head-to-head (2026-10-06, WI-10006633)

The same parity battery, one CLI after another so startup times share the box's load, 11:56-12:24Z,
120x40 headless PTY. Legs: stock Claude Code 2.1.289 (`--permission-mode default`, paid through the
inference gateway because the box login was at its weekly limit), stock Codex 0.160.1
(`-s read-only -a on-request`, isolated CODEX_HOME), and the installed pui 0.1.0 (bd4f522988, equal to
the tree at install) on its Claude engine (`--account auto`) and its Codex engine, both switched to
approvals `ask`, against the staging operator :3170. The first pui-claude run is not used for the edit
row: its edit send hit a measured :3170 main-loop stall (12:04:33-39Z, filed as WI-10006644). That leg
was rerun at 12:17Z. Two pui-codex oddities were repeated with `--probes` (10,12,21,26 and 20,21).
Frames, summaries and the runner script: `~/.papercusp/evidence/pui-p032-2026-10-06/` (secret-scanned,
with a positive control).

| # | Behaviour | Claude Code | Codex | pui: Claude engine / Codex engine | Grade |
|---|---|---|---|---|---|
| 1 | Startup to usable prompt | 1.8 s | 0.5 s | 0.1 s / 0.1 s | Ahead (G-1 closed) |
| 2 | "hi": feedback, answer | Answer in 6.0 s | First change 44.8 s, answer 57 s | Echo and spinner by 150 ms; answer 9.8 s / 12.3-13.0 s. One Claude run sat 37 s on "Starting Claude…" (launch bootstrap 15.0 s at 12:03Z) | Level |
| 3 | Working indicator | Spinner, elapsed, Esc hint; no tokens | Same | Spinner, elapsed, tokens, Esc hint on both engines | Ahead (G-2 closed) |
| 4 | Answer and turn footer | "● …" then "✻ Worked for Ns" | "• …" | "● …" then "✻ Worked for Ns" | Level |
| 5 | Streaming text | 2 distinct counts | 7 | 2 / 6 | Level with each engine |
| 6 | Tool call and result | 11.5 s | 12.0 s | 13.5 s / 16.0-18.5 s; one compact row and a one-line result | Level |
| 7 | Edit with diff | 19.8 s, 1 approval, file changed | 22.8 s, 1 approval, file changed | Claude: 12.3 s, 1 approval, file changed. Codex: 8 approvals over 132 s, file unchanged, because the engine obeyed this box's AGENTS.md rule to claim a Papercusp file lock first and the lock was refused (not a git repo). The stock Codex leg had an isolated CODEX_HOME, so this is box config, not pui | Level on Claude; Codex not comparable on this box |
| 8 | Approval prompt | 1 Yes / 2 Yes, and accept edits / 3 No | Codex's own approval card | 1 Yes / 2 Yes, don't ask again / 3 No on both engines (D-028) | Level |
| 9 | Interrupt (Esc mid-reply) | Stops in 2.0 s, "Interrupted · What should Claude do instead?" | 2.0 s, "Conversation interrupted" | 2.0 s on both. The Claude engine also printed a raw `[ede_diagnostic] … Last child stderr` line | Level. Post-fix (13:34Z, :3170 728748a085): no stray line in any interrupt, Ctrl+C or scrollback frame (WI-10006646 done) |
| 10 | Esc with nothing running | Stays in the box | Stays | Stays in the box | Level (G-3 closed) |
| 11 | Slash menu | ~100 commands | Codex's list | 15 commands incl. /model /effort /backend /status /compact /approvals /clear; "/mo" filters to /model | Level (G-4 closed) |
| 12 | Model switch | Picker of models with prices | Model and effort picker | /model and /effort exist, but the picker lists the server's routing tiers (all claude-opus-5:xhigh) with internal "[owner 2026-09-03] …" notes as descriptions; on Codex it offers only Claude tiers marked not settable | Level after WI-10006652 (13:34-13:42Z): in a conversation /model lists the engine's own models (Claude: Default, Opus, Fable, Sonnet); before the first message it offers only tiers for that engine, with no "[owner" notes |
| 13 | ? shortcuts overlay | Two-column key list | Key list | Overlay with keys and commands | Level |
| 14 | History (Up) | Recalls earlier messages | Recalls | Up 1 / Up 2 recall in order | Level |
| 15 | Multiline input | Ctrl+J and `\`+Enter | Ctrl+J; `\`+Enter submits | Ctrl+J and `\`+Enter on both engines | Level |
| 16 | Paste (40 lines) | Chip | Chip | "[Pasted text #1 +39 lines]" | Level (G-7 closed) |
| 17 | @ file mention | "@cal" lists calc.js and calc.test.js under the prompt at once | Not captured (no list in the frame) | "Attach a file · 2 matches" popup on both engines. Right after a cleared paste the popup is open but not drawn until the next key (reproduced) | Level after WI-10006651 (13:28Z): the popup draws at once after a cleared paste on both engines |
| 18 | /status, context and cost | Settings › Status panel | /status panel | Claude: model, account, engine, approvals, context 19077/1000000, cost. Codex: the same without context | Level after WI-10006653 (14:02Z, real Codex, installed pui b2f07aeeaa): a live conversation's /status shows "context N/M (N% left)" with no resume; e2e `a live reply reports context left…` passes |
| 19 | Idle footer | "⏸ manual mode on · ? for shortcuts" | Model · cwd · task | Claude: model · approvals · cwd · context % · cost. Codex: no context % until after a resume (reproduced) | Ahead on both after WI-10006653 (14:02Z): the Codex footer reads "gpt-6.1-sol · auto-edit · <dir> · 98% context left" after the first live reply |
| 20 | Unknown command | Transcript line | Transcript line | Transcript line "No command /notacommand…" and "no command matches" in the popup | Level (G-10 closed) |
| 21 | Ctrl+C with a draft | 1st clears, 3rd exits | 1st clears, 2nd exits | 1st clears ("Press Ctrl+C again to exit"), 2nd exits | Level with Codex (G-11 closed) |
| 22 | Resume | `--continue` ready 1.9 s, recall correct | `resume --last` 0.5 s, recall correct | Claude: ready 0.1 s, /resume picker, recall correct. Codex: once the picker said "No earlier conversations" for a conversation that existed, so recall was never sent; the repeat listed it at once and recall was correct | Level on Claude; Codex glitch unconfirmed → WI-10006654 |
| 23 | Errors: usage limit | - | - | Not exercised (no account was walled); P-031 covered the wording; the line still offers no next step | Level after WI-10006626 (14:15Z): chat-first adds "Wait for the reset, or type /backend to continue on another engine in a new conversation." under the failure line (stock Claude Code: /usage-credits). Rendered-frame test only; no account was walled to capture it live |
| 24 | Choosing the account/route | Login or env | Login | `pui --account auto`; /status names the account | Level (G-14 closed) |
| 25 | Zellij panes | n/a | n/a | Not exercised by this battery | P-030 |

Also seen: when the operator is stalled rather than down, a send that waits more than 5 s tells the user
to start or restart Papercusp Server and drops the turn (WI-10006644). Fixed 13:32Z: pui shows "Papercusp is
busy; still trying to send your message", retries for 20 s and keeps the draft (P-024 e2e passes).

Verdict: 22 rows level or ahead on the Claude engine (9 and 17 with a filed fix); 1 behind (12, model picker); 1 open (23);
1 not in scope here (25). On the Codex engine rows 7, 18, 19 and 22 are not yet level (7 is box config).
Before re-asking Avi for R-05 (P-006): ship WI-10006646 live and fix WI-10006652, WI-10006651 and
WI-10006653 [self-imposed under AUTO, owner:Avi #1356], since the model picker was one of the reasons
for the 2026-10-02 rejection.

Post-fix verdict (2026-10-06 14:05Z, installed pui b2f07aeeaa built from the tree, :3170 728748a085): all
four fixes are done and verified on real engines (rows 9, 12, 17 above; 18 and 19 by the real-Codex e2e
`a live reply reports context left in the footer and /status without a resume`). Claude engine: 24 rows
level or ahead (23 by WI-10006626 at 14:15Z, frame test), 1 not in scope (25, P-030).
Codex engine: 18 and 19 now level; still not level are 7 (box config, not pui) and 22 (one unconfirmed
resume-picker glitch, WI-10006654). R-05 itself is Avi's verdict; it is not graded here.

## Where pui is already level or ahead

Instant echo and working line after Enter (P-024), history recall, multiline input (three ways), the @ file
picker, a shortcuts overlay, and mouse drag-copy.

## Recorded R-05 owner sign-off (read back 2026-10-09)

The authoritative record is `pui-chat-first-ux-2026-09-28#D-037` (plan revision 130,
content hash `57c5b9af67e6414aae8512d2393b8aa4cce83f6cc722edfc906c765b362aa567`).
It records Avi's 2026-10-07 interactive AskUserQuestion answer in session
`su-caaa53ba-fb38-44e0-a1b4-996a55267afc`: **“Good enough, ship it”**.
The approved installed build was `33287a0d19`, with binary SHA-256
`6531c790a8d483c61d65a1b2abdcfc223c11582f1538281bee3e533ba9b3c82a`.

This is the historical human sign-off for `AUTO-BAR-R-05-P-006@7`. It supersedes
the rejection in D-018. It does not attest a later binary's test result or release
compatibility. Current P-005 execution, stock five-task comparison, clause proofs,
independent grading and shipment verification remain separate evidence obligations.
