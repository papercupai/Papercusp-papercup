# Creating rules and events without code
URL: /internal/docs/agent-insights/creating-rules-and-events-without-code

Use agent tools to author, test, enable, execute, and share local rules and event types without editing source code.

## What this enables

Agents can create local rules and event types through the existing agent tools. Rule authoring stores a disabled revision in Postgres; event authoring uses `events:emit { save: true }` to persist a typed event declaration. These tools extend the existing rule registry and event-key registry rather than creating parallel stores.

## Safe lifecycle

For a rule, use `rules:validate`, `rules:create`, `rules:test`, then `rules:enable`. Creation and edits start disabled. Enabling requires a passing replay for the same revision, and any edit invalidates that proof. `rules:disable` and `rules:delete` remain available as recovery controls. Local rules execute within the author’s live wearer identity, workspace or pot scope, capability ceilings, fire budgets, and existing receipt paths. Authoring a definition does not grant capabilities.

For events, call `events:emit` with `announce: true, save: true`, a description, and an optional synchronous JSON payload schema. Saving declares and catalogs the event type without firing it. A later normal emit validates the payload and wakes matching awaits. Invalid payloads are rejected before dispatch. Event keys are scoped to the workspace and preserve contributor ownership.

## Test before relying on it

Use `rules:test` to replay bounded matching tool or event history. It is a dry run with no executor dispatch and reports unknown when the ledger lacks the required result or condition inputs. Test the matching, nonmatching, disabled, edited, and reloaded cases before enabling. The maintained suites are `packages/operator-core/lib/agent-tools/rules/lifecycle.test.ts`, `packages/operator-core/lib/events/authored-rule-test.test.ts`, `packages/operator-core/lib/events/local-rule-runtime.integration.test.ts`, and `packages/operator-core/lib/events/saved-event-type.integration.test.ts`.

## Sharing

Use `cupboard:publish-rule { exportOnly: true }` or `cupboard:publish-event { exportOnly: true }` to export a portable package. Export-only writes a local directory and does not contact GitHub or submit a listing. Push the returned directory to the intended mirror, then publish the listing through the normal reviewed Cupboard flow. A fresh workspace installs the package and claims the event or rule through its existing registry seam; installed packages remain inert until explicitly worn or enabled. Sharing carries curated definitions and payload contracts, never local receipts, grants, lifecycle state, or derived measurements.

## Boundaries

The tools do not create executable capability classes, providers, transport adapters, hook implementations, parser instruments, or kernel authority. Those remain reviewed source or plugin contributions. Structured rubric checks, watches, schedules, topics, and voice channels already provide authorable measurement, alerting, recurrence, and communication paths. Disable a rule immediately if its behavior is wrong; deletion is available for cleanup.
