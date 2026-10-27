import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { decodePng } from '../../../../libs/generic/image-blankness/src/png';

export const IMAGE_COLORS = {
  red: [255, 0, 0], blue: [0, 0, 255], green: [0, 200, 0], yellow: [255, 255, 0],
} as const;
export type ImageColor = keyof typeof IMAGE_COLORS;

/** Input order is TL, TR, BR, BL; no color names are encoded in the image. */
export function quadrantPng(colors: readonly ImageColor[]): Buffer {
  if (colors.length !== 4 || new Set(colors).size !== 4) throw new Error('Four distinct colors required');
  const width = 256, pixels = Buffer.alloc((1 + width * 3) * width);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const quadrant = y < width / 2 ? (x < width / 2 ? 0 : 1) : (x < width / 2 ? 3 : 2);
    const offset = y * (1 + width * 3) + 1 + x * 3;
    IMAGE_COLORS[colors[quadrant]].forEach((value, channel) => { pixels[offset + channel] = value; });
  }
  const chunk = (name: string, bytes: Buffer) => {
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4), type = Buffer.from(name);
    size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([size, type, bytes, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(width, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/** Independent screenshot decoder, sampled at literal clockwise coordinates. */
export function clockwisePngColors(bytes: Buffer): ImageColor[] {
  const decoded = decodePng(bytes);
  if (!decoded || decoded.width < 2 || decoded.height < 2) throw new Error('Quadrant PNG is undecodable');
  return [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]].map(([x, y]) => {
    const offset = (Math.floor(decoded.height * y) * decoded.width + Math.floor(decoded.width * x)) * 3;
    const rgb = decoded.rgb.slice(offset, offset + 3);
    const color = (Object.keys(IMAGE_COLORS) as ImageColor[])
      .find(name => IMAGE_COLORS[name].every((value, index) => value === rgb[index]));
    if (!color) throw new Error(`Unknown quadrant RGB: ${[...rgb].join(',')}`);
    return color;
  });
}

export function imageSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Only synthetic test input belongs here; never copy a session's whole transcript. */
export function retainImageInput(directory: string, command: unknown, png: Buffer): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'input.png'), png, { mode: 0o600 });
  writeFileSync(join(directory, 'command.json'), JSON.stringify(command, null, 2) + '\n', { mode: 0o600 });
}
