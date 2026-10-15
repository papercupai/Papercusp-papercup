import { afterEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseIcs,
  parseMbox,
  parsePersonalArchive,
  parseVcard,
  streamPersonalArchiveFile,
} from './archive-import';
import {
  PERSONAL_ARCHIVE_ENCRYPTION_HEADER_BYTES,
  PersonalArchiveEncryptedWriter,
  assertPersonalArchiveDataChunkIndex,
  openEncryptedPersonalArchive,
} from './archive-encryption';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Personal Vault archive importers', () => {
  it('rejects a ZIP declared-size bomb before allocating its claimed output size', () => {
    // GHSA-7q85-xj36-vmfc: five stored bytes claim a 1.8 GB output. Intercept
    // large allocations so a dependency regression fails safely in the suite.
    const bytes = Buffer.from(
      'UEsDBBQAAAAAAAAAAAAAAAAABQAAAAUAAAABAAAAYWhlbGxvUEsBAhQAFAAAAAAAAAAAAAAAAAAFAAAA4C7DaQEAAAAAAAAAAAAAAAAAAAAAAGFQSwUGAAAAAAEAAQAvAAAAJAAAAAAA',
      'base64',
    );
    const originalAlloc = Buffer.alloc;
    const oversized: number[] = [];
    const allocate = vi.spyOn(Buffer, 'alloc').mockImplementation(((size: number, ...args: unknown[]) => {
      if (size > 1024 * 1024) {
        oversized.push(size);
        throw new Error('test blocked unsafe ZIP allocation');
      }
      return Reflect.apply(originalAlloc, Buffer, [size, ...args]);
    }) as typeof Buffer.alloc);
    try {
      expect(() => new AdmZip(bytes).getEntries()[0]!.getData()).toThrow();
      expect(oversized).toEqual([]);
    } finally {
      allocate.mockRestore();
    }
  });

  it('keeps the manifest nonce structurally outside the data-chunk domain', () => {
    expect(() => assertPersonalArchiveDataChunkIndex(0xffff_fffe)).not.toThrow();
    expect(() => assertPersonalArchiveDataChunkIndex(0xffff_ffff)).toThrow(
      'personal_vault_import_chunk_index_overflow',
    );
  });

  it('stores only ciphertext at rest and restores plaintext with the same key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-encrypted-import-'));
    tempDirs.push(dir);
    const path = join(dir, 'archive.bin');
    const plaintext = Buffer.from('private-mail-marker: the plaintext must not appear on disk');
    const rootKey = 'same-host-restore-key-with-at-least-thirty-two-bytes';
    const writer = await PersonalArchiveEncryptedWriter.create('workspace-a', path, {
      chunkBytes: 1024,
      rootKey,
    });
    await writer.write(plaintext);
    await writer.finish();

    const ciphertext = await readFile(path);
    expect(ciphertext.includes(plaintext)).toBe(false);
    const restored = await openEncryptedPersonalArchive('workspace-a', path, { rootKey });
    const chunks: Buffer[] = [];
    for await (const chunk of restored.createReadStream()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(plaintext);
  });

  it('fails non-destructively when a restored archive does not have its original key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-encrypted-import-'));
    tempDirs.push(dir);
    const path = join(dir, 'archive.bin');
    const writer = await PersonalArchiveEncryptedWriter.create('workspace-a', path, {
      chunkBytes: 1024,
      rootKey: 'original-host-key-with-at-least-thirty-two-bytes',
    });
    await writer.write(Buffer.from('encrypted owner history'));
    await writer.finish();
    const before = await readFile(path);

    await expect(openEncryptedPersonalArchive('workspace-a', path, {
      rootKey: 'replacement-host-key-after-original-key-was-lost',
    })).rejects.toThrow('personal_vault_import_manifest_authentication_failed');
    expect(await readFile(path)).toEqual(before);
  });

  it('rejects authenticated-header mutation and ciphertext truncation explicitly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-encrypted-import-'));
    tempDirs.push(dir);
    const rootKey = 'mutation-test-key-with-at-least-thirty-two-bytes';
    const writeArchive = async (name: string) => {
      const path = join(dir, name);
      const writer = await PersonalArchiveEncryptedWriter.create('workspace-a', path, {
        chunkBytes: 1024,
        rootKey,
      });
      await writer.write(Buffer.from('authenticated archive payload'));
      await writer.finish();
      return path;
    };

    const mutatedPath = await writeArchive('mutated.bin');
    const mutated = await readFile(mutatedPath);
    mutated[32] ^= 0x01;
    await writeFile(mutatedPath, mutated);
    await expect(openEncryptedPersonalArchive('workspace-a', mutatedPath, { rootKey }))
      .rejects.toThrow('personal_vault_import_manifest_authentication_failed');

    const truncatedPath = await writeArchive('truncated.bin');
    const complete = await readFile(truncatedPath);
    expect(complete.length).toBeGreaterThan(PERSONAL_ARCHIVE_ENCRYPTION_HEADER_BYTES);
    await writeFile(truncatedPath, complete.subarray(0, -1));
    await expect(openEncryptedPersonalArchive('workspace-a', truncatedPath, { rootKey }))
      .rejects.toThrow('personal_vault_import_ciphertext_size_invalid');
  });

  it('parses Gmail mbox messages into canonical mail records with stable ids and participants', () => {
    const docs = parseMbox('From sender@example.com Tue Jan 1 00:00:00 2026\nMessage-ID: <m1@example.com>\nDate: Tue, 01 Jan 2026 00:00:00 +0000\nFrom: Ada <ada@example.com>\nTo: Bob <bob@example.com>\nSubject: Planning\n\nBring the notes.');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: 'mail', externalId: 'm1@example.com', title: 'Planning', dedupeKey: 'mail:m1@example.com' });
    expect(docs[0]!.participants).toEqual(['ada@example.com', 'bob@example.com']);
  });

  it('parses Calendar ICS and Contacts vCard exports', () => {
    const events = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:e1\nDTSTART:20260822T120000Z\nSUMMARY:Review\nATTENDEE:mailto:ada@example.com\nDESCRIPTION:Agenda\nEND:VEVENT\nEND:VCALENDAR');
    expect(events[0]).toMatchObject({ source: 'calendar', externalId: 'e1', title: 'Review' });
    expect(events[0]!.participants).toEqual(['ada@example.com']);
    const contacts = parseVcard('BEGIN:VCARD\nFN:Ada Lovelace\nEMAIL:ada@example.com\nTEL:+1-555-0100\nEND:VCARD');
    expect(contacts[0]).toMatchObject({ source: 'contacts', title: 'Ada Lovelace', externalId: 'ada@example.com' });
  });

  it('parses Facebook/Instagram and X JSON inside one local ZIP', () => {
    const zip = new AdmZip();
    zip.addFile('facebook/messages/inbox/thread/message_1.json', Buffer.from(JSON.stringify({
      participants: [{ name: 'Ada' }, { name: 'Bob' }],
      messages: [{ sender_name: 'Ada', timestamp_ms: 1_787_000_000_000, content: 'Hello' }],
    })));
    zip.addFile('data/tweets.js', Buffer.from('window.YTD.tweets.part0 = [{"tweet":{"id_str":"42","created_at":"2026-08-21T00:00:00Z","full_text":"A post"}}];'));
    const parsed = parsePersonalArchive('exports.zip', zip.toBuffer());
    expect(parsed.sources).toEqual(['facebook', 'x']);
    expect(parsed.documents.map((d) => d.kind).sort()).toEqual(['message', 'post']);
    expect(parsed.warnings).toEqual([]);
  });

  it('streams Meta message arrays one record at a time and resumes from a record checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-meta-import-'));
    tempDirs.push(dir);
    const path = join(dir, 'archive.bin');
    const messages = Array.from({ length: 250 }, (_, index) => ({
      id: `message-${index}`,
      sender_name: index % 2 ? 'Ada' : 'Bob',
      timestamp_ms: 1_787_000_000_000 + index,
      content: `Message ${index}`,
    }));
    const zip = new AdmZip();
    zip.addFile(
      'facebook/messages/inbox/thread/message_1.json',
      Buffer.from(JSON.stringify({ participants: [{ name: 'Ada' }, { name: 'Bob' }], messages })),
    );
    const writer = await PersonalArchiveEncryptedWriter.create('workspace-a', path, {
      chunkBytes: 1024,
    });
    await writer.write(zip.toBuffer());
    await writer.finish();

    const first: string[] = [];
    for await (const record of streamPersonalArchiveFile(
      'workspace-a',
      'facebook.zip',
      path,
      {},
    )) {
      if (record.document) first.push(record.document.externalId!);
      if (first.length === 125) break;
    }
    const resumed: string[] = [];
    for await (const record of streamPersonalArchiveFile(
      'workspace-a',
      'facebook.zip',
      path,
      { entryIndex: 0, recordIndex: 125 },
    )) {
      if (record.document) resumed.push(record.document.externalId!);
    }
    expect(first).toEqual(messages.slice(0, 125).map(({ id }) => id));
    expect(resumed).toEqual(messages.slice(125).map(({ id }) => id));
  });

  it('reports a deliberately unparseable ZIP entry while preserving good records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-malformed-import-'));
    tempDirs.push(dir);
    const path = join(dir, 'archive.bin');
    const zip = new AdmZip();
    zip.addFile(
      'facebook/messages/inbox/good.json',
      Buffer.from(JSON.stringify({
        messages: [{ id: 'good-record', sender_name: 'Ada', content: 'Keep this message.' }],
      })),
    );
    zip.addFile(
      'facebook/messages/inbox/bad.json',
      Buffer.from('{ deliberately unparseable JSON'),
    );
    const writer = await PersonalArchiveEncryptedWriter.create('workspace-a', path, {
      chunkBytes: 1024,
    });
    await writer.write(zip.toBuffer());
    await writer.finish();

    const records = [];
    for await (const record of streamPersonalArchiveFile('workspace-a', 'facebook.zip', path, {})) {
      records.push(record);
    }
    const documents = records.flatMap(({ document }) => (document ? [document] : []));
    const warnings = records.flatMap(({ warning }) => (warning ? [warning] : []));

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ externalId: 'good-record', text: 'Keep this message.' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('facebook/messages/inbox/bad.json:');
  });
});
