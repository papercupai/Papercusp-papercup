// Shared by the existing deployer and its registered tests. No credentials are logged.
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Every IPv4 range that is not a public unicast destination. Also the edge's forward-chain
 *  drop set (infra/phone-app/edge/edge-config.mjs, WI-10006686), so the two cannot drift. */
export const NON_PUBLIC_V4_SUBNETS = Object.freeze([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(subnet => Object.freeze(subnet)));
const blocked = new BlockList();
for (const [ip, prefix] of NON_PUBLIC_V4_SUBNETS) blocked.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2001:2::', 48, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6'); // IETF special assignments, including embedded-address tunnels
blocked.addSubnet('2002::', 16, 'ipv6'); // 6to4 can embed a non-public IPv4 address

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function publicHostname(hostname) {
  if (!hostname || hostname.length > 253 || isIP(hostname) ||
      !hostname.includes('.') || !hostname.split('.').every(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/i.test(hostname)) {
    throw new Error('public media requires a public DNS hostname');
  }
  return hostname.toLowerCase();
}

export function publicMediaUrl(value) {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('invalid public media URL');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid public media URL'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || (url.port && url.port !== '443')) {
    throw new Error('public media requires a wss:// origin on port 443 without credentials, path or query');
  }
  publicHostname(url.hostname);
  return url;
}

export function validateCertificate(certPem, keyPem, hostname, now = Date.now()) {
  const cert = new X509Certificate(certPem);
  if (!cert.checkHost(hostname) || Date.parse(cert.validFrom) > now ||
      Date.parse(cert.validTo) < now + 7 * 86400_000) {
    throw new Error('TURN certificate must cover its hostname and remain valid for at least seven days');
  }
  const actual = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
  const expected = cert.publicKey.export({ type: 'spki', format: 'der' });
  if (!actual.equals(expected)) throw new Error('TURN certificate and private key do not match');
  return cert;
}

export function mediaConfig(env, hosted = false) {
  const publicUrl = env.PHONE_LIVEKIT_PUBLIC_URL;
  if (publicUrl) publicMediaUrl(publicUrl);
  else if (hosted) throw new Error('hosted deployment requires PHONE_LIVEKIT_PUBLIC_URL=wss://...');
  const domain = env.PHONE_TURN_DOMAIN;
  const certPath = env.PHONE_TURN_CERT_FILE;
  const keyPath = env.PHONE_TURN_KEY_FILE;
  if (!domain && !certPath && !keyPath && !env.PHONE_TURN_TLS_PORT && !hosted) {
    return { turnYaml: '  tls_port: 0', publicUrl };
  }
  const hostname = publicHostname(domain);
  if (!certPath?.startsWith('/') || !keyPath?.startsWith('/') ||
      /[\r\n\0]/.test(certPath + keyPath)) {
    throw new Error('TURN certificate and key require absolute external file paths');
  }
  if (!publicUrl) throw new Error('TURN/TLS requires the public WSS origin');
  if (new URL(publicUrl).hostname === hostname) {
    throw new Error('WSS and TURN require separate public DNS hostnames');
  }
  const port = Number(env.PHONE_TURN_TLS_PORT || '7894');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [7890, 7891, 7892, 7893, 5070].includes(port)) {
    throw new Error('TURN TLS backend port must be an unprivileged port distinct from existing media ports');
  }
  validateCertificate(readFileSync(certPath), readFileSync(keyPath), hostname);
  return {
    publicUrl, turnDomain: hostname, turnPort: port,
    turnYaml: ['  tls_port: ' + port, '  domain: ' + JSON.stringify(hostname),
      '  cert_file: ' + JSON.stringify(certPath), '  key_file: ' + JSON.stringify(keyPath)].join('\n'),
  };
}

export async function publicAddresses(hostname, resolve = lookup) {
  publicHostname(hostname);
  const rows = await resolve(hostname, { all: true, verbatim: true });
  if (!rows.length || rows.some(row => !isPublicAddress(row.address))) {
    throw new Error('public media DNS must resolve exclusively to global addresses');
  }
  return [...new Set(rows.map(row => row.address))];
}

// Connecting to the measured address pins DNS; SNI and CA verification still use
// the original hostname. ca is a test seam; the CLI always uses system trust.
export function checkTlsEndpoint({ hostname, address, port = 443, timeoutMs = 5000, ca }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, servername: hostname,
      rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}) });
    const timer = setTimeout(() => finish(new Error('public media TLS connection timed out')), timeoutMs);
    let done = false;
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    }
    socket.once('error', () => finish(new Error('public media TLS trust or connectivity check failed')));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!socket.authorized || Date.parse(cert.valid_to) < Date.now() + 7 * 86400_000) {
        finish(new Error('public media TLS certificate is untrusted or renewal is due'));
      } else finish(null, { hostname, address, validTo: cert.valid_to });
    });
  });
}

export async function remotePreflight(env) {
  // A remote client needs only these two non-secret coordinates. It never
  // needs the media API credential, TURN private key or server filesystem.
  const url = publicMediaUrl(env.PHONE_LIVEKIT_PUBLIC_URL);
  const turnDomain = publicHostname(env.PHONE_TURN_DOMAIN);
  if (url.hostname === turnDomain) throw new Error('WSS and TURN require separate public DNS hostnames');
  const reports = [];
  for (const hostname of [url.hostname, turnDomain]) {
    for (const address of await publicAddresses(hostname)) {
      reports.push(await checkTlsEndpoint({ hostname, address }));
    }
  }
  return { checks: reports, audioVerified: false,
    next: 'Prove authenticated bidirectional audio from external and UDP-blocked clients; TLS is a prerequisite only.' };
}

// This is the single-publisher/single-subscriber CLI smoke test, not public or
// bidirectional acceptance. lk 2.16 writes received RTP payload counts in the
// Track loading table; its process may exit zero even when a subscriber failed.
export function loadTestReceipt(output) {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const sections = text.split('Subscriber summaries:');
  if (sections.length !== 2 || !sections[0].includes('Track loading:')) {
    throw new Error('missing unambiguous media measurement tables');
  }
  function table(section, header) {
    const rows = section.split(/\r?\n/).filter(line => /^[\s]*[│|]/.test(line))
      .map(line => line.trim().split(/[│|]/).slice(1, -1).map(cell => cell.trim()));
    if (rows.length < 2 || rows[0].join('|') !== header.join('|') ||
        rows.slice(1).some(row => row.length !== header.length)) {
      throw new Error('unknown media measurement table format');
    }
    return rows.slice(1).filter(row => row.some(Boolean));
  }
  function positiveBitrate(value) {
    const match = /^(\d+(?:\.\d+)?)(?:[kmg])?bps$/i.exec(value);
    return Boolean(match && Number(match[1]) > 0);
  }
  const tracks = table(sections[0].split('Track loading:')[1],
    ['Tester', 'Track', 'Kind', 'Pkts.', 'Bitrate', 'Pkt. Loss']);
  const summaries = table(sections[1], ['Tester', 'Tracks', 'Bitrate', 'Total Pkt. Loss', 'Error']);
  if (tracks.length !== 1 || summaries.length !== 2) {
    throw new Error('expected exactly one received audio track and one subscriber');
  }
  const [tester, track, kind, packets, bitrate] = tracks[0];
  const [summary, total] = summaries;
  if (!/^Sub \d+$/.test(tester) || !/^TR_[A-Za-z0-9]+$/.test(track) || kind !== 'audio' ||
      !/^[1-9]\d*$/.test(packets) || !Number.isSafeInteger(Number(packets)) ||
      !positiveBitrate(bitrate) || summary[0] !== tester || summary[1] !== '1/1' ||
      !positiveBitrate(summary[2]) || summary[4] !== '-' ||
      total[0] !== 'Total' || total[1] !== '1/1' || total[4] !== '0') {
    throw new Error('subscriber did not demonstrate a complete error-free audio receive path');
  }
  return { subscriber: tester, track, receivedPackets: Number(packets), bitrate,
    scope: 'single-publisher-to-subscriber', publicAudioVerified: false, bidirectionalAudioVerified: false };
}

export function localProbeHealthUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port || Number(url.port) < 1024 || url.port === '7880' ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('local media smoke test requires an explicit loopback control origin; public acceptance is separate');
  }
  url.protocol = 'http:';
  return url.href;
}

const PHONE_UNITS = [
  ['media', 'papercusp-phone-livekit.service'],
  ['sip', 'papercusp-phone-sip.service'],
  ['worker', 'papercusp-phone-worker.service'],
  ['sidecar', 'papercusp-phone-sidecar.service'],
];
// A health failure should name its operational owner and the next diagnostic,
// without requiring the alert consumer to parse journal text or credentials.
const PHONE_RECOVERY = {
  media: 'Inspect papercusp-phone-livekit.service and its pinned media configuration.',
  sip: 'Inspect papercusp-phone-sip.service and the SIP-to-media connection.',
  worker: 'Inspect papercusp-phone-worker.service and its vendor/credential preflight.',
  sidecar: 'Inspect papercusp-phone-sidecar.service and its database dependency.',
  'media-http': 'Inspect the loopback LiveKit HTTP control endpoint and media unit.',
  'sidecar-http': 'Inspect the sidecar /api/health endpoint and its unit.',
  'worker-ingest': 'Re-run infra/phone-app/deploy.sh so PHONE_WORKER_SECRET is in livekit.env, then restart the worker and sidecar.',
  'turn-certificate': 'Renew and recheck the hosted TURN certificate/key before expiry; do not admit hosted traffic.',
};
let execFileAsyncMemo;
function execFileAsync(...args) {
  return (execFileAsyncMemo ??= promisify(execFile))(...args);
}

/** Local process/HTTP readiness is deliberately narrower than public calling:
 * it does not assert PSTN, bidirectional media, price policy or recovery drills.
 * Return false on an unknown probe or a missing unit, never a false green. */
export async function localPhoneReadiness(env, probes = {}) {
  const unitState = probes.unitState ?? (async unit => {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', unit], { timeout: 3000 });
    return stdout.trim() === 'active';
  });
  const httpReady = probes.httpReady ?? (async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  });
  const httpStatus = probes.httpStatus ?? (async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.status;
  });
  const checks = await Promise.all(PHONE_UNITS.map(async ([component, unit]) => {
    try { return { component, ready: (await unitState(unit)) === true }; }
    catch { return { component, ready: false }; }
  }));
  for (const [component, value] of [
    ['media-http', env.PHONE_LIVEKIT_URL],
    ['sidecar-http', env.PHONE_SIDECAR_URL],
  ]) {
    try {
      const url = component === 'sidecar-http'
        ? new URL('api/health', localProbeHealthUrl(value)).href
        : localProbeHealthUrl(value);
      checks.push({ component, ready: (await httpReady(url)) === true });
    } catch { checks.push({ component, ready: false }); }
  }
  // Worker→sidecar ingest (WI-10006645). Both units read PHONE_WORKER_SECRET
  // from livekit.env. Blank, the worker reports nothing and the sidecar answers
  // every /internal/* call 503 phone_worker_ingest_disabled: calls then lose
  // context, transcripts, notices and voicemail while every unit and health
  // endpoint above stays green. Armed, a request WITHOUT the secret is refused
  // 401, which is the only ready answer. The secret is never sent or echoed.
  let ingestReady = false;
  if (typeof env.PHONE_WORKER_SECRET === 'string' && env.PHONE_WORKER_SECRET.trim() !== '') {
    try {
      const url = new URL('internal/readiness', localProbeHealthUrl(env.PHONE_SIDECAR_URL)).href;
      ingestReady = (await httpStatus(url)) === 401;
    } catch { /* An unknown probe is not ready. */ }
  }
  checks.push({ component: 'worker-ingest', ready: ingestReady });
  // The local LAN install has no TLS material. Once any hosted coordinate is
  // present, however, a partial/expired/mismatched TURN certificate is an
  // operational failure even if all processes and HTTP endpoints are healthy.
  // Reuse the render-time validator so status cannot silently drift from it.
  const hosted = [
    env.PHONE_LIVEKIT_PUBLIC_URL, env.PHONE_TURN_DOMAIN,
    env.PHONE_TURN_CERT_FILE, env.PHONE_TURN_KEY_FILE, env.PHONE_TURN_TLS_PORT,
  ].some(value => value !== undefined && value !== '');
  if (hosted) {
    let ready = false;
    try {
      mediaConfig(env, true);
      ready = true;
    } catch { /* Never echo certificate, key, paths or parser errors in status. */ }
    checks.push({ component: 'turn-certificate', ready });
  }
  return {
    ok: checks.every(check => check.ready),
    checks,
    alerts: checks.filter(check => !check.ready).map(check => ({
      component: check.component,
      owner: 'phone-operations',
      action: PHONE_RECOVERY[check.component],
    })),
    scope: 'local-process-and-http-only',
    publicPhoneVerified: false,
    turnCertificateVerified: hosted && checks.at(-1).ready,
    bidirectionalAudioVerified: false,
    recoveryVerified: false,
    costPolicyVerified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2];
    if (action === 'preflight') console.log(JSON.stringify(await remotePreflight(process.env)));
    else if (action === 'load-test-receipt') console.log(JSON.stringify(loadTestReceipt(readFileSync(process.argv[3], 'utf8'))));
    else if (action === 'local-probe-health') console.log(localProbeHealthUrl(process.argv[3]));
    else if (action === 'local-readiness') {
      const result = await localPhoneReadiness(process.env);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    }
    else if (action === 'public-dns') {
      const config = mediaConfig(process.env, true);
      for (const hostname of [new URL(config.publicUrl).hostname, config.turnDomain]) {
        await publicAddresses(hostname);
      }
      console.log('public media DNS prerequisites passed');
    }
    else if (action === 'turn-config') console.log(mediaConfig(process.env, process.argv.includes('--hosted')).turnYaml);
    else throw new Error('expected turn-config, public-dns or preflight');
  } catch (error) {
    // Crypto/file exceptions can include input details. Report their class only.
    const safe = error.code ? 'media prerequisite failed (' + error.code + ')' :
      error.message.startsWith('error:') ? 'media certificate validation failed' : error.message;
    console.error(safe);
    process.exitCode = 1;
  }
}
