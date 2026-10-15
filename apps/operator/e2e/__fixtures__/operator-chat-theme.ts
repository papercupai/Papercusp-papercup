/** Real host styles, not copied colors. Kept in the established fixture lane so
 * test:affected follows OperatorChat's import edge to its portable stylesheet.
 * Reading the adapter also checks that this sheet actually travels with it. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const themes = ['frost', 'black', 'honeycomb', 'portal-light', 'portal-dark'] as const;
export const operatorHostSource = readFileSync(resolve(import.meta.dirname, '../../app/_components/OperatorChat.tsx'), 'utf8');
export const hostCss = readFileSync(resolve(import.meta.dirname, '../../app/_components/operator-chat.css'), 'utf8');
export const themeCss = [
  readFileSync(resolve(import.meta.dirname, '../../app/_brand-primitives.css'), 'utf8'),
  readFileSync(resolve(import.meta.dirname, '../../app/_semantic.css'), 'utf8'),
  readFileSync(resolve(import.meta.dirname, '../../app/_semantic.frost.css'), 'utf8'),
  readFileSync(resolve(import.meta.dirname, '../../app/_semantic.black.css'), 'utf8'),
  readFileSync(resolve(import.meta.dirname, '../../app/_semantic.honeycomb.css'), 'utf8'),
  readFileSync(resolve(import.meta.dirname, '../../app/_semantic.portal-light.css'), 'utf8'),
  readFileSync(resolve(import.meta.dirname, '../../app/_semantic.portal-dark.css'), 'utf8'),
].join('\n');
