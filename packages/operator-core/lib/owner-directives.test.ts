/**
 * owner-directives (EI-11484) — budgeted-renderer unit tests: rows up to the
 * D-004 cap render whole; longer rows render the labelled agent summary (or a
 * summary-pending note) plus an orders:get pointer, never a cut fragment; the
 * block cap collapses overflow into a "+N more" line; guard assembly
 * soft-blocks only while open rows exist.
 */
import { describe, expect, it } from 'vitest';
import {
  OWNER_DIRECTIVES_BLOCK_CHAR_CAP,
  OWNER_DIRECTIVES_BLOCK_HEADER,
  OWNER_DIRECTIVES_FYI_LEGEND,
  renderOwnerDirectiveRow,
  renderOwnerDirectivesBlock,
  type OwnerDirectiveRow,
} from './owner-directives';
import { OWNER_DIRECTIVE_VERBATIM_CAP } from './owner-directive-display';
import { buildOpenDirectivesGuard } from './agent-tools/orders/open-directives-guard';
import { renderLoopWakeText } from './harness/routines/loop-fire';

const NOW = Date.UTC(2026, 6, 13, 20, 0, 0);

function row(over: Partial<OwnerDirectiveRow> = {}): OwnerDirectiveRow {
  return {
    id: 7,
    workspaceId: 'papercusp-workspace',
    ownerId: 'owner',
    sessionRef: null,
    sourceTurnRef: null,
    verbatimText: 'resume all the sessions active in the last half hour',
    recordedBy: 'su-00a9161f-6a7d-4caa-abec-4b24bcd94d1f',
    createdAtMs: NOW - 5 * 60_000,
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
    ...over,
  };
}

describe('renderOwnerDirectiveRow', () => {
  it('renders a short row whole, verbatim, with id + age + recorder attribution', () => {
    const own = row();
    const out = renderOwnerDirectiveRow(own, NOW, own.recordedBy);
    expect(out).toContain('#7');
    expect(out).toContain('[FOR THIS SESSION]');
    expect(out).toContain('5m old');
    expect(out).toContain('su-00a9161f-'); // recorder shortened, still attributable
    expect(out).toContain('"resume all the sessions active in the last half hour"');
    expect(out).not.toContain('orders:get'); // short rows carry no pointer
  });

  it('D-004: a long row with no summary yet shows NO fragment of the owner text — a note + the orders:get pointer', () => {
    const long = 'do the thing '.repeat(60); // ~780 chars
    expect(long.trim().length).toBeGreaterThan(OWNER_DIRECTIVE_VERBATIM_CAP);
    const own = row({ id: 41, verbatimText: long });
    const out = renderOwnerDirectiveRow(own, NOW, own.recordedBy);
    expect(out).not.toContain('do the thing');
    expect(out).toContain('summary not written yet');
    expect(out).toContain('[full text: orders:get #41]');
  });

  it('D-004: a long row with a summary shows the summary, labelled with its author', () => {
    const long = 'do the thing '.repeat(60);
    const own = row({ id: 41, verbatimText: long, summaryText: 'Do the thing, sixty times.', summaryBy: 'su-summarizer-01' });
    const out = renderOwnerDirectiveRow(own, NOW, own.recordedBy);
    expect(out).toContain('summary by su-summarize');
    expect(out).toContain('"Do the thing, sixty times."');
    expect(out).toContain('[full text: orders:get #41]');
  });

  it('renders exactly at the whole-row boundary without a pointer', () => {
    const exact = 'x'.repeat(OWNER_DIRECTIVE_VERBATIM_CAP);
    const own = row({ verbatimText: exact });
    const out = renderOwnerDirectiveRow(own, NOW, own.recordedBy);
    expect(out).toContain(`"${exact}"`);
    expect(out).not.toContain('orders:get');
  });

  it('shows a peer directive as FYI while preserving the action row for its recorded session', () => {
    const peer = row({
      id: 43,
      recordedBy: 'su-peer-session',
      sessionRef: 'source-session-peer',
      verbatimText: 'answer the owner about the peer project',
    });
    const foreignView = renderOwnerDirectiveRow(peer, NOW, 'su-current-session');
    const ownerView = renderOwnerDirectiveRow(peer, NOW, peer.recordedBy);

    expect(foreignView).toContain('[FYI');
    expect(foreignView).toContain('recorded by su-peer-s');
    expect(foreignView).toContain('source session source-s');
    expect(foreignView).toContain('not an action assignment for this session');
    expect(foreignView).toContain('orders:get #43');
    expect(foreignView).not.toContain(peer.verbatimText);
    expect(foreignView).not.toContain('[FOR THIS SESSION]');

    // Negative control: the same row is actionable only for its recorded session.
    expect(ownerView).toContain('[FOR THIS SESSION]');
    expect(ownerView).toContain(peer.verbatimText);
    expect(ownerView).not.toContain('[FYI');
  });

  it('D-004(1): an own row whose text is open in other sessions says "also sent to N other sessions"', () => {
    const own = row({ otherSessionCopies: 3 });
    expect(renderOwnerDirectiveRow(own, NOW, own.recordedBy)).toContain(
      "(also sent to 3 other sessions; each copy is its own addressee's to close)",
    );
    expect(renderOwnerDirectiveRow(row({ otherSessionCopies: 1 }), NOW, own.recordedBy)).toContain('also sent to 1 other session;');
    // Negative controls: a unique row and an uncomputed count both render no note.
    expect(renderOwnerDirectiveRow(row({ otherSessionCopies: 0 }), NOW, own.recordedBy)).not.toContain('also sent to');
    expect(renderOwnerDirectiveRow(row(), NOW, own.recordedBy)).not.toContain('also sent to');
  });
});

describe('renderOwnerDirectivesBlock', () => {
  it('returns null with no rows', () => {
    expect(renderOwnerDirectivesBlock([], { nowMs: NOW })).toBeNull();
  });

  it('renders header + one line per row, oldest first as given', () => {
    const out = renderOwnerDirectivesBlock([row({ id: 1 }), row({ id: 2 })], {
      nowMs: NOW,
      viewerOwnerId: row().recordedBy,
    })!;
    expect(out.startsWith(OWNER_DIRECTIVES_BLOCK_HEADER)).toBe(true);
    expect(out.indexOf('#1')).toBeLessThan(out.indexOf('#2'));
    expect(out).not.toContain('more open');
  });

  it('caps the block and collapses overflow into "+N more — orders:list"', () => {
    // Each row renders the full verbatim (~560 chars); enough rows to blow the cap.
    const long = 'L'.repeat(OWNER_DIRECTIVE_VERBATIM_CAP);
    const rows = Array.from({ length: 40 }, (_, i) => row({ id: i + 1, verbatimText: long }));
    const out = renderOwnerDirectivesBlock(rows, { nowMs: NOW, viewerOwnerId: row().recordedBy })!;
    expect(out.length).toBeLessThanOrEqual(OWNER_DIRECTIVES_BLOCK_CHAR_CAP + 200); // header + "+N more" slack
    expect(out).toMatch(/\+\d+ more open — orders:list/);
  });

  it('adds the "+N more" line when totalOpen exceeds the fetched rows even under the cap', () => {
    const out = renderOwnerDirectivesBlock([row({ id: 3 })], {
      nowMs: NOW,
      totalOpen: 9,
      viewerOwnerId: row().recordedBy,
    })!;
    expect(out).toContain('+8 more open — orders:list');
  });

  it('WI-10002888: the viewer’s own row renders first and is never the one the cap folds away', () => {
    const viewer = 'su-current-session';
    // [FYI] rows render as bare grouped ids (~6 chars each), so it takes well over
    // a thousand older peer rows to exhaust the char cap on their own. Then the
    // viewer's own directive comes LAST, which is the order the oldest-first fetch
    // supplies. Its id is outside the peer range so the control cannot hit a peer.
    const peers = Array.from({ length: 1500 }, (_, i) => row({ id: i + 1, recordedBy: `su-peer-${i % 3}` }));
    const own = row({ id: 99999, recordedBy: viewer, verbatimText: 'carry the plans to shipped' });
    const out = renderOwnerDirectivesBlock([...peers, own], { nowMs: NOW, viewerOwnerId: viewer })!;
    const lines = out.split('\n');
    expect(lines[1]).toContain('#99999');
    expect(lines[1]).toContain('[FOR THIS SESSION]');
    expect(out.length).toBeLessThanOrEqual(OWNER_DIRECTIVES_BLOCK_CHAR_CAP + 200);
    expect(out).toMatch(/\+\d+ more open — orders:list/);
    // Control: without a viewer the given order is kept, so the same input hides #99999.
    const ledger = renderOwnerDirectivesBlock([...peers, own], { nowMs: NOW })!;
    expect(ledger).not.toContain('#99999');
    expect(ledger).toMatch(/\+\d+ more open — orders:list/);
  });

  it('labels mixed workspace rows by the session that can act on each one', () => {
    const ownerId = 'su-current-session';
    const ownText = 'carry out my open directive';
    const peerText = 'take over the peer session project';
    const own = row({ id: 44, recordedBy: ownerId, verbatimText: ownText });
    const peer = row({ id: 45, recordedBy: 'su-peer-session', verbatimText: peerText });
    const out = renderOwnerDirectivesBlock([own, peer], { nowMs: NOW, viewerOwnerId: ownerId })!;
    const ownLine = out.split('\n').find((line) => line.includes('#44'))!;
    const peerLine = out.split('\n').find((line) => line.includes('#45'))!;

    expect(ownLine).toContain('[FOR THIS SESSION]');
    expect(ownLine).toContain(ownText);
    // The peer id sits under the [FYI] legend, attributed to its recording
    // session, and never carries the peer's words.
    const lines = out.split('\n');
    const legendAt = lines.indexOf(OWNER_DIRECTIVES_FYI_LEGEND);
    expect(legendAt).toBeGreaterThan(lines.indexOf(ownLine));
    expect(lines.indexOf(peerLine)).toBeGreaterThan(legendAt);
    expect(OWNER_DIRECTIVES_FYI_LEGEND).toContain('[FYI]');
    expect(OWNER_DIRECTIVES_FYI_LEGEND).toContain('not an action assignment for this session');
    expect(OWNER_DIRECTIVES_FYI_LEGEND).toContain('orders:get #<id>');
    expect(peerLine).toContain('su-peer-s');
    expect(peerLine).not.toContain('[FOR THIS SESSION]');
    expect(out).not.toContain(peerText);
  });

  it('P-006: [FYI] rows collapse to one legend plus one id line per recording session', () => {
    const viewer = 'su-current-session';
    const own = row({ id: 1713, recordedBy: viewer, verbatimText: 'audit the oversized tool calls' });
    const recorders = ['su-aaaaaaaa-1', 'su-bbbbbbbb-2', 'su-cccccccc-3'];
    const peers = Array.from({ length: 11 }, (_, i) => row({ id: 400 + i, recordedBy: recorders[i % 3] }));
    const out = renderOwnerDirectivesBlock([own, ...peers], { nowMs: NOW, viewerOwnerId: viewer })!;
    const lines = out.split('\n');
    // header, own row, legend, three recorder lines — nothing per id.
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain('#1713');
    expect(lines[2]).toBe(OWNER_DIRECTIVES_FYI_LEGEND);
    expect(lines[3]).toBe('  • su-aaaaaaaa-: #400 #403 #406 #409');
    for (const p of peers) expect(out).toContain(`#${p.id}`);
    expect(out).not.toContain('more open');
    // The per-row form spent ~150 chars of disclaimer on each FYI id.
    const perRow = peers.map((p) => renderOwnerDirectiveRow(p, NOW, viewer)).join('\n').length;
    const grouped = lines.slice(2).join('\n').length;
    expect(grouped).toBeLessThan(perRow / 3);
  });
});

describe('loop wake render (EI-11484) — directives ABOVE the loop contract', () => {
  const KICKOFF = '🔁 loop goal: drain the bug queue\nfull contract body here';
  const block = renderOwnerDirectivesBlock([row({ id: 5 })], {
    nowMs: NOW,
    viewerOwnerId: row().recordedBy,
  })!;

  it('FULL form: the directives block renders above the walls and the checkpoint', () => {
    const out = renderLoopWakeText({
      kickoff: KICKOFF,
      fireNumber: 1,
      checkpoint: '## Next action\ndo the thing',
      walls: [{ claim: 'a wall', sinceMs: NOW - 1000 }],
      ownerDirectivesBlock: block,
      nowMs: NOW,
    });
    expect(out).toContain('OPEN OWNER DIRECTIVES');
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('OPEN WALLS'));
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('do the thing'));
  });

  it('SHORT form: the directives block still renders, above the checkpoint', () => {
    const out = renderLoopWakeText({
      kickoff: KICKOFF,
      fireNumber: 3,
      checkpoint: '## Next action\ndo the thing',
      ownerDirectivesBlock: block,
      nowMs: NOW,
    });
    expect(out).toContain('short form');
    expect(out).toContain('OPEN OWNER DIRECTIVES');
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('do the thing'));
  });

  it('no open directives ⇒ no block in either form', () => {
    const out = renderLoopWakeText({
      kickoff: KICKOFF,
      fireNumber: 3,
      checkpoint: 'c',
      ownerDirectivesBlock: null,
      nowMs: NOW,
    });
    expect(out).not.toContain('OPEN OWNER DIRECTIVES');
  });
});

describe('buildOpenDirectivesGuard', () => {
  it('null when nothing is open', () => {
    expect(buildOpenDirectivesGuard([], 0, 'loop:end', NOW)).toBeNull();
  });

  it('soft-blocks with the open rows, the count, and the acknowledge escape hatch', () => {
    const g = buildOpenDirectivesGuard([row({ id: 12 })], 3, 'loop:end', NOW)!;
    expect(g.ok).toBe(false);
    expect(g.error).toBe('open_owner_directives');
    expect(g.openCount).toBe(3);
    expect(g.directives[0]).toContain('#12');
    expect(g.note).toContain('orders:disposition');
    expect(g.note).toContain('acknowledgeOpenDirectives: true');
    expect(g.note).toContain('loop:end');
  });
});
