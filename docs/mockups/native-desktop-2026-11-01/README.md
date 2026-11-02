# Papercup Workbench — OS sidebars

Workbench is now the selected, revised direction. It represents a resident desktop integration: direct global shortcuts summon OS sidebars and overlays without first opening a foreground app. Six interfaces are covered: Quick Access, terminal HUD panels, window organization, Papercup chat, accounts, and Goals with Work on everything. Open `index.html` directly; it has no external dependencies and performs no network requests.

- **A · Focus:** compact floating windows, full terminal side panels when useful, and a small account popover.
- **B · Workbench (current):** edge-anchored OS sidebars, an OS workspace overview, attached terminal context, direct shortcuts, Escape dismissal, and optional pinning. There is no app dock or panel minimize/maximize chrome. Only the ordinary terminal remains an application window.
- **C · Orbit:** edge controls, drawers, and a docked Papercup conversation beside the terminal.

Use the direction buttons or keys 1–3, the five interface tabs, and the Ubuntu/macOS/Windows chrome selector. Search, agent selection, plan/report previews, layout selection, panel collapse, and account Default/Force/Exclude controls work as simulations. Every action is a preview; nothing is sent to an agent or account service.

Focus and Orbit remain earlier comparison studies; Workbench is the current iteration and opens by default. Suggested shortcuts are Ctrl+Alt+Space (Quick Access), Ctrl+Alt+G (Goals), Ctrl+Alt+P (Papercup), Ctrl+Alt+A (Accounts), Ctrl+Alt+W (window organization), and Ctrl+Alt+H (terminal HUD). In the mockup these work only while the browser has focus. Repeat the shortcut to toggle; Escape dismisses; unpinned sidebars dismiss on outside click. The chat draft is retained when the sidebar is dismissed and summoned again.

The production requirement is availability from desktop login, with no separate Dock/taskbar/Alt-Tab entries for panels. This is specified by plan decision `quick-access-search-launcher-2026-10-26#D-009`. This mockup does not install a startup helper or register actual OS shortcuts.

The Workbench lifecycle is also captured in `b-dismissed.png` (panels dismissed, integration still available) and `b-chat-pinned.png` (chat pinned beside the existing terminal). Pin state is independent for each sidebar. Ordinary terminal windows remain application windows; the sidebars do not acquire app launchers or minimize/maximize controls.

Goals are integrated through the existing goal model, not another scheduler or lifecycle. `b-goals.png` shows a regular goal; `b-work-on-everything.png` shows the standing goal's selected plans, priority worklist, attention, outcomes, spend cap and evidence access; `b-goal-search.png` shows goal discovery from Quick Access. Terminal Orders and Papercup carry goal context. Accounts distinguish the goal spend/cap from environment account steering. Window organization supports grouping by goal, plan or fleet within each desktop. Goal actions are preview-only and never optimistically change the displayed running state. Plan decision D-010 governs this addition.

Remote connections reuse psu's saved profile and connection mechanism. Sources checked: `apps/operator/scripts/psu-connection-front-controller.mjs`, `apps/tui/src/remote_connect.rs`, and `packages/operator-ui/src/accounts/AccountsTab.tsx`. Sample identities, counts, usage, and reset times are illustrative.

The HTML represents native interface designs; it is not the proposed production renderer. The native implementation would use GNOME/GTK, AppKit/SwiftUI, and WinUI/WPF while retaining existing backend contracts.

`native-desktop.ir.json` records the interaction and component vocabulary. The current registry contains React primitives, so native presentation is represented as an explicit custom surface while preserving registered controls and existing product semantics.

`render.mjs` exports the fifteen interface screenshots, three direction boards, and three platform-chrome samples. Run from the repository root:

```sh
node docs/mockups/native-desktop-2026-11-01/render.mjs
```

The renderer records browser errors, unexpected network requests, overview-card integrity, and window bounds in `verification.json`. These checks validate the mockup, not production native behavior.

## Comparison sheets

- [Quick Access](compare-launcher.png)
- [Terminal HUD](compare-terminal.png)
- [Window organizer](compare-organizer.png)
- [Papercup chat](compare-chat.png)
- [Accounts](compare-accounts.png)

Each sheet places A, B, and C side by side. Full-size views use `<direction>-<surface>.png`, for example `b-accounts.png`. The `<direction>-overview.png` files show all five interfaces in one direction.

During delivery, the gallery was also exercised in Playwright for remote search and saved-psu-connection focus previews, independent Default/Force/Exclude axes, clearing overrides while preserving Default, Orbit panel collapse, simulated chat submission, overview keyboard navigation, and a narrow viewport. This is preview verification only; it does not establish any production native behavior.
