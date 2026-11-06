//! Agent-context panes (dock 4-pane split, owner ask 2026-06-11) — the three
//! data boards stacked with the wake board in an agent's dock side column:
//!
//!   - `pui orders-pane` — the GUI's current owner-scoped Orders projection;
//!   - `pui activity-pane` — the GUI's current Activity dossier;
//!   - `pui prompt-pane` — the prompt the agent RUNS ON: a fleet spawn's
//!     recorded prompt_body (its brief — the per-agent signal — led first,
//!     with the model/tier it launched at), or a live render of the role
//!     persona for interactive agents like the queen (GET
//!     /api/fleet/agent-prompt, sources labeled recorded/rendered);
//!   - `pui mail-pane`   — coord mail addressed to / sent by the agent;
//!   - `pui work-pane`   — its ranked work items + declared plan + claims.
//!
//! Each pane is one pinned `Tab::AgentCtx` pui instance; the mode + agent
//! scope come from argv (default scope: the queen — the panes live in her
//! column). Orders/Activity use the GUI named queries and push invalidations;
//! the legacy prompt/mail/work modes remain available. All render lives here;
//! `app.rs` holds the snapshot + keymap
//! (j/k scroll · N notifications) and `ui.rs` a one-line delegation, the
//! wake_board.rs convention.

use crate::app::{AgentCtxMode, App};
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::Rect,
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
    Frame,
};
use serde::Deserialize;

// Mirrors of the GUI wire contracts in use-agent-orders/use-agent-detail. Every
// evolving field stays optional: a server predating it is unavailable, not empty.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentOrders {
    pub mission: Option<OrdersMission>,
    pub modes: Option<Vec<OrdersMode>>,
    pub wake_mode: Option<WakeMode>,
    pub walls: Option<Vec<CarriedCheck>>,
    pub directives: Option<Vec<OrdersDirective>>,
    pub directives_total_open: Option<u64>,
    pub facts: Option<Vec<OrdersFact>>,
    pub carry: Option<OrdersCarry>,
    pub obligation_rows: Option<Vec<ObligationRow>>,
    pub unavailable: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OrdersMission {
    pub constraint: Option<String>,
    pub explanation: Option<String>,
    pub authority: Option<String>,
    pub route: Option<String>,
    pub suppressed: Option<Vec<SuppressedOrder>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SuppressedOrder {
    pub key: String,
    pub value: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OrdersMode {
    pub mode: String,
    pub reason: Option<String>,
    pub owner_directed: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WakeMode {
    pub effective: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OrdersDirective {
    pub id: u64,
    pub verbatim_text: String,
    pub source_turn_ref: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OrdersFact {
    pub key: String,
    pub body: String,
    pub possibly_stale: Option<bool>,
    pub contested: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CarriedCheck {
    pub claim: String,
    pub recheck: Option<String>,
    pub verified: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OrdersCarry {
    pub mode: Option<String>,
    pub generation: Option<u64>,
    pub loop_active: Option<bool>,
    pub note: Option<String>,
    pub note_updated_at_ms: Option<u64>,
    pub never_written: Option<bool>,
    pub held_items: Option<Vec<CarryItem>>,
    pub checks: Option<Vec<CarriedCheck>>,
    pub cited_refs_terminal: Option<Vec<String>>,
    pub awaits: Option<Vec<SidebarAwait>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CarryItem {
    pub id: String,
    pub title: Option<String>,
    pub checkpoint: Option<String>,
    pub checkpoint_updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SidebarAwait {
    pub event_key: String,
    pub note: Option<String>,
    pub once: Option<bool>,
    pub wakes: Option<bool>,
    pub expires_ts: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ObligationRow {
    pub order: u64,
    pub text: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentActivity {
    pub locks: Option<ActivityLocks>,
    pub coord: Option<ActivityCoord>,
    pub signals: Option<ActivitySignals>,
    pub subscriptions: Option<ActivitySubscriptions>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ActivityLocks {
    pub held: Option<Vec<SidebarLock>>,
    pub waiting: Option<Vec<WaitingLock>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SidebarLock {
    pub path: String,
    pub intent: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WaitingLock {
    pub paths: Vec<String>,
    pub intent: String,
    pub ahead_count: Option<u64>,
    pub blocked_by: Vec<LockBlocker>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct LockBlocker {
    pub path: String,
    pub holder: String,
    pub intent: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivityCoord {
    pub unread_count: Option<u64>,
    pub unread: Option<Vec<SidebarMessage>>,
    pub open_handoffs: Option<Vec<SidebarMessage>>,
    pub open_escalations: Option<Vec<SidebarMessage>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SidebarMessage {
    pub summary: String,
    pub from: Option<String>,
    pub next_action: Option<String>,
    pub severity: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivitySignals {
    pub liveness: Option<ActivityLiveness>,
    pub r#loop: Option<ActivityLoop>,
    pub context_tokens: Option<u64>,
    pub compaction_limit: Option<u64>,
    pub last_tool_call_at: Option<String>,
    pub current_claim: Option<ActivityClaim>,
    pub last_checkpoint: Option<ActivityCheckpoint>,
    pub unavailable_signals: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivityLiveness {
    pub session_state: Option<String>,
    pub live_turn: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivityLoop {
    pub active: Option<bool>,
    pub interval_sec: Option<u64>,
    pub next_fire_at: Option<String>,
    pub parked: Option<bool>,
    pub stalled: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivityClaim {
    pub id: String,
    pub title: Option<String>,
    pub progress: Option<String>,
    pub idle_sec: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivityCheckpoint {
    pub text: String,
    pub updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ActivitySubscriptions {
    pub items: Option<Vec<SidebarAwait>>,
    pub count: Option<u64>,
    pub error: Option<String>,
}

/// Existing sync invalidations, scoped to this pinned reader. A change for a
/// different owner must not refetch this agent's expensive carry projection.
pub fn matches_sidebar_invalidation(
    mode: AgentCtxMode,
    scope: &crate::app::WakeFilter,
    data: &str,
) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return false;
    };
    let Some(name) = value.get("name").and_then(serde_json::Value::as_str) else {
        return false;
    };
    if name == "advRoster.list" {
        return true;
    }
    let query = match mode {
        AgentCtxMode::Orders => "agentOrders.byOwner",
        AgentCtxMode::Activity => "agentDetail.byOwner",
        _ => return false,
    };
    if name != query {
        return false;
    }
    match (
        scope,
        value
            .get("args")
            .and_then(|args| args.get("ownerId"))
            .and_then(serde_json::Value::as_str),
    ) {
        (crate::app::WakeFilter::Owner(owner), Some(changed)) => owner == changed,
        _ => true,
    }
}

/// Short display form of an owner id (mirrors app.rs's short_owner idiom).
fn short(owner: &str) -> String {
    if owner.len() <= 14 {
        owner.to_string()
    } else {
        format!("{}…", &owner[..13])
    }
}

pub fn draw_agent_ctx(f: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line> = Vec::new();
    match &app.agent_ctx {
        None => lines.push(Line::from(Span::styled("loading…", Theme::dim()))),
        Some(Err(e)) => lines.push(Line::from(Span::styled(
            format!("error: {e}"),
            Theme::warn(),
        ))),
        Some(Ok(d)) => {
            let who = d
                .label
                .clone()
                .or_else(|| d.owner.as_deref().map(short))
                .unwrap_or_else(|| "(no agent)".to_string());
            lines.push(Line::from(vec![
                Span::styled(title(app.agent_ctx_mode), Theme::header()),
                Span::raw(" · "),
                Span::styled(who, Theme::dim()),
            ]));
            lines.push(Line::default());
            if d.owner.is_none() {
                lines.push(Line::from(Span::styled(
                    "agent not on the roster yet",
                    Theme::dim(),
                )));
            } else {
                match app.agent_ctx_mode {
                    AgentCtxMode::Prompt => prompt_lines(d, &mut lines),
                    AgentCtxMode::Mail => mail_lines(d, &mut lines),
                    AgentCtxMode::Work => work_lines(d, &mut lines),
                    AgentCtxMode::Orders => orders_lines(d, &mut lines),
                    AgentCtxMode::Activity => activity_lines(d, &mut lines),
                }
            }
        }
    }
    let para = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((app.agent_ctx_scroll, 0));
    f.render_widget(para, area);
}

fn title(mode: AgentCtxMode) -> &'static str {
    match mode {
        AgentCtxMode::Prompt => "✉ prompt",
        AgentCtxMode::Mail => "✉ mail",
        AgentCtxMode::Work => "☑ work",
        AgentCtxMode::Orders => "Orders",
        AgentCtxMode::Activity => "Activity",
    }
}

fn heading(lines: &mut Vec<Line<'_>>, text: impl Into<String>) {
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(text.into(), Theme::header())));
}

fn text_lines(lines: &mut Vec<Line<'_>>, text: &str) {
    lines.extend(text.lines().map(|line| Line::from(line.to_owned())));
}

fn field(lines: &mut Vec<Line<'_>>, name: &str, value: Option<&str>) {
    lines.push(Line::from(format!(
        "{name}: {}",
        value.unwrap_or("unavailable")
    )));
}

fn recorded_age(lines: &mut Vec<Line<'_>>, timestamp_ms: Option<u64>) {
    let age = timestamp_ms.and_then(|stamp| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis();
        now.checked_sub(u128::from(stamp)).map(|ms| ms / 1000)
    });
    match age {
        Some(seconds) => lines.push(Line::from(format!("recorded {seconds}s ago"))),
        None => lines.push(Line::from("recording time unavailable")),
    }
}

fn section<T>(
    lines: &mut Vec<Line<'_>>,
    name: &str,
    rows: Option<&[T]>,
    mut render: impl FnMut(&T, &mut Vec<Line<'_>>),
) {
    heading(lines, name);
    match rows {
        None => lines.push(Line::from("unavailable from this operator")),
        Some([]) => lines.push(Line::from("none")),
        Some(rows) => rows.iter().for_each(|row| render(row, lines)),
    }
}

fn orders_lines(d: &crate::models::AgentCtxData, lines: &mut Vec<Line<'_>>) {
    let Some(o) = &d.orders else {
        lines.push(Line::from("orders unavailable from this operator"));
        return;
    };
    let unavailable = |key: &str| {
        o.unavailable
            .as_ref()
            .is_some_and(|v| v.iter().any(|v| v == key))
    };
    if let Some(keys) = o.unavailable.as_ref().filter(|keys| !keys.is_empty()) {
        lines.push(Line::from(Span::styled(
            format!("unavailable: {}", keys.join(", ")),
            Theme::warn(),
        )));
    }
    heading(lines, "mission");
    match o.mission.as_ref().filter(|_| !unavailable("mission")) {
        None => lines.push(Line::from("mission unavailable")),
        Some(m) => {
            field(lines, "scope", m.constraint.as_deref());
            if let Some(text) = &m.explanation {
                text_lines(lines, text);
            }
            field(lines, "authority", m.authority.as_deref());
            field(lines, "route", m.route.as_deref());
            section(
                lines,
                "suppressed instructions",
                m.suppressed.as_deref(),
                |s, lines| {
                    text_lines(lines, &format!("{}: {} — {}", s.key, s.value, s.reason));
                },
            );
        }
    }
    section(
        lines,
        "modes",
        o.modes.as_deref().filter(|_| !unavailable("modes")),
        |m, lines| {
            let source = match m.owner_directed {
                Some(true) => "owner directed",
                Some(false) => "agent directed",
                None => "source unavailable",
            };
            lines.push(Line::from(format!("{} · {source}", m.mode)));
            if let Some(reason) = &m.reason {
                text_lines(lines, reason);
            }
        },
    );
    field(
        lines,
        "wake",
        o.wake_mode
            .as_ref()
            .filter(|_| !unavailable("wakeMode"))
            .and_then(|m| m.effective.as_deref()),
    );
    let directives_title = o
        .directives_total_open
        .map(|total| {
            format!(
                "owner directives · showing {} of {total}",
                o.directives.as_ref().map_or(0, Vec::len)
            )
        })
        .unwrap_or_else(|| "owner directives · total unavailable".into());
    section(
        lines,
        &directives_title,
        o.directives.as_deref(),
        |directive, lines| {
            lines.push(Line::from(format!("#{}", directive.id)));
            text_lines(lines, &directive.verbatim_text);
            if let Some(source) = &directive.source_turn_ref {
                field(lines, "source", Some(source));
            }
        },
    );
    section(
        lines,
        "standing facts",
        o.facts.as_deref(),
        |fact, lines| {
            let stale = if fact.possibly_stale == Some(true) {
                " · possibly stale"
            } else {
                ""
            };
            let contested = if fact.contested.is_some() {
                " · contested"
            } else {
                ""
            };
            lines.push(Line::from(format!("{}{stale}{contested}", fact.key)));
            text_lines(lines, &fact.body);
        },
    );
    section(lines, "walls", o.walls.as_deref(), |wall, lines| {
        text_lines(lines, &wall.claim);
        if let Some(recheck) = &wall.recheck {
            field(lines, "recheck", Some(recheck));
        }
    });
    heading(lines, "carry");
    match o.carry.as_ref().filter(|_| !unavailable("carry")) {
        None => lines.push(Line::from("carry unavailable")),
        Some(carry) => {
            field(lines, "context carry", carry.mode.as_deref());
            if let Some(generation) = carry.generation {
                lines.push(Line::from(format!("carry generation {generation}")));
            }
            recorded_age(lines, carry.note_updated_at_ms);
            field(
                lines,
                "loop",
                carry
                    .loop_active
                    .map(|active| if active { "active" } else { "inactive" }),
            );
            match &carry.note {
                Some(note) => text_lines(lines, note),
                None if carry.never_written == Some(true) => {
                    lines.push(Line::from("carry note never written"))
                }
                None => lines.push(Line::from("carry note unavailable")),
            }
            section(
                lines,
                "held items",
                carry.held_items.as_deref(),
                |item, lines| {
                    lines.push(Line::from(format!(
                        "{} {}",
                        item.id,
                        item.title.as_deref().unwrap_or("")
                    )));
                    if let Some(checkpoint) = &item.checkpoint {
                        recorded_age(lines, item.checkpoint_updated_at_ms);
                        text_lines(lines, checkpoint);
                    }
                },
            );
            section(
                lines,
                "carried checks",
                carry.checks.as_deref(),
                |check, lines| {
                    lines.push(Line::from(format!(
                        "{}: {}",
                        if check.verified.is_some() {
                            "verified"
                        } else {
                            "predicted"
                        },
                        check.claim
                    )));
                    if let Some(proof) = &check.verified {
                        text_lines(lines, proof);
                    }
                    if let Some(recheck) = &check.recheck {
                        field(lines, "recheck", Some(recheck));
                    }
                },
            );
            section(
                lines,
                "cited items now terminal",
                carry.cited_refs_terminal.as_deref(),
                |id, lines| {
                    lines.push(Line::from(Span::styled(id.clone(), Theme::warn())));
                },
            );
            section(lines, "awaits", carry.awaits.as_deref(), |a, lines| {
                lines.push(Line::from(a.event_key.clone()));
                if let Some(note) = &a.note {
                    text_lines(lines, note);
                }
            });
        }
    }
    // This is already the shared, priority-ordered obligation projection.
    section(
        lines,
        "obligations",
        o.obligation_rows
            .as_deref()
            .filter(|_| !unavailable("obligationRows")),
        |row, lines| {
            text_lines(lines, &row.text);
        },
    );
}

fn activity_lines(d: &crate::models::AgentCtxData, lines: &mut Vec<Line<'_>>) {
    let Some(a) = &d.activity else {
        lines.push(Line::from("activity unavailable from this operator"));
        return;
    };
    heading(lines, "activity");
    if let Some(signals) = &a.signals {
        let unavailable = |key: &str| {
            signals
                .unavailable_signals
                .as_ref()
                .is_some_and(|keys| keys.iter().any(|k| k == key))
        };
        if let Some(keys) = signals
            .unavailable_signals
            .as_ref()
            .filter(|keys| !keys.is_empty())
        {
            lines.push(Line::from(format!(
                "unavailable signals: {}",
                keys.join(", ")
            )));
        }
        let liveness = signals
            .liveness
            .as_ref()
            .filter(|_| !unavailable("liveness"));
        field(
            lines,
            "session",
            liveness.and_then(|live| live.session_state.as_deref()),
        );
        field(
            lines,
            "turn",
            liveness
                .and_then(|live| live.live_turn)
                .map(|live| if live { "speaking" } else { "silent" }),
        );
        heading(lines, "loop");
        match signals.r#loop.as_ref().filter(|_| !unavailable("loop")) {
            Some(loop_state) => {
                field(
                    lines,
                    "state",
                    loop_state
                        .active
                        .map(|active| if active { "active" } else { "inactive" }),
                );
                if loop_state.stalled == Some(true) {
                    lines.push(Line::from("stalled"));
                }
                if loop_state.parked == Some(true) {
                    lines.push(Line::from("parked"));
                }
                if let Some(seconds) = loop_state.interval_sec {
                    lines.push(Line::from(format!("interval: {seconds}s")));
                }
                field(lines, "next fire", loop_state.next_fire_at.as_deref());
            }
            None => lines.push(Line::from("loop unavailable or not armed")),
        }
        if unavailable("context") {
            field(lines, "context", None);
        } else {
            match (signals.context_tokens, signals.compaction_limit) {
                (Some(tokens), Some(limit)) => {
                    lines.push(Line::from(format!("context: {tokens} / {limit} tokens")))
                }
                _ => field(lines, "context", None),
            }
        }
        field(
            lines,
            "last tool call",
            signals
                .last_tool_call_at
                .as_deref()
                .filter(|_| !unavailable("lastToolCall")),
        );
        heading(lines, "current claim");
        match signals
            .current_claim
            .as_ref()
            .filter(|_| !unavailable("currentClaim"))
        {
            Some(claim) => {
                lines.push(Line::from(format!(
                    "{} {}",
                    claim.id,
                    claim.title.as_deref().unwrap_or("")
                )));
                field(lines, "progress", claim.progress.as_deref());
                if let Some(seconds) = claim.idle_sec {
                    lines.push(Line::from(format!("idle: {seconds}s")));
                }
            }
            None => lines.push(Line::from("current claim unavailable or not recorded")),
        }
        if let Some(checkpoint) = &signals.last_checkpoint {
            heading(lines, "checkpoint");
            recorded_age(lines, checkpoint.updated_at_ms);
            text_lines(lines, &checkpoint.text);
        }
    } else {
        lines.push(Line::from("activity signals unavailable"));
    }
    heading(lines, "locks");
    match &a.locks {
        Some(locks) if locks.error.is_none() => {
            section(lines, "held", locks.held.as_deref(), |lock, lines| {
                text_lines(lines, &format!("{} — {}", lock.path, lock.intent));
            });
            section(lines, "waiting", locks.waiting.as_deref(), |lock, lines| {
                text_lines(
                    lines,
                    &format!("{} — {}", lock.paths.join(", "), lock.intent),
                );
                if let Some(ahead) = lock.ahead_count {
                    lines.push(Line::from(format!("ahead in queue: {ahead}")));
                }
                for blocker in &lock.blocked_by {
                    text_lines(
                        lines,
                        &format!(
                            "{} held by {} — {}",
                            blocker.path, blocker.holder, blocker.intent
                        ),
                    );
                }
            });
        }
        Some(locks) => field(lines, "unavailable", locks.error.as_deref()),
        None => lines.push(Line::from("locks unavailable")),
    }
    heading(lines, "coordination");
    match &a.coord {
        Some(coord) if coord.error.is_none() => {
            let title = match (coord.unread.as_ref(), coord.unread_count) {
                (Some(rows), Some(total)) => format!("unread · showing {} of {total}", rows.len()),
                _ => "unread · coverage unavailable".into(),
            };
            let render = |m: &SidebarMessage, lines: &mut Vec<Line<'_>>| {
                if let Some(from) = &m.from {
                    field(lines, "from", Some(from));
                }
                if let Some(severity) = &m.severity {
                    field(lines, "severity", Some(severity));
                }
                text_lines(lines, &m.summary);
                if let Some(next) = &m.next_action {
                    field(lines, "next", Some(next));
                }
            };
            section(lines, &title, coord.unread.as_deref(), render);
            section(
                lines,
                "open handoffs",
                coord.open_handoffs.as_deref(),
                render,
            );
            section(
                lines,
                "open escalations",
                coord.open_escalations.as_deref(),
                render,
            );
        }
        Some(coord) => field(lines, "unavailable", coord.error.as_deref()),
        None => lines.push(Line::from("coordination unavailable")),
    }
    heading(lines, "subscriptions");
    match &a.subscriptions {
        Some(subs) if subs.error.is_none() => {
            let title = subs
                .count
                .map(|total| {
                    format!(
                        "events · showing {} of {total}",
                        subs.items.as_ref().map_or(0, Vec::len)
                    )
                })
                .unwrap_or_else(|| "events · total unavailable".into());
            section(lines, &title, subs.items.as_deref(), |item, lines| {
                lines.push(Line::from(item.event_key.clone()));
                field(
                    lines,
                    "delivery",
                    item.wakes.map(|wakes| {
                        if wakes {
                            "wakes the agent"
                        } else {
                            "observational"
                        }
                    }),
                );
                field(
                    lines,
                    "lifetime",
                    item.once
                        .map(|once| if once { "one shot" } else { "standing" }),
                );
                if let Some(expires) = &item.expires_ts {
                    field(lines, "expires", Some(expires));
                }
                if let Some(note) = &item.note {
                    text_lines(lines, note);
                }
            })
        }
        Some(subs) => field(lines, "unavailable", subs.error.as_deref()),
        None => lines.push(Line::from("subscriptions unavailable")),
    }
}

fn prompt_lines(d: &crate::models::AgentCtxData, lines: &mut Vec<Line<'_>>) {
    if let (Some(m), t) = (&d.model, &d.tier) {
        let tier = t.as_deref().map(|t| format!(" ({t})")).unwrap_or_default();
        lines.push(Line::from(Span::styled(
            format!("model: {m}{tier}"),
            Theme::dim(),
        )));
        lines.push(Line::default());
    }
    // The brief leads when present — it's the per-agent signal; the full
    // prompt below is mostly boilerplate shared across agents of the role.
    if let Some(b) = d.brief.as_deref().filter(|b| !b.trim().is_empty()) {
        lines.push(Line::from(Span::styled("brief", Theme::header())));
        for l in b.lines() {
            lines.push(Line::from(format!("  {l}")));
        }
        lines.push(Line::default());
    }
    match d.prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            let src = match d.source.as_deref() {
                Some("recorded") => "full prompt (recorded — what this run was invoked with)",
                Some("rendered") => "full prompt (rendered — what a fresh session of this role gets)",
                _ => "full prompt",
            };
            lines.push(Line::from(Span::styled(src, Theme::header())));
            for l in p.lines() {
                lines.push(Line::from(l.to_string()));
            }
        }
        None if d.brief.is_none() => lines.push(Line::from(Span::styled(
            "(no prompt available — run predates recording, or the agent is interactive with no role hint)",
            Theme::dim(),
        ))),
        None => lines.push(Line::from(Span::styled(
            "(full prompt not recorded for this run)",
            Theme::dim(),
        ))),
    }
}

fn mail_lines(d: &crate::models::AgentCtxData, lines: &mut Vec<Line<'_>>) {
    let Some(mail) = &d.mail else {
        lines.push(Line::from(Span::styled("loading…", Theme::dim())));
        return;
    };
    lines.push(Line::from(Span::styled(
        format!("inbox ({})", mail.inbox.total),
        Theme::header(),
    )));
    if mail.inbox.entries.is_empty() {
        lines.push(Line::from(Span::styled("  (empty)", Theme::dim())));
    }
    for m in &mail.inbox.entries {
        let from = m.from.as_deref().map(short).unwrap_or_default();
        lines.push(Line::from(vec![
            Span::styled(format!("  {:<10}", trunc(&m.kind, 10)), Theme::warn()),
            Span::styled(format!("{from} "), Theme::dim()),
            Span::raw(m.summary.clone().unwrap_or_default()),
        ]));
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        format!("outbox ({})", mail.outbox.total),
        Theme::header(),
    )));
    if mail.outbox.entries.is_empty() {
        lines.push(Line::from(Span::styled("  (empty)", Theme::dim())));
    }
    for m in &mail.outbox.entries {
        let to = m.to.first().map(|t| short(t)).unwrap_or_default();
        lines.push(Line::from(vec![
            Span::styled(format!("  {:<10}", trunc(&m.kind, 10)), Theme::warn()),
            Span::styled(format!("→{to} "), Theme::dim()),
            Span::raw(m.summary.clone().unwrap_or_default()),
        ]));
    }
}

fn work_lines(d: &crate::models::AgentCtxData, lines: &mut Vec<Line<'_>>) {
    let Some(a) = &d.assignment else {
        lines.push(Line::from(Span::styled(
            "(no assignment — nothing queued for this agent)",
            Theme::dim(),
        )));
        return;
    };
    if !a.intent.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("intent: ", Theme::dim()),
            Span::raw(a.intent.clone()),
        ]));
    }
    if let Some(p) = &a.declared_plan_slug {
        lines.push(Line::from(vec![
            Span::styled("plan:   ", Theme::dim()),
            Span::styled(p.clone(), Theme::header()),
        ]));
    }
    let claimed: Vec<&str> = a
        .claims
        .iter()
        .filter_map(|c| c.plan_slug.as_deref())
        .collect();
    if !claimed.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("claims: ", Theme::dim()),
            Span::raw(claimed.join(", ")),
        ]));
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        format!("work items ({})", a.queued.len()),
        Theme::header(),
    )));
    if a.queued.is_empty() {
        lines.push(Line::from(Span::styled("  (none queued)", Theme::dim())));
    }
    for w in &a.queued {
        let status = w.status.as_deref().unwrap_or("-");
        let rank = w
            .rank
            .map(|r| format!("#{r}"))
            .unwrap_or_else(|| "·".to_string());
        lines.push(Line::from(vec![
            Span::styled(format!("  {:<3}", rank), Theme::dim()),
            Span::styled(format!("{:<12}", trunc(&w.id, 12)), Theme::header()),
            Span::styled(format!("{:<9}", trunc(status, 9)), Theme::warn()),
            Span::raw(trunc(&w.title, 60)),
        ]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};
    use serde_json::json;

    fn render(
        mode: AgentCtxMode,
        orders: serde_json::Value,
        activity: serde_json::Value,
    ) -> String {
        let mut app = App::new();
        app.agent_ctx_mode = mode;
        app.agent_ctx = Some(Ok(crate::models::AgentCtxData {
            owner: Some("su-selected".into()),
            orders: serde_json::from_value(orders).unwrap(),
            activity: serde_json::from_value(activity).unwrap(),
            ..Default::default()
        }));
        let mut terminal = Terminal::new(TestBackend::new(100, 100)).unwrap();
        terminal
            .draw(|f| draw_agent_ctx(f, &app, f.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        (0..100)
            .map(|y| {
                (0..100)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn orders_pane_preserves_owner_text_shared_obligations_and_partial_total() {
        let text = render(
            AgentCtxMode::Orders,
            json!({
                "mission": { "constraint":"execute-owner-directed-scope", "authority":"act-and-report", "route":"self",
                    "suppressed":[{"key":"route","value":"ask","reason":"AUTO approved"}] },
                "modes":[{"mode":"auto","ownerDirected":true,"reason":"Ship the Workbench"}],
                "wakeMode":{"effective":"manual"},
                "directives":[{"id":47,"verbatimText":"Exact owner's words\nSecond line.","sourceTurnRef":"turn:47"}],
                "directivesTotalOpen":9,
                "facts":[{"key":"guard","body":"Keep this sentence.","possiblyStale":true,"contested":{"note":"disputed"}}],
                "walls":[],
                "carry":{"mode":"cold","loopActive":true,"note":"Recorded carry note", "heldItems":[],
                    "checks":[{"claim":"Installed app works","recheck":"Run native acceptance"}],
                    "citedRefsTerminal":["WI-terminal"],"awaits":[]},
                "obligationRows":[{"order":3,"text":"Shared obligation first"},{"order":8,"text":"Shared obligation second"}]
            }),
            json!(null),
        );
        for expected in [
            "Orders",
            "act-and-report",
            "route: self",
            "auto · owner directed",
            "wake: manual",
            "showing 1 of 9",
            "Exact owner's words",
            "Second line.",
            "turn:47",
            "possibly stale · contested",
            "Recorded carry note",
            "predicted: Installed app works",
            "Run native acceptance",
            "WI-terminal",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
        assert!(
            text.find("Shared obligation first").unwrap()
                < text.find("Shared obligation second").unwrap()
        );
    }

    #[test]
    fn orders_pane_keeps_failed_absent_empty_and_never_written_distinct() {
        let failed = render(
            AgentCtxMode::Orders,
            json!({
                "mission":{"authority":"act-and-report"}, "modes":[{"mode":"auto"}],
                "unavailable":["mission","modes","obligationRows"], "obligationRows":[],
                "walls":[], "carry":{"neverWritten":true}
            }),
            json!(null),
        );
        assert!(failed.contains("mission unavailable"));
        assert!(!failed.contains("act-and-report"));
        assert!(!failed.contains("auto ·"));
        assert!(failed.contains("carry note never written"));
        assert!(failed.contains("standing facts"));
        let mut lines = Vec::new();
        section::<String>(&mut lines, "old field", None, |_, _| {});
        section::<String>(&mut lines, "known empty", Some(&[]), |_, _| {});
        let text = lines
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            text,
            "\nold field\nunavailable from this operator\n\nknown empty\nnone"
        );
        let old = render(AgentCtxMode::Orders, json!({}), json!(null));
        assert!(!old.contains("never written"));
        assert!(old.contains("carry unavailable"));
    }

    #[test]
    fn activity_pane_uses_authoritative_unread_total_and_lock_blocker() {
        let text = render(
            AgentCtxMode::Activity,
            json!(null),
            json!({
                "locks":{"held":[],"waiting":[{"paths":["src/a.rs"],"intent":"change", "aheadCount":2,
                    "blockedBy":[{"path":"src/a.rs","holder":"su-blocker","intent":"atomic fix"}]}],"error":null},
                "coord":{"unreadCount":38,"unread":[{"from":"su-peer","summary":"A real message"}],
                    "openHandoffs":[{"summary":"Hand over","nextAction":"Verify installed app"}],"openEscalations":[]},
                "signals":{"liveness":{"sessionState":"parked","liveTurn":false},"loop":{"active":true,"parked":true,"stalled":false,"intervalSec":60},
                    "contextTokens":120,"compactionLimit":200,"currentClaim":{"id":"WI-held","title":"Implement", "progress":"unknown"},
                    "lastCheckpoint":{"text":"Saved evidence"}, "unavailableSignals":[]},
                "subscriptions":{"count":1,"items":[{"eventKey":"work-item:done:WI-dep","note":"Unblocks native proof"}]}
            }),
        );
        for expected in [
            "Activity",
            "showing 1 of 38",
            "A real message",
            "su-blocker",
            "atomic fix",
            "next: Verify installed app",
            "context: 120 / 200 tokens",
            "WI-held",
            "progress: unknown",
            "Saved evidence",
            "work-item:done:WI-dep",
            "session: parked",
            "turn: silent",
            "interval: 60s",
        ] {
            assert!(text.contains(expected), "missing {expected}: {text}");
        }
        assert!(!text.contains("unread · showing 1 of 1"));
    }

    #[test]
    fn activity_pane_never_presents_failed_reads_as_empty_or_zero() {
        let text = render(
            AgentCtxMode::Activity,
            json!(null),
            json!({
                "locks":{"error":"locks store unreachable","held":[],"waiting":[]},
                "coord":{"error":"coord read failed","unreadCount":0,"unread":[]},
                "signals":{"contextTokens":0,"compactionLimit":200,"unavailableSignals":["context","currentClaim"]},
                "subscriptions":{"error":"events read failed","items":[]}
            }),
        );
        for error in [
            "locks store unreachable",
            "coord read failed",
            "events read failed",
            "context: unavailable",
        ] {
            assert!(text.contains(error), "{text}");
        }
        assert!(!text.contains("0 / 200"));
        assert!(!text.contains("of 0"));
        assert!(!text.contains("\nnone"));
        let old = render(AgentCtxMode::Activity, json!(null), json!({}));
        assert!(old.contains("activity signals unavailable"));
        assert!(old.contains("locks unavailable"));
        assert!(old.contains("coordination unavailable"));
    }

    #[test]
    fn sidebar_invalidations_are_query_and_owner_scoped() {
        use crate::app::WakeFilter;
        let scope = WakeFilter::Owner("su-selected".into());
        for name in ["agentOrders.byOwner", "agentDetail.byOwner"] {
            let mode = if name == "agentOrders.byOwner" {
                AgentCtxMode::Orders
            } else {
                AgentCtxMode::Activity
            };
            assert!(matches_sidebar_invalidation(
                mode,
                &scope,
                &json!({"name":name,"args":{"ownerId":"su-selected"}}).to_string()
            ));
            assert!(!matches_sidebar_invalidation(
                mode,
                &scope,
                &json!({"name":name,"args":{"ownerId":"su-other"}}).to_string()
            ));
            assert!(matches_sidebar_invalidation(
                mode,
                &scope,
                &json!({"name":name}).to_string()
            ));
        }
        assert!(!matches_sidebar_invalidation(
            AgentCtxMode::Orders,
            &scope,
            r#"{"name":"agentDetail.byOwner"}"#
        ));
        assert!(matches_sidebar_invalidation(
            AgentCtxMode::Orders,
            &scope,
            r#"{"name":"advRoster.list"}"#
        ));
        assert!(!matches_sidebar_invalidation(
            AgentCtxMode::Orders,
            &scope,
            "malformed"
        ));
    }
}
