/**
 * /adv Harnesses tab — create a Hive from a GitHub repo
 * (hive-from-github-url-2026-06-11 P-018 e2e). Drives the REAL header "New" →
 * CreateHarnessPicker → Search GitHub entry on the live default path
 * (`/adv?tab=harnesses&slug=<hive>` → `?create=true` → `?picker=github-url`,
 * both nuqs axes), NOT a component story with injected props (the EI-89 /
 * D-007 bug class is "works under injected props, mis-wired on the live
 * default path").
 *
 * comb-hive-native-sharing P-006/P-009 reworked this entry: the picker now
 * groups Create / Join, and the "Search GitHub" card opens a search panel; a
 * pasted repo URL short-circuits to the create form (EntryGithubUrlForm).
 * These specs drive that path. (Not yet live-run under Tauri — that's P-013.)
 *
 * Covers:
 *   P-018a  the picker (POT_FROM_GITHUB_URL on — the default) shows the
 *           hive-native Create / Join layout: the "Search GitHub" entry with
 *           its create-or-join explainer, and the Join cards (Browse the Comb,
 *           hive invite, harness link).
 *   P-018b  selecting the entry renders EntryGithubUrlForm on the real URL
 *           axis: new-hive is the headline default mode, visibility defaults
 *           Public, and the slug auto-derives from the repo name
 *           (octocat/Hello-World → `hello-world`, home `hello-world-hive`).
 *   P-018c  an invalid URL fails inline client-side — NO network call.
 *   P-018d  a mocked created-response renders the success summary (potSlug /
 *           memberSlug / publish outcome) and Done lands the new hive focused
 *           (`?slug=`).
 *   P-018e  a mocked existing-response (joinable) renders the JOIN-OFFER card
 *           (title / owner / member-link count / Join button).
 *   P-018f  a mocked existing-response with no member links offers
 *           Create-anyway, which re-submits with force:true and renders the
 *           duplicate-flagged summary.
 *
 * Hermetic: stubs `/api/flags/bootstrap` (pins POT_FROM_GITHUB_URL +
 * THE_HIVE so copy is deterministic), the `harnessProjects.lite` sync query +
 * benign dock fetches, and MOCKS POST /api/harness/pots/from-repo — the spec
 * never clones a repository or writes anything. The sync stub is asserted so
 * a missed fixture cannot silently load real workspace projects. The
 * projects/join-link POSTs are stubbed to fail loudly so a mis-route can never
 * hit the real backend.
 *
 * NB (same as the creation-fork spec): the operator-vite SPA only renders
 * against a BUILT bundle (staging-served dist on :3170, or a vite preview) —
 * a stale HMR-disabled :3055 serves a blank #root, so these `test.skip`. The
 * WebKitGTK/Tauri-shell confirmation per D-007 is a separate agent-driven run
 * (isolated Xvfb), recorded as plan evidence.
 *
 * NB: the creation-fork spec opens the picker via the bottom-right
 * `/new harness/i` FAB, which has since been REMOVED (see the
 * HarnessesWorkspace header comment) — that opener is stale. The live entry
 * is the shell header's "New" button (title 'Create or add a new harness'),
 * which is what this spec drives.
 */
import { test, expect, assertMounted, type Page, type Locator } from './_egress';
import { stubSyncQueries, type SyncQueryStub } from './_sync-stub';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

const HIVE = 'e2e-hive';
const MEMBER_RD = 'e2e-hive-rd';

const REPO_URL = 'https://github.com/octocat/Hello-World';
const DERIVED_SLUG = 'hello-world'; // deriveSlugFromRepo('Hello-World')
const HOME_SLUG = 'hello-world-hive';

/** Sync-query fixture: a real root + a member so the tab mounts its dock. */
const PROJECTS_LITE = {
  projects: [
    { slug: HIVE, path: `/tmp/${HIVE}`, hasState: true, hasSpec: true, parent_slug: null, harness_kind: 'project', is_shared: false },
    { slug: MEMBER_RD, path: `/tmp/${MEMBER_RD}`, hasState: true, hasSpec: false, parent_slug: HIVE, harness_kind: 'coding', is_shared: false },
  ],
};

interface FromRepoCapture {
  bodies: Array<Record<string, unknown>>;
}

/**
 * Pin the flags this spec depends on (POT_FROM_GITHUB_URL — the live entry;
 * THE_HIVE — "Hive" lexicon so copy assertions are deterministic), stub the
 * `harnessProjects.lite` sync query + benign dock fetches, and fail-loud-stub the OTHER write
 * endpoints so a mis-routed create can never touch the real backend.
 */
async function stubBase(page: Page): Promise<SyncQueryStub> {
  await page.route('**/api/flags/bootstrap', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        flags: { 'papercusp-hive-from-github-url': true, 'papercusp-the-hive': true },
        evaluatedAt: Date.now(),
        source: 'api',
      }),
    });
  });
  const sync = await stubSyncQueries(page, (name) =>
    name === 'harnessProjects.lite' ? PROJECTS_LITE.projects : undefined,
  );
  // Guard rails: this spec must NEVER create anything for real.
  await page.route('**/api/harness/projects', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'e2e: unexpected projects POST', code: 'e2e_unexpected' }) });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/harness/join-link', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'e2e: unexpected join-link POST', code: 'e2e_unexpected' }) });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/harness/*/lanes**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lanes: [], max: 1 }) });
  });
  await page.route('**/api/harness/*/status**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ iteration: 1, alive: false, counts: { passed: 0 } }) });
  });
  await page.route('**/api/harness/*/agents**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [] }) });
  });
  return sync;
}

/**
 * MOCK POST /api/harness/pots/from-repo (the spec never clones): responses
 * are served in order (the last repeats), and every request body is captured —
 * the force:true / visibility / no-network oracles.
 */
async function stubFromRepo(page: Page, responses: Array<Record<string, unknown>>): Promise<FromRepoCapture> {
  const cap: FromRepoCapture = { bodies: [] };
  let i = 0;
  await page.route('**/api/harness/pots/from-repo', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    cap.bodies.push(JSON.parse(route.request().postData() ?? '{}'));
    const body = responses[Math.min(i, responses.length - 1)];
    i += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return cap;
}

const CREATED_RESPONSE = {
  ok: true,
  created: { potSlug: HOME_SLUG, memberSlug: DERIVED_SLUG, memberPath: `/tmp/${DERIVED_SLUG}`, defaultBranch: 'main' },
  publish: { announced: true, cupboard: { attempted: true, rowsCreated: 2, rowsFailed: 0 } },
};

const EXISTING_JOINABLE_RESPONSE = {
  ok: true,
  existing: {
    kind: 'hive',
    hive: {
      potId: 'h-hello-world',
      title: 'Hello World Hive',
      ownerGithubLogin: 'octocat',
      memberLinks: ['papercusp://harness?v=1&payload=e2e-member-link'],
      claimStatus: 'claimed',
    },
    coords: { owner: 'octocat', repo: 'Hello-World' },
    source: 'cupboard',
  },
};

const EXISTING_UNJOINABLE_RESPONSE = {
  ok: true,
  existing: {
    kind: 'hive',
    hive: { potId: 'h-hello-world', title: 'Hello World Hive', ownerGithubLogin: 'octocat', memberLinks: [], claimStatus: 'unclaimed' },
    coords: { owner: 'octocat', repo: 'Hello-World' },
    source: 'cupboard',
  },
};

const FORCED_CREATED_RESPONSE = {
  ok: true,
  created: {
    potSlug: HOME_SLUG,
    memberSlug: DERIVED_SLUG,
    memberPath: `/tmp/${DERIVED_SLUG}`,
    defaultBranch: 'main',
    duplicateOf: { kind: 'hive', hivePubkey: 'abc123', source: 'cupboard' },
  },
  publish: { announced: true, cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 } },
};

const DOCK_MOUNT = { role: 'button', name: 'Add panel' } as const;
const SKIP_MSG =
  'The /adv shell did not mount the Harnesses tab. Run against a BUILT operator-vite bundle ' +
  '(staging-served dist on :3170 via OPERATOR_E2E_BASE_URL=http://127.0.0.1:3170, or a vite preview) — ' +
  "a stale HMR-disabled :3055 serves a blank #root.";

async function gotoHarnessesTab(page: Page, search: string, sync: SyncQueryStub): Promise<boolean> {
  await page.goto(`${baseURL}/adv?tab=harnesses&${search}`, { waitUntil: 'domcontentloaded' });
  await sync.waitForServed(['harnessProjects.lite']);
  return page
    .getByRole(DOCK_MOUNT.role, { name: DOCK_MOUNT.name })
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

/** Open the create picker from the shell header's "New" button. */
async function openPicker(page: Page): Promise<Locator> {
  // Locate by the button's stable class, not its wording: the header button
  // lost its `title` attribute to a <Tooltip>, and both its label and the
  // dialog title now render through the lexicon (`Create or add a new
  // ${t('pot')}` / `Add a ${t('pot')}`), so a literal 'harness' never matches
  // (WI-10006792).
  await page.locator('button.pc-advshell__action--new').first().click();
  const dialog = page.getByRole('dialog', { name: /^Add a /i });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

/**
 * Picker grid → Search GitHub → paste the repo URL → short-circuit to the
 * create form (EntryGithubUrlForm, `?picker=github-url`). The pasted URL
 * prefills the form's URL field (P-009).
 */
async function openGithubUrlForm(page: Page): Promise<Locator> {
  const dialog = await openPicker(page);
  await dialog.getByRole('button', { name: /Search GitHub/ }).click();
  await dialog.getByRole('searchbox').fill(REPO_URL);
  await dialog.getByTestId('gh-search-url-continue').click();
  await expect(dialog.getByRole('heading', { name: 'GitHub URL' })).toBeVisible({ timeout: 10_000 });
  return dialog;
}

test.describe('/adv Harnesses tab — Hive from GitHub repo (P-018)', () => {
  test('P-018a picker shows the hive-native Create / Join layout (flag-on default)', async ({ page }) => {
    const sync = await stubBase(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`, sync);
    assertMounted(mounted, SKIP_MSG);

    const dialog = await openPicker(page);
    // Create group — the Search GitHub entry with its create-or-join explainer.
    await expect(dialog.getByRole('button', { name: /Search GitHub/ })).toBeVisible();
    await expect(dialog.getByText(/Find any repo on GitHub and create or join/)).toBeVisible();
    // The old "GitHub URL" card label is gone (folded into search, P-006).
    await expect(dialog.getByRole('button', { name: 'GitHub URL' })).toHaveCount(0);
    // Join group — the cards (no more demoted underline affordances). "Browse
    // the Comb" is a link to /cupboard (closing the modal in the same
    // navigation, WI-10003268); the other two are buttons.
    await expect(dialog.getByRole('link', { name: /Browse the Comb/ })).toHaveAttribute('href', '/cupboard?create=false');
    // Lexicon-independent: the card reads "<Pot|Hive> invite" per t('pot').
    await expect(dialog.getByRole('button', { name: /(Hive|Pot) invite/i })).toBeVisible();
    // The legacy per-hive "Hive link" / "Harness link" join card is retired.
    await expect(dialog.getByRole('button', { name: /Harness link/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /Hive link/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /I have a harness link/ })).toHaveCount(0);
  });

  test('P-018b entry renders EntryGithubUrlForm: new-hive default, visibility Public, slug auto-derive', async ({ page }) => {
    const sync = await stubBase(page);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`, sync);
    assertMounted(mounted, SKIP_MSG);

    const dialog = await openGithubUrlForm(page);
    // The selected entry rides the nuqs `?picker=` axis (the live URL state).
    await expect.poll(() => new URL(page.url()).searchParams.get('picker'), { timeout: 10_000 }).toBe('github-url');

    // The creation fork (P-012): new-hive is the headline default; no hive
    // scope on the shell picker ⇒ no "Add to <hive>" mode. Every created Pot is
    // a hive, so the plain-harness "Standalone" mode is RETIRED.
    const fork = dialog.getByRole('group', { name: 'Creation mode' });
    await expect(fork.getByRole('button', { name: /^New (hive|pot)$/i })).toHaveAttribute('aria-pressed', 'true');
    await expect(fork.getByRole('button', { name: 'Standalone' })).toHaveCount(0);
    await expect(fork.getByRole('button', { name: /^Add to/ })).toHaveCount(0);

    // Visibility is DERIVED from the repo's privacy (the chooser radio is
    // retired): a pasted URL has unknown privacy ⇒ the neutral read-only hint.
    const visibility = dialog.getByTestId('derived-visibility');
    await expect(visibility).toBeVisible();
    await expect(visibility.getByText(/Visibility is set automatically from the repository/)).toBeVisible();

    // Slug auto-derive: octocat/Hello-World → hello-world (+ home hello-world-hive).
    await dialog.getByPlaceholder('https://github.com/owner/repo').fill(REPO_URL);
    await dialog.getByRole('button', { name: /Advanced: customize slug/ }).click();
    await expect(dialog.getByLabel('Slug')).toHaveValue(DERIVED_SLUG);
    await expect(dialog.getByText(/The hive home becomes/)).toBeVisible();
    await expect(dialog.getByText(HOME_SLUG, { exact: true })).toBeVisible();
  });

  test('P-018c invalid URL fails inline with NO network call', async ({ page }) => {
    const sync = await stubBase(page);
    const cap = await stubFromRepo(page, [CREATED_RESPONSE]);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`, sync);
    assertMounted(mounted, SKIP_MSG);

    const dialog = await openGithubUrlForm(page);
    await dialog.getByPlaceholder('https://github.com/owner/repo').fill('https://gitlab.com/acme/rocket');
    await dialog.getByRole('button', { name: 'Create hive' }).click();

    // Inline client-side validation (mirrors the server parser)…
    await expect(dialog.getByText(/Not a valid GitHub repository URL/)).toBeVisible();
    // …the form never left the draft phase (no progress strip)…
    await expect(dialog.getByTestId('github-url-progress')).toHaveCount(0);
    // …and the backend was never called.
    expect(cap.bodies).toHaveLength(0);
  });

  test('P-018d clean created response closes the dialog and focuses the new hive', async ({ page }) => {
    const sync = await stubBase(page);
    const cap = await stubFromRepo(page, [CREATED_RESPONSE]);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`, sync);
    assertMounted(mounted, SKIP_MSG);

    const dialog = await openGithubUrlForm(page);
    await dialog.getByPlaceholder('https://github.com/owner/repo').fill(REPO_URL);
    await dialog.getByRole('button', { name: 'Create hive' }).click();

    // modal-lifecycle-2026-06-17: a CLEAN create (no one-time invite secret,
    // no warning to read) does not linger on a success view — the dialog closes
    // and onCreated focuses the new hive (?slug=). The stay-open summary path is
    // covered by P-018f (duplicate-flagged).
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => new URL(page.url()).searchParams.get('slug'), { timeout: 10_000 }).toBe(HOME_SLUG);

    // The POST carried the URL and NO chosen visibility (it is derived
    // server-side from the repo's privacy) and no force flag.
    expect(cap.bodies).toHaveLength(1);
    expect(cap.bodies[0].githubUrl).toBe(REPO_URL);
    expect(cap.bodies[0]).not.toHaveProperty('visibility');
    expect(cap.bodies[0].force).toBeUndefined();
  });

  test('P-018e existing (joinable) response renders the join-offer card with Join', async ({ page }) => {
    const sync = await stubBase(page);
    const cap = await stubFromRepo(page, [EXISTING_JOINABLE_RESPONSE]);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`, sync);
    assertMounted(mounted, SKIP_MSG);

    const dialog = await openGithubUrlForm(page);
    await dialog.getByPlaceholder('https://github.com/owner/repo').fill(REPO_URL);
    await dialog.getByRole('button', { name: 'Create hive' }).click();

    // The JOIN OFFER (zero side effects happened server-side).
    await expect(dialog.getByRole('heading', { name: /A hive already exists for this repository/ })).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText('Hello World Hive')).toBeVisible();
    await expect(dialog.getByText('owner: octocat')).toBeVisible();
    await expect(dialog.getByText('1 member harness')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Join hive' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
    // Joinable ⇒ no Create-anyway.
    await expect(dialog.getByRole('button', { name: 'Create anyway' })).toHaveCount(0);
    expect(cap.bodies).toHaveLength(1);
  });

  test('P-018f existing non-joinable response offers Create-anyway → force:true → duplicate-flagged summary', async ({ page }) => {
    const sync = await stubBase(page);
    const cap = await stubFromRepo(page, [EXISTING_UNJOINABLE_RESPONSE, FORCED_CREATED_RESPONSE]);
    const mounted = await gotoHarnessesTab(page, `slug=${HIVE}`, sync);
    assertMounted(mounted, SKIP_MSG);

    const dialog = await openGithubUrlForm(page);
    await dialog.getByPlaceholder('https://github.com/owner/repo').fill(REPO_URL);
    await dialog.getByRole('button', { name: 'Create hive' }).click();

    // Exists but isn't joinable yet — no Join button, Create-anyway offered.
    await expect(dialog.getByRole('heading', { name: /A hive already exists for this repository/ })).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(/isn[’']t joinable yet/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Join hive' })).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Create anyway' }).click();

    // The re-submit carried force:true (the duplicateOf-flagged path).
    await expect.poll(() => cap.bodies.length, { timeout: 10_000 }).toBe(2);
    expect(cap.bodies[0].force).toBeUndefined();
    expect(cap.bodies[1].force).toBe(true);
    expect(cap.bodies[1].githubUrl).toBe(REPO_URL);

    // The duplicate-flagged success summary.
    await expect(dialog.getByRole('heading', { name: /Hive created/ })).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(/Created as a duplicate of an existing hive/)).toBeVisible();
  });
});
