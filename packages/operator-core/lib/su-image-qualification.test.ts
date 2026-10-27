import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clockwisePngColors, imageSha256, quadrantPng, retainImageInput, type ImageColor } from './__fixtures__/su-image-qualification';

function permutations(colors: ImageColor[]): ImageColor[][] {
  return colors.length ? colors.flatMap((color, index) => permutations(colors.filter((_, i) => i !== index))
    .map(rest => [color, ...rest])) : [[]];
}

describe('native image qualification calibration and custody', () => {
  it.each(permutations(['red', 'blue', 'green', 'yellow']).map(colors => [colors] as const))
    ('independently decodes clockwise quadrants %j', colors => {
      const png = quadrantPng(colors);
      expect(clockwisePngColors(png)).toEqual(colors);
      // Row-major decoding is a plausible wrong oracle and must not qualify.
      expect(clockwisePngColors(png)).not.toEqual([colors[0], colors[1], colors[3], colors[2]]);
    });

  it('retains the exact serialized command and independently decodable PNG outside fixture teardown', () => {
    const root = mkdtempSync(join(tmpdir(), 'su-image-custody-'));
    try {
      const png = quadrantPng(['green', 'red', 'blue', 'yellow']);
      const command = { content: 'Read the image', input: [{ type: 'image', data: png.toString('base64') }] };
      const evidence = join(root, 'retained');
      retainImageInput(evidence, command, png);
      const saved = JSON.parse(readFileSync(join(evidence, 'command.json'), 'utf8'));
      const retained = readFileSync(join(evidence, 'input.png'));
      expect(saved).toEqual(command);
      expect(imageSha256(Buffer.from(saved.input[0].data, 'base64'))).toBe(imageSha256(retained));
      expect(clockwisePngColors(retained)).toEqual(['green', 'red', 'blue', 'yellow']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses undecodable evidence and a degenerate quadrant palette', () => {
    expect(() => clockwisePngColors(Buffer.from('not a PNG'))).toThrow('undecodable');
    expect(() => quadrantPng(['red', 'red', 'green', 'yellow'])).toThrow('distinct');
  });
});
