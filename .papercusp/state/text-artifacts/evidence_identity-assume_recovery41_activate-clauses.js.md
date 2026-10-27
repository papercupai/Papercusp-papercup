---
rel_path: "evidence/identity-assume/recovery41/activate-clauses.js"
updated_at: 1792915203990
_body: "content"
---

const r=await tools.plans.get_specs({slug:'agent-assume-identity-2026-10-23',harness:'papercusp'});const keys=['specId','planItemId','behavior','behaviorClass','requiredEvidence','requiredTestLayers','mutationRequired','sourceValId','falsifier','exemption','supersedes','acceptanceRef','sourceBar'];const selected=r.specs.filter(s=>s.specId.startsWith('AUTO-BAR-')&&s.lifecycleStatus==='draft');const items=selected.map(s=>{const x={expectedRevision:s.revision,lifecycleStatus:'active'};for(const k of keys)if(k in s)x[k]=s[k];return x;});const a=await tools.plans.set_specs({slug:'agent-assume-identity-2026-10-23',harness:'papercusp',items});return {selected:selected.length,resultKeys:Object.keys(a),ok:a.ok,results:a.results?.map(x=>({ok:x.ok,specId:x.specId,revision:x.revision,evidenceCarriedForward:x.evidenceCarriedForward}))};
