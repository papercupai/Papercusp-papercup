import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeNativeBridgeJson } from './_native-bridge-json';

const exec = promisify(execFile);

test('Reports reader and individual Work panes fullscreen and restore their layout', async () => {
  test.setTimeout(240_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_SEED).toBe('ready');
  const pid = process.env.VERIFY_TAURI_PID;
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN;
  if (!pid || !tool) throw new Error('Run inside the isolated native Tauri verifier');
  async function native(command: string, ...args: string[]) {
    const { stdout } = await exec(tool!, [command, '--pid', pid!, ...args, '--json'], { timeout: 30_000 });
    return decodeNativeBridgeJson(stdout, command);
  }
  const evaluate = (expression: string) => native('eval', expression);
  const click = (label: string) => native('click', `[aria-label=${JSON.stringify(label)}]`);
  const visible = (selector: string) => evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    const r = e?.getBoundingClientRect();
    return !!r && r.width > 0 && r.height > 0;
  })()`);
  const fillsViewport = (selector: string) => evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return !!r && Math.abs(r.x) < 2 && Math.abs(r.y) < 2
      && Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
  })()`);
  const wait = (probe: () => Promise<unknown>) => expect.poll(probe, { timeout: 60_000 }).toBe(true);

  await native('navigate', '/reports');
  await wait(() => visible('[aria-label="Fullscreen report reader"]'));
  await click('Fullscreen report reader');
  await wait(() => fillsViewport('.reports-reader--fullscreen'));
  await click('Restore report reader');
  await wait(() => evaluate('!document.querySelector(".reports-reader--fullscreen")'));
  // Exercise the app's Escape path inside the native WebView as well.
  await click('Fullscreen report reader');
  await wait(() => fillsViewport('.reports-reader--fullscreen'));
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await wait(() => evaluate('!document.querySelector(".reports-reader--fullscreen")'));

  await native('navigate', '/adv?tab=harnesses&slug=papercusp&scope=self&welcome=false');
  await wait(() => visible('[aria-label="Fullscreen Work items"]'));
  const panes = ['Work items', 'Dependency graph', 'Detail'];
  // The private profile starts from the default layout; retain actual geometry
  // to verify that maximize never overwrites its split ratios.
  const layout = () => evaluate(`JSON.stringify(${JSON.stringify(panes)}.map(title => {
    const e = document.querySelector('[aria-label="Fullscreen ' + title + '"]')?.closest('.dv-groupview');
    const r = e?.getBoundingClientRect();
    return r ? [title, ...[r.x, r.y, r.width, r.height].map(Math.round)] : [title, null];
  }))`);
  const before = await layout();
  for (const [index, title] of panes.entries()) {
    await click(`Fullscreen ${title}`);
    await wait(() => fillsViewport('[data-testid="dock-fullscreen-surface"][data-fullscreen="true"]'));
    await wait(() => evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(`[aria-label="Restore ${title}"]`)})?.closest('.dv-groupview');
      const r = e?.getBoundingClientRect();
      return !!r && r.width > innerWidth - 20 && r.height > innerHeight - 60;
    })()`));
    if (index === 1) {
      await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    } else await click(`Restore ${title}`);
    await wait(() => visible(`[aria-label="Fullscreen ${title}"]`));
    await expect.poll(layout, { timeout: 15_000 }).toBe(before);
  }
});
