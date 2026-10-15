import { describe, expect, it } from 'vitest';
import { evidenceVerdict } from './p2p-candidate-evidence';
import { P202_SEAT_JOURNEY, P202_SEAT_LEGS, deriveSeatJourneyEvidence, readSeatTranscript } from './p202-seat-journey-evidence';
import { P521_JOURNEYS } from './p2p-candidate-manifest';
import { DRILL_LEG_JOURNEYS } from './p521-drill-journey-evidence';

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

/** A transcript in the exact shape scenario-p202-workdist.sh + p202-workdist.sh print. */
function transcript(opts: { legs?: Record<string, string[]>; tally?: string | null; overall?: boolean; rig?: boolean } = {}): string {
  const lines = ['  ✓ WD-0 preflight complete — the run can exercise its probes'];
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let setup = 0;
  for (const leg of P202_SEAT_LEGS) {
    lines.push(`── ${leg}  probe heading ──`);
    for (const l of opts.legs?.[leg] ?? ['  ✓ green']) {
      lines.push(l);
      if (l.trim().startsWith('✓')) pass += 1;
      else if (l.trim().startsWith('✗')) fail += 1;
      else if (l.trim().startsWith('⏭ SKIP')) skip += 1;
      else if (l.trim().startsWith('⚠ SETUP FAIL')) setup += 1;
    }
  }
  lines.push('════════════════════════════════════════════════════════');
  if (opts.tally !== null) {
    lines.push(opts.tally ?? `P-202 LIVE-2 cross-machine work-distribution: PASS=${pass} FAIL=${fail} SKIP=${skip} SETUP-FAIL=${setup}`);
  }
  if (opts.overall ?? true) lines.push('OVERALL: PASS — every exercised leg green; 0 leg(s) reported with a DETECTED reason');
  if (opts.rig ?? true) lines.push('  rig: tower=main-server  vm=Avis-iMac.local  fleet=p202-physical-20261006060000  finished=2026-10-06T06:10:00Z');
  return `${lines.join('\n')}\n`;
}

function derive(text: string, over: Partial<Parameters<typeof deriveSeatJourneyEvidence>[0]> = {}) {
  return deriveSeatJourneyEvidence({
    transcript: text,
    transcriptPath: 'docs/evidence/p202.log',
    transcriptSha256: SHA,
    driverExitCode: 0,
    release: '0.0.29-alpha',
    artifact: 'Papercusp Server_0.0.29_amd64.deb',
    actualDebSha256: SHA,
    expectedDebSha256: SHA,
    observer: 'su-test',
    command: ['p202-workdist.sh --i-accept-live-spawn'],
    ...over,
  });
}

describe('every P-521 manifest journey has an evidence producer (WI-10006413 class guard)', () => {
  it('drill legs + P-202 LIVE-2 + the offline-installer journey cover P521_JOURNEYS exactly', () => {
    // full-installer-compat is written by papercusp-desktop/bin/offline-installer-journey.sh.
    const OFFLINE_INSTALLER_JOURNEY = 'full-installer-compat';
    const produced = new Set([...DRILL_LEG_JOURNEYS.map((r) => r.journey), P202_SEAT_JOURNEY, OFFLINE_INSTALLER_JOURNEY]);
    const required = P521_JOURNEYS.map((j) => j.key);
    expect(required.filter((k) => !produced.has(k))).toEqual([]);
    expect([...produced].filter((k) => !required.includes(k))).toEqual([]);
  });
});

describe('p202 seat journey evidence (WI-10006413)', () => {
  it('a fully green LIVE-2 run on the exact artifact is a pass bound to both rig hosts', () => {
    const { journey, doc, fileName } = derive(transcript());
    expect(journey).toBe('delegated-seat-lifecycle');
    expect(fileName).toBe('p521-p202-p202-physical-20261006060000-delegated-seat-lifecycle.json');
    expect(evidenceVerdict(doc).verdict).toBe('pass');
    expect((doc.subject as { topology: { hosts: Array<{ id: string }> } }).topology.hosts.map((h) => h.id)).toEqual(['tower', 'mac-vm']);
    expect((doc.subject as { debSha256: string }).debSha256).toBe(SHA);
    expect(doc.p521Journey).toBe('delegated-seat-lifecycle');
  });

  it('a red WD leg fails the row and names the leg', () => {
    const { doc } = derive(transcript({ legs: { 'WD-7': ['  ✗ receipt never reached the origin'] }, overall: false }), { driverExitCode: 1 });
    const v = evidenceVerdict(doc);
    expect(v.verdict).toBe('fail');
    expect(v.reason).toContain('WD-7');
  });

  it('a SKIPPED revocation leg is never a pass', () => {
    const { doc } = derive(transcript({ legs: { 'WD-9': ['  ⏭ SKIP revocation path absent'] } }));
    expect(evidenceVerdict(doc).verdict).not.toBe('pass');
    expect(readSeatTranscript(transcript({ legs: { 'WD-9': ['  ⏭ SKIP x'] } })).legs.find((l) => l.leg === 'WD-9')?.status).toBe('skipped');
  });

  it('a NO VERDICT run (setup failure, exit 2) is not a pass and says so', () => {
    const { doc } = derive(transcript({ legs: { 'WD-5': ['  ⚠ SETUP FAIL mcp call errored'] }, overall: false }), { driverExitCode: 2 });
    expect(evidenceVerdict(doc).verdict).not.toBe('pass');
    expect(String(doc.summary)).toContain('NO VERDICT');
  });

  it('a different artifact fails the exact-artifact assertion even when every leg is green', () => {
    const { doc } = derive(transcript(), { actualDebSha256: OTHER });
    const v = evidenceVerdict(doc);
    expect(v.verdict).toBe('fail');
    expect(v.reason).toContain('exact-artifact');
  });

  it('a leg absent from the transcript is missing, not passed', () => {
    const text = transcript().replace(/── WD-8 [^\n]*\n {2}✓ green\n/, '');
    const reading = readSeatTranscript(text);
    expect(reading.legs.find((l) => l.leg === 'WD-8')?.status).toBe('missing');
    expect(evidenceVerdict(derive(text).doc).verdict).not.toBe('pass');
  });

  it('a tally that disagrees with the per-leg reading fails (truncated or spliced transcript)', () => {
    const { doc } = derive(transcript({ tally: 'P-202 LIVE-2 cross-machine work-distribution: PASS=99 FAIL=0 SKIP=0 SETUP-FAIL=0' }));
    expect(evidenceVerdict(doc).reason).toContain('tally-matches-legs');
  });

  it('a transcript without the rig line names no peers and fails two-physical-hosts', () => {
    const { doc } = derive(transcript({ rig: false }));
    expect((doc.subject as { topology: { hosts: unknown[] } }).topology.hosts).toEqual([]);
    expect(evidenceVerdict(doc).reason).toContain('two-physical-hosts');
  });
});
