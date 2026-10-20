/** ESM browser expressions shared by the native verifier and rendered-control regressions. */
export const WORKBENCH_FIELD_SELECTOR = '[role="combobox"],input:not([type="hidden"]):not([aria-hidden="true"]),textarea,select:not([aria-hidden="true"])';

/** Retain each action's response across automatic refreshes; install only one observer. */
export function captureWorkbenchResponses(): string {
  return `(()=>{if(!window.__DAO_HR_CAPTURE__){const state={responses:{}};const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(args[1]?.method==='POST'&&String(args[0]).includes('/api/pot/')){const request=JSON.parse(args[1].body);const op=request.action||request.op;state.responses[op]={op,status:r.status,body:await r.clone().json(),request:Object.fromEntries(['offerId','personId','companyPersonId'].filter(k=>typeof request[k]==='string').map(k=>[k,request[k]]))}}return r};window.__DAO_HR_CAPTURE__=state}window.__DAO_HR_CAPTURE__.responses={};return true})()`;
}

/** Match the verified record, accepting the API's canonical lowercase EVM address. */
export function workbenchVerifiedWallet(address: string, chainId: number): string {
  const text = `Your verified wallet: ${address.toLowerCase()} · chain ${chainId}`;
  return `[...document.querySelectorAll('p')].some(p=>p.textContent.trim().toLowerCase()===${JSON.stringify(text.toLowerCase())})`;
}

/** Compare column labels without RichGrid's presentation-only uppercase transform. */
export function workbenchEquitySnapshot(title: 'Cap table' | 'My equity'): string {
  const section = 'document.querySelector(' + JSON.stringify('section[aria-label="' + title + '"]') + ')';
  return "(()=>{const section=" + section + ";const rows=[...section.querySelectorAll('[role=table] [role=row]')];return {marker:section.querySelector('[role=note]')?.innerText,blockNumber:section.innerText.match(/block (\\d+)/)?.[1],headings:[...rows[0].children].map(cell=>cell.textContent.trim()),rows:rows.slice(1).map(row=>[...row.firstElementChild.children].map(cell=>cell.innerText.trim()))}})()";
}

/** Action buttons must not resolve to a Select trigger showing the same text. */
function workbenchButtonElement(label: string, scope: string): string {
  return `[...${scope}.querySelectorAll('button:not([role="combobox"])')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`;
}

function workbenchTextFieldElement(label: string, scope: string): string {
  return `([...document.querySelectorAll(${JSON.stringify(scope + ' label')})].find(e=>e.firstChild?.textContent?.trim()===${JSON.stringify(label)}))?.querySelector('input:not([type="hidden"]),textarea,select')`;
}

function workbenchControlReady(target: string): string {
  return `(()=>{const control=${target};if(!control||control.matches(':disabled,[readonly],[aria-disabled="true"]')||control.closest('[hidden],[aria-hidden="true"],details:not([open])'))return false;for(let n=control;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse')return false}return true})()`;
}

/** Response capture precedes React's render; wait for the actual control before acting. */
export function workbenchButtonReady(label: string, scope = 'document'): string {
  return workbenchControlReady(workbenchButtonElement(label, scope));
}

export function workbenchTextFieldReady(label: string, scope = '.dao-governance'): string {
  return workbenchControlReady(workbenchTextFieldElement(label, scope));
}

/** Retain rendered-state evidence without serializing field values or signed payloads. */
export function workbenchControlDiagnostics(scope = '.dao-governance'): string {
  return `(()=>{const root=document.querySelector(${JSON.stringify(scope)});return {url:location.href,scopeFound:!!root,text:root?.textContent,alerts:[...document.querySelectorAll('[role="alert"]')].map(e=>e.textContent),fields:[...(root?.querySelectorAll('label')||[])].map(l=>{const e=l.querySelector('input,textarea,select');return {label:l.firstChild?.textContent?.trim(),tag:e?.tagName,type:e?.getAttribute('type'),disabled:e?.matches(':disabled'),readOnly:e?.hasAttribute('readonly')}}),buttons:[...(root?.querySelectorAll('button')||[])].map(e=>({text:e.textContent.trim(),disabled:e.disabled})),disclosures:[...(root?.querySelectorAll('details')||[])].map(e=>({summary:e.querySelector('summary')?.textContent,open:e.open}))}})()`;
}

export function clickWorkbenchButton(label: string, scope = 'document'): string {
  return `(()=>{const b=${workbenchButtonElement(label, scope)};if(!${workbenchControlReady('b')})throw Error('Unavailable control '+${JSON.stringify(label)});b.click();return true})()`;
}

export function workbenchTextField(label: string, value: string, scope = '.dao-governance'): string {
  return `(()=>{const e=${workbenchTextFieldElement(label, scope)};if(!e)throw Error('Missing text field '+${JSON.stringify(label)});if(!${workbenchControlReady('e')})throw Error('Unavailable text field '+${JSON.stringify(label)});const p=e instanceof HTMLInputElement?HTMLInputElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`;
}

/** Open the named disclosure through its summary, preserving an already-open form. */
export function openWorkbenchDisclosure(label: string, scope = '.dao-governance'): string {
  return `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope + ' details > summary')})].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing disclosure '+${JSON.stringify(label)});if(!e.parentElement.open)e.click();return true})()`;
}

export function openWorkbenchSelect(label: string, scope = '.dao-governance'): string {
  return `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope + ' [role="combobox"]')})].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e||e.matches(':disabled,[aria-disabled="true"]'))throw Error('Missing enabled select '+${JSON.stringify(label)});e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));return true})()`;
}

/** Names are presentation, while values identify a person across calibrated legs. */
export function chooseWorkbenchOption(label: string, value?: string): string {
  const identity = value === undefined ? '' : `&&e.getAttribute('data-value')===${JSON.stringify(value)}`;
  return `(()=>{const matches=[...document.querySelectorAll('[role="option"]')].filter(e=>e.textContent.trim()===${JSON.stringify(label)}${identity});if(matches.length>1)throw Error('Ambiguous option '+${JSON.stringify(label)});const e=matches[0];if(!e||e.getAttribute('aria-disabled')==='true')throw Error('Missing enabled option '+${JSON.stringify(label)});e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`;
}

export function reviewWorkbenchProposal(): string {
  return `(()=>{const e=document.querySelector('.dao-governance [role="checkbox"][aria-label="I reviewed this proposal and its exact revision."]');if(!e||e.matches(':disabled,[aria-disabled="true"]'))throw Error('Missing enabled revision review');if(e.getAttribute('aria-checked')!=='true')e.click();return true})()`;
}
