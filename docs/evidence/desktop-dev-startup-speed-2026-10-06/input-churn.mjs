// P-001 side measurement: how often do the dev host bundle's inputs change on
// this shared tree? Reads an esbuild metafile and reports, for several
// windows, how many inputs were modified within that window.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
const [meta, baseDir] = process.argv.slice(2);
const inputs = Object.keys(JSON.parse(readFileSync(meta, "utf8")).inputs);
const now = Date.now();
const ages = [];
let missing = 0;
for (const rel of inputs) {
  try {
    ages.push((now - statSync(resolve(baseDir, rel)).mtimeMs) / 1000);
  } catch {
    missing += 1;
  }
}
const out = { inputs: inputs.length, missing, nodeModules: inputs.filter((p) => p.includes("node_modules/")).length };
for (const w of [300, 900, 1800, 3600, 4 * 3600, 24 * 3600]) out[`changedWithin${w}s`] = ages.filter((a) => a < w).length;
ages.sort((a, b) => a - b);
out.youngestAgesSec = ages.slice(0, 10).map((a) => Math.round(a));
console.log(JSON.stringify(out));
