---
title: Reply to inbound Outlook mail
slug: outlook-reply-2026-10-06
status: ready
created: 2026-10-06
updated: 2026-10-06
---

# Reply to inbound Outlook mail

## Now

**State:** Ready pack template.

**Next:** Draft a reply to the triggering message.

## Requirements

**R-1 — Reply to the triggering message.**
```requirement
{"intent":{"request":"Draft one reply to the inbound message that triggered this run.","constraints":["Read the triggering event through triggers:read-payload."],"sourceRefs":["P-001"]},"acceptance":{"condition":"A run of this template drafts exactly one reply to its triggering message.","falsifier":"A run completes without a draft, or drafts more than one reply.","requiredScope":["tree"],"evidencePlane":"tree"},"verification":{"method":"Fire the pack binding through the binding engine and read the resulting run.","check":{"kind":"instrument","instrumentKey":"none"},"replication":"Run the independent-author journey suite."}}
```

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |

## Phase 1 — Reply

- **P-001** `todo` Read the triggering message and draft a reply in the configured tone.
