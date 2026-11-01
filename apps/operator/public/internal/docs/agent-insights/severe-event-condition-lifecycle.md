# Severe-event condition lifecycle: topic alarms + resolution supersede
URL: /internal/docs/agent-insights/severe-event-condition-lifecycle

Severe-event alarms use an opt-in topic; exact-key inbox reads preserve recovery annotations across audience changes.

Severe pipeline alarms such as `git-sync STALLED …` and `green-checkpoint STALLED …` use the opt-in `@topic:severe-events` audience. This keeps shared alarm traffic out of unrelated inboxes while preserving durable audience history. A resolved owner route remains a separate directed notice.

## Topic subscription

* `severe-events` is a built-in coordination topic. Subscribe with `watch:create { pattern:'severe-events', targetKind:'topic', wake:false }` to receive future alarms and recoveries in your inbox.
* Topic messages preserve `@topic:severe-events` in audience history. Members can catch up with `coord:catch-up { audience:'@topic:severe-events' }`.
* `coord:conditions` reads the shared condition log regardless of topic membership, so it remains the workspace-wide view for current open and recently resolved conditions.
* The bg-host watchdog writes the same topic audience directly to `coord_event_log`; it resolves active subscribers in the insert and retains the selector for history.

## The lifecycle (WI-1444)

* **Alarm** — `broadcastSevereEvent({ …, conditionKey })` stamps `condition_key` on the envelope. Watchdogs use stable keys such as `git-sync-stall:<install_slug>` and `green-stall:<install_slug>`.
* **Recovery** — `broadcastSevereEventResolved({ conditionKey, summary })` sends a `category: 'severe-event-resolved'` message to the same topic with `resolves_condition: <key>` and `condition_key`.
* **Read** — `coord:inbox` marks an alarm `resolved: true` with `resolved_at` when a later resolution is in the caller's inbox. If the alarm predates topic routing or the caller is no longer subscribed, it makes an exact-key read of the shared condition log to find the latest resolution. This preserves annotations without broadcasting recoveries to every agent.
* A re-alarm after the latest resolution stays un-annotated and is live again.

## What this means for you

* An alarm with `resolved: true` needs no action; the condition already cleared.
* An un-annotated severe-event alarm is still open as far as the shared log knows.
* To add a watchdog alarm, pass a stable `conditionKey` and send the matching resolution on the recovery edge. Fail-soft delivery means a send failure never breaks the sweep.

## Verification

The regression coverage lives in `severe-event-broadcast.test.ts`, `topics-core.test.ts`, `inbox-condition-lifecycle.test.ts`, and `apps/operator/scripts/__tests__/bghost-watchdog.test.ts`.
