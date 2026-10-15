---
title: Fixture message triage
slug: integrations-setup-triage
status: draft
---

# Fixture message triage

## Now

**State:** Test-only template. Installation makes this trigger pack available but does not arm it.

**Next:** Pick the channels and the destination project on Settings → Integrations, review the
disarmed binding, and arm it explicitly.

## Background

Test-only pack for plan cupboard-distributable-integrations-2026-10-10 R-2. It has the bug-triage
setup shape (channels to watch, a destination project) so a private operator can prove the whole
setup is completed on Settings → Integrations: the page fills both pickers from an installed
provider, saves the choices, and arms only after review.

## Phase 1 — Record

- **P-001** `todo` Record the fixture message text and the chosen destination as this plan's output. Do nothing else.

## Decisions

## Requirements

**R-1 — Fixture message recorded.**
```requirement
{
  "intent": {
    "request": "Record the triggering fixture message text and the chosen destination as this plan's output.",
    "constraints": [
      "Source references name the plan items that implement this outcome."
    ],
    "sourceRefs": [
      "P-001"
    ]
  },
  "acceptance": {
    "condition": "The plan output holds the triggering message text and the chosen destination, and nothing else happens.",
    "falsifier": "The output is missing, holds other text, or the run takes any other action.",
    "requiredScope": [
      "plan-run"
    ],
    "evidencePlane": "tree"
  },
  "verification": {
    "method": "Read the installed plan template and trace one representative trigger run against its input and recorded output.",
    "check": {
      "kind": "instrument",
      "instrumentKey": "none"
    },
    "replication": "Repeat the review for each trigger event the binding admits."
  }
}
```

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
