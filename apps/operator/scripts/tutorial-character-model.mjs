/** Pure PaperCup animation and page model, shared by the renderer and its contract tests. */
export function visemeForCharacter(character) {
  if (!character || /[\s.,!?;:]/.test(character)) return 'rest';
  if (/[mbp]/i.test(character)) return 'closed';
  if (/[wqou]/i.test(character)) return 'round';
  if (/[fv]/i.test(character)) return 'teeth';
  if (/[eiyjsz]/i.test(character)) return 'narrow';
  return 'open';
}

export function characterStateAt(alignment, seconds) {
  const chars = alignment?.characters ?? [];
  const starts = alignment?.character_start_times_seconds ?? [];
  const ends = alignment?.character_end_times_seconds ?? [];
  let index = -1;
  for (let i = 0; i < chars.length; i += 1) {
    if (seconds >= (starts[i] ?? 0) && seconds < (ends[i] ?? 0)) { index = i; break; }
  }
  const speaking = index >= 0;
  const time = Math.max(0, seconds);
  const context = chars.slice(Math.max(0, index - 55), Math.max(0, index + 12)).join('');
  const wave = speaking && /^hi\b/i.test(chars.join('').trim()) && time > 0.55 && time < 2.2;
  const point = speaking && /\b(here|open|look|show)\b/i.test(context);
  const thoughtful = /\b(check|review|evidence|compare|costs|blocked)\b/i.test(context);
  const happy = /\b(hi|welcome|together|improve)\b|let['’]s/i.test(context);
  return {
    mouth: speaking ? visemeForCharacter(chars[index]) : 'rest',
    expression: thoughtful ? 'thoughtful' : happy ? 'happy' : 'warm',
    blink: time % 3.7 > 2.75 && time % 3.7 < 2.88,
    gesture: wave ? 'wave' : point ? 'point' : 'idle',
    armAngle: wave ? -48 + Math.sin(time * 14) * 12 : Math.sin(time * 1.5) * 2,
    leftArmAngle: point ? 40 : 0,
    gazeX: point ? -5 : Math.sin(time * 0.65) * 1.7,
    tilt: speaking ? Math.sin(time * 2.3) * 0.7 : 0,
  };
}

export function pageHtml(svg, alignment, duration, { width = 960, height = 540, transparent = false } = {}) {
  const clean = svg.replace(/<script[\s\S]*?<\/script>/gi, '');
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:${transparent ? 'transparent' : '#eaf2f5'};overflow:hidden}svg{width:${width}px;height:${height}px}</style>${clean}<script>const a=${JSON.stringify(alignment)},d=${duration};${visemeForCharacter.toString()};${characterStateAt.toString()};window.setTime=t=>{const z=characterStateAt(a,Math.max(0,Math.min(d,t)));const r=document.querySelector('svg');Object.entries(z).forEach(([k,v])=>r.dataset[k]=v);r.querySelector('.right-arm').style.transform='rotate('+z.armAngle+'deg)';r.querySelector('.right-arm').style.transformOrigin='657px 357px';r.querySelector('.left-arm').style.transform='rotate('+z.leftArmAngle+'deg)';r.querySelector('.left-arm').style.transformOrigin='303px 357px';r.querySelector('#cup').style.transform='rotate('+z.tilt+'deg)';r.querySelector('#cup').style.transformOrigin='480px 449px';r.querySelectorAll('.pupil').forEach(p=>p.style.transform='translateX('+z.gazeX+'px)')};</script>`;
}
