/** WI-10007176: measure the actual CSS cascade, including translucent fills.
 * The goal embed has no .session-chat ancestor. The former popup-only token
 * selector passed its source test while leaving that embed pale-on-white.
 * This stylesheet integration fixture needs no API, account, or live server.
 * Fixture entry: 'apps/operator/e2e/__fixtures__/operator-chat-theme.ts'.
 * That entry also enrolls this spec in the existing affected-browser-test lane.
 */
import AxeBuilder from '@axe-core/playwright';
import { PAPERCUP_CHAT_CSS } from '../../../packages/operator-ui/src/papercup-chat/papercup-chat.styles';
import { test, expect, type Page } from './_egress';
import { hostCss, operatorHostSource, themeCss, themes } from './__fixtures__/operator-chat-theme';

const hosts = ['goal', 'session', 'operator'] as const;

async function mount(page: Page, host: typeof hosts[number], theme: typeof themes[number], css = hostCss) {
  expect(operatorHostSource).toMatch(/\bimport\s+["']\.\/operator-chat\.css["']/);
  await page.setContent(`<!doctype html><html lang="en" data-theme="${theme}"><head>
    <title>Chat contrast regression</title><style>${themeCss}\n${PAPERCUP_CHAT_CSS}\n${css}
    body { margin: 0; background: var(--bg); color: var(--fg); font-family: sans-serif; }
    main { width: 580px; height: 500px; padding: 20px; background: var(--bg-popover); }
    </style></head><body><main class="${host === 'session' ? 'session-chat' : ''}" data-testid="${host}-chat">
    <div class="pc-chat op-chat-shared"><div class="pc-chat__scroller">
      <div class="pc-chat__turn pc-chat__turn--assistant">
        <span class="pc-chat__time">Oct 7 · 12:32</span>
        <div class="pc-chat__body"><p class="pc-chat__p">The goal chat is readable without a popup wrapper.</p>
          <p class="pc-chat__p"><strong>Verified result:</strong> <em>high-contrast text</em> and <code>inline code</code>.</p>
          <ul><li>Readable list item</li><li><a href="#verification">Verification details</a></li></ul>
          <blockquote>Supporting context remains readable.</blockquote>
        </div>
      </div>
      <div class="pc-chat__turn pc-chat__turn--user"><div class="pc-chat__body">
        <p class="pc-chat__p">Please fix the chat pane.</p>
      </div></div>
    </div></div></main></body></html>`);
}

for (const theme of themes) {
  for (const host of hosts) {
    test(`${host} chat text meets AA contrast in ${theme}`, async ({ page }, testInfo) => {
      await mount(page, host, theme);
      expect(await page.locator('.op-chat-shared').evaluate((el) => el.closest('.session-chat') !== null))
        .toBe(host === 'session');
      const result = await new AxeBuilder({ page }).include('.op-chat-shared').withRules(['color-contrast']).analyze();
      await testInfo.attach('contrast', { body: JSON.stringify(result), contentType: 'application/json' });
      expect(result.violations).toEqual([]);
      expect(result.incomplete).toEqual([]);
      expect(result.passes.find((rule) => rule.id === 'color-contrast')?.nodes.length).toBeGreaterThan(0);
      if (theme === 'frost' && host === 'goal') {
        await page.screenshot({ path: testInfo.outputPath('goal-chat-readable.png') });
      }
    });
  }
}

test('negative control detects the original popup-only theme scope', async ({ page }, testInfo) => {
  const popupOnly = hostCss.replace('.op-chat-shared {', '.session-chat .op-chat-shared {');
  expect(popupOnly).not.toBe(hostCss);
  await mount(page, 'goal', 'frost', popupOnly);
  await expect(page.locator('.pc-chat__body').first()).toHaveCSS('background-color', 'rgb(247, 247, 248)');
  const result = await new AxeBuilder({ page }).include('.op-chat-shared').withRules(['color-contrast']).analyze();
  expect(result.violations.some((rule) => rule.id === 'color-contrast')).toBe(true);
  await testInfo.attach('original-scope-contrast-failure', { body: JSON.stringify(result), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('goal-chat-original-failure.png') });
});
