/** Pure demand math shared by recipes and passive SQL discovery. Policy stays with each caller. */
export const clampDemandScore = (n: number): number => n < 0 ? 0 : n > 1 ? 1 : n;

export function logDemandScore(count: number, saturation: number): number {
  return count <= 0 ? 0 : clampDemandScore(Math.log1p(count) / Math.log1p(saturation));
}

export function linearDemandScore(count: number, saturation: number): number {
  return clampDemandScore(count / saturation);
}

export interface DemandScoreComponent {
  key: string;
  value: number;
  weight: number;
  contribution: number;
}

/** Ordered components are serializable evidence of the calculation, not usefulness proof. */
export function explainDemandScore(inputs: readonly { key: string; value: number; weight: number }[]): {
  score: number; components: DemandScoreComponent[];
} {
  const components = inputs.map(input => ({ ...input, contribution: input.value * input.weight }));
  return { score: clampDemandScore(components.reduce((sum, component) => sum + component.contribution, 0)), components };
}

export const compareDemandRank = (a: { score: number; id: string }, b: { score: number; id: string }): number =>
  b.score - a.score || a.id.localeCompare(b.id);
