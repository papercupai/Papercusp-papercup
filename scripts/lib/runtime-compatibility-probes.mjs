/** Isolated semantic operations for P-001; run with runtime-compatibility.mjs.
 * These seeds are not the complete application capability population. No probe
 * opens application data, inherits service credentials, or starts a bg owner.
 */
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { once } from 'node:events';

export const NATIVE_EXPECTATIONS = Object.freeze({
  'sqlite-transaction-reopen': { rows: [{ value: 'committed' }], rolledBack: true },
  'sodium-secretbox-roundtrip': { plaintext: 'runtime compatibility', rejectsTampering: true },
  'sharp-png-roundtrip': { width: 1, height: 1, channels: 4, pixels: [17, 34, 51, 255] },
  'udx-loopback': { message: 'runtime compatibility' },
  'rocksdb-reopen': { value: 'committed' },
  'pty-input-exit': { echoed: true, exitCode: 0 },
});

export async function performNativeCapability(id, requireFrom) {
  if (!Object.hasOwn(NATIVE_EXPECTATIONS, id)) throw new Error(`Unknown native capability: ${id}`);
  if (!requireFrom || !isAbsolute(requireFrom)) throw new Error('Absolute candidate package manifest required');
  const require = createRequire(requireFrom);
  if (id === 'sodium-secretbox-roundtrip') {
    const sodium = require('sodium-native');
    const message = Buffer.from('runtime compatibility');
    const key = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES), nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
    sodium.randombytes_buf(key); sodium.randombytes_buf(nonce);
    const ciphertext = Buffer.alloc(message.length + sodium.crypto_secretbox_MACBYTES), plaintext = Buffer.alloc(message.length);
    try {
      sodium.crypto_secretbox_easy(ciphertext, message, nonce, key);
      if (!sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key)) throw new Error('Secretbox roundtrip refused');
      ciphertext[0] ^= 1;
      return { plaintext: plaintext.toString(), rejectsTampering: !sodium.crypto_secretbox_open_easy(Buffer.alloc(message.length), ciphertext, nonce, key) };
    } finally { sodium.sodium_memzero(key); }
  }
  if (id === 'sharp-png-roundtrip') {
    const sharp = require('sharp');
    const png = await sharp(Buffer.from([17, 34, 51, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, channels: info.channels, pixels: [...data] };
  }
  if (id === 'udx-loopback') {
    const UDX = require('udx-native'), udx = new UDX();
    const sender = udx.createSocket(), receiver = udx.createSocket();
    try {
      sender.bind(0, '127.0.0.1'); receiver.bind(0, '127.0.0.1');
      const received = once(receiver, 'message');
      await sender.send(Buffer.from('runtime compatibility'), receiver.address().port, '127.0.0.1');
      const [message] = await received;
      return { message: message.toString() };
    } finally { await Promise.all([sender.close(), receiver.close()]); }
  }
  if (id === 'pty-input-exit') {
    if (process.platform === 'win32') throw new Error('POSIX PTY probe does not cover Windows ConPTY');
    const pty = require('@lydell/node-pty');
    const terminal = pty.spawn('/bin/sh', ['-c', 'read value; printf "probe:%s\\n" "$value"'], {
      name: 'xterm', cols: 80, rows: 24, cwd: tmpdir(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    let output = '';
    const data = terminal.onData(chunk => { output += chunk; });
    try {
      const exited = new Promise(resolve => terminal.onExit(resolve));
      terminal.write('runtime-compatibility\r');
      const { exitCode } = await exited;
      return { echoed: output.includes('probe:runtime-compatibility'), exitCode };
    } finally { data.dispose(); terminal.kill(); }
  }
  const directory = await mkdtemp(join(tmpdir(), 'papercusp-runtime-probe-'));
  try {
    if (id === 'sqlite-transaction-reopen') {
      const Database = require('better-sqlite3'), path = join(directory, 'probe.sqlite');
      let db = new Database(path);
      let rolledBack = false;
      try {
        db.exec('CREATE TABLE probe (value TEXT NOT NULL)');
        db.transaction(() => db.prepare('INSERT INTO probe VALUES (?)').run('committed'))();
        try {
          db.transaction(() => { db.prepare('INSERT INTO probe VALUES (?)').run('reverted'); throw new Error('planted rollback'); })();
        } catch (error) { if (error.message !== 'planted rollback') throw error; rolledBack = true; }
      } finally { db.close(); }
      db = new Database(path);
      try { return { rows: db.prepare('SELECT value FROM probe ORDER BY rowid').all(), rolledBack }; }
      finally { db.close(); }
    }
    const RocksDB = require('rocksdb-native'), path = join(directory, 'rocks');
    let db = new RocksDB(path);
    try { await db.ready(); await db.put('key', 'committed'); }
    finally { await db.close(); }
    db = new RocksDB(path);
    try { await db.ready(); return { value: (await db.get('key')).toString() }; }
    finally { await db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** The receipt runner invokes this inside the selected interpreter. */
export async function perform() {
  return performNativeCapability(process.env.PAPERCUSP_PROBE_CAPABILITY, process.env.PAPERCUSP_PROBE_REQUIRE_FROM);
}
