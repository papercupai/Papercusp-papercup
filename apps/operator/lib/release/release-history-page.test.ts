import { describe, expect, it } from 'vitest';
import {
  assertReleaseHistoryIndexSizeBudget,
  escapeHtml,
  formatBytes,
  groupReleaseCards,
  INSTRUCTIONS_BODY_ID,
  INSTRUCTIONS_LOADER_ATTR,
  INSTRUCTIONS_PAGE_PATH,
  MAX_RELEASE_HISTORY_INDEX_BYTES,
  planPagePath,
  renderHistoryJson,
  renderHoldingHtml,
  renderIndexHtml,
  renderInstructionsHtml,
  renderPlanPageHtml,
  renderProductDownloads,
  renderProjectHistoryPage,
  renderWorkItemPageHtml,
  workItemPagePath,
  type Analytics,
  type HydratedRelease,
} from './release-history-page';
import { groupItemsByPlan, isUserFacing, type ReleaseRow, type ShippedItem, type ShippedPlan } from './release-registry';
import { DISCORD_URL, INSTRUCTIONS_MD } from './release-instructions';
import { partialScopeApprovalNote } from './release-partial-scope';
import { HOLDING_PAGE_MARKER, PUBLISHED_CONTACT_EMAIL } from './release-content-scrub';
import { DEMO_VIDEO_SRC } from './release-video';
import { releaseHistoryStem } from './release-project-history';

const ANALYTICS: Analytics = { host: 'https://flags.example.com', projectKey: 'phc_test' };
const GENERATED_AT = new Date('2026-07-13T00:00:00Z');

/** The index minus its Instructions loader — the one script that is not the beacon (owner #868). */
const LOADER_RE = new RegExp(`<script ${INSTRUCTIONS_LOADER_ATTR}>[\\s\\S]*?</script>`);
const withoutInstructionsLoader = (html: string) => html.replace(LOADER_RE, '');
const withoutOptionalLoaders = (html: string) => withoutInstructionsLoader(html)
  .replace(/<script data-product-downloads>[\s\S]*?<\/script>/, '');

function row(over: Partial<ReleaseRow> = {}): ReleaseRow {
  return {
    version: '0.0.9',
    channel: 'alpha',
    cutAt: new Date('2026-07-12T00:00:00Z'),
    publishedAt: null,
    changelogMd: '## Highlights\n\nAuto-update actually works now.',
    workItemIds: ['WI-1'],
    planSlugs: ['a-plan'],
    artifacts: [
      {
        product: 'gui',
        platform: 'linux-x86_64',
        name: 'papercusp_0.0.9_amd64.deb',
        url: 'desktop-v0.0.9-alpha/papercusp_0.0.9_amd64.deb',
        size: 4_200_000_000,
        sha256: 'abc123',
      },
    ],
    gitSha: 'deadbeefcafe1234',
    cutBy: 'su-test',
    notes: null,
    ...over,
  };
}

function plan(over: Partial<ShippedPlan> = {}): ShippedPlan {
  return {
    slug: 'a-plan',
    title: 'A Plan',
    status: 'active',
    content: '# A Plan\n\nBody text.',
    itemCount: 1,
    ...over,
  };
}

function hydrated(over: Partial<HydratedRelease> = {}): HydratedRelease {
  return {
    row: row(),
    items: [{ id: 'WI-1', title: 'Fix the updater', planSlug: 'a-plan' }],
    plans: [plan()],
    internalCount: 0,
    ...over,
  };
}

describe('work items expand to their full body (WI-5525)', () => {
  it('wraps an item in a click-to-expand <details> when it has a body', () => {
    const html = renderIndexHtml(
      [
        hydrated({
          items: [
            { id: 'WI-9', title: 'Ship the thing', summary: 'The full body.\nSecond detail line.', planSlug: null },
          ],
          plans: [],
        }),
      ],
      { generatedAt: GENERATED_AT, analytics: null },
    );
    // The id+title stay the clickable summary; the panel carries the full body.
    expect(html).toContain('<details><summary><span class="wid">WI-9</span>Ship the thing</summary>');
    expect(html).toContain('class="item-body"');
    expect(html).toContain('The full body.');
    expect(html).toContain('Second detail line.');
  });

  it('renders a plain row (no expander) when the item has no body', () => {
    const html = renderIndexHtml(
      [hydrated({ items: [{ id: 'WI-9', title: 'No body item', summary: '', planSlug: null }], plans: [] })],
      { generatedAt: GENERATED_AT, analytics: null },
    );
    expect(html).toContain('No body item');
    // not wrapped in an item-level details/summary
    expect(html).not.toContain('<summary><span class="wid">WI-9</span>');
    expect(html).not.toContain('class="item-body"');
  });

  it('escapes the body — HTML in a work-item summary is not evaluated (public page)', () => {
    const html = renderIndexHtml(
      [hydrated({ items: [{ id: 'WI-9', title: 'x', summary: '<img src=x onerror=alert(1)>', planSlug: null }], plans: [] })],
      { generatedAt: GENERATED_AT, analytics: null },
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});

describe('work-item detail pages and explicit navigation', () => {
  it('builds relative, sanitized paths without exposing the secret base', () => {
    expect(workItemPagePath('WI-123')).toBe('work-items/WI-123.html');
    expect(workItemPagePath('../WI 123/secret')).toBe('work-items/..-WI-123-secret.html');
  });

  it('links preview items and plans explicitly from the release index', () => {
    const html = renderIndexHtml([hydrated()], {
      generatedAt: GENERATED_AT,
      analytics: null,
      redact: [],
    });
    expect(html).toContain('href="work-items/WI-1.html"');
    expect(html).toContain('View full work item →');
    expect(html).toContain('href="plans/a-plan.html"');
    expect(html).toContain('View full plan →');
    expect(html).toContain('href="changes/desktop-v0.0.9-alpha.html"');
  });

  it('fails generation when the index exceeds its UTF-8 byte budget (EI-23963957634267483)', () => {
    const withinBudget = 'é'.repeat(Math.floor(MAX_RELEASE_HISTORY_INDEX_BYTES / 2));
    expect(() => assertReleaseHistoryIndexSizeBudget(withinBudget)).not.toThrow();
    expect(() => assertReleaseHistoryIndexSizeBudget(`${withinBudget}é`)).toThrow(
      /exceeds its 5242880-byte generation budget/,
    );
  });

  it('keeps the landing index bounded and leaves older items on the full release page (EI-23963957634267483)', () => {
    const items = Array.from({ length: 2_000 }, (_, index) => ({
      id: `WI-${String(index).padStart(4, '0')}`,
      title: `Work item ${index}`,
      summary: `LONG_BODY_${String(index).padStart(4, '0')}_${'x'.repeat(2_048)}`,
      planSlug: null,
    }));
    const release = hydrated({
      row: row({ workItemIds: items.map((item) => item.id), planSlugs: [] }),
      items,
      plans: [],
      internalCount: 0,
    });
    const options = { generatedAt: GENERATED_AT, analytics: null, redact: [] };
    const indexHtml = renderIndexHtml([release], options);

    expect(indexHtml).toContain('Showing the 50 most recent of 2000 user-facing work items');
    expect(indexHtml).toContain('LONG_BODY_1999');
    expect(indexHtml).not.toContain('LONG_BODY_0000');
    expect(indexHtml).toContain('href="work-items/WI-1999.html"');
    expect(indexHtml).toContain('href="changes/desktop-v0.0.9-alpha.html"');
    expect(indexHtml.length).toBeLessThan(1_000_000);

    const releaseHtml = renderProjectHistoryPage(release, options);
    expect(releaseHtml).toContain('LONG_BODY_0000');
    expect(releaseHtml).toContain('LONG_BODY_1999');
  });

  it('renders canonical metadata and structured verification while escaping public content', () => {
    const html = renderWorkItemPageHtml(
      {
        id: 'WI-9',
        title: 'Ship <safe> details',
        summary: 'Public description <script>alert(1)</script>',
        planSlug: 'a-plan',
        kind: 'change',
        state: 'done',
        createdAt: '2026-08-10T12:00:00.000Z',
        updatedAt: '2026-08-11T13:00:00.000Z',
        closedAt: '2026-08-12T14:00:00.000Z',
        terminalCompletionRef: 'Verified release detail pages.',
        terminalCompletionEvidence: {
          summary: 'Published and checked.',
          verifiedHow: 'integration',
          testsRun: 'vitest release-history-page.test.ts',
          testResult: 'all green',
          filesChanged: ['apps/operator/<renderer>.ts'],
          addedTests: true,
        },
        completionAuthority: 'committed',
      },
      {
        generatedAt: GENERATED_AT,
        analytics: ANALYTICS,
        redact: [],
        version: '0.0.16',
        channel: 'alpha',
        plan: plan(),
      },
    );

    expect(html).toContain('Ship &lt;safe&gt; details');
    expect(html).toContain('Public description &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('<dt>Type</dt><dd>change</dd>');
    expect(html).toContain('<dt>State</dt><dd>done</dd>');
    expect(html).toContain('2026-08-12 14:00:00 UTC');
    expect(html).toContain('Verified release detail pages.');
    expect(html).toContain('vitest release-history-page.test.ts');
    expect(html).toContain('apps/operator/&lt;renderer&gt;.ts');
    expect(html).toContain('href="../plans/a-plan.html"');
    expect(html).toContain('href="../index.html"');
    expect(html).toContain('var PAGE_PATH = "/work-items/WI-9.html"');
    expect(html).not.toContain('_completionEvidence');
    expect(html).not.toContain('checkpoint');
  });

  it('does not crash or publish a malformed legacy filesChanged string', () => {
    const html = renderWorkItemPageHtml(
      {
        id: 'WI-legacy',
        title: 'Legacy completion evidence',
        summary: 'Still renderable.',
        planSlug: null,
        terminalCompletionEvidence: {
          summary: 'The valid part survives.',
          filesChanged: '/legacy/not-an-array.ts' as never,
        },
      },
      {
        generatedAt: GENERATED_AT,
        analytics: null,
        redact: [],
        version: '0.0.1',
        channel: 'alpha',
      },
    );
    expect(html).toContain('The valid part survives.');
    expect(html).not.toContain('/legacy/not-an-array.ts');
  });
});

describe('the beacon — the leak detector [owner: "collect stats on visits to make sure it isnt leaked"]', () => {
  it('captures document.referrer — the only signal that actually names a leak', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain('document.referrer');
  });

  /**
   * The beacon's own source, extracted from the page.
   *
   * Scoping matters here, and it was found by checking a REAL generated page
   * rather than a fixture: the live index contains work-item bodies that quote
   * application source, and one of them contains the literal
   * `window.location.href` as escaped TEXT. A whole-document grep therefore
   * says "the page contains location.href" about a page whose script is
   * perfectly clean — a false alarm today, and worse tomorrow, because the day
   * a fixture gains such prose the guard starts reporting on the wrong thing
   * entirely. The question was always "what does the SCRIPT read", so ask that.
   */
  const beaconOf = (html: string) => {
    const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(withoutOptionalLoaders(html));
    return m ? m[1] : '';
  };

  it('NEVER reads the real url — the url IS the secret, and an analytics store is not a place to keep it', () => {
    const html = beaconOf(
      renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS }),
    );
    expect(html.length).toBeGreaterThan(0); // the extraction actually found the beacon
    // ── Why this no longer just forbids the token "$current_url" ──────────────
    // It used to, because the beacon sent no url of any kind. [owner 2026-07-27]
    // then asked for papercusp.com's tracking here, and PostHog's page/session
    // reports are keyed on the url family — so the page now DOES send
    // $current_url/$pathname/path, built from a generation-time page identity
    // under a literal <redacted> base. The invariant was never "the token must
    // not appear"; it was "the real path must never be READ". That is what is
    // asserted now, and it is the stricter statement: these four are the only
    // ways the browser can hand you the secret path at runtime.
    expect(html).not.toContain('location.href');
    expect(html).not.toContain('location.pathname');
    expect(html).not.toContain('window.location');
    expect(html).not.toContain('document.URL');
  });

  it('sends the url family REDACTED — analytics keeps its page breakdowns, the secret stays out', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain(`var PAGE_PATH = "/index.html"`);
    expect(html).toContain(`'$current_url': location.origin + '/<redacted>' + PAGE_PATH`);
    expect(html).toContain(`'$pathname': PAGE_PATH`);
    expect(html).toContain(`path: PAGE_PATH`);
    // The hostname is NOT the secret — only the path is (D-002) — so $host is
    // sent as-is and PostHog can still tell the release host from the website.
    expect(html).toContain(`'$host': location.host`);
  });

  it('gives a plan page its own redacted identity, so plan pages are distinguishable', () => {
    const script = beaconOf(
      renderPlanPageHtml(plan(), {
        generatedAt: GENERATED_AT,
        analytics: ANALYTICS,
        version: '0.0.9',
      }),
    );
    expect(script).toContain(`var PAGE_PATH = "/plans/a-plan.html"`);
    expect(script).not.toContain('location.pathname');
  });

  it('reports a same-origin referrer as $internal, never as the (secret) url it really is', () => {
    // index -> plan navigation makes document.referrer the secret url. The page's
    // meta referrer tag should already blank it; this is the second mechanism.
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain(`if (rh === location.hostname) { ref = '$internal'; refDomain = '$internal'; }`);
  });

  it('never resolves a relative href into an absolute one — that would rebuild the secret url', () => {
    // a.href resolves against the document; a.getAttribute('href') does not. On a
    // page whose every download link is relative, that distinction IS the secret.
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain(`a2.getAttribute('href')`);
    expect(html).not.toContain('new URL(href, location');
  });
});

describe('PostHog parity with papercusp.com [owner 2026-07-27: "the same sort of posthog tracking"]', () => {
  const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });

  it('reports into the same project as the site', () => {
    // POSTHOG_PUBLIC_DEFAULTS already matched the site's host+key before this
    // change; what differed was only how much each event carried.
    expect(html).toContain(ANALYTICS.host);
    expect(html).toContain(ANALYTICS.projectKey);
  });

  it('counts repeat visits as ONE visitor, the way the site does', () => {
    expect(html).toContain("localStorage.getItem('pc_aid')");
    expect(html).toContain("sessionStorage.getItem('pc_aid')"); // privacy-mode fallback
  });

  it('sends a bare-UUID $session_id — a prefixed one is silently dropped by PostHog', () => {
    expect(html).toContain("base['$session_id'] = sid");
    expect(html).toContain('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx');
    // the site learned this the hard way; a prefix kills duration/bounce/paths
    expect(html).not.toMatch(/sid\s*=\s*'s-'/);
  });

  it('carries first/last-touch UTM attribution', () => {
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'ft_', 'lt_']) {
      expect(html).toContain(k);
    }
  });

  it('derives the reserved browser/os/device props by hand (no posthog-js on the page)', () => {
    for (const p of ['$browser', '$os', '$device_type', '$screen_width', '$screen_height']) {
      expect(html).toContain(p);
    }
  });

  it('keeps the legacy lowercase props the site\'s admin queries read', () => {
    for (const p of ['path:', 'referrer:', 'screen:', 'lang:']) expect(html).toContain(p);
  });

  // EI-18859175264310052. This page and papercusp.com publish into the SAME
  // PostHog project, so a consumer query has to be able to name which producer it
  // means. `surface` is that axis, and it must be on EVERY event: the queries that
  // actually got contaminated were scoped by TIME ALONE, with no event filter, so
  // a prop present on only some events would not have saved them.
  it('stamps an explicit `surface` on every event, so producers are separable by contract', () => {
    expect(html).toContain('"surface":"releases"');
  });

  // The falsifiable half of the rule above. `page` is 'index' | 'plan' |
  // 'work-item' — a page WITHIN this surface — and it separated the two producers
  // only because the site happens not to send it. If someone ever deletes
  // `surface` and leans on that coincidence again, this fails: it asserts the two
  // props are genuinely distinct axes, not that some page-ish string exists.
  it('does not let `page` stand in for `surface` — they are different axes', () => {
    const planHtml = renderPlanPageHtml(plan(), {
      generatedAt: GENERATED_AT,
      analytics: ANALYTICS,
      version: '0.0.9',
    });
    // `surface` is CONSTANT across pages; `page` VARIES. That is the whole
    // distinction, and asserting both together is what makes this falsifiable:
    // deleting `surface` and re-deriving it from `page` cannot satisfy both.
    expect(planHtml).toContain('"surface":"releases"');
    expect(planHtml).toContain('"page":"plan"');
    expect(html).toContain('"page":"index"');
  });

  it('instruments what this page is FOR — downloads, the Discord link, and the demo', () => {
    for (const ev of [
      'release_history_viewed',
      'download_clicked',
      'discord_clicked',
      'outbound_link_clicked',
      'plan_page_opened',
      'work_item_page_opened',
      'release_history_returned',
      'demo_video_played',
    ]) {
      expect(html).toContain(ev);
    }
  });

  it('omits the beacon ENTIRELY when no analytics are configured', () => {
    // Optional content loaders are separate from analytics and keep static fallbacks.
    const html = withoutOptionalLoaders(
      renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: null }),
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('fetch(');
  });

  it('tells search engines not to index an unlisted page', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain('noindex');
    // ...and does not hand the secret path to whatever a tester clicks through to.
    expect(html).toContain('name="referrer" content="no-referrer"');
  });
});

describe('one product downloads page', () => {
  it('provides five native product choices and keeps the console fallback without JavaScript', () => {
    const html = withoutOptionalLoaders(renderIndexHtml([hydrated()], {
      generatedAt: GENERATED_AT, analytics: null, redact: [],
    }));
    for (const [id, label] of [['server', 'Desktop Server'], ['gui', 'Desktop GUI'],
      ['psu', 'PSU + PUI'], ['android', 'Android'], ['iphone', 'iPhone']]) {
      expect(html).toContain(`id="choose-${id}"`);
      expect(html).toContain(`<label for="choose-${id}">${label}</label>`);
      expect(html).toContain(`id="download-${id}"`);
    }
    expect(html).toContain('href="pui/index.html"');
    expect(html).toContain('Where should psu run?');
    expect(html).toContain('Local — this computer');
    expect(html).toContain('Uses the same download as Linux.');
    expect(html).toContain('Apple Silicon: no verified standalone download is published yet.');
    expect(html).toContain('Intel: no verified standalone download is published yet.');
    expect(html).toContain('PSU and PUI are included.');
    expect(html).not.toMatch(/(?:psu|pui) --connect/);
  });

  it('keeps the server setup guide inside its product panel and archives closed by default', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: null, redact: [] });
    const server = html.slice(html.indexOf('id="download-server"'), html.indexOf('id="download-gui"'));
    expect(server).toContain(`id="${INSTRUCTIONS_BODY_ID}"`);
    expect(html.match(new RegExp(`id="${INSTRUCTIONS_BODY_ID}"`, 'g'))).toHaveLength(1);
    expect(html).toContain('<details class="release-downloads"><summary>Archived downloads for');
    expect(html).not.toContain('<details class="release-downloads" open');
  });

  it('explains the unpublished replacement mobile builds without offering withdrawn downloads', () => {
    const html = renderProductDownloads([]);
    expect(html).toContain('The previous Android builds were withdrawn. A replacement download is not published yet.');
    expect(html).toContain('The previous iPhone builds were withdrawn. A replacement download is not published yet.');
    expect(html).not.toMatch(/href="[^"]+\.(?:apk|ipa)"/);
  });

  it('keeps separate server, GUI and mobile artifacts, including multiple formats', () => {
    const artifacts = [
      { product: 'gui' as const, platform: 'linux-x86_64', name: 'gui.deb' },
      { product: 'gui' as const, platform: 'linux-x86_64', name: 'gui.AppImage' },
      { product: 'server' as const, platform: 'linux-x86_64', name: 'server.deb' },
      { product: 'mobile' as const, platform: 'android-universal', name: 'android.apk' },
      { product: 'mobile' as const, platform: 'ios-arm64', name: 'iphone.ipa' },
    ].map(a => ({ ...a, url: `release/${a.name}`, size: 1000, sha256: 'a'.repeat(64) }));
    const html = renderProductDownloads([hydrated({ row: row({ artifacts }) })]);
    for (const artifact of artifacts) expect(html).toContain(`href="release/${artifact.name}"`);
    const server = html.slice(html.indexOf('id="download-server"'), html.indexOf('id="download-gui"'));
    expect(server).toContain('server.deb');
    expect(server).not.toContain('gui.deb');
  });

  it('does not revive an older build when the newest platform slot is withdrawn', () => {
    const pulled = { ...row().artifacts[0], name: 'pulled.deb', url: 'new/pulled.deb',
      withdrawn: { at: '2026-10-12T00:00:00Z', reason: 'rejected', ref: 'D-1' } };
    const html = renderProductDownloads([
      hydrated({ row: row({ version: '0.0.10', artifacts: [pulled] }) }), hydrated(),
    ]);
    expect(html).not.toContain('href="new/pulled.deb"');
    expect(html).not.toContain('href="desktop-v0.0.9-alpha/papercusp_0.0.9_amd64.deb"');
    expect(html).toContain('No download is published for this product yet.');
  });
});

describe('the page renders with JavaScript disabled', () => {
  // A beta tester is here to read what changed and download an installer. If that
  // depended on a script, a blocked/failed fetch would show them a blank page at
  // exactly the moment they need it. The beacon is the ONLY script, and it is
  // best-effort. So: every load-bearing thing must be in the HTML itself.
  const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });

  it('bakes the download link, size and checksum into the markup', () => {
    expect(html).toContain('papercusp_0.0.9_amd64.deb');
    expect(html).toContain('4.20 GB');
    expect(html).toContain('abc123');
  });

  it('percent-encodes spaces in artifact hrefs while keeping the release path relative', () => {
    const html = renderIndexHtml(
      [
        hydrated({
          row: row({
            artifacts: [
              {
                product: 'gui',
                platform: 'linux-x86_64',
                name: 'Papercusp GUI_0.0.16_amd64.deb',
                url: 'desktop-v0.0.16-alpha/Papercusp GUI_0.0.16_amd64.deb',
                size: 4_200_000_000,
                sha256: 'space-safe',
              },
            ],
          }),
        }),
      ],
      { generatedAt: GENERATED_AT, analytics: null, redact: [] },
    );

    expect(html).toContain('href="desktop-v0.0.16-alpha/Papercusp%20GUI_0.0.16_amd64.deb"');
    expect(html).not.toContain('href="desktop-v0.0.16-alpha/Papercusp GUI_0.0.16_amd64.deb"');
  });

  it('bakes the changelog in as rendered HTML, not markdown awaiting a renderer', () => {
    expect(html).toContain('Auto-update actually works now.');
    expect(html).toContain('<h2');
    expect(html).not.toContain('## Highlights');
  });

  it('bakes the work-item list in', () => {
    expect(html).toContain('WI-1');
    expect(html).toContain('Fix the updater');
  });
});

describe('links never carry the secret', () => {
  /** Every host this page is allowed to link OUT to. A new entry is a deliberate
   *  decision, which is the point of listing them: an unexpected absolute link is
   *  exactly how the base url starts creeping into the HTML. */
  const ALLOWED_EXTERNAL_HOSTS = ['discord.gg', 'platform.openai.com'];

  const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  const absoluteAnchors = (html: string) =>
    anchors(html).filter((a) => /href="https?:\/\//.test(a));

  it('links to plan pages relatively', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain('href="plans/a-plan.html"');
    // ...and so does every link INTO this release host: the base path is the
    // secret, so a link that spells out its own url has written the secret down.
    expect(html).not.toMatch(/href="https?:\/\/[^"]*(?:r2\.dev|cloudflarestorage|index\.html)/);
  });

  // ── Why this replaced a blanket `not.toMatch(/href="https?:\/\//)` ──────────
  // That assertion said "no absolute links at all", which was a sound PROXY while
  // the page had none. The owner's Instructions section (2026-07-27) added real
  // outbound links — Discord, the OpenAI key page — so the proxy had to be
  // restated as the invariant it was standing in for. An absolute link is fine;
  // an absolute link that can carry the secret path is not. It could, two ways:
  //   1. the href SPELLING OUT the base url  → the host allowlist below
  //   2. the browser's Referer header on click → rel="noreferrer" below
  // Both are asserted, so this is a stricter guard than the line it replaced —
  // not a relaxed one. If you are here because you added a link and it failed:
  // that is the guard working. Add the host on purpose, keep the rel.
  // The index AND instructions.html: since owner #868 the Instructions text (and
  // its outbound links) lives on its own page, under the same secret path.
  const publishedPages = () => [
    renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS }),
    renderInstructionsHtml({ generatedAt: GENERATED_AT }),
  ];

  it('only links out to hosts we chose on purpose', () => {
    const absolute = publishedPages().flatMap(absoluteAnchors);
    expect(absolute.length).toBeGreaterThan(0); // the instructions are supposed to have links
    for (const tag of absolute) {
      const href = /href="([^"]+)"/.exec(tag)![1];
      expect(ALLOWED_EXTERNAL_HOSTS).toContain(new URL(href).host);
    }
  });

  it('every outbound link is rel="noreferrer" — a click must not hand the url to the far side', () => {
    // The page already ships <meta name="referrer" content="no-referrer">, which
    // covers this globally. This is the per-link belt to that braces: the meta is
    // one line in a shell() that also renders plan pages, and if it is ever
    // dropped or overridden, the secret would ride out in the Referer header of
    // the very first Discord click. Two independent mechanisms, on purpose.
    for (const tag of publishedPages().flatMap(absoluteAnchors)) {
      expect(tag).toContain('rel="noopener noreferrer"');
    }
  });

  it('refuses to let a plan slug escape the plans/ directory', () => {
    // The slashes are what would traverse; stripping them leaves an inert
    // filename, dots and all.
    expect(planPagePath('../../etc/passwd')).toBe('plans/..-..-etc-passwd.html');
    expect(planPagePath('../../etc/passwd')).not.toContain('/etc/');
    expect(planPagePath('ok-slug_1.2')).toBe('plans/ok-slug_1.2.html');
  });
});

describe('escaping', () => {
  it('escapes a work-item title that contains markup', () => {
    const html = renderIndexHtml(
      [
        hydrated({
          items: [{ id: 'WI-2', title: '<img src=x onerror=alert(1)>', planSlug: null }],
          plans: [],
          row: row({ planSlugs: [] }),
        }),
      ],
      { generatedAt: GENERATED_AT, analytics: null },
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapeHtml covers the five', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('formatBytes', () => {
  it('scales', () => {
    expect(formatBytes(4_200_000_000)).toBe('4.20 GB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(2_000)).toBe('2 KB');
    expect(formatBytes(0)).toBe('—');
  });
});

describe('groupItemsByPlan — 1,000 items must become ~44 readable stories', () => {
  const plans: ShippedPlan[] = [
    plan({ slug: 'big', title: 'Big', itemCount: 3 }),
    plan({ slug: 'small', title: 'Small', itemCount: 1 }),
  ];
  const items: ShippedItem[] = [
    { id: 'WI-1', title: 'a', planSlug: 'small' },
    { id: 'WI-2', title: 'b', planSlug: 'big' },
    { id: 'WI-3', title: 'c', planSlug: 'big' },
    { id: 'WI-4', title: 'd', planSlug: 'big' },
    { id: 'WI-5', title: 'e', planSlug: null },
  ];

  it('sorts the biggest plan first and puts the unplanned items last', () => {
    const groups = groupItemsByPlan(items, plans);
    expect(groups.map((g) => g.plan?.slug ?? '(none)')).toEqual(['big', 'small', '(none)']);
    expect(groups[0].items).toHaveLength(3);
  });

  it('still shows items whose plan row is missing — the full list stays full', () => {
    const groups = groupItemsByPlan(
      [{ id: 'WI-9', title: 'orphan', planSlug: 'vanished' }],
      [], // no plan row for 'vanished'
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].plan).toBeNull();
    expect(groups[0].items[0].id).toBe('WI-9');
  });

  it('loses nothing: every item lands in exactly one group', () => {
    const groups = groupItemsByPlan(items, plans);
    const seen = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(seen.sort()).toEqual(['WI-1', 'WI-2', 'WI-3', 'WI-4', 'WI-5']);
  });
});

describe('isUserFacing', () => {
  it('excludes EI-* — the agents fixing their own tooling is not release-notes material', () => {
    expect(isUserFacing('EI-10666')).toBe(false);
    expect(isUserFacing('WI-4446')).toBe(true);
    expect(isUserFacing('F-101')).toBe(true);
  });
});

describe('internal items are counted, never silently dropped', () => {
  it('states the internal count instead of hiding it', () => {
    const html = renderIndexHtml([hydrated({ internalCount: 738 })], {
      generatedAt: GENERATED_AT,
      analytics: null,
    });
    expect(html).toContain('738 internal engineering-tooling fixes');
  });
});

describe('empty / degenerate states', () => {
  it('renders a coherent page with no releases at all', () => {
    const html = renderIndexHtml([], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).toContain('No releases have been recorded yet');
  });

  it('says so when a release has no changelog rather than showing a blank slot', () => {
    const html = renderIndexHtml([hydrated({ row: row({ changelogMd: null }) })], {
      generatedAt: GENERATED_AT,
      analytics: null,
    });
    expect(html).toContain('No changelog was written');
  });

  it('says so when a release has no artifacts', () => {
    const html = renderIndexHtml([hydrated({ row: row({ artifacts: [] }) })], {
      generatedAt: GENERATED_AT,
      analytics: null,
    });
    expect(html).toContain('No downloadable artifacts recorded');
  });
});

describe('the homepage demo video [owner 2026-07-27: "add the same video that is on our homepage to the top"]', () => {
  const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: null });

  it('renders the same cut the homepage plays, with the homepage\'s own attributes', () => {
    expect(html).toContain(DEMO_VIDEO_SRC);
    expect(html).toContain('clips.papercusp.com');
    expect(html).toContain('controls autoplay muted playsinline preload="metadata"');
    expect(html).toContain('id="demoVid"');
  });

  it('is at the TOP — above the instructions and the downloads', () => {
    const video = html.indexOf('<section class="demo">');
    const instructions = html.indexOf('<h2>Instructions</h2>');
    const release = html.indexOf('<h2>0.0.9</h2>');
    expect(video).toBeGreaterThan(-1);
    expect(video).toBeLessThan(instructions);
    expect(instructions).toBeLessThan(release);
  });

  it('inlines the poster, so the frame is never a broken image under the secret path', () => {
    // The homepage serves the poster relatively (video/poster-d65.jpg), which
    // would 404 under the release bucket's secret path.
    expect(html).toContain('poster="data:image/jpeg;base64,');
    expect(html).not.toContain('poster="video/');
  });

  it('does NOT inline the 32MB video — it stays on the CDN the homepage uses', () => {
    // Copying it under the secret path would add 32MB to every publish and give
    // us a second copy to keep in sync, for no gain.
    expect(html).not.toContain('data:video/');
    expect(html).toMatch(/src="https:\/\/clips\.papercusp\.com\/[^"]+\.mp4"/);
  });

  it('needs no JavaScript to appear — <video> is markup, like everything else here', () => {
    // analytics:null ⇒ no beacon, and the video still renders. (The Instructions
    // loader is unrelated to the video and is stripped for this check.)
    expect(withoutOptionalLoaders(html)).not.toContain('<script');
    expect(html).toContain('<video');
  });

  it('is carried by the index only — a plan page is a wall of text, not a landing', () => {
    const planHtml = renderPlanPageHtml(plan(), {
      generatedAt: GENERATED_AT,
      analytics: null,
      version: '0.0.9',
    });
    expect(planHtml).not.toContain('<video');
  });
});

describe('the Instructions section [owner 2026-07-27]', () => {
  const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: null });

  it('renders a section headed "Instructions"', () => {
    expect(html).toContain('<h2>Instructions</h2>');
  });

  it('sits ABOVE the downloads — the placement is the point, not a layout preference', () => {
    // The section is the setup steps a tester needs BEFORE choosing a download.
    // Read after the download tables it is too late. If someone moves it below
    // the releases, this fails.
    const instructions = html.indexOf('<h2>Instructions</h2>');
    const firstRelease = html.indexOf('<h2>0.0.9</h2>');
    expect(instructions).toBeGreaterThan(-1);
    expect(firstRelease).toBeGreaterThan(-1);
    expect(instructions).toBeLessThan(firstRelease);
  });

  // The instructions TEXT lives only on instructions.html [owner 2026-09-28 #868].
  const page = renderInstructionsHtml({ generatedAt: GENERATED_AT });

  it('the index does NOT carry the instructions text — no release cut can change or roll it back [owner #868]', () => {
    // The 0.0.24 publish rendered the index from a checkout pinned before that day's
    // instruction edits, and the live text reverted (EI-24562046738478155). If the
    // text is back in the index, a release is back in charge of it.
    for (const text of ['Install both apps', 'Agent modes', 'EmbeddingGemma', "Don't like something about Papercusp?"]) {
      expect(html).not.toContain(text);
    }
    // The section loads the separately-published page instead...
    expect(html).toContain(`id="${INSTRUCTIONS_BODY_ID}"`);
    expect(html).toContain(`<script ${INSTRUCTIONS_LOADER_ATTR}>`);
    expect(html).toContain(`fetch("${INSTRUCTIONS_PAGE_PATH}"`);
    // ...by a RELATIVE path: the base path is the secret.
    expect(INSTRUCTIONS_PAGE_PATH).toBe('instructions.html');
  });

  it('without JavaScript the section is a link to the same instructions', () => {
    expect(withoutInstructionsLoader(html)).toContain(`<a href="${INSTRUCTIONS_PAGE_PATH}">Read the setup instructions</a>`);
  });

  it('instructions.html is the page the loader reads: same element id, and a way back to the downloads', () => {
    expect(page).toContain(`<div class="prose" id="${INSTRUCTIONS_BODY_ID}">`);
    expect(page).toContain('href="index.html"');
    // An unlisted page like the rest, with no script of its own (not even the beacon).
    expect(page).toContain('noindex');
    expect(page).toContain('name="referrer" content="no-referrer"');
    expect(page).not.toContain('<script');
  });

  it('makes psu in a terminal the main way, with the GUI HUD tab as the alternative [owner 2026-09-28 #839]', () => {
    // Setup still happens once in the GUI (psu has no backend/embeddings picker)...
    expect(page).toContain('Open Papercusp GUI once');
    // ...then psu is THE way to work, and the GUI is the named alternative.
    expect(page).toContain('<strong>Open a terminal and run <code>psu</code>.</strong> This is the main way');
    expect(page).toContain('Prefer the GUI? Open the <strong>HUD</strong> tab');
    // The previous GUI-first framing, where psu was only the fallback, must not come back.
    expect(page).not.toContain('Prefer the terminal?');
    // The retired "GUI not ready, use psu" callout must not come back.
    expect(page).not.toContain('The GUI is not ready yet');
    expect(page).not.toContain('THE GUI NOT READY YET');
  });

  it('renders the setup steps as real markup, at generation time', () => {
    expect(page).toContain('<ol>');
    expect(page).toContain('<strong>Install both apps</strong>');
    expect(page).toContain('EmbeddingGemma + Harrier');
    // The two sections the owner kept [2026-09-28 #811] survive the render,
    // the self-improvement one under the heading the owner chose [#823]...
    expect(INSTRUCTIONS_MD).toContain("### Don't like something about Papercusp?");
    expect(INSTRUCTIONS_MD).not.toContain('Improve Papercusp itself');
    expect(page).toContain('Use several AI accounts (inference gateway)');
    // ...the modes section the owner brought back [#823] renders as a real list...
    expect(page).toContain('Agent modes');
    for (const mode of ['AUTO', 'COLD AUTO', 'IDEATE', 'DRAIN', 'GRADE', 'TEST', 'AUDIT', 'GOAL']) {
      expect(page).toContain(`<strong>${mode}</strong>`);
    }
    // ...and the "Not ready" list the owner removed [#812] stays gone.
    expect(INSTRUCTIONS_MD).not.toContain('Not ready');
  });

  it('points problem reports at the desktop door, with preview and explicit consent (P-017)', () => {
    const section = INSTRUCTIONS_MD.split("### Don't like something about Papercusp?")[1].split('### Use several AI accounts')[0];
    expect(section).toContain('open the command palette and choose **Report a problem**');
    expect(section).toContain('<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>');
    expect(section).toContain('<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on macOS');
    expect(section).toContain('one sentence');
    expect(section).toContain('**Review** to see exactly what will be sent');
    expect(section).toContain('log lines are optional and off by default');
    expect(section).toContain('nothing is sent until you choose **Send**');
    expect(section.indexOf('**Report a problem**')).toBeLessThan(section.indexOf('Ask an agent to build it'));
    expect(page).toContain('<strong>Report a problem</strong>');
    expect(page).toContain('<strong>Review</strong>');
    expect(page).toContain('<strong>Send</strong>');
    expect(page).toContain('click <strong>Release</strong> to go back');
  });

  it('opens external links in a new tab — losing this page means losing the secret URL', () => {
    // The page IS the release: navigate away mid-setup and the only way back is
    // a URL the tester has to go dig out of a message.
    expect(page).toContain(
      '<a target="_blank" rel="noopener noreferrer" href="https://discord.gg/HjRQ8g4Nju"',
    );
    // (That EVERY absolute link gets the treatment, not just this one, is
    // asserted in "links never carry the secret" above.)
  });

  it('does NOT touch the relative download links — the base path is the secret', () => {
    // Release artifacts are linked relatively on purpose. Blanket-targeting every
    // <a> would open the installer in a new tab AND is how a rewrite starts
    // creeping toward absolute urls.
    expect(html).toContain('<td><a href="desktop-v0.0.9-alpha/papercusp_0.0.9_amd64.deb">');
  });

  it('renders even when the registry has no releases at all', () => {
    // The page where a reader has the least context must not be the page that
    // explains the least.
    const empty = renderIndexHtml([], { generatedAt: GENERATED_AT, analytics: null });
    expect(empty).toContain('<h2>Instructions</h2>');
    expect(empty).toContain(`<script ${INSTRUCTIONS_LOADER_ATTR}>`);
    expect(empty).toContain('No releases have been recorded yet');
  });

  it('carries no identity for the scrub to redact', () => {
    // The section is hand-written prose bound for a public bucket. It must pass
    // the gate on its own merits, not because scrubIdentity happened to catch it.
    expect(INSTRUCTIONS_MD).not.toMatch(/\/home\/[A-Za-z0-9._-]+/);
    expect(INSTRUCTIONS_MD).not.toMatch(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/);
  });

});

describe('plan page', () => {
  it('renders the plan body and links back relatively', () => {
    const html = renderPlanPageHtml(plan(), {
      generatedAt: GENERATED_AT,
      analytics: ANALYTICS,
      version: '0.0.9',
    });
    expect(html).toContain('Body text.');
    expect(html).toContain('href="../index.html"');
    expect(html).toContain('document.referrer'); // the beacon is on this page too
    // The plan page's url family is redacted the same way the index's is. The
    // absence side of that guard is asserted against the SCRIPT (not the whole
    // document) in "NEVER reads the real url" — a plan body can legitimately
    // contain the literal text of a browser api it is describing.
    expect(html).toContain('/<redacted>');
  });

  // ── The frontmatter leak, found by rendering a REAL plan page and reading it.
  it('strips YAML frontmatter — it is metadata, and `owner:` is a live email address', () => {
    const content = [
      '---',
      'title: A Plan',
      'slug: a-plan',
      'status: draft',
      'owner: someone@gmail.com',
      '---',
      '',
      '## Now',
      '',
      'The real body.',
    ].join('\n');

    const html = renderPlanPageHtml(plan({ content }), {
      generatedAt: GENERATED_AT,
      analytics: null,
      version: '0.0.9',
    });

    expect(html).toContain('The real body.');
    expect(html).not.toContain('someone@gmail.com');
    expect(html).not.toContain('slug: a-plan');
    expect(html).not.toContain('status: draft');
  });

  it('keeps a body that merely CONTAINS a --- rule', () => {
    const html = renderPlanPageHtml(plan({ content: '# Title\n\nBefore.\n\n---\n\nAfter.' }), {
      generatedAt: GENERATED_AT,
      analytics: null,
      version: '0.0.9',
    });
    expect(html).toContain('Before.');
    expect(html).toContain('After.');
  });

  // Every real plan body opens with `# <its own title>`, so the page was rendering
  // the title twice — once as the page heading, once as the first line of the prose.
  it('does not print the plan title twice', () => {
    const html = renderPlanPageHtml(
      plan({ title: 'A Plan', content: '# A Plan\n\nBody text.' }),
      { generatedAt: GENERATED_AT, analytics: null, version: '0.0.9' },
    );
    expect(html).toContain('Body text.');
    expect(html).toContain('<h1 class="plan-title">A Plan</h1>'); // the page heading stays
    expect(html).not.toMatch(/<h1>A Plan<\/h1>/); // ...the markdown's copy of it does not
  });

  it('keeps a first heading that is NOT the title — that is content, not a duplicate', () => {
    const html = renderPlanPageHtml(
      plan({ title: 'A Plan', content: '# Background\n\nBody text.' }),
      { generatedAt: GENERATED_AT, analytics: null, version: '0.0.9' },
    );
    expect(html).toContain('Background');
    expect(html).toContain('Body text.');
  });

  it('does not publish our internal plan status to testers', () => {
    const html = renderPlanPageHtml(plan({ status: 'draft' }), {
      generatedAt: GENERATED_AT,
      analytics: null,
      version: '0.0.9',
    });
    expect(html).toContain('1 work item shipped in 0.0.9');
    expect(html).not.toContain('draft');
  });
});

describe('the Server artifact is disclosed, not silently dropped', () => {
  const withServer = hydrated({
    row: row({
      artifacts: [
        {
          product: 'gui',
          platform: 'linux-x86_64',
          name: 'gui_0.0.9_amd64.deb',
          url: 'desktop-v0.0.9-alpha/gui_0.0.9_amd64.deb',
          size: 3_600_000_000,
          sha256: 'aaa',
        },
        {
          product: 'server',
          platform: 'linux-x86_64',
          name: 'server_0.0.9_amd64.deb',
          url: 'desktop-v0.0.9-alpha/server_0.0.9_amd64.deb',
          size: 3_600_000_000,
          sha256: 'bbb',
        },
      ],
    }),
  });

  it('puts the Server in its OWN labelled table under the Linux section, not a prose link', () => {
    const html = renderIndexHtml([withServer], { generatedAt: GENERATED_AT, analytics: null });
    // The release's downloads are grouped under a per-platform section header.
    expect(html).toContain('<h3 class="platform-h">Linux</h3>');
    // Both the app and the Server appear, each under its own component sub-header,
    // each a first-class <table class="dl"> (the Server is NOT a prose footnote).
    expect(html).toContain('<h4 class="component-h">App</h4>');
    expect(html).toContain('<h4 class="component-h">Papercusp Server</h4>');
    expect(html).toContain('gui_0.0.9_amd64.deb');
    expect(html).toContain('server_0.0.9_amd64.deb');
    // Linux now matches macOS/Windows: the GUI requires the sibling Server.
    expect(html).toContain('Install both.');
    expect(html).toContain('needs <strong>Papercusp Server</strong> running alongside it');
    expect(html).not.toContain('runs on its own on Linux');
    expect(html).not.toContain('optional here');
    expect(html).not.toContain('headless server build');
  });

  it('tells mac/Windows to install BOTH, and puts the Server in its own table there too', () => {
    const macBoth = hydrated({
      row: row({
        artifacts: [
          { product: 'gui', platform: 'darwin-universal', name: 'GUI_0.0.9_universal.dmg', url: 'desktop-v0.0.9-alpha/GUI_0.0.9_universal.dmg', size: 1_300_000_000, sha256: 'g' },
          { product: 'server', platform: 'darwin-universal', name: 'Server_0.0.9_universal.dmg', url: 'desktop-v0.0.9-alpha/Server_0.0.9_universal.dmg', size: 1_300_000_000, sha256: 's' },
        ],
      }),
    });
    const html = renderIndexHtml([macBoth], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).toContain('<h3 class="platform-h">macOS</h3>');
    expect(html).toContain('<h4 class="component-h">Papercusp Server</h4>');
    expect(html).toContain('Server_0.0.9_universal.dmg');
    expect(html).toContain('Install both.');
  });

  /* EI-20109680727314274 — our mac builds are AD-HOC SIGNED, so Gatekeeper hard-blocks
     first launch and the ONLY way through is a Terminal `xattr` command. Before this,
     no tester-facing surface said so anywhere: the sole occurrence of the command in
     the whole release tree was our own mac E2E harness, which unquarantines the bundles
     ITSELF before launching them — so the automation was structurally incapable of
     hitting the wall a human hits. These tests are the recurrence guard. */
  describe('macOS Gatekeeper first-launch instruction (EI-20109680727314274)', () => {
    const XATTR = 'xattr -dr com.apple.quarantine';

    it('gives the unquarantine command for EVERY mac app in the release', () => {
      const macBoth = hydrated({
        row: row({
          artifacts: [
            { product: 'gui', platform: 'darwin-universal', name: 'GUI_0.0.9_universal.dmg', url: 'desktop-v0.0.9-alpha/GUI_0.0.9_universal.dmg', size: 1_300_000_000, sha256: 'g' },
            { product: 'server', platform: 'darwin-universal', name: 'Server_0.0.9_universal.dmg', url: 'desktop-v0.0.9-alpha/Server_0.0.9_universal.dmg', size: 1_300_000_000, sha256: 's' },
          ],
        }),
      });
      const html = renderIndexHtml([macBoth], { generatedAt: GENERATED_AT, analytics: null });
      expect(html).toContain(`${XATTR} "/Applications/Papercusp GUI.app"`);
      expect(html).toContain(`${XATTR} "/Applications/Papercusp Server.app"`);
    });

    it('names ONLY the apps actually shipped — no command for a Server that is not in the release', () => {
      const macGuiOnly = hydrated({
        row: row({
          artifacts: [
            { product: 'gui', platform: 'darwin-universal', name: 'GUI_0.0.9_universal.dmg', url: 'desktop-v0.0.9-alpha/GUI_0.0.9_universal.dmg', size: 1_300_000_000, sha256: 'g' },
          ],
        }),
      });
      const html = renderIndexHtml([macGuiOnly], { generatedAt: GENERATED_AT, analytics: null });
      expect(html).toContain(`${XATTR} "/Applications/Papercusp GUI.app"`);
      expect(html).not.toContain('Papercusp Server.app');
    });

    /* The falsifier: this note is macOS-ONLY. If it ever renders under Linux or
       Windows it is actively wrong — those platforms have no Gatekeeper — so a
       leak across the platform boundary must fail here. */
    it('does NOT appear for Linux', () => {
      const linux = hydrated({
        row: row({
          artifacts: [
            { product: 'gui', platform: 'linux-x86_64', name: 'GUI_0.0.9_amd64.AppImage', url: 'desktop-v0.0.9-alpha/GUI_0.0.9_amd64.AppImage', size: 1_300_000_000, sha256: 'l' },
          ],
        }),
      });
      const html = renderIndexHtml([linux], { generatedAt: GENERATED_AT, analytics: null });
      expect(html).not.toContain(XATTR);
    });

    it('does NOT appear for Windows', () => {
      const win = hydrated({
        row: row({
          artifacts: [
            { product: 'gui', platform: 'windows-x86_64', name: 'GUI_0.0.9_x64-setup.exe', url: 'desktop-v0.0.9-alpha/GUI_0.0.9_x64-setup.exe', size: 1_800_000_000, sha256: 'w' },
          ],
        }),
      });
      const html = renderIndexHtml([win], { generatedAt: GENERATED_AT, analytics: null });
      expect(html).not.toContain(XATTR);
    });
  });

  it('WARNS when a mac/Windows section has an app but NO Server (the non-functional case)', () => {
    const macGuiOnly = hydrated({
      row: row({
        artifacts: [
          { product: 'gui', platform: 'windows-x86_64', name: 'GUI_0.0.9_x64-setup.exe', url: 'desktop-v0.0.9-alpha/GUI_0.0.9_x64-setup.exe', size: 1_800_000_000, sha256: 'w' },
        ],
      }),
    });
    const html = renderIndexHtml([macGuiOnly], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).toContain('<h3 class="platform-h">Windows</h3>');
    expect(html).toContain('class="warn"');
    expect(html).toContain('needs <strong>Papercusp Server</strong>');
  });

  it('WARNS when Linux ships a GUI without its required Server', () => {
    const linuxGuiOnly = hydrated({
      row: row({
        artifacts: [
          { product: 'gui', platform: 'linux-x86_64', name: 'GUI_0.0.9_amd64.deb', url: 'desktop-v0.0.9-alpha/GUI_0.0.9_amd64.deb', size: 80_000_000, sha256: 'l' },
        ],
      }),
    });
    const html = renderIndexHtml([linuxGuiOnly], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).toContain('<h3 class="platform-h">Linux</h3>');
    expect(html).toContain('class="warn"');
    expect(html).toContain('needs <strong>Papercusp Server</strong>');
    expect(html).toContain("this build can't start on its own");
  });
});

describe('the mobile apps render in their own labelled section [owner: "make sure the iphone and android builds make it onto our releases page"]', () => {
  const withAndroid = hydrated({
    row: row({
      artifacts: [
        {
          product: 'gui',
          platform: 'linux-x86_64',
          name: 'papercusp_0.0.9_amd64.deb',
          url: 'desktop-v0.0.9-alpha/papercusp_0.0.9_amd64.deb',
          size: 3_600_000_000,
          sha256: 'aaa',
        },
        {
          product: 'mobile',
          platform: 'android-universal',
          name: 'Papercusp_0.0.9_android.apk',
          url: 'desktop-v0.0.9-alpha/Papercusp_0.0.9_android.apk',
          size: 90_000_000,
          sha256: 'droid',
        },
      ],
    }),
  });

  it('gives the phone build its OWN "Mobile" platform section, without mixing it into a desktop table', () => {
    const html = renderIndexHtml([withAndroid], { generatedAt: GENERATED_AT, analytics: null });
    // The desktop installer stays under its own Linux section.
    expect(html).toContain('<h3 class="platform-h">Linux</h3>');
    expect(html).toContain('papercusp_0.0.9_amd64.deb');
    // The Android build gets its own Mobile section so an APK never reads as a
    // desktop download.
    expect(html).toContain('<h3 class="platform-h">Mobile</h3>');
    expect(html).toContain('Papercusp_0.0.9_android.apk');
    // download link, size and checksum baked into the markup (JS-off).
    expect(html).toContain('desktop-v0.0.9-alpha/Papercusp_0.0.9_android.apk');
    expect(html).toContain('droid');
  });

  it('surfaces an iOS build under the same Mobile section once a signed .ipa exists', () => {
    // iOS is enrollment-gated today (no signed .ipa yet), but the render path must
    // already be correct so the build appears the moment record-release finds one.
    const withIos = hydrated({
      row: row({
        artifacts: [
          {
            product: 'mobile',
            platform: 'ios-arm64',
            name: 'Papercusp_0.0.9_ios.ipa',
            url: 'desktop-v0.0.9-alpha/Papercusp_0.0.9_ios.ipa',
            size: 40_000_000,
            sha256: 'iphone',
          },
        ],
      }),
    });
    const html = renderIndexHtml([withIos], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).toContain('<h3 class="platform-h">Mobile</h3>');
    expect(html).toContain('Papercusp_0.0.9_ios.ipa');
  });

  it('omits the Mobile section entirely for a desktop-only release', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).not.toContain('<h3 class="platform-h">Mobile</h3>');
  });
});

// WI-6580 — the temporary holding page [owner 2026-07-28].
describe('renderHoldingHtml — what it keeps, and what it must not leak', () => {
  const opts = { generatedAt: GENERATED_AT, analytics: ANALYTICS };

  it('says the one thing it is for', () => {
    expect(renderHoldingHtml(opts)).toContain('NEXT UPDATE COMING SOON');
  });

  it('keeps the video, the Discord invite and a contact mailto', () => {
    const html = renderHoldingHtml(opts);
    expect(html).toContain(DEMO_VIDEO_SRC);
    expect(html).toContain(DISCORD_URL);
    expect(html).toContain(`mailto:${PUBLISHED_CONTACT_EMAIL}`);
  });

  it('publishes the contact address INTACT — the scrub must not mangle it', () => {
    // The whole point of the allowance: without it, shell()'s scrub rewrites the
    // address to `[email]` and the page ships a dead `mailto:[email]` link.
    const html = renderHoldingHtml(opts);
    expect(html).toContain(PUBLISHED_CONTACT_EMAIL);
    expect(html).not.toContain('mailto:[email]');
  });

  it('carries the marker the publish gate keys its allowance off', () => {
    expect(renderHoldingHtml(opts)).toContain(HOLDING_PAGE_MARKER);
  });

  it('shows NO releases: no downloads, no changelog, no plan links', () => {
    const html = renderHoldingHtml(opts);
    expect(html).not.toContain('papercusp_0.0.9_amd64.deb');
    expect(html).not.toContain('Auto-update actually works now');
    expect(html).not.toContain('plans/');
    expect(html).not.toContain('SHA-256');
  });

  it('keeps the beacon alive so the admin panel still sees visits while held', () => {
    const html = renderHoldingHtml(opts);
    expect(html).toContain('release_history_viewed');
    expect(html).toContain('contact_clicked');
  });

  it('never puts the address in an analytics property', () => {
    // A mailto click must not travel to PostHog carrying the address — the gate
    // only ever reads the HTML, so nothing downstream would catch that.
    const html = renderHoldingHtml(opts);
    expect(html).toContain("capture('contact_clicked')");
    expect(html).not.toContain("capture('contact_clicked', { href");
  });

  it('is still a no-index unlisted page', () => {
    expect(renderHoldingHtml(opts)).toContain('noindex, nofollow, noarchive');
  });
});

describe('a platform-only hotfix shares the card of the release it patches (WI-10003687, owner #800)', () => {
  function art(
    version: string,
    platform: string,
    product: 'gui' | 'server',
    name: string,
  ): ReleaseRow['artifacts'][number] {
    return {
      product,
      platform,
      name,
      url: `desktop-v${version}-alpha/${name}`,
      size: 1000,
      sha256: `${version}-${platform}-${product}`,
    };
  }
  function fullRelease(version: string, over: Partial<ReleaseRow> = {}): HydratedRelease {
    return hydrated({
      row: row({
        version,
        changelogMd: `## ${version}\n\nFull release notes.`,
        artifacts: [
          art(version, 'linux-x86_64', 'gui', `Papercusp GUI_${version}_amd64.deb`),
          art(version, 'linux-x86_64', 'server', `Papercusp Server_${version}_amd64.deb`),
          art(version, 'darwin-universal', 'gui', `Papercusp GUI_${version}_universal.dmg`),
          art(version, 'windows-x86_64', 'gui', `Papercusp GUI_${version}_x64-setup.exe`),
          art(version, 'windows-x86_64', 'server', `Papercusp Server_${version}_x64-setup.exe`),
        ],
        ...over,
      }),
    });
  }
  const windowsHotfix = hydrated({
    row: row({
      version: '0.0.23',
      notes: partialScopeApprovalNote(832),
      cutAt: new Date('2026-09-28T14:29:00Z'),
      publishedAt: new Date('2026-09-28T17:00:00Z'),
      changelogMd: 'Windows Server upgrades over a running operator no longer fail.',
      artifacts: [
        art('0.0.23', 'windows-x86_64', 'gui', 'Papercusp GUI_0.0.23_x64-setup.exe'),
        art('0.0.23', 'windows-x86_64', 'server', 'Papercusp Server_0.0.23_x64-setup.exe'),
        art('0.0.23', 'windows-x86_64', 'server', 'Papercusp Server_0.0.23_x64-setup.exe.sig'),
      ],
    }),
  });
  const base = fullRelease('0.0.22');
  const opts = { generatedAt: GENERATED_AT, analytics: null, redact: [] };

  it('renders ONE card headed by the full release, with the hotfix builds in their platform section', () => {
    const html = renderIndexHtml([windowsHotfix, base], opts);
    expect(html).toContain('<h2>0.0.22</h2>');
    expect(html).not.toContain('<h2>0.0.23</h2>');
    expect(html.match(/<section class="rel"/g)).toHaveLength(1);
    // The card declares the newest release it carries, which the publish guard binds to.
    expect(html).toContain('<section class="rel" data-newest-release="0.0.23">');
    // Windows downloads are the 0.0.23 builds; the replaced 0.0.22 Windows builds are gone.
    expect(html).toContain('Papercusp GUI_0.0.23_x64-setup.exe');
    expect(html).toContain('Papercusp Server_0.0.23_x64-setup.exe');
    expect(html).not.toContain('Papercusp GUI_0.0.22_x64-setup.exe');
    expect(html).not.toContain('Papercusp Server_0.0.22_x64-setup.exe');
    // Linux and macOS keep their 0.0.22 builds.
    expect(html).toContain('Papercusp GUI_0.0.22_amd64.deb');
    expect(html).toContain('Papercusp GUI_0.0.22_universal.dmg');
    // The combined card is the latest one.
    expect(html).toContain('<span class="tag current">latest</span>');
  });

  it('labels only the hotfixed platform with its real version and links its own changes page', () => {
    const html = renderIndexHtml([windowsHotfix, base], opts);
    const windows = html.slice(html.indexOf('<h3 class="platform-h">Windows</h3>'));
    const windowsSection = windows.slice(0, windows.indexOf('</section>'));
    expect(windowsSection).toContain('Updated to <strong>0.0.23</strong>');
    expect(windowsSection).toContain(`href="changes/${releaseHistoryStem('0.0.23', 'alpha')}.html"`);
    const linux = html.slice(html.indexOf('<h3 class="platform-h">Linux</h3>'));
    expect(linux.slice(0, linux.indexOf('</section>'))).not.toContain('hotfix-note');
    // The hotfix's own notes appear in the card, under its platform + version.
    expect(html).toContain('<h3>Windows 0.0.23</h3>');
    expect(html).toContain('Windows Server upgrades over a running operator no longer fail.');
  });

  it('leaves history.json (the in-app update feed) listing each release on its own', () => {
    const json = JSON.parse(renderHistoryJson([windowsHotfix, base], opts)) as {
      releases: Array<{ version: string; artifacts: Array<{ name: string }> }>;
    };
    expect(json.releases.map((r) => r.version)).toEqual(['0.0.23', '0.0.22']);
    expect(json.releases[0]!.artifacts.map((a) => a.name)).toEqual([
      'Papercusp GUI_0.0.23_x64-setup.exe',
      'Papercusp Server_0.0.23_x64-setup.exe',
    ]);
    expect(json.releases[1]!.artifacts.map((a) => a.name)).toContain('Papercusp GUI_0.0.22_x64-setup.exe');
  });

  it('gives a newer FULL release its own card', () => {
    const html = renderIndexHtml([fullRelease('0.0.23'), base], opts);
    expect(html).toContain('<h2>0.0.23</h2>');
    expect(html).toContain('<h2>0.0.22</h2>');
    expect(html).not.toContain('hotfix-note');
  });

  it('never folds across channels', () => {
    const betaHotfix = hydrated({ row: { ...windowsHotfix.row, channel: 'beta' } });
    const cards = groupReleaseCards([betaHotfix, base]);
    expect(cards.map((c) => [c.base.row.version, c.hotfixes.length])).toEqual([
      ['0.0.23', 0],
      ['0.0.22', 0],
    ]);
  });

  it('chains successive hotfixes onto the same card, newest build winning', () => {
    const second = hydrated({
      row: row({
        version: '0.0.24',
        notes: partialScopeApprovalNote(900),
        artifacts: [art('0.0.24', 'windows-x86_64', 'gui', 'Papercusp GUI_0.0.24_x64-setup.exe')],
      }),
    });
    const cards = groupReleaseCards([second, windowsHotfix, base]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.base.row.version).toBe('0.0.22');
    expect(cards[0]!.hotfixes.map((h) => h.row.version)).toEqual(['0.0.23', '0.0.24']);
    const html = renderIndexHtml([second, windowsHotfix, base], opts);
    expect(html).toContain('Papercusp GUI_0.0.24_x64-setup.exe');
    expect(html).not.toContain('Papercusp GUI_0.0.23_x64-setup.exe');
    // The Server was only replaced by 0.0.23, so it stays at 0.0.23.
    expect(html).toContain('Papercusp Server_0.0.23_x64-setup.exe');
  });

  it('keeps an older release with no downloads as its own card', () => {
    const empty = hydrated({ row: row({ version: '0.0.21', artifacts: [] }) });
    const cards = groupReleaseCards([base, empty]);
    expect(cards.map((c) => c.base.row.version)).toEqual(['0.0.22', '0.0.21']);
  });

  // The live registry shape that first broke this: 0.0.14 was the last cut with
  // Android/iOS, so every later desktop-only release ships a strict SUBSET of its
  // platforms. They are full releases, not hotfixes, and each keeps its own card.
  it('gives a desktop-only full release its own card after a cut that also shipped mobile', () => {
    const withMobile = fullRelease('0.0.14');
    withMobile.row.artifacts.push(
      art('0.0.14', 'android-universal', 'gui', 'Papercusp_0.0.14_android.apk'),
      art('0.0.14', 'ios-arm64', 'gui', 'Papercusp_0.0.14_ios.ipa'),
    );
    const releases = [windowsHotfix, base, fullRelease('0.0.21'), fullRelease('0.0.15'), withMobile];
    const cards = groupReleaseCards(releases);
    expect(cards.map((c) => [c.base.row.version, c.hotfixes.map((h) => h.row.version)])).toEqual([
      ['0.0.22', ['0.0.23']],
      ['0.0.21', []],
      ['0.0.15', []],
      ['0.0.14', []],
    ]);
    const html = renderIndexHtml(releases, opts);
    expect(html.match(/hotfix-note/g)).toHaveLength(1);
    expect(html).not.toContain('on top of 0.0.14');
  });

  // 0.0.10 shipped Linux only after 0.0.9 shipped Linux + macOS: a full release
  // whose other legs did not build, with no owner-approved partial scope recorded.
  it('does not fold a fewer-platform release that recorded no owner-approved partial scope', () => {
    const linuxOnly = hydrated({
      row: row({
        version: '0.0.23',
        artifacts: [art('0.0.23', 'linux-x86_64', 'gui', 'Papercusp GUI_0.0.23_amd64.deb')],
      }),
    });
    const cards = groupReleaseCards([linuxOnly, base]);
    expect(cards.map((c) => [c.base.row.version, c.hotfixes.length])).toEqual([
      ['0.0.23', 0],
      ['0.0.22', 0],
    ]);
  });
});

// open-source-release-2026-09-29 D-030: an artifact pulled from the channel keeps its
// registry entry (marked `withdrawn`) but must not be offered for download anywhere.
describe('withdrawn artifacts', () => {
  const opts = { generatedAt: GENERATED_AT, analytics: null, redact: [] };
  const listed = {
    product: 'gui' as const,
    platform: 'linux-x86_64',
    name: 'Papercusp GUI_0.0.25_amd64.deb',
    url: 'desktop-v0.0.25-alpha/Papercusp GUI_0.0.25_amd64.deb',
    size: 1_000,
    sha256: 'aaa',
  };
  const pulled = {
    product: 'gui' as const,
    platform: 'linux-x86_64',
    name: 'Papercusp_GUI_0.0.25_amd64.AppImage',
    url: 'desktop-v0.0.25-alpha/Papercusp_GUI_0.0.25_amd64.AppImage',
    size: 2_000,
    sha256: 'bbb',
    withdrawn: { at: '2026-10-06T11:00:00Z', reason: 'fails the installer license scan', ref: 'D-030' },
  };
  const rel = hydrated({ row: row({ version: '0.0.25', artifacts: [listed, pulled] }) });

  it('the releases page links the listed artifact and not the withdrawn one', () => {
    const html = renderIndexHtml([rel], opts);
    expect(html).toContain('Papercusp GUI_0.0.25_amd64.deb');
    expect(html).not.toContain('Papercusp_GUI_0.0.25_amd64.AppImage');
  });

  it('history.json (the in-app update feed) omits the withdrawn artifact', () => {
    const json = JSON.parse(renderHistoryJson([rel], opts)) as {
      releases: Array<{ artifacts: Array<{ name: string }> }>;
    };
    expect(json.releases[0]!.artifacts.map((a) => a.name)).toEqual(['Papercusp GUI_0.0.25_amd64.deb']);
  });

  it('a release whose only artifact is withdrawn says it has no downloads', () => {
    const html = renderIndexHtml([hydrated({ row: row({ version: '0.0.25', artifacts: [pulled] }) })], opts);
    expect(html).not.toContain('Papercusp_GUI_0.0.25_amd64.AppImage');
    expect(html).toContain('No downloadable artifacts recorded for this release.');
  });
});
