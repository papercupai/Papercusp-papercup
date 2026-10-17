import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { characterStateAt, pageHtml, visemeForCharacter } from '../tutorial-character-model.mjs';

describe('PaperCup speaking character timing', () => {
  it('maps speech characters to stable mouth poses', () => {
    expect(visemeForCharacter('a')).toBe('open');
    expect(visemeForCharacter('m')).toBe('closed');
    expect(visemeForCharacter('w')).toBe('round');
    expect(visemeForCharacter('o')).toBe('round');
    expect(visemeForCharacter('f')).toBe('teeth');
    expect(visemeForCharacter('i')).toBe('narrow');
    expect(visemeForCharacter(' ')).toBe('rest');
  });

  it('rests during silence and selects the aligned character during speech', () => {
    const alignment = { characters: ['h', 'i', '!'], character_start_times_seconds: [0.1, 0.2, 0.4], character_end_times_seconds: [0.2, 0.4, 0.5] };
    expect(characterStateAt(alignment, 0).mouth).toBe('rest');
    expect(characterStateAt(alignment, 0.25).mouth).toBe('narrow');
    expect(characterStateAt(alignment, 0.45).mouth).toBe('rest');
    expect(characterStateAt(alignment, 0.6).mouth).toBe('rest');
  });

  it('closes at exact phrase boundaries and reproduces a pose when seeking backwards', () => {
    const alignment = { characters: ['a', 'm'], character_start_times_seconds: [1, 1.2], character_end_times_seconds: [1.1, 1.3] };
    expect(characterStateAt(alignment, 1.1).mouth).toBe('rest');
    expect(characterStateAt(alignment, 1.2).mouth).toBe('closed');
    const first = characterStateAt(alignment, 1.05);
    characterStateAt(alignment, 3);
    expect(characterStateAt(alignment, 1.05)).toEqual(first);
    expect(characterStateAt(alignment, 2.8).blink).toBe(true);
    expect(characterStateAt(alignment, 0.8).gesture).toBe('idle');
  });

  it('greets during speech, then directs a thoughtful look and gesture toward the demonstrated screen', () => {
    const aligned = (text: string) => ({ characters: [...text], character_start_times_seconds: [...text].map((_, i) => i / 10), character_end_times_seconds: [...text].map((_, i) => (i + 1) / 10) });
    expect(characterStateAt(aligned('Hi, welcome.'), .8)).toMatchObject({ gesture: 'wave', expression: 'happy' });
    expect(characterStateAt(aligned('Open the evidence here.'), 1)).toMatchObject({ gesture: 'point', expression: 'thoughtful', gazeX: -5, leftArmAngle: 40 });
    expect(characterStateAt(aligned('Open the evidence here.'), 4)).toMatchObject({ mouth: 'rest', gesture: 'idle' });
  });

  it('renders a visible resting mouth and closed consonant in valid SVG', () => {
    const svg = readFileSync(new URL('../../public/tutorial-character.svg', import.meta.url), 'utf8');
    // XML parsing catches duplicate attributes that an HTML parser silently discards.
    const xml = new JSDOM(svg, { contentType: 'image/svg+xml' });
    const ids = [...xml.window.document.querySelectorAll('[id]')].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    xml.window.close();
    const alignment = { characters: ['m'], character_start_times_seconds: [1], character_end_times_seconds: [1.2] };
    const dom = new JSDOM(pageHtml(svg, alignment, 2), { runScripts: 'dangerously' });
    const win = dom.window as typeof dom.window & { setTime: (time: number) => void };
    // jsdom does not register SVG <style> sheets; load the same CSS as HTML.
    const style = win.document.createElement('style');
    style.textContent = win.document.querySelector('svg style')!.textContent;
    win.document.head.append(style);
    win.setTime(0);
    const rest = win.document.querySelector('.mouth-rest')!;
    expect(win.getComputedStyle(rest).stroke).toBe('rgb(58, 36, 24)');
    win.setTime(1.05);
    const closed = win.document.querySelector('.mouth-closed')!;
    expect(win.getComputedStyle(closed).display).toBe('block');
    expect(win.getComputedStyle(closed).stroke).toBe('rgb(58, 36, 24)');
    win.setTime(1.2);
    expect(win.document.querySelector('svg')?.getAttribute('data-mouth')).toBe('rest');
    win.close();
  });
});
