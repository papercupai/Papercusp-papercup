/** Native content translation. Inline image bytes live with the durable command.
 * Project references remain references: every delivery/replay rechecks their
 * workspace, digest, lifetime and current filesystem permission under the
 * authenticated engine's root. No URL fetch or basename fallback is permitted. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat as pathStat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SU_SESSION_INPUT_LIMITS, type SuSessionInputPart, type SuSessionRefusal } from '@papercusp/chat-protocol';

export const SU_INPUT_IMAGE_BYTES = SU_SESSION_INPUT_LIMITS.imageBytes;
export const SU_INPUT_TEXT_BYTES = SU_SESSION_INPUT_LIMITS.textFileBytes;
export const SU_INPUT_TOTAL_BYTES = SU_SESSION_INPUT_LIMITS.totalBytes;
export const SU_INPUT_IMAGE_TYPES = SU_SESSION_INPUT_LIMITS.imageMediaTypes;
type ImageType = typeof SU_INPUT_IMAGE_TYPES[number];
type NativeContent = { type: 'text'; text: string } | {
  type: 'image'; source: { type: 'base64'; media_type: ImageType; data: string };
};
export interface SuInputAuthority { workspaceId: string; root: string; now?: number }
export class SuInputRefusal extends Error implements SuSessionRefusal {
  readonly retryable = false;
  constructor(readonly code: string, message: string) { super(message); }
}
function refuse(code: string, message: string): never { throw new SuInputRefusal(code, message); }
function imageType(mediaType: string, bytes: Buffer): ImageType {
  if (!(SU_INPUT_IMAGE_TYPES as readonly string[]).includes(mediaType)) {
    refuse('unsupported_input_media_type', 'Images support PNG, JPEG, GIF and WebP only');
  }
  const valid = mediaType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mediaType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mediaType === 'image/gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) refuse('input_media_mismatch', 'Image bytes do not match the declared media type');
  return mediaType as ImageType;
}

async function readProjectInput(part: Extract<SuSessionInputPart, { type: 'file' }>, authority: SuInputAuthority): Promise<Buffer> {
  // These optional wire fields are mandatory for file delivery. Legacy file
  // commands receive an explicit refusal rather than acquiring fresh authority.
  const pin = part;
  if (!authority.workspaceId || pin.workspaceId !== authority.workspaceId) {
    refuse('input_workspace_mismatch', 'File reference does not belong to this session workspace');
  }
  if (!/^[a-f0-9]{64}$/.test(pin.sha256 ?? '')) refuse('input_identity_missing', 'File reference requires its SHA-256 identity');
  if (pin.expiresAt !== undefined && (!Number.isFinite(Date.parse(pin.expiresAt))
    || Date.parse(pin.expiresAt) <= (authority.now ?? Date.now()))) {
    refuse('input_expired', 'File reference has expired');
  }
  if (!part.uri.startsWith('project:')) refuse('unsupported_input_reference', 'Files require a project-relative project: reference');
  const path = part.uri.slice('project:'.length);
  if (!path || isAbsolute(path) || path.includes('\0')) refuse('input_outside_project', 'File reference must be project-relative');
  const root = await realpath(authority.root);
  const canonical = await realpath(resolve(root, path));
  const within = relative(root, canonical);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    refuse('input_outside_project', 'File reference resolves outside this session project');
  }
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    // O_NOFOLLOW covers the leaf. Recheck the opened handle too, since an
    // ancestor can be exchanged for a symlink between realpath and open.
    const opened = await realpath(process.platform === 'linux' ? `/proc/self/fd/${file.fd}` : canonical);
    const openedWithin = relative(root, opened);
    const current = await pathStat(opened);
    if (openedWithin === '..' || openedWithin.startsWith(`..${sep}`) || isAbsolute(openedWithin)
      || stat.dev !== current.dev || stat.ino !== current.ino) {
      refuse('input_outside_project', 'File reference changed project identity during delivery');
    }
    if (!stat.isFile() || (stat.mode & 0o444) === 0) refuse('input_unreadable', 'File reference is not a readable regular file');
    const limit = part.mediaType.startsWith('image/') ? SU_INPUT_IMAGE_BYTES : SU_INPUT_TEXT_BYTES;
    if (stat.size > limit) refuse('input_too_large', `File exceeds the ${limit}-byte input limit`);
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const content = bytes.subarray(0, count);
    if (createHash('sha256').update(content).digest('hex') !== pin.sha256) {
      refuse('input_identity_changed', 'File reference changed after selection; select the file again');
    }
    return content;
  } finally { await file.close(); }
}

/** Invoke at delivery, including restored queued commands, before native input. */
export async function prepareSuSessionInput(
  turn: { content: string; input?: readonly SuSessionInputPart[] }, authority: SuInputAuthority,
): Promise<{ claude: string | NativeContent[]; codex: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> }> {
  if (!turn.input?.length) return { claude: turn.content, codex: [{ type: 'text', text: turn.content }] };
  const blocks: NativeContent[] = turn.content ? [{ type: 'text', text: turn.content }] : [];
  let total = Buffer.byteLength(turn.content), images = 0;
  for (const part of turn.input) {
    if (part.type === 'text') {
      total += Buffer.byteLength(part.text);
      blocks.push({ type: 'text', text: part.text });
    } else {
      let bytes: Buffer;
      try {
        if (part.type === 'file') bytes = await readProjectInput(part, authority);
        else {
          if (part.data.length > Math.ceil(SU_INPUT_IMAGE_BYTES / 3) * 4) refuse('input_too_large', 'Image exceeds the 5 MiB input limit');
          bytes = Buffer.from(part.data, 'base64');
          if (!bytes.length || bytes.toString('base64') !== part.data) refuse('input_encoding_invalid', 'Image requires canonical base64 data');
        }
      } catch (error) {
        if (error instanceof SuInputRefusal) throw error;
        refuse('input_unreadable', 'File reference is no longer available under this session project');
      }
      total += bytes.length;
      if (part.mediaType.startsWith('image/')) {
        if (bytes.length > SU_INPUT_IMAGE_BYTES || ++images > SU_SESSION_INPUT_LIMITS.maxImages) refuse('input_too_large', 'At most five images of 5 MiB each are supported');
        blocks.push({ type: 'image', source: { type: 'base64', media_type: imageType(part.mediaType, bytes), data: bytes.toString('base64') } });
      } else {
        if (part.type !== 'file' || !(SU_SESSION_INPUT_LIMITS.fileMediaTypes as readonly string[]).includes(part.mediaType)) {
          refuse('unsupported_input_media_type', 'File references support images, UTF-8 plain text, Markdown and JSON only');
        }
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { refuse('input_encoding_invalid', 'Text file is not valid UTF-8'); }
        blocks.push({ type: 'text', text: `File ${part.uri}\n${text}` });
      }
    }
    if (total > SU_INPUT_TOTAL_BYTES) refuse('input_too_large', 'Combined input exceeds 10 MiB');
  }
  return { claude: blocks, codex: blocks.map(block => block.type === 'text' ? block
    : { type: 'image', url: `data:${block.source.media_type};base64,${block.source.data}` }) };
}
