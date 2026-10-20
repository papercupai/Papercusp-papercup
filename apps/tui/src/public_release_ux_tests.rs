//! Dedicated R-14 / P-002 regression coverage. These offline integration checks
//! reuse the maintained Rust surfaces; they do not certify an installed release.

use crate::app::{Action, App, Tab};
use crate::event::Event;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{backend::TestBackend, Terminal};
use serde_json::json;

fn press(app: &mut App, code: KeyCode, modifiers: KeyModifiers) -> Action {
    app.update(Event::Key(KeyEvent::new(code, modifiers)))
}

fn render(app: &App, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|frame| crate::ui::draw(frame, app)).unwrap();
    terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect()
}

fn composing() -> App {
    let mut app = App::new();
    app.tab = Tab::Operator;
    app.chat_composing = true;
    app.chat_input = "未送信 draft\nsecond line".into();
    app
}

fn receive_question(app: &mut App) {
    app.agent_chat_id = Some("r14-chat".into());
    app.card_state.apply_snapshot(
        crate::card_view::SnapshotEnvelope::from_json(&json!({
            "runId": "r14-run", "version": 1, "workspaceId": "r14-workspace",
            "snapshot": {"openCards": [{"correlationId":"r14-question", "prompt":"Keep or change?",
                "presentation":{"kind":"radio","options":[
                    {"id":"keep","label":"Keep"},{"id":"change","label":"Change"}
                ]}}]}
        }).to_string())
        .unwrap(),
    );
}

#[test]
fn r14_p002_registry_reuse_and_required_screen_states_remain_explicit() {
    let contract = include_str!("../PUBLIC_RELEASE_UX.md");
    let ir: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docs/mockups/pui-public-release-ux.ir.json"
    ))
    .unwrap();
    assert!(
        contract.contains("design-registry lookup for ecosystem ratatui returned no components")
    );
    for source in [
        "app.rs",
        "ui.rs",
        "plans_board.rs",
        "su_session.rs",
        "session_config.rs",
        "card_view.rs",
        "semantic_tool_cards.rs",
        "agent_chats.rs",
        "tutorial.rs",
    ] {
        assert!(
            contract.contains(&format!("src/{source}")),
            "missing reuse route: {source}"
        );
        assert!(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(source)
            .is_file());
    }
    assert_eq!(ir["ecosystem"], "ratatui");
    for state in [
        "first-run",
        "session-picker",
        "settings-palette",
        "approval",
        "error-recovery",
        "attachment-picker",
        "about-support",
        "too-small",
    ] {
        assert!(ir["states"][state].is_object(), "missing state: {state}");
    }
    for requirement in [
        "First-run UX",
        "Chat UX",
        "Task-list/editor UX",
        "Session-picker UX",
        "Settings/command palette UX",
        "Approval UX",
        "Error/recovery UX",
        "Compact-terminal UX",
        "Launcher conflict",
        "Release matrix",
        "Keyboard and copy",
    ] {
        let crosswalk = contract.split("## Acceptance crosswalk").nth(1).unwrap();
        assert!(
            crosswalk.contains(&format!("| {requirement} |")),
            "missing crosswalk: {requirement}"
        );
    }
}

#[test]
fn r14_p002_switcher_owns_typing_and_escape_restores_the_composer() {
    let mut app = composing();
    let draft = app.chat_input.clone();
    assert!(matches!(
        press(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL),
        Action::FetchSessionSwitcher { .. }
    ));
    for key in ['q', 'o', '2'] {
        press(&mut app, KeyCode::Char(key), KeyModifiers::NONE);
    }
    assert_eq!(app.session_switcher.as_ref().unwrap().query, "qo2");
    assert_eq!(app.tab, Tab::Operator);
    assert_eq!(app.chat_input, draft);
    assert!(!app.should_quit);
    assert!(render(&app, 80, 24).contains("Sessions"));
    press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
    assert!(app.session_switcher.is_none());
    assert!(app.chat_composing);
    assert_eq!(app.chat_input, draft);
    assert!(!app.should_quit);
}

#[test]
fn r14_p002_palette_captures_navigation_and_closes_only_its_layer() {
    let mut app = composing();
    app.chat_composing = false;
    let draft = app.chat_input.clone();
    press(&mut app, KeyCode::Char(':'), KeyModifiers::NONE);
    assert!(app.palette_open);
    for key in ['q', 'o', '2'] {
        press(&mut app, KeyCode::Char(key), KeyModifiers::NONE);
    }
    assert_eq!(app.palette_input, "qo2");
    assert_eq!(app.tab, Tab::Operator);
    assert_eq!(app.chat_input, draft);
    assert!(!app.should_quit);
    press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
    assert!(!app.palette_open);
    assert_eq!(app.tab, Tab::Operator);
    assert_eq!(app.chat_input, draft);
    assert!(!app.should_quit);
}

#[test]
fn r14_p002_composer_keeps_quit_and_destination_letters_as_text() {
    let mut app = composing();
    let draft = app.chat_input.clone();
    for key in ['q', 'o', '2'] {
        press(&mut app, KeyCode::Char(key), KeyModifiers::NONE);
    }
    assert_eq!(app.chat_input, format!("{draft}qo2"));
    assert_eq!(app.tab, Tab::Operator);
    assert!(app.chat_composing);
    assert!(!app.should_quit);
}

#[test]
fn r14_p002_context_round_trip_preserves_draft_in_compact_and_wide_frames() {
    for (width, height) in [(80, 24), (180, 40)] {
        let mut app = composing();
        app.update(Event::Resize(width, height));
        let draft = app.chat_input.clone();
        assert!(render(&app, width, height).contains("second line"));
        assert_eq!(
            press(&mut app, KeyCode::Char('t'), KeyModifiers::CONTROL),
            Action::FetchContextProjection
        );
        assert_eq!(app.tab, Tab::PlansBoard);
        assert!(!app.chat_composing);
        assert!(render(&app, width, height).contains("Context"));
        // With no task selected this verb must not navigate to Sessions.
        press(&mut app, KeyCode::Char('s'), KeyModifiers::NONE);
        assert_eq!(app.tab, Tab::PlansBoard);
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(app.tab, Tab::Operator);
        assert!(app.chat_composing);
        assert_eq!(app.chat_input, draft);
        assert!(render(&app, width, height).contains("second line"));
        assert!(!app.should_quit);
    }
}

#[test]
fn r14_p002_blocking_question_owns_answer_keys_before_composer_and_navigation() {
    let mut app = composing();
    receive_question(&mut app);
    let draft = app.chat_input.clone();
    assert!(render(&app, 80, 24).contains("Keep or change?"));
    let action = press(&mut app, KeyCode::Char('2'), KeyModifiers::NONE);
    assert!(matches!(action, Action::CardRespond {
        correlation_id, workspace_id, payload: Some(payload), ..
    } if correlation_id == "r14-question" && workspace_id.as_deref() == Some("r14-workspace")
        && payload == json!({"picks":["change"]})));
    assert_eq!(app.tab, Tab::Operator);
    assert_eq!(app.chat_input, draft);
    assert!(!app.should_quit);
}

#[test]
fn r14_p002_late_question_preempts_and_restores_existing_modals() {
    for modal in ["attachment picker", "palette", "session switcher"] {
        let mut app = composing();
        let project = tempfile::tempdir().unwrap();
        app.project_root = project.path().to_path_buf();
        match modal {
            "attachment picker" => {
                app.open_file_picker();
            }
            "palette" => {
                app.palette_open = true;
            }
            _ => {
                press(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL);
            }
        }
        let draft = app.chat_input.clone();
        receive_question(&mut app);
        let mut question_only = composing();
        question_only.project_root = project.path().to_path_buf();
        receive_question(&mut question_only);
        let frame = render(&app, 80, 24);
        assert!(frame.contains("Keep or change?"));
        assert_eq!(
            frame,
            render(&question_only, 80, 24),
            "{modal} covered the question"
        );
        let action = press(&mut app, KeyCode::Char('2'), KeyModifiers::NONE);
        assert!(
            matches!(action, Action::CardRespond {
            correlation_id, workspace_id, payload: Some(payload), ..
        } if correlation_id == "r14-question" && workspace_id.as_deref() == Some("r14-workspace")
            && payload == json!({"picks":["change"]})),
            "{modal} stole the question's answer"
        );
        assert_eq!(app.chat_input, draft);
        assert_eq!(app.tab, Tab::Operator);
        assert!(!app.should_quit);
        // The authoritative close releases question focus, revealing the same
        // modal. The answer digit must never have edited its query or draft.
        app.card_state
            .apply_snapshot(crate::card_view::SnapshotEnvelope {
                run_id: "r14-run".into(),
                workspace_id: Some("r14-workspace".into()),
                version: 2,
                cards: vec![],
            });
        match modal {
            "attachment picker" => assert_eq!(app.open_file_picker.as_ref().unwrap().query, ""),
            "palette" => {
                assert!(app.palette_open);
                assert_eq!(app.palette_input, "");
            }
            _ => assert_eq!(app.session_switcher.as_ref().unwrap().query, ""),
        }
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert!(
            app.open_file_picker.is_none() && !app.palette_open && app.session_switcher.is_none()
        );
        assert_eq!(app.chat_input, draft);
        assert!(app.chat_composing);
    }
}

#[test]
fn r14_p002_too_small_frame_holds_hidden_input_until_resize() {
    let mut app = composing();
    let draft = app.chat_input.clone();
    app.update(Event::Resize(79, 19));
    assert!(render(&app, 79, 19).contains("Terminal too small"));
    assert_eq!(
        press(&mut app, KeyCode::Char('x'), KeyModifiers::NONE),
        Action::None
    );
    assert_eq!(app.chat_input, draft);
    assert!(!app.should_quit);
    app.update(Event::Resize(80, 24));
    assert!(render(&app, 80, 24).contains("second line"));
    assert_eq!(app.chat_input, draft);
}
