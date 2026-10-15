# Visual desktops — concept study

Owner: Avi. Design owner: su-f48fd476-39f2-4e33-b9d0-23c18c9c00e2. Work: WI-2001281 / unified-web-portal-2026-08-29 P-031.

Open index.html for the interactive, self-contained concept review. All desktops, users, previews and activity are illustrative. It makes no network requests, provisions nothing, and controls no live desktop.

- A / Gallery: a first-class Desktops destination with preview cards, state and separate Watch / Take control actions.
- B / Workspace: a large selected desktop with a compact roster and activity beside it. Recommended for everyday use; the gallery can serve as its entry page.
- C / Dock: keep a desktop visible alongside the task being discussed. Fullscreen opens the focused layout.

Use the top concept buttons to switch. Watch and Take control open a simulated viewer; taking control shows a confirmation if an agent is active. Escape and Release control return to watching. The state selector demonstrates connection loss, setup and empty states. Preview controls are illustrative, not promises of implemented behavior.

Theme: existing portal-dark semantic colors from apps/operator/app/_semantic.portal-dark.css. Intended production reuse: HostedDesktopViewer, OperateStage DesktopSurface, AdvFramesTab, app/harness Button, Tooltip, Popover and HostCheckBanner. Registry searched before design. ui-ir.json passed design-phase.validate_spec; lint has no errors and three orphan warnings for components referenced only from state roots. Mockups are advisory design artifacts, not a ratified visual reference or shipped feature.

No production code was changed. The next design decision is which layout to adopt; live desktop acceptance remains dependent on the BYOC canary.
