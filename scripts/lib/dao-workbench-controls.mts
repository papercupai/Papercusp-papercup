/** ESM browser expressions shared by the native verifier and rendered-control regressions. */
export const WORKBENCH_FIELD_SELECTOR = '[role="combobox"],input:not([type="hidden"]):not([aria-hidden="true"]),textarea,select:not([aria-hidden="true"])';

/** Retain each action's response across automatic refreshes; install only one observer. */
export function captureWorkbenchResponses(): string {
  return `(()=>{if(!window.__DAO_HR_CAPTURE__){const state={responses:{}};const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(args[1]?.method==='POST'&&String(args[0]).includes('/api/pot/')){const request=JSON.parse(args[1].body);const op=request.action||request.op;state.responses[op]={op,status:r.status,body:await r.clone().json()}}return r};window.__DAO_HR_CAPTURE__=state}window.__DAO_HR_CAPTURE__.responses={};return true})()`;
}

/** Match the verified record, accepting the API's canonical lowercase EVM address. */
export function workbenchVerifiedWallet(address: string, chainId: number): string {
  const text = `Your verified wallet: ${address.toLowerCase()} · chain ${chainId}`;
  return `[...document.querySelectorAll('p')].some(p=>p.textContent.trim().toLowerCase()===${JSON.stringify(text.toLowerCase())})`;
}

export function workbenchTextField(label: string, value: string, scope = '.dao-governance'): string {
  return `(()=>{const l=[...document.querySelectorAll(${JSON.stringify(scope + ' label')})].find(e=>e.firstChild?.textContent?.trim()===${JSON.stringify(label)});const e=l?.querySelector('input:not([type="hidden"]),textarea,select');if(!e)throw Error('Missing text field '+${JSON.stringify(label)});const p=e instanceof HTMLInputElement?HTMLInputElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`;
}

export function openWorkbenchSelect(label: string, scope = '.dao-governance'): string {
  return `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope + ' [role="combobox"]')})].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e||e.matches(':disabled,[aria-disabled="true"]'))throw Error('Missing enabled select '+${JSON.stringify(label)});e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));return true})()`;
}

export function chooseWorkbenchOption(label: string): string {
  return `(()=>{const e=[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e||e.getAttribute('aria-disabled')==='true')throw Error('Missing enabled option '+${JSON.stringify(label)});e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`;
}

export function reviewWorkbenchProposal(): string {
  return `(()=>{const e=document.querySelector('.dao-governance [role="checkbox"][aria-label="I reviewed this proposal and its exact revision."]');if(!e||e.matches(':disabled,[aria-disabled="true"]'))throw Error('Missing enabled revision review');if(e.getAttribute('aria-checked')!=='true')e.click();return true})()`;
}
