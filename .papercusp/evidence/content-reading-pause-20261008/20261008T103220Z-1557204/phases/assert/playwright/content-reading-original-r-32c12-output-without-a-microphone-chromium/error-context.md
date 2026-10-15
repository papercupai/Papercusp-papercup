# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: content-reading.spec.ts >> original reading preserves its final tail and pauses/resumes the same output without a microphone
- Location: e2e/content-reading.spec.ts:89:5

# Error details

```
TimeoutError: locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Pause', exact: true })

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e2]:
    - complementary "Pot steering sidebar" [ref=e3]:
      - generic [ref=e4]:
        - button "Collapse sidebar" [ref=e6] [cursor=pointer]:
          - img [ref=e7]
        - tablist [ref=e10]:
          - tab "Accounts" [selected] [ref=e11] [cursor=pointer]:
            - img [ref=e13]
            - generic [ref=e16]: Accounts
          - tab "Papercup" [ref=e17] [cursor=pointer]:
            - img [ref=e19]
            - generic [ref=e23]: Papercup
          - tab "Pulse" [ref=e24] [cursor=pointer]:
            - img [ref=e26]
            - generic [ref=e28]: Pulse
        - generic [ref=e30]:
          - generic [ref=e31]:
            - generic [ref=e32]:
              - img [ref=e33]
              - generic [ref=e36]:
                - generic [ref=e37]: spawn account pool
                - paragraph [ref=e38]: Session steering for fleet account use.
            - generic "Account pool summary" [ref=e39]:
              - generic [ref=e40]:
                - generic [ref=e41]: 0/0
                - text: avail
              - generic [ref=e42]:
                - generic [ref=e43]: "0"
                - text: Claude
              - generic [ref=e44]:
                - generic [ref=e45]: "0"
                - text: Codex
              - generic [ref=e46]:
                - generic [ref=e47]: "0"
                - text: paused
              - generic [ref=e48]:
                - generic [ref=e49]: "0"
                - text: limited
              - generic [ref=e50]:
                - generic [ref=e51]: "off"
                - text: steer
          - note [ref=e52]:
            - strong [ref=e53]: ★ Default
            - text: starts here ·
            - strong [ref=e54]: Force
            - text: allow-lists ·
            - strong [ref=e55]: Excl
            - text: skips · none uses the whole pool
          - status [ref=e56]:
            - generic [ref=e57]:
              - text: No default — using this machine’s own Claude login (
              - code [ref=e58]: ~/.claude
              - text: ).
          - generic [ref=e59]: No accounts in the pool yet.
          - link "Add / remove accounts…" [ref=e60] [cursor=pointer]:
            - /url: /settings/deploy-accounts
            - img [ref=e61]
            - text: Add / remove accounts…
          - paragraph [ref=e64]: Usage is the last observed provider limit signal from the inference gateway. Claude rows show Max 5h + 7d windows; Codex rows show OpenAI-compatible route usage when available.
      - separator "Resize sidebar" [ref=e65]
    - status [ref=e66]
    - alert [ref=e67]
    - complementary "Papercup chat" [ref=e68]:
      - generic [ref=e69]:
        - generic [ref=e71]:
          - button "Show plans" [ref=e72] [cursor=pointer]:
            - img [ref=e73]
          - button "Show Resolution Inbox" [ref=e76] [cursor=pointer]:
            - img [ref=e77]
            - generic "23 inbox items need you" [ref=e80]: "23"
          - button "Papercup chat" [pressed] [ref=e81] [cursor=pointer]:
            - img [ref=e83]
          - button "Show pot health" [ref=e97] [cursor=pointer]:
            - generic [ref=e98]: 🎯
            - generic: Pot Health
          - group "Papercup voice controls — ready" [ref=e99]:
            - button "Audience mode settings" [ref=e100] [cursor=pointer]:
              - img [ref=e101]
            - 'button "Papercup interaction mode: active. Click to set passive." [ref=e102] [cursor=pointer]'
            - button "Voice mode" [ref=e105] [cursor=pointer]:
              - generic [ref=e107]: 🚫
            - button "Mute spoken voice replies" [pressed] [ref=e108] [cursor=pointer]:
              - img [ref=e109]
            - button "Read selected text aloud" [expanded] [ref=e113] [cursor=pointer]: Read aloud
          - button "Collapse Papercup chat" [ref=e114] [cursor=pointer]:
            - img [ref=e115]
        - generic [ref=e117]:
          - generic [ref=e118]:
            - status [ref=e119]:
              - generic [ref=e120]:
                - generic [ref=e121]: Papercup
                - generic [ref=e122]: Tell me what you want to inspect, scan, or unblock.
                - generic "Quick draft prompts" [ref=e123]:
                  - generic [ref=e124]:
                    - img [ref=e125]
                    - generic [ref=e136]: Quick draft prompts
                  - generic [ref=e137]:
                    - 'button "Scan workspaces: find active harnesses and urgent issues. Draft this prompt." [ref=e138] [cursor=pointer]':
                      - generic [ref=e139]: Scan workspaces
                      - generic [ref=e140]: find active harnesses and urgent issues
                      - text: Draft
                    - 'button "Review blockers: surface failing runs, audits, and pending answers. Draft this prompt." [ref=e141] [cursor=pointer]':
                      - generic [ref=e142]: Review blockers
                      - generic [ref=e143]: surface failing runs, audits, and pending answers
                      - text: Draft
                    - 'button "Summarize state: get a quick brief on what changed recently. Draft this prompt." [ref=e144] [cursor=pointer]':
                      - generic [ref=e145]: Summarize state
                      - generic [ref=e146]: get a quick brief on what changed recently
                      - text: Draft
            - log
          - generic [ref=e147]:
            - textbox "Message Papercup" [ref=e148]:
              - /placeholder: Reply to Papercup…
            - button "Generate ideas" [ref=e150] [cursor=pointer]:
              - img [ref=e151]
            - button "Send" [disabled] [ref=e153]
      - separator "Resize Papercup chat" [ref=e154]
    - main [ref=e155]:
      - generic [ref=e158]:
        - heading "Welcome to Papercusp" [level=1] [ref=e159]
        - paragraph [ref=e160]: The chat-first onboarding runs inside the desktop app. In a browser, use the classic setup wizard instead.
        - button "Open the setup wizard" [ref=e161] [cursor=pointer]
        - paragraph [ref=e162]:
          - button "Skip setup — go to the app" [ref=e163] [cursor=pointer]
    - region "Notifications alt+T"
    - complementary "Dev admin rail" [ref=e164]:
      - button "Open dev admin rail" [ref=e165] [cursor=pointer]:
        - img [ref=e167]
        - generic [ref=e169]: Dev
        - img [ref=e170]
    - button "app v0.0.26 · c0bb6e7be2 started 10/8/2026, 6:36:32 AM browser":
      - generic: v0.0.26
      - generic: ·
      - generic: c0bb6e7be2
  - dialog "Original reading controls" [ref=e173]:
    - group "Original reading controls" [ref=e174]:
      - generic [ref=e175]:
        - text: Text to read or summarize
        - textbox "Text to read or summarize" [active] [ref=e176]: Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. Authorized source sentence. EXACT FINAL TAIL
      - generic [ref=e177]:
        - checkbox "Allow selected text to use cloud speech" [ref=e178]
        - text: Allow selected text to use cloud speech
      - button "Read selection" [ref=e179] [cursor=pointer]
      - generic [ref=e180]:
        - checkbox "Allow this text to use a cloud summary model" [ref=e181]
        - text: Allow this text to use a cloud summary model
      - generic [ref=e182]:
        - text: Summary length
        - combobox "Summary length" [ref=e183]:
          - option "Short"
          - option "Standard" [selected]
          - option "Detailed"
      - generic [ref=e184]:
        - text: Summary focus
        - textbox "Summary focus" [ref=e185]:
          - /placeholder: Optional
      - generic [ref=e186]:
        - text: Summary language
        - textbox "Summary language" [ref=e187]:
          - /placeholder: Original language
      - group [ref=e188]:
        - generic "Model and account" [ref=e189]
      - button "Summarize" [ref=e190] [cursor=pointer]
      - button "Summarize and read" [ref=e191] [cursor=pointer]
      - progressbar "Reading progress" [ref=e192]
      - status [ref=e193]: stopped · 0%
      - paragraph [ref=e194]: Selected or pasted text only.
```

# Test source

```ts
  4   | /** Production shell and reading player with controlled output adapters. Real provider
  5   |  * synthesis is verified separately; this suite exercises source order, controls,
  6   |  * microphone independence and explicit composition without a device or paid call. */
  7   | type OutputProbe = {
  8   |   created: number; plays: number; pauses: number; resumes: number; mic: number;
  9   |   utterances: string[]; cancellations: string[]; finish(): void;
  10  | };
  11  | type ProbeWindow = Window & { __contentOutput: OutputProbe };
  12  | 
  13  | async function openReading(page: Page) {
  14  |   await page.addInitScript(() => {
  15  |     sessionStorage.setItem('oracle-tutorial-complete', 'true');
  16  |     let finish: (() => void) | undefined;
  17  |     const probe: OutputProbe = {
  18  |       created: 0, plays: 0, pauses: 0, resumes: 0, mic: 0, utterances: [], cancellations: [],
  19  |       finish() { const callback = finish; finish = undefined; callback?.(); },
  20  |     };
  21  |     (window as unknown as ProbeWindow).__contentOutput = probe;
  22  |     class ControlledAudio {
  23  |       playbackRate = 1;
  24  |       currentTime = 0;
  25  |       onended: (() => void) | null = null;
  26  |       onerror: (() => void) | null = null;
  27  |       constructor() { probe.created++; }
  28  |       async play() { probe.plays++; finish = () => this.onended?.(); }
  29  |       pause() { probe.pauses++; }
  30  |     }
  31  |     Object.defineProperty(window, 'Audio', { configurable: true, value: ControlledAudio });
  32  |     Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
  33  |       getVoices: () => [{ name: 'Content fixture local voice', lang: 'en-US', localService: true }],
  34  |       speak(utterance: SpeechSynthesisUtterance) {
  35  |         probe.created++; probe.plays++; probe.utterances.push(utterance.text);
  36  |         finish = () => utterance.onend?.(new Event('end') as SpeechSynthesisEvent);
  37  |       },
  38  |       pause() { probe.pauses++; }, resume() { probe.resumes++; },
  39  |       cancel() { probe.cancellations.push(new Error('Speech cancelled').stack ?? 'unknown caller'); probe.pauses++; finish = undefined; },
  40  |     } });
  41  |     if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
  42  |       probe.mic++;
  43  |       throw new DOMException('Output-only reading must not request a microphone', 'NotAllowedError');
  44  |     };
  45  |   });
  46  |   const turnPosts: string[] = [];
  47  |   page.on('request', request => {
  48  |     if (request.method() === 'POST' && /\/api\/operator\/conversations\/[^/]+\/turns/.test(request.url())) turnPosts.push(request.url());
  49  |   });
  50  |   await page.goto('/?chat=true');
  51  |   const trigger = page.getByRole('button', { name: 'Read selected text aloud' });
  52  |   await expect(trigger).toBeVisible({ timeout: 60_000 });
  53  |   await trigger.click();
  54  |   await expect(page.getByRole('textbox', { name: 'Text to read or summarize' })).toBeVisible();
  55  |   return turnPosts;
  56  | }
  57  | 
  58  | test.afterEach(async ({ page }, testInfo) => {
  59  |   if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  60  |   const evidence = await page.evaluate(() => {
  61  |     const probe = (window as unknown as ProbeWindow).__contentOutput;
  62  |     return { ...probe, readingStatus: document.querySelector('[aria-label="Original reading controls"] [role="status"]')?.textContent };
  63  |   });
  64  |   await testInfo.attach('controlled-output-diagnostics', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  65  | });
  66  | 
  67  | async function output(page: Page) {
  68  |   return page.evaluate(() => {
  69  |     const { created, plays, pauses, resumes, mic, utterances } = (window as unknown as ProbeWindow).__contentOutput;
  70  |     return { created, plays, pauses, resumes, mic, utterances };
  71  |   });
  72  | }
  73  | 
  74  | async function finishOutput(page: Page) {
  75  |   await page.evaluate(() => (window as unknown as ProbeWindow).__contentOutput.finish());
  76  | }
  77  | 
  78  | async function fulfillReading(route: Route, text: string) {
  79  |   const records = [];
  80  |   for (let start = 0; start < text.length; start += 2000) {
  81  |     const chunk = text.slice(start, start + 2000);
  82  |     records.push({ type: 'chunk', ok: true, start, end: start + chunk.length,
  83  |       text: chunk, contentType: 'audio/wav', audioBase64: 'UklGRg==' });
  84  |   }
  85  |   records.push({ type: 'completed', ok: true });
  86  |   await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: records.map(record => JSON.stringify(record)).join('\n') + '\n' });
  87  | }
  88  | 
  89  | test('original reading preserves its final tail and pauses/resumes the same output without a microphone', async ({ page }) => {
  90  |   const source = 'Authorized source sentence. '.repeat(180) + 'EXACT FINAL TAIL';
  91  |   const reads: string[] = [];
  92  |   await page.route('**/api/agent-mcp/operator-tts', async route => {
  93  |     const body = route.request().postDataJSON();
  94  |     expect(body.operation).toBe('read'); reads.push(body.text);
  95  |     expect(body.allowCloud).toBe(false);
  96  |     await fulfillReading(route, body.text);
  97  |   });
  98  |   const turns = await openReading(page);
  99  |   await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill(source);
  100 |   await page.getByRole('button', { name: 'Read selection', exact: true }).click();
  101 |   await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  102 |   await expect.poll(async () => (await output(page)).plays).toBeGreaterThan(0);
  103 |   const before = await output(page);
> 104 |   await page.getByRole('button', { name: 'Pause', exact: true }).click();
      |                                                                  ^ TimeoutError: locator.click: Timeout 10000ms exceeded.
  105 |   await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  106 |   expect((await output(page)).created).toBe(before.created);
  107 |   await page.getByRole('button', { name: 'Resume', exact: true }).click();
  108 |   expect((await output(page)).created).toBe(before.created);
  109 |   // Both the stream adapter (2000 chars) and browser adapter (4000 bytes) are
  110 |   // controlled at their end event. Every advance waits for the next real output.
  111 |   for (let i = 0; i < 4; i++) {
  112 |     const progress = page.getByRole('progressbar', { name: 'Reading progress' });
  113 |     if (Number(await progress.getAttribute('value')) === source.length) break;
  114 |     const created = (await output(page)).created;
  115 |     await finishOutput(page);
  116 |     await expect.poll(async () => {
  117 |       const value = Number(await progress.getAttribute('value'));
  118 |       return value === source.length || (await output(page)).created > created;
  119 |     }).toBe(true);
  120 |   }
  121 |   const progress = page.getByRole('progressbar', { name: 'Reading progress' });
  122 |   await expect(progress).toHaveAttribute('value', String(source.length));
  123 |   const probe = await output(page);
  124 |   expect(reads.length ? reads.join('') : probe.utterances.join('')).toBe(source);
  125 |   expect(probe.mic).toBe(0); expect(turns).toEqual([]);
  126 | });
  127 | 
  128 | test('summary-only and summary-and-read keep separate consent and source coverage', async ({ page }) => {
  129 |   const source = 'Source with numbers 12 and 34. EXACT FINAL TAIL';
  130 |   const summary = 'The source reports 12 and 34.';
  131 |   const requests: Array<Record<string, unknown>> = [];
  132 |   await page.route('**/api/agent-mcp/operator-tts', async route => {
  133 |     const body = route.request().postDataJSON(); requests.push(body);
  134 |     if (body.operation === 'read') {
  135 |       expect(body.text).toBe(summary); expect(body.allowCloud).toBe(false);
  136 |       await fulfillReading(route, summary); return;
  137 |     }
  138 |     expect(body.operation).toBe('summarize');
  139 |     expect(body.content).toMatchObject({ kind: 'selection', text: source, partial: true });
  140 |     expect(body.summary).toMatchObject({ allowCloud: true, length: 'short', focus: 'numbers', language: 'English' });
  141 |     await route.fulfill({ json: { ok: true, summary, coverage: { complete: false, warnings: ['source-partial'] } } });
  142 |   });
  143 |   const turns = await openReading(page);
  144 |   await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill(source);
  145 |   await page.getByRole('checkbox', { name: 'Allow this text to use a cloud summary model' }).check();
  146 |   await page.getByRole('combobox', { name: 'Summary length' }).selectOption('short');
  147 |   await page.getByRole('textbox', { name: 'Summary focus' }).fill('numbers');
  148 |   await page.getByRole('textbox', { name: 'Summary language' }).fill('English');
  149 |   await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  150 |   await expect(page.getByRole('region', { name: 'Summary', exact: true })).toContainText(summary);
  151 |   await expect(page.getByRole('region', { name: 'Summary', exact: true })).toContainText('source-partial');
  152 |   expect((await output(page)).created).toBe(0);
  153 |   expect(requests).toHaveLength(1);
  154 |   await page.getByRole('button', { name: 'Summarize and read', exact: true }).click();
  155 |   await expect.poll(async () => (await output(page)).plays).toBeGreaterThan(0);
  156 |   const probe = await output(page);
  157 |   expect(requests.filter(request => request.operation === 'summarize')).toHaveLength(2);
  158 |   expect(probe.mic).toBe(0); expect(turns).toEqual([]);
  159 |   await page.getByRole('button', { name: 'Stop', exact: true }).click();
  160 |   await finishOutput(page);
  161 |   await expect(page.getByRole('button', { name: 'Read selection', exact: true })).toBeEnabled();
  162 | });
  163 | 
  164 | test('cancel summary ignores a late result and cannot start obsolete speech', async ({ page }) => {
  165 |   let release!: () => void;
  166 |   let received!: () => void;
  167 |   const requestReceived = new Promise<void>(resolve => { received = resolve; });
  168 |   const responseReleased = new Promise<void>(resolve => { release = resolve; });
  169 |   await page.route('**/api/agent-mcp/operator-tts', async route => {
  170 |     received(); await responseReleased;
  171 |     await route.fulfill({ json: { ok: true, summary: 'Late obsolete summary', coverage: { complete: true, warnings: [] } } }).catch(() => {});
  172 |   });
  173 |   await openReading(page);
  174 |   await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill('Authorized text.');
  175 |   await page.getByRole('button', { name: 'Summarize and read', exact: true }).click();
  176 |   await requestReceived;
  177 |   await page.getByRole('button', { name: 'Cancel summary', exact: true }).click();
  178 |   release();
  179 |   await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeEnabled();
  180 |   await expect(page.getByRole('region', { name: 'Summary', exact: true })).toHaveCount(0);
  181 |   expect((await output(page)).created).toBe(0);
  182 | });
  183 | 
  184 | test('summary failure is visible and never becomes summary text or speech', async ({ page }) => {
  185 |   await page.route('**/api/agent-mcp/operator-tts', route => route.fulfill({ status: 403, json: { ok: false, error: 'Cloud summary requires explicit consent.' } }));
  186 |   await openReading(page);
  187 |   await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill('Private source.');
  188 |   await page.getByRole('button', { name: 'Summarize and read', exact: true }).click();
  189 |   await expect(page.getByText('Cloud summary requires explicit consent.', { exact: true })).toBeVisible();
  190 |   await expect(page.getByRole('region', { name: 'Summary', exact: true })).toHaveCount(0);
  191 |   expect((await output(page)).created).toBe(0);
  192 | });
  193 | 
```