'use client';

/**
 * Browser-side PostHog initialization.
 *
 * Telemetry is OFF by default. This provider does:
 *   1. On mount, GET /api/desktop/telemetry-config.
 *   2. If `enabled === false` → DO NOTHING (no posthog-js import, no
 *      cookies set, no network requests to PostHog).
 *   3. If `enabled === true` AND host + project_key are present →
 *      dynamic-import posthog-js for explicitly consented event capture.
 *      Automatic pageview, pageleave, autocapture, and session recording are
 *      disabled. The shared consent check and implementation live in
 *      `packages/operator-ui/src/browser-telemetry.tsx`.
 *
 * The dynamic import is deliberate — when telemetry is off, the
 * posthog-js bundle never even ships to the user.
 *
 * This is mounted from the root layout but only contributes JS when
 * the wizard's telemetry toggle is on.
 */
export { PostHogProvider, captureBrowserTelemetry } from '@papercusp/operator-ui/browser-telemetry';
