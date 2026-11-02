//! Read-only transcript view of the autonomous Queen / Overwatch
//! (queen-overwatch-live-visibility-2026-06-16, D-003).
//!
//! The dock's old `♛ queen` (`psu --brain`) and `👁 overwatch`
//! (`psu --role=overwatch`) panes were INTERACTIVE sessions: a single Claude
//! session can't be attached in two places at once, so a second desktop
//! instance / a relaunch could not resume the live one — it spawned its OWN
//! parked per-window shell. Result: the owner never saw the SAME queen/overwatch
//! across instances, and a pane blanked when its shell exited ("she disappeared").
//!
//! This pane instead TAILS the one autonomous session's transcript file
//! read-only (the shared backend file, resolved from the live roster) — so every
//! instance renders the SAME live agent, identically, and it survives shell exit.
//! It never attaches to or drives the session; "take control" (interactive
//! `psu --brain`) is a separate action (TODO: bind a key on the dock).

use crate::client::OperatorClient;
use crate::models::ChatMessage;
use crate::models::RosterEntry;
use crate::theme::Theme;
use crate::transcript::{locate_session_transcript, tail_transcript};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
    Frame, Terminal,
};
use std::io::stdout;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{self, Instant};

const MAX_MESSAGES: usize = 240;
const TAIL_INTERVAL: Duration = Duration::from_millis(1500);
const REPAIR_INTERVAL: Duration = Duration::from_secs(60);
const RETRY_INTERVAL: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(5);
type LocateTranscript = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// Which autonomous agent this pane follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Queen,
    Overwatch,
}

impl Scope {
    /// Parse the pane arg (`--queen` | `--overwatch`); defaults to Queen.
    pub fn from_arg(arg: Option<&str>) -> Self {
        match arg {
            Some("--overwatch") => Scope::Overwatch,
            _ => Scope::Queen,
        }
    }

    /// The Hive-lexicon term key for this scope's role (Queen→`brain`→"Mug",
    /// Overwatch→`overwatch`→"Kettle"). The header renders the RESOLVED label via
    /// `Lexicon::lex` — never a hardcoded brand word (pui-hive-lexicon-2026-06-06).
    fn lexicon_term(&self) -> &'static str {
        match self {
            Scope::Queen => "brain",
            Scope::Overwatch => "overwatch",
        }
    }

    fn kind(&self) -> crate::agent_pane_kind::AgentPaneKind {
        match self {
            Scope::Queen => crate::agent_pane_kind::AgentPaneKind::Queen,
            Scope::Overwatch => crate::agent_pane_kind::AgentPaneKind::Overwatch,
        }
    }

    /// Roster `role` values that identify this scope's autonomous session.
    /// (adv-roster falls back to the presence `agentRole`, so an invoke-route
    /// launch with no adv row still carries its role here.)
    fn matches_role(&self, role: &str) -> bool {
        let r = role.to_ascii_lowercase();
        match self {
            Scope::Queen => r == "mug" || r == "queen" || r == "brain",
            Scope::Overwatch => r == "kettle" || r == "overwatch",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AttachState {
    Connecting,
    Waiting,
    Attached { short: String },
}

impl AttachState {
    fn label(&self) -> String {
        match self {
            AttachState::Connecting => "connecting".to_string(),
            AttachState::Waiting => "waiting".to_string(),
            AttachState::Attached { short } => format!("attached {short}"),
        }
    }

    fn style(&self) -> Style {
        match self {
            AttachState::Connecting => Theme::info(),
            AttachState::Waiting => Theme::warn(),
            AttachState::Attached { .. } => Theme::success(),
        }
    }
}

#[derive(Debug, Clone)]
struct BrainViewState {
    scope: Scope,
    /// Resolved display label for this scope's role (lexicon: brain→Mug,
    /// overwatch→Kettle). Seeded from CLASSIC in `new`, refreshed once the client
    /// fetches the active pack — so the header never bypasses the Hive lexicon.
    label: String,
    status: AttachState,
    current_uuid: Option<String>,
    offset: u64,
    path: Option<PathBuf>,
    messages: Vec<ChatMessage>,
    tick: u64,
    workspace: Option<String>,
}

impl BrainViewState {
    fn new(scope: Scope) -> Self {
        Self {
            scope,
            label: crate::lexicon::Lexicon::default().lex(scope.lexicon_term()),
            status: AttachState::Connecting,
            // Impossible sentinel so the first resolve always renders a transition.
            current_uuid: Some(String::new()),
            offset: 0,
            path: None,
            messages: Vec::new(),
            tick: 0,
            workspace: None,
        }
    }

    fn set_resolved(&mut self, resolved: Option<(String, PathBuf)>) {
        let uuid = resolved.as_ref().map(|(u, _)| u.clone());
        if uuid == self.current_uuid {
            return;
        }
        // BETWEEN WAKES, keep the last wake's turns on screen.
        //
        // A wake's transcript is ingested, archived and then DELETED from disk ~15s
        // after the session ends (session-archive-hook.ts, plan
        // session-db-archive-retire-dirs-2026-07-10), which retired this module's
        // founding assumption that it "keeps showing the last wake's transcript,
        // which persists on disk after the process exits". It does not persist any
        // more: the resolve goes empty the moment the archive lands, and wiping to a
        // bare "waiting…" pane meant the Mug/Kettle panes sat EMPTY for the ~18 of
        // every ~20 minutes they are not mid-wake (the Kettle pane the owner
        // screenshotted on 2026-07-13 was in exactly this state).
        //
        // So an empty resolve means "between wakes", NOT "nothing to show" — hold
        // the turns and just drop the attachment. The next wake re-attaches below.
        if uuid.is_none() && !self.messages.is_empty() {
            self.current_uuid = None;
            self.offset = 0;
            self.path = None;
            self.status = AttachState::Waiting;
            return;
        }
        self.current_uuid = uuid;
        self.offset = 0;
        self.path = resolved.map(|(_, p)| p);
        self.messages.clear();
        self.status = match &self.current_uuid {
            Some(u) if !u.is_empty() => AttachState::Attached {
                short: short_session(u),
            },
            _ => AttachState::Waiting,
        };
    }

    fn push_messages(&mut self, msgs: Vec<ChatMessage>) {
        self.messages.extend(msgs);
        let extra = self.messages.len().saturating_sub(MAX_MESSAGES);
        if extra > 0 {
            self.messages.drain(0..extra);
        }
    }

    fn advance_tick(&mut self) {
        self.tick = self.tick.wrapping_add(1);
    }
}

fn short_session(uuid: &str) -> String {
    uuid.chars().take(8).collect()
}

/// Resolve the autonomous session this pane follows: the NEWEST session for
/// this scope (across the live `active` AND `ended` roster tiers) whose transcript
/// file actually exists on disk. Returns its native uuid + transcript path together
/// (we locate once), or None when no such session is up yet. The roster is the
/// SAME backend data every desktop instance reads, so all instances resolve the
/// same session.
///
/// The `ended` tier is ESSENTIAL, not optional: an autonomous wake's adv_sessions
/// row is markAdvSessionEnded the instant its invoke run returns, so a short wake
/// (every Overwatch fire; a Queen wake between cycles) is in `ended` by the time
/// this resolves — reading only `active` is exactly why the Overwatch pane was
/// stuck on "waiting…". See roster_brain_scoped (client.rs).
///
/// The Queen runs as a SERIES of short "wake" sessions, each a fresh uuid; the
/// roster accumulates dozens of past wakes (45 active + 24 ended is normal). We
/// sort by `adv_session_id` — a serial PK, so a higher id launched later — and
/// take the most recent wake that has turns on disk. This makes the pane show
/// her latest activity and roll forward to each new wake automatically, and it
/// never blanks between wakes (it keeps showing the last wake's transcript,
/// which persists on disk after the process exits). Taking the FIRST match
/// instead pinned the pane to the OLDEST stale wake — the wrong-session symptom.
async fn resolve_session(
    client: &OperatorClient,
    scope: &Scope,
    locate: &LocateTranscript,
) -> anyhow::Result<(Option<String>, Option<(String, PathBuf)>)> {
    // Scope the roster to THIS desktop's ACTIVE workspace so the pane shows that
    // workspace's queen/overwatch — NOT the fleet-wide newest across every
    // workspace. Re-read on invalidation and the slow repair so a
    // workspace SWITCH (which rewrites registry.current) rolls the pane to the
    // new workspace's agent within a tick. A switch reloads the desktop webview
    // but does NOT re-spawn this pane, so the scope MUST be resolved live here,
    // not baked in at launch. Unknown workspace (dev / webapp with no registry)
    // → unscoped, preserving the prior fleet-wide behavior. A failed read
    // retains the current attachment rather than reading another workspace.
    let workspace = client.current_workspace().await?;
    // Read the `active` AND `ended` roster tiers (roster_brain_scoped): a
    // short-lived autonomous wake (every Overwatch invoke; a Queen wake between
    // cycles) is markAdvSessionEnded the instant its run returns, so it sits in
    // `ended`, not `active`. The OLD code read only `active` (+ the reactive-pane
    // `pending` tier, which never carries a queen/overwatch session) — so the
    // Overwatch pane resolved nothing and printed "not running right now —
    // waiting…" forever even though its transcript was on disk. Tailing the last
    // ended wake IS this pane's contract ("keeps showing the last wake's
    // transcript, which persists on disk after the process exits", below).
    let entries: Vec<RosterEntry> = client.roster_brain_scoped(workspace.as_deref()).await?;
    Ok((
        workspace,
        select_newest_with_transcript(entries, scope, |id| locate(id)),
    ))
}

/// Pure core of [`resolve_session`] (network + fs injected): among `entries`,
/// the NEWEST (by `adv_session_id`) entry whose role matches `scope`, has a
/// non-empty session id, AND whose uuid `locate`s to a real transcript file.
/// Returns the uuid + its path, or None. Separated out so the "newest wake with
/// turns, not the first stale match" selection is unit-testable.
fn select_newest_with_transcript(
    entries: Vec<RosterEntry>,
    scope: &Scope,
    locate: impl Fn(&str) -> Option<PathBuf>,
) -> Option<(String, PathBuf)> {
    let mut matches: Vec<RosterEntry> = entries
        .into_iter()
        .filter(|e| {
            e.role
                .as_deref()
                .map(|r| scope.matches_role(r))
                .unwrap_or(false)
                && e.session_id
                    .as_deref()
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false)
        })
        .collect();
    // Newest launch first (adv_session_id is a serial PK; higher = launched later).
    matches.sort_by(|a, b| {
        b.adv_session_id
            .unwrap_or(0)
            .cmp(&a.adv_session_id.unwrap_or(0))
    });
    for e in matches {
        if let Some(uuid) = e.session_id {
            if let Some(path) = locate(&uuid) {
                return Some((uuid, path));
            }
        }
    }
    None
}

/// Run the read-only transcript pane: connect, resolve the autonomous session
/// uuid, locate its transcript file, and render new turns into a compact TUI.
/// Re-resolves on shared invalidation with a slow repair, and shows a clear
/// placeholder when the agent isn't running — it NEVER blanks or crashes.
/// Loops until the pane is closed.
pub async fn run(scope: Scope) -> anyhow::Result<()> {
    let out = stdout();
    let mut terminal = Terminal::new(CrosstermBackend::new(out))?;

    run_tui(&mut terminal, scope).await
}

async fn run_tui(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    scope: Scope,
) -> anyhow::Result<()> {
    let mut state = BrainViewState::new(scope);
    terminal.draw(|f| draw_brain_view(f, &state))?;

    // Connect (retry until the operator is reachable — the pane outlives boot order).
    let client = loop {
        match OperatorClient::from_discovery().await {
            Ok(c) => break c,
            Err(_) => {
                state.advance_tick();
                terminal.draw(|f| draw_brain_view(f, &state))?;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };

    // Resolve this scope's display label through the active Hive lexicon now the
    // client is up (brain→Mug / overwatch→Kettle under CLASSIC; the-hive → its own
    // labels). Any fetch error keeps the CLASSIC seed from `new`.
    if let Ok(pack) = client.lexicon_active_pack().await {
        state.label = crate::lexicon::Lexicon::from_payload(&pack).lex(scope.lexicon_term());
    }

    follow_brain(
        client,
        state,
        Arc::new(locate_session_transcript),
        |state| {
            terminal.draw(|f| draw_brain_view(f, state))?;
            Ok(())
        },
    )
    .await
}

enum BrainSignal {
    Frame(crate::sse::SseFrame),
    Reconnected,
}

// The existing transport/parser owns the wire; this pane only selects its views.
fn relevant_frame(frame: &crate::sse::SseFrame, workspace: Option<&str>) -> bool {
    if frame.event != "invalidate" && frame.event != "update" {
        return false;
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&frame.data) else {
        return false;
    };
    match payload.get("name").and_then(|v| v.as_str()) {
        Some("workspace" | "workspaces" | "workspaces.current") => true,
        Some("roster") => {
            let target = payload
                .get("args")
                .and_then(|a| a.get("workspaceId").or_else(|| a.get("workspace")))
                .and_then(|v| v.as_str());
            target.is_none() || workspace.is_none() || target == workspace
        }
        _ => false,
    }
}

async fn brain_invalidation(client: OperatorClient, tx: mpsc::UnboundedSender<BrainSignal>) {
    let mut reconnect = false;
    loop {
        if tx.is_closed() {
            return;
        }
        match time::timeout(READ_TIMEOUT, client.subscribe_sse("/api/zero-harness/sse")).await {
            Ok(Ok(mut frames)) => {
                if reconnect && tx.send(BrainSignal::Reconnected).is_err() {
                    return;
                }
                while let Some(frame) = frames.recv().await {
                    if tx.send(BrainSignal::Frame(frame)).is_err() {
                        return;
                    }
                }
            }
            _ => {}
        }
        reconnect = true;
        time::sleep(RETRY_INTERVAL).await;
    }
}

struct StopOnDrop(tokio::task::JoinHandle<()>);
impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Local tail/render never await a remote read. A newer invalidation cancels the
/// old generation, including a workspace read or roster response still in flight.
async fn follow_brain(
    client: OperatorClient,
    mut state: BrainViewState,
    locate: LocateTranscript,
    mut render: impl FnMut(&BrainViewState) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let (tx, mut signals) = mpsc::unbounded_channel();
    let _subscription = StopOnDrop(tokio::spawn(brain_invalidation(client.clone(), tx)));
    let mut reads = tokio::task::JoinSet::new();
    let mut generation = 0u64;
    let mut due = Instant::now();
    let mut tail = time::interval_at(Instant::now() + TAIL_INTERVAL, TAIL_INTERVAL);
    tail.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            Some(signal) = signals.recv() => {
                if matches!(&signal, BrainSignal::Reconnected) || matches!(&signal, BrainSignal::Frame(f) if relevant_frame(f, state.workspace.as_deref())) {
                    generation = generation.wrapping_add(1);
                    reads.abort_all();
                    due = Instant::now();
                }
            }
            _ = async { if due > Instant::now() { time::sleep_until(due).await; } } => {
                let client = client.clone();
                let locate = locate.clone();
                let scope = state.scope;
                let current = generation;
                reads.spawn(async move { (current, time::timeout(READ_TIMEOUT, resolve_session(&client, &scope, &locate)).await) });
                due = Instant::now() + REPAIR_INTERVAL;
            }
            Some(result) = reads.join_next(), if !reads.is_empty() => {
                if let Ok((current, result)) = result {
                    if current != generation { continue; }
                    match result {
                        Ok(Ok((workspace, resolved))) => {
                            if workspace != state.workspace {
                                state.messages.clear();
                                state.current_uuid = Some(String::new());
                                state.workspace = workspace;
                            }
                            state.set_resolved(resolved);
                        }
                        _ => { due = Instant::now() + RETRY_INTERVAL; }
                    }
                    tail_local(&mut state);
                    render(&state)?;
                }
            }
            _ = tail.tick() => {
                tail_local(&mut state);
                render(&state)?;
            }
        }
    }
}

fn tail_local(state: &mut BrainViewState) {
    if let Some(p) = &state.path {
        if let Ok((new_offset, msgs)) = tail_transcript(p, state.offset) {
            state.offset = new_offset;
            state.push_messages(msgs);
        }
    }
    state.advance_tick();
}

fn draw_brain_view(f: &mut Frame, state: &BrainViewState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(f.area());

    f.render_widget(Paragraph::new(header_line(state)), chunks[0]);
    draw_transcript(f, state, chunks[1]);
    f.render_widget(Paragraph::new(footer_line(state)), chunks[2]);
    // The second real terminal in the binary gets the same P-011 guarantee.
    crate::glyph::scrub_control_cells(f.buffer_mut());
}

fn header_line(state: &BrainViewState) -> Line<'static> {
    let kind = state.scope.kind();
    let mut spans = vec![
        Span::styled(
            format!("{} {}", kind.glyph(), state.label),
            Theme::title().fg(kind.color()).add_modifier(Modifier::BOLD),
        ),
        Span::styled(" · live", Theme::dim()),
        Span::styled(" · ro", Theme::warn()),
        Span::raw(" · "),
        Span::styled(state.status.label(), state.status.style()),
    ];
    if !state.messages.is_empty() {
        spans.push(Span::styled(
            format!(" · {}t", state.messages.len()),
            Theme::dim(),
        ));
    }
    Line::from(spans)
}

fn footer_line(state: &BrainViewState) -> Line<'static> {
    let pulse = match state.tick % 4 {
        0 => "·",
        1 => "∙",
        2 => "•",
        _ => "∙",
    };
    let retained = if state.messages.len() >= MAX_MESSAGES {
        format!(" · retaining latest {MAX_MESSAGES}")
    } else {
        String::new()
    };
    Line::from(vec![
        Span::styled(format!("{pulse} mirror"), Theme::dim()),
        Span::styled(" · read-only", Theme::dim()),
        Span::styled(retained, Theme::dim()),
    ])
}

fn draw_transcript(f: &mut Frame, state: &BrainViewState, area: Rect) {
    let mut lines = transcript_lines(state);
    let height = area.height.max(1) as usize;
    if lines.len() > height {
        lines = lines.split_off(lines.len() - height);
    }
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

fn transcript_lines(state: &BrainViewState) -> Vec<Line<'static>> {
    if state.messages.is_empty() {
        let message = match state.status {
            AttachState::Connecting => " connecting to the operator…",
            AttachState::Waiting => {
                " no transcript found for this scope yet — waiting for the next wake…"
            }
            AttachState::Attached { .. } => " attached — waiting for transcript turns…",
        };
        return vec![
            Line::default(),
            Line::from(Span::styled(message, Theme::dim())),
        ];
    }

    let mut lines = Vec::new();
    for msg in &state.messages {
        let role = msg.role.trim();
        let (label, style) = role_style(state.scope, role);
        let content = msg.content.trim();
        if content.is_empty() {
            continue;
        }
        let mut content_lines = content.lines().filter_map(compact_content_line);
        if let Some(first) = content_lines.next() {
            let mut spans = vec![Span::styled(format!("{label} "), style)];
            spans.extend(styled_content_spans(&first));
            lines.push(Line::from(spans));
        }
        for line in content_lines {
            let mut spans = vec![Span::styled("  ", Theme::dim())];
            spans.extend(styled_content_spans(&line));
            lines.push(Line::from(spans));
        }
    }
    lines
}

fn role_style(scope: Scope, role: &str) -> (&'static str, Style) {
    match role.to_ascii_lowercase().as_str() {
        "assistant" => (
            "a",
            Theme::title()
                .fg(scope.kind().color())
                .add_modifier(Modifier::BOLD),
        ),
        "user" => ("u", Theme::info()),
        "system" => ("s", Theme::warn()),
        _ => ("•", Theme::dim()),
    }
}

fn compact_content_line(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

fn styled_content_spans(line: &str) -> Vec<Span<'static>> {
    if let Some(rest) = line.strip_prefix("### ") {
        return vec![
            Span::styled("## ", Theme::dim()),
            Span::styled(rest.to_string(), Theme::header()),
        ];
    }
    if let Some(rest) = line.strip_prefix("- ") {
        let mut spans = vec![Span::styled("- ", Theme::dim())];
        spans.extend(styled_inline_spans(rest));
        return spans;
    }
    if line.starts_with('<') && line.ends_with('>') {
        return vec![Span::styled(line.to_string(), Theme::dim())];
    }
    if line.contains("API Error") || line.contains("Error:") {
        return vec![Span::styled(
            line.to_string(),
            Theme::danger().add_modifier(Modifier::BOLD),
        )];
    }
    styled_inline_spans(line)
}

fn styled_inline_spans(text: &str) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    for token in text.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let suffix = &token[trimmed.len()..];
        if !trimmed.is_empty() {
            spans.push(Span::styled(trimmed.to_string(), token_style(trimmed)));
        }
        if !suffix.is_empty() {
            spans.push(Span::raw(suffix.to_string()));
        }
    }
    spans
}

fn token_style(token: &str) -> Style {
    let normalized = token
        .trim_matches(|c: char| {
            matches!(
                c,
                '.' | ',' | ':' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '!' | '?'
            )
        })
        .to_ascii_lowercase();
    let active = Theme::active();

    if token.starts_with('`') || token.starts_with('\'') || token.ends_with('`') {
        return Theme::info();
    }
    if normalized.starts_with("mq")
        || normalized.starts_with("ei-")
        || normalized.starts_with("s-")
        || normalized.contains("0000-")
    {
        return Theme::dim();
    }
    if normalized.parse::<u64>().is_ok()
        || normalized.ends_with('t')
            && normalized[..normalized.len().saturating_sub(1)]
                .parse::<u64>()
                .is_ok()
        || normalized.ends_with("(s)")
    {
        return Style::default()
            .fg(active.accent_hot)
            .add_modifier(Modifier::BOLD);
    }
    if matches!(
        normalized.as_str(),
        "blocked"
            | "blocker"
            | "dead"
            | "error"
            | "failure"
            | "failed"
            | "failing"
            | "limiting"
            | "stalled"
            | "stranded"
            | "critical"
            | "429"
            | "aging"
    ) {
        return Theme::danger();
    }
    if matches!(
        normalized.as_str(),
        "alive" | "available" | "completed" | "ready" | "resolved" | "running" | "attached" | "ok"
    ) {
        return Theme::success();
    }
    if matches!(
        normalized.as_str(),
        "advisory" | "paused" | "churning" | "unscheduled" | "warning" | "warn"
    ) {
        return Theme::warn();
    }
    if normalized.contains('/')
        || normalized.contains("coord:")
        || normalized.contains("work")
        || normalized.contains("token")
        || normalized.contains("gateway")
    {
        return Theme::info();
    }

    Style::default().fg(active.muted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::{broadcast, Notify};

    #[derive(Default)]
    struct ApiState {
        workspace: String,
        rosters: HashMap<String, serde_json::Value>,
        requests: Vec<String>,
        fail_workspace: usize,
        fail_sse: usize,
        blocked_roster: Option<String>,
    }

    // Real OperatorClient HTTP + existing sse.rs parser; only the API is a fixture.
    // Paused time drives the production timers, never a second model of the loop.
    struct BrainFixture {
        api: Arc<Mutex<ApiState>>,
        wire: broadcast::Sender<String>,
        release: Arc<Notify>,
        snapshots: Arc<Mutex<Vec<BrainViewState>>>,
        _server: StopOnDrop,
        _pane: StopOnDrop,
        transcripts: tempfile::TempDir,
        paused: Cell<bool>,
    }

    impl BrainFixture {
        async fn start(scope: Scope, roster: serde_json::Value) -> Self {
            Self::start_with_faults(scope, roster, 0, 0).await
        }

        async fn start_with_faults(
            scope: Scope,
            roster: serde_json::Value,
            fail_workspace: usize,
            fail_sse: usize,
        ) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let api = Arc::new(Mutex::new(ApiState {
                workspace: "a".into(),
                rosters: HashMap::from([("a".into(), roster)]),
                fail_workspace,
                fail_sse,
                ..Default::default()
            }));
            let (wire, _) = broadcast::channel::<String>(64);
            let release = Arc::new(Notify::new());
            let server_api = api.clone();
            let server_wire = wire.clone();
            let server_release = release.clone();
            let server = tokio::spawn(async move {
                while let Ok((mut socket, _)) = listener.accept().await {
                    socket.set_nodelay(true).unwrap();
                    let api = server_api.clone();
                    let mut events = server_wire.subscribe();
                    let release = server_release.clone();
                    tokio::spawn(async move {
                        let mut request = Vec::new();
                        loop {
                            let mut buf = [0; 2048];
                            let n = socket.read(&mut buf).await.unwrap_or(0);
                            if n == 0 {
                                return;
                            }
                            request.extend_from_slice(&buf[..n]);
                            if request.windows(4).any(|b| b == b"\r\n\r\n") {
                                break;
                            }
                        }
                        let request = String::from_utf8_lossy(&request);
                        let path = request.split_whitespace().nth(1).unwrap().to_string();
                        let (status, body, block) = {
                            let mut api = api.lock().unwrap();
                            api.requests.push(path.clone());
                            if path == "/api/zero-harness/sse" && api.fail_sse > 0 {
                                api.fail_sse -= 1;
                                (503, serde_json::json!({}), false)
                            } else if path == "/api/workspaces" {
                                if api.fail_workspace > 0 {
                                    api.fail_workspace -= 1;
                                    (503, serde_json::json!({}), false)
                                } else {
                                    (200, serde_json::json!({"current": api.workspace}), false)
                                }
                            } else {
                                let ws = path.split("workspace=").nth(1).unwrap_or("");
                                (
                                    200,
                                    api.rosters
                                        .get(ws)
                                        .cloned()
                                        .unwrap_or(serde_json::json!({"active":[],"ended":[]})),
                                    api.blocked_roster.as_deref() == Some(ws),
                                )
                            }
                        };
                        if path == "/api/zero-harness/sse" && status == 200 {
                            if socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n: connected\n\n").await.is_err() { return; }
                            while let Ok(chunk) = events.recv().await {
                                if chunk == "CLOSE"
                                    || socket.write_all(chunk.as_bytes()).await.is_err()
                                {
                                    return;
                                }
                            }
                        } else {
                            if block {
                                release.notified().await;
                            }
                            let body = body.to_string();
                            let reply = format!("HTTP/1.1 {status} fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = socket.write_all(reply.as_bytes()).await;
                        }
                    });
                }
            });
            let transcripts = tempfile::tempdir().unwrap();
            let root = transcripts.path().to_path_buf();
            let locate: LocateTranscript = Arc::new(move |id| {
                let path = root.join(format!("{id}.jsonl"));
                path.is_file().then_some(path)
            });
            let snapshots = Arc::new(Mutex::new(Vec::new()));
            let recorded = snapshots.clone();
            let pane = tokio::spawn(async move {
                follow_brain(
                    OperatorClient::from_selection(&endpoint).unwrap(),
                    BrainViewState::new(scope),
                    locate,
                    move |s| {
                        recorded.lock().unwrap().push(s.clone());
                        Ok(())
                    },
                )
                .await
                .unwrap();
            });
            let fixture = Self {
                api,
                wire,
                release,
                snapshots,
                _server: StopOnDrop(server),
                _pane: StopOnDrop(pane),
                transcripts,
                paused: Cell::new(false),
            };
            fixture
                .wait_for(|| {
                    fixture.count("/api/zero-harness/sse") == 1
                        && !fixture.snapshots.lock().unwrap().is_empty()
                })
                .await;
            fixture
        }

        fn count(&self, path: &str) -> usize {
            self.api
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|p| p.as_str() == path)
                .count()
        }

        fn frame(&self, name: &str, args: serde_json::Value) {
            self.wire
                .send(format!(
                    "event: invalidate\ndata: {}\n\n",
                    serde_json::json!({"name":name,"args":args})
                ))
                .unwrap();
        }

        async fn settle(&self) {
            for _ in 0..1000 {
                tokio::task::yield_now().await;
            }
        }

        async fn advance_until(&self, budget: Duration, condition: impl Fn() -> bool) {
            // Observe the asynchronous EOF before assuming its retry timer was
            // armed. Full-suite scheduling can deliver EOF after a single large
            // advance; stepping bounds the recovery without that false premise.
            let deadline = Instant::now() + budget;
            while !condition() && Instant::now() < deadline {
                time::advance(Duration::from_millis(10)).await;
                self.settle().await;
            }
            self.wait_for(condition).await;
        }

        async fn wait_for(&self, condition: impl Fn() -> bool) {
            for step in 0..100_000 {
                if condition() {
                    return;
                }
                // Tokio rounds timer deadlines to milliseconds. Let immediate
                // HTTP/connect/retry timers cross that boundary while settling
                // real sockets under the paused clock (at most 100ms total).
                if self.paused.get() && step % 1000 == 999 {
                    time::advance(Duration::from_millis(1)).await;
                }
                tokio::task::yield_now().await;
            }
            panic!(
                "fixture did not converge; requests={:?}",
                self.api.lock().unwrap().requests
            );
        }

        fn write_turn(&self, id: &str, text: &str) {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.transcripts.path().join(format!("{id}.jsonl")))
                .unwrap();
            writeln!(file, "{}", serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":text}]}})).unwrap();
        }

        fn latest(&self) -> BrainViewState {
            self.snapshots.lock().unwrap().last().unwrap().clone()
        }

        fn pause(&self) {
            time::pause();
            self.paused.set(true);
        }
    }

    fn roster(active: &[RosterEntry], ended: &[RosterEntry]) -> serde_json::Value {
        let encode =
            |entries: &[RosterEntry]| {
                entries.iter().map(|e| serde_json::json!({
            "role": e.role, "advSessionId": e.adv_session_id, "sessionId": e.session_id,
        })).collect::<Vec<_>>()
            };
        let active = encode(active);
        let ended = encode(ended);
        serde_json::json!({"active":active,"ended":ended,"pending":[]})
    }

    #[tokio::test]
    async fn rules_events_r8_sse_invalidates_once() {
        let f = BrainFixture::start(Scope::Queen, roster(&[], &[])).await;
        for name in ["roster", "workspace", "workspaces", "workspaces.current"] {
            let before = f.count("/api/workspaces");
            // Split wire frames exercise the shared parser rather than fabricated signals.
            f.wire.send("event: invalidate\ndata: ".into()).unwrap();
            f.wire
                .send(format!("{}\n\n", serde_json::json!({"name":name})))
                .unwrap();
            f.wait_for(|| f.count("/api/adv/roster?workspace=a") == before + 1)
                .await;
            f.settle().await;
            assert_eq!(f.count("/api/workspaces"), before + 1);
            assert_eq!(f.count("/api/adv/roster?workspace=a"), before + 1);
        }
        let before = f.count("/api/workspaces");
        for data in [
            "event: heartbeat\ndata: {}\n\n",
            "event: invalidate\ndata: broken\n\n",
            "event: update\ndata: {\"name\":\"plans\"}\n\n",
        ] {
            f.wire.send(data.into()).unwrap();
        }
        f.frame("roster", serde_json::json!({"workspaceId":"other"}));
        f.settle().await;
        assert_eq!(
            f.count("/api/workspaces"),
            before,
            "irrelevant/malformed frames must not resolve"
        );

        // Refetch counts alone do not prove that the pane applies the new roster.
        // Freeze repair time and drive a real old-to-new transcript selection.
        f.pause();
        f.write_turn("old", "selected old wake");
        f.write_turn("new", "selected new wake");
        f.api.lock().unwrap().rosters.insert(
            "a".into(),
            roster(&[entry("queen", 1, Some("old"))], &[]),
        );
        f.frame("roster", serde_json::json!({"workspaceId":"a"}));
        f.wait_for(|| f.latest().current_uuid.as_deref() == Some("old"))
            .await;
        assert_eq!(f.latest().messages[0].content, "selected old wake");

        f.api.lock().unwrap().rosters.insert(
            "a".into(),
            roster(&[entry("queen", 2, Some("new"))], &[]),
        );
        f.settle().await;
        assert_eq!(f.latest().current_uuid.as_deref(), Some("old"));
        let before = f.count("/api/workspaces");
        f.frame("roster", serde_json::json!({"workspaceId":"a"}));
        f.wait_for(|| f.latest().current_uuid.as_deref() == Some("new"))
            .await;
        assert_eq!(f.count("/api/workspaces"), before + 1);
        assert_eq!(f.latest().messages[0].content, "selected new wake");
        let rendered: String = transcript_lines(&f.latest())
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect();
        assert!(rendered.contains("selected new wake"), "{rendered}");
        assert!(!rendered.contains("selected old wake"), "{rendered}");
    }

    #[tokio::test]
    async fn rules_events_r58_reconnect_and_repair() {
        let f = BrainFixture::start(Scope::Queen, roster(&[], &[])).await;
        f.pause();
        // Failed startup/read retries within five seconds, rather than at repair.
        f.api.lock().unwrap().fail_workspace = 1;
        f.frame("roster", serde_json::json!({}));
        f.wait_for(|| f.count("/api/workspaces") == 2).await;
        f.settle().await;
        time::advance(RETRY_INTERVAL).await;
        f.wait_for(|| f.count("/api/adv/roster?workspace=a") == 2)
            .await;
        f.settle().await;
        let before = f.count("/api/workspaces");
        f.wire.send("CLOSE".into()).unwrap();
        f.advance_until(Duration::from_secs(3), || {
            f.count("/api/zero-harness/sse") == 2 && f.count("/api/adv/roster?workspace=a") == 3
        })
        .await;
        f.settle().await;
        assert_eq!(
            f.count("/api/workspaces"),
            before + 1,
            "reconnect repairs missed frames immediately"
        );
        let before = f.count("/api/workspaces");
        time::advance(Duration::from_secs(59)).await;
        f.settle().await;
        assert_eq!(f.count("/api/workspaces"), before);
        time::advance(Duration::from_secs(1)).await;
        f.wait_for(|| f.count("/api/workspaces") == before + 1)
            .await;
    }

    #[tokio::test]
    async fn rules_events_r58_reconnect_and_repair_failed_startup_and_sse() {
        let f = BrainFixture::start_with_faults(Scope::Queen, roster(&[], &[]), 1, 1).await;
        f.pause();
        f.settle().await;
        assert_eq!(f.count("/api/adv/roster?workspace=a"), 0);
        time::advance(RETRY_INTERVAL).await;
        f.wait_for(|| {
            f.count("/api/adv/roster?workspace=a") >= 1 && f.count("/api/zero-harness/sse") == 2
        })
        .await;
        f.settle().await;
        assert_eq!(f.latest().status, AttachState::Waiting);
        assert!(RETRY_INTERVAL <= Duration::from_secs(5));
    }

    #[tokio::test]
    async fn rules_events_r59_local_tail() {
        let f = BrainFixture::start(
            Scope::Queen,
            roster(&[entry("queen", 1, Some("wake"))], &[]),
        )
        .await;
        f.write_turn("wake", "before offline");
        f.frame("roster", serde_json::json!({}));
        f.wait_for(|| f.latest().messages.len() == 1).await;
        f.pause();
        f.api.lock().unwrap().blocked_roster = Some("a".into());
        f.frame("roster", serde_json::json!({}));
        f.wait_for(|| f.count("/api/adv/roster?workspace=a") == 3)
            .await;
        f.write_turn("wake", "appended while HTTP blocked");
        time::advance(TAIL_INTERVAL).await;
        f.wait_for(|| f.latest().messages.len() == 2).await;
        let rendered: String = transcript_lines(&f.latest())
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect();
        assert!(
            rendered.contains("appended while HTTP blocked"),
            "{rendered}"
        );
        assert_eq!(f.count("/api/adv/roster?workspace=a"), 3);
    }

    #[tokio::test]
    async fn rules_events_r60_newest_ended_wake() {
        let f = BrainFixture::start(
            Scope::Overwatch,
            roster(
                &[entry("overwatch", 1, Some("old"))],
                &[
                    entry("overwatch", 4, Some("new")),
                    entry("queen", 9, Some("wrong-role")),
                ],
            ),
        )
        .await;
        f.write_turn("old", "old wake");
        f.write_turn("new", "ended newest wake");
        f.frame("roster", serde_json::json!({}));
        f.wait_for(|| f.latest().current_uuid.as_deref() == Some("new"))
            .await;
        assert_eq!(f.latest().messages[0].content, "ended newest wake");
        f.api
            .lock()
            .unwrap()
            .rosters
            .insert("a".into(), roster(&[], &[]));
        let before = f.count("/api/workspaces");
        f.frame("roster", serde_json::json!({}));
        f.wait_for(|| {
            f.latest().status == AttachState::Waiting && f.count("/api/workspaces") > before
        })
        .await;
        assert_eq!(
            f.latest().messages[0].content,
            "ended newest wake",
            "retain ended wake between runs"
        );
    }

    #[tokio::test]
    async fn rules_events_r61_workspace_generation() {
        let f =
            BrainFixture::start(Scope::Queen, roster(&[entry("queen", 1, Some("old"))], &[])).await;
        f.write_turn("old", "workspace A");
        f.write_turn("new", "workspace B");
        f.frame("roster", serde_json::json!({}));
        f.wait_for(|| f.latest().current_uuid.as_deref() == Some("old"))
            .await;
        f.api.lock().unwrap().blocked_roster = Some("a".into());
        let before = f.count("/api/adv/roster?workspace=a");
        f.frame("roster", serde_json::json!({}));
        f.wait_for(|| f.count("/api/adv/roster?workspace=a") == before + 1)
            .await;
        {
            let mut api = f.api.lock().unwrap();
            api.workspace = "b".into();
            api.rosters
                .insert("b".into(), roster(&[], &[entry("queen", 2, Some("new"))]));
        }
        f.frame("workspaces", serde_json::json!({}));
        f.wait_for(|| f.latest().current_uuid.as_deref() == Some("new"))
            .await;
        f.frame("roster", serde_json::json!({"workspaceId":"a"}));
        f.release.notify_waiters();
        f.settle().await;
        assert_eq!(f.latest().workspace.as_deref(), Some("b"));
        assert_eq!(f.latest().current_uuid.as_deref(), Some("new"));
        assert_eq!(f.latest().messages[0].content, "workspace B");
        assert_eq!(f.count("/api/adv/roster?workspace=b"), 1);
    }

    #[tokio::test]
    async fn rules_events_r62_no_fast_remote_poll() {
        let f = BrainFixture::start(Scope::Queen, roster(&[], &[])).await;
        f.pause();
        for _ in 0..20 {
            time::advance(TAIL_INTERVAL).await;
            f.settle().await;
        }
        assert_eq!(f.count("/api/workspaces"), 1);
        assert_eq!(f.count("/api/adv/roster?workspace=a"), 1);
        assert!(
            f.snapshots.lock().unwrap().len() >= 21,
            "local tail/render continues"
        );
    }

    fn entry(role: &str, adv: i64, sid: Option<&str>) -> RosterEntry {
        RosterEntry {
            role: Some(role.into()),
            adv_session_id: Some(adv),
            session_id: sid.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn scope_matches_role_aliases() {
        assert!(Scope::Queen.matches_role("queen"));
        assert!(Scope::Queen.matches_role("mug"));
        assert!(Scope::Overwatch.matches_role("kettle"));
        assert!(Scope::Queen.matches_role("brain"));
        assert!(Scope::Queen.matches_role("QUEEN"));
        assert!(!Scope::Queen.matches_role("overwatch"));
        assert!(Scope::Overwatch.matches_role("overwatch"));
        assert!(!Scope::Overwatch.matches_role("queen"));
    }

    #[test]
    fn picks_newest_wake_with_a_transcript_not_the_first_stale_one() {
        // Three queen wakes; only the two newest have a transcript on disk.
        let entries = vec![
            entry("queen", 2915, Some("old-stale")), // oldest — would win a `.find()`
            entry("overwatch", 3019, Some("ow")),    // wrong scope
            entry("queen", 3329, Some("newest")),    // newest, but no file yet
            entry("queen", 3328, Some("live")),      // 2nd-newest, HAS a file
        ];
        // `newest` (3329) has no transcript; `live` (3328) and `old-stale` do.
        let locate = |uuid: &str| -> Option<PathBuf> {
            match uuid {
                "live" | "old-stale" => Some(PathBuf::from(format!("/t/{uuid}.jsonl"))),
                _ => None,
            }
        };
        let got = select_newest_with_transcript(entries, &Scope::Queen, locate);
        // Rolls back from 3329 (no file) to 3328 (`live`) — NOT the oldest 2915.
        assert_eq!(got, Some(("live".into(), PathBuf::from("/t/live.jsonl"))));
    }

    #[test]
    fn overwatch_resolves_from_an_ended_wake_with_a_transcript() {
        // The regression this fix closes: every Overwatch wake is a short invoke
        // whose adv_sessions row is ENDED by the time the pane polls, so it arrives
        // ONLY via the roster's `ended` tier (now merged into `entries` by
        // roster_brain_scoped). select_newest_with_transcript is tier-agnostic, so
        // an overwatch entry with a sessionId + an on-disk transcript MUST resolve
        // — proving the pane attaches instead of printing "waiting…". (Before the
        // fix the ended tier was dropped client-side and `entries` was empty.)
        let entries = vec![
            entry("overwatch", 6929, Some("ow-old")), // older ended wake, has a file
            entry("queen", 6940, Some("q")),          // wrong scope, newer
            entry("overwatch", 6946, Some("ow-new")), // newest ended wake, has a file
        ];
        let locate = |uuid: &str| -> Option<PathBuf> {
            match uuid {
                "ow-old" | "ow-new" => Some(PathBuf::from(format!("/t/{uuid}.jsonl"))),
                _ => None,
            }
        };
        let got = select_newest_with_transcript(entries, &Scope::Overwatch, locate);
        assert_eq!(
            got,
            Some(("ow-new".into(), PathBuf::from("/t/ow-new.jsonl")))
        );
    }

    #[test]
    fn returns_none_when_no_matching_session_has_a_transcript() {
        let entries = vec![
            entry("queen", 3329, Some("a")),
            entry("queen", 3328, Some("")), // empty sid ignored
            entry("bee", 9000, Some("b")),  // wrong scope
        ];
        let got = select_newest_with_transcript(entries, &Scope::Queen, |_| None);
        assert_eq!(got, None);
    }

    #[test]
    fn state_transition_to_new_session_resets_tail_and_messages() {
        let mut state = BrainViewState::new(Scope::Queen);
        state.offset = 99;
        state.push_messages(vec![ChatMessage::assistant("old turn")]);

        state.set_resolved(Some((
            "12345678-aaaa-bbbb-cccc-123456789000".into(),
            PathBuf::from("/tmp/q.jsonl"),
        )));

        assert_eq!(
            state.status,
            AttachState::Attached {
                short: "12345678".into()
            }
        );
        assert_eq!(state.offset, 0);
        assert!(state.messages.is_empty());
        assert_eq!(state.path, Some(PathBuf::from("/tmp/q.jsonl")));
    }

    #[test]
    fn between_wakes_the_pane_holds_the_last_wake_instead_of_blanking() {
        // The wake's transcript is archived + DELETED ~15s after the session ends
        // (session-archive-hook.ts), so the resolve goes empty between wakes. That
        // must NOT wipe the pane: a mug/kettle wake runs ~2 of every ~20 minutes, so
        // clearing on an empty resolve left the pane blank almost all the time.
        let mut state = BrainViewState::new(Scope::Overwatch);
        state.set_resolved(Some((
            "90408e54-7492-4f22-8df9-fed630425eeb".into(),
            PathBuf::from("/tmp/k.jsonl"),
        )));
        state.offset = 4096;
        state.push_messages(vec![ChatMessage::assistant("kettle wake N")]);

        // The wake ends and its transcript is archived away → resolve returns None.
        state.set_resolved(None);

        // Detached (nothing left to tail) but the turns STAY on screen.
        assert_eq!(state.status, AttachState::Waiting);
        assert_eq!(state.path, None);
        assert_eq!(state.offset, 0);
        assert_eq!(
            state.messages.len(),
            1,
            "last wake's turns must be retained"
        );
        assert_eq!(state.messages[0].content, "kettle wake N");
        // Still-empty resolves are idle — no churn, no re-clear.
        state.set_resolved(None);
        assert_eq!(state.messages.len(), 1);

        // The NEXT wake attaches and takes over the pane (fresh session, fresh tail).
        state.set_resolved(Some((
            "aaaaaaaa-1111-2222-3333-444444444444".into(),
            PathBuf::from("/tmp/k2.jsonl"),
        )));
        assert_eq!(
            state.status,
            AttachState::Attached {
                short: "aaaaaaaa".into()
            }
        );
        assert!(state.messages.is_empty());
    }

    #[test]
    fn a_first_resolve_that_finds_nothing_still_reports_waiting() {
        // The retain path must not mask the cold-start case: no wake seen yet ⇒ the
        // pane legitimately has nothing to show and says so.
        let mut state = BrainViewState::new(Scope::Queen);
        state.set_resolved(None);
        assert_eq!(state.status, AttachState::Waiting);
        assert!(state.messages.is_empty());
        assert_eq!(state.path, None);
    }

    #[test]
    fn retained_transcript_messages_are_bounded() {
        let mut state = BrainViewState::new(Scope::Overwatch);
        let msgs: Vec<ChatMessage> = (0..(MAX_MESSAGES + 12))
            .map(|i| ChatMessage::assistant(&format!("turn {i}")))
            .collect();

        state.push_messages(msgs);

        assert_eq!(state.messages.len(), MAX_MESSAGES);
        assert_eq!(state.messages.first().unwrap().content, "turn 12");
        assert_eq!(
            state.messages.last().unwrap().content,
            format!("turn {}", MAX_MESSAGES + 11)
        );
    }

    #[test]
    fn renderer_draws_tui_chrome_and_transcript_rows() {
        let mut state = BrainViewState::new(Scope::Queen);
        state.status = AttachState::Attached {
            short: "abcdef12".into(),
        };
        state.push_messages(vec![
            ChatMessage::user("place the next item"),
            ChatMessage::assistant("Placed WI-123.\nVerifier queued."),
        ]);

        let mut terminal = Terminal::new(TestBackend::new(80, 8)).unwrap();
        terminal.draw(|f| draw_brain_view(f, &state)).unwrap();
        let text = format!("{:?}", terminal.backend().buffer());

        // Header renders the lexicon-resolved label (CLASSIC: brain→Mug), never
        // the hardcoded old brand word "Queen".
        assert!(text.contains("Mug"), "{text}");
        assert!(!text.contains("Queen"), "{text}");
        assert!(text.contains("read-only"), "{text}");
        assert!(text.contains("attached abcdef12"), "{text}");
        assert!(text.contains("place the next item"), "{text}");
        assert!(text.contains("Placed WI-123"), "{text}");
        assert!(text.contains("mirror"), "{text}");
        assert!(text.contains("read-only"), "{text}");
    }

    #[test]
    fn transcript_rows_are_dense_without_wide_gutters_or_blank_turn_gaps() {
        let mut state = BrainViewState::new(Scope::Overwatch);
        state.status = AttachState::Attached {
            short: "5054eed3".into(),
        };
        state.push_messages(vec![
            ChatMessage {
                role: "system".into(),
                content: "alpha\n\n  beta".into(),
                reasoning: String::new(),
                provenance: None,
                tools: Vec::new(),
                streaming: false,
                worked_for: None,
            },
            ChatMessage::assistant("gamma\n  delta"),
        ]);

        let lines = transcript_lines(&state);
        let rendered: Vec<String> = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();

        assert_eq!(rendered, vec!["s alpha", "  beta", "a gamma", "  delta"]);
    }

    #[test]
    fn transcript_content_styles_headings_metrics_status_and_ids() {
        let heading = styled_content_spans("### Work feed");
        assert_eq!(heading[0].content.as_ref(), "## ");
        assert_eq!(heading[0].style, Theme::dim());
        assert_eq!(heading[1].content.as_ref(), "Work feed");
        assert_eq!(heading[1].style, Theme::header());

        let bullet = styled_content_spans(
            "- frontier 93 ready · 2 stalled item(s) · escalation:mqsu-0000-abcd `coord:send`",
        );
        let style_for = |needle: &str| {
            bullet
                .iter()
                .find(|span| span.content.as_ref() == needle)
                .map(|span| span.style)
                .unwrap_or_else(|| panic!("missing span {needle:?}: {bullet:?}"))
        };

        assert_eq!(style_for("93"), Theme::title());
        assert_eq!(style_for("ready"), Theme::success());
        assert_eq!(style_for("stalled"), Theme::danger());
        assert_eq!(style_for("escalation:mqsu-0000-abcd"), Theme::dim());
        assert_eq!(style_for("`coord:send`"), Theme::info());
    }
}
