/**
 * consult-backed-parking-2026-10-12 R-8 (P-008, WI-6554700010009496): agents are steered to the
 * park door. A reversible judgment call belongs in a product-decision park
 * (`work_items:set_blocker kind:'product-decision'` with a default and a deadline), not in an
 * owner question or a bare hold. Four surfaces carry that steer, and each is judged here:
 *
 *   (1) work_items:set_blocker guidance   (2) coord:ask-owner guidance
 *   (3) consult:get_feedback guidance     (4) the su blocker section of the project guide
 *
 * The judge is pure so its test can calibrate it on the LIVE surfaces and then prove each
 * surface's violation is caught by a mutated control.
 */

export const PARK_DOOR_SURFACES = [
  'work_items:set_blocker',
  'coord:ask-owner',
  'consult:get_feedback',
  'su-blocker-section',
] as const;

export type ParkDoorSurface = (typeof PARK_DOOR_SURFACES)[number];

/** What a surface must name for an agent to find the park door from it. */
export const PARK_DOOR_TERMS = {
  /** The door itself: the product-decision blocker kind. */
  door: /product-decision/,
  /** The required default the parked agent proceeds on. */
  defaultArg: /defaultIfUnanswered/,
  /** The deadline after which silence means proceed. */
  deadline: /decideBy|deadline/,
} as const;

export interface ParkDoorVerdict {
  ok: boolean;
  violations: string[];
}

export function judgeParkDoorGuidance(surfaces: Partial<Record<ParkDoorSurface, string>>): ParkDoorVerdict {
  const violations: string[] = [];
  PARK_DOOR_SURFACES.forEach((surface, index) => {
    const prose = surfaces[surface];
    if (!prose?.trim()) {
      violations.push(`(${index + 1}) ${surface}: surface text is missing`);
      return;
    }
    for (const [term, pattern] of Object.entries(PARK_DOOR_TERMS)) {
      if (!pattern.test(prose)) {
        violations.push(`(${index + 1}) ${surface}: does not name the park door's ${term} (${pattern})`);
      }
    }
  });
  return { ok: violations.length === 0, violations };
}

/** The body of one `## <heading>` section of a Markdown guide, up to the next `## ` heading. */
export function markdownSection(markdown: string, headingPrefix: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${headingPrefix}`));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}
