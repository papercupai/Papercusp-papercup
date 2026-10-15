import fs from 'node:fs';
import { parsePlan, resolveEffectiveStatusForItems } from '@papercusp/plan-parser';
const folder = new URL('./', import.meta.url);
const snapshot = JSON.parse(fs.readFileSync(new URL('snapshot.json', folder), 'utf8'));
const rows = snapshot.plans.map(plan => {
  const parsed = parsePlan(plan.content);
  const resolved = resolveEffectiveStatusForItems(parsed.items);
  return {slug:plan.slug, items:resolved.items, missingRefs:resolved.missingRefs,
          cycleMembers:resolved.cycleMembers, parsedTitle:parsed.frontmatter?.title ?? null,
          indexCount:Array.isArray(plan.items)?plan.items.length:null,
          parsedCount:parsed.items.length};
});
fs.writeFileSync(new URL('canonical.json',folder),JSON.stringify(rows));
process.stdout.write(JSON.stringify({plans:rows.length,indexMissing:rows.filter(r=>r.indexCount===null).length,
  indexCountMismatch:rows.filter(r=>r.indexCount!==null&&r.indexCount!==r.parsedCount).length,
  missingRefs:rows.filter(r=>r.missingRefs.length).length,cycles:rows.filter(r=>r.cycleMembers.length).length})+'\n');
