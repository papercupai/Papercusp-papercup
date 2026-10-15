'use client';
import { useState, type ReactNode } from 'react';
import { useFieldArray } from 'react-hook-form';
import { useQueryStates, parseAsString, parseAsStringEnum, parseAsBoolean } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { ArrowRight, ArrowUpRight, Users, Landmark, Wallet, FileText, ShieldCheck, ListChecks, LayoutGrid, Check, Plus, LockKeyhole, X } from 'lucide-react';
import {
  createDaoLaunchSchema, updateDaoLaunchSchema, daoFundingExample, DAO_LAUNCH_STEPS,
  type DaoLaunchProjection, type DaoLaunchStep,
} from '@papercusp/operator-core/lib/dao-launch';
import { Modal } from '../harness/Modal';
import { Select } from '../harness/Select';
import { Checkbox } from '../harness/Checkbox';
import { useFormWith } from '@/lib/forms/useFormWith';
import { FormField } from '@/lib/forms/FormField';
import './dao-launch.css';

const panels = ['launch', 'overview', 'governance', 'funding', 'legal', 'banking'] as const;
type Panel = typeof panels[number];
type Editor = Exclude<DaoLaunchStep, 'review'> | 'funding';
const editors = ['', 'organization', 'governance', 'funding', 'legal', 'banking', 'review'] as const;
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const percent = (bps: number) => (bps / 100).toLocaleString() + '%';
const titles: Record<Editor | 'review', string> = {
  organization: 'Purpose & founding team', governance: 'Governance rules', funding: 'Funding model',
  legal: 'Legal preparation', banking: 'Banking & treasury preparation', review: 'Review launch preparation',
};
const nav = [
  { id: 'launch', label: 'Launch checklist', icon: ListChecks },
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'governance', label: 'Members & rules', icon: Users },
  { id: 'funding', label: 'Money flow', icon: Wallet },
  { id: 'legal', label: 'Legal & documents', icon: FileText },
  { id: 'banking', label: 'Banking & treasury', icon: Landmark },
] as const;

async function writeDraft(path: string, method: string, payload: unknown): Promise<DaoLaunchProjection> {
  const response = await fetch('/api/desktop/dao-launch' + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'The draft could not be saved. Please try again.');
  return result.organization;
}

export function DaoLaunchWorkspace() {
  const [state, setState] = useQueryStates({
    daoOrg: parseAsString.withDefault(''), daoPanel: parseAsStringEnum([...panels]).withDefault('launch'),
    daoEdit: parseAsStringEnum([...editors]).withDefault(''), daoNew: parseAsBoolean.withDefault(false),
  }, { history: 'push' });
  const library = useSyncQuery<DaoLaunchProjection>({ queryName: 'dao.launches', args: {} });
  const [recent, setRecent] = useState<DaoLaunchProjection | null>(null);
  const [notice, setNotice] = useState('');
  const selectedId = state.daoOrg || library.data[0]?.id || recent?.id;
  const stored = library.data.find(row => row.id === selectedId);
  const selected = recent && recent.id === selectedId && (!stored || recent.revision > stored.revision) ? recent : stored;
  const organizations = recent && !library.data.some(row => row.id === recent.id) ? [recent, ...library.data] : library.data;
  function saved(record: DaoLaunchProjection) {
    setRecent(record); library.invalidate();
    void setState({ daoOrg: record.id, daoEdit: '', daoNew: false });
    setNotice('Draft saved. Payment activation is unchanged.');
  }
  function open(editor: Editor | 'review') { setNotice(''); void setState({ daoEdit: editor }); }
  const next = selected?.steps.find(step => step.state === 'next') || selected?.steps.find(step => step.state !== 'prepared');

  return <div className="dao-workspace-container"><main className="dao-workspace" data-testid="dao-launch-workspace">
    <aside className="dao-sidebar">
      <div className="dao-brand"><span className="dao-brandmark">p</span><strong>papercusp</strong></div>
      <div className="dao-org-select"><Select ariaLabel="Organization" value={selectedId || '__none__'} onChange={value => { setNotice(''); void setState({ daoOrg: value, daoEdit: '' }); }}
        options={organizations.length ? organizations.map(org => ({ value: org.id, label: org.name })) : [{ value: '__none__', label: 'No organizations yet', disabled: true }]} /></div>
      <button className="dao-sidebar-create" onClick={() => { void setState({ daoNew: true }); }}><Plus size={15} /> New organization</button>
      <div className="dao-sidebar-label">Your organization</div>
      <nav aria-label="DAO workspace">{nav.map(item => <button key={item.id} className={state.daoPanel === item.id ? 'active' : ''}
        aria-current={state.daoPanel === item.id ? 'page' : undefined} onClick={() => { void setState({ daoPanel: item.id, daoEdit: '' }); }}><item.icon size={17} />{item.label}</button>)}</nav>
      <div className="dao-sidebar-foot"><ShieldCheck size={16} /><span>{selected?.preparationReady ? 'Preparation complete' : 'Draft organization'}</span></div>
    </aside>
    <section className="dao-main">
      <div className="dao-breadcrumb">Workspace <span>/</span> {selected?.name || 'Organizations'} <span>/</span> {nav.find(item => item.id === state.daoPanel)?.label}</div>
      {library.loading && !selected && <div className="dao-state" role="status">Loading your organizations…</div>}
      {library.error && <div className="dao-error" role="alert"><p>Could not load saved organizations: {library.error.message}</p><button className="dao-button" onClick={library.invalidate}>Retry</button></div>}
      {!library.loading && !library.error && !selected && <div className="dao-empty">
        <div className="dao-empty-icon"><Users size={32} /></div><div className="dao-eyebrow">Start with a shared purpose</div>
        <h1>Your DAO starts here.</h1><p>Create an organization draft. Bring your founding team, governance, legal preparation and treasury setup into one shared workspace.</p>
        {state.daoOrg && <p>The selected organization is unavailable in this workspace. Choose another organization or create a draft.</p>}
        <button className="dao-button primary" onClick={() => { void setState({ daoNew: true }); }}>Create an organization <ArrowRight size={16} /></button>
        <div className="dao-hint"><LockKeyhole size={15} />Creating a draft does not form a legal entity or activate payments.</div>
      </div>}
      {selected && <>
        <header className="dao-heading"><div><div className="dao-eyebrow">Your launch workspace</div><h1>{state.daoPanel === 'launch' ? 'From idea to operating DAO.' : nav.find(item => item.id === state.daoPanel)?.label}</h1>
          <p>One shared checklist. Clear owners. No mystery about what comes next.</p></div>
          <button className="dao-button" onClick={() => open('organization')}><Users size={16} /> Edit founding team</button>
        </header>
        {notice && <p className="dao-notice" role="status">{notice}</p>}
        <div className="dao-summary">
          <div><span>Launch preparation</span><div className="dao-summary-value">{selected.completedSteps} of 5 steps prepared <Status state={selected.preparationReady ? 'prepared' : 'todo'} /></div><progress max="5" value={selected.completedSteps} aria-label="Launch preparation progress" /></div>
          <div><span>Treasury balance</span><strong>Not connected</strong><small>No verified balance available</small></div>
          <div><span>Funding model</span><strong>{selected.sections.funding.basis === 'contributions' ? 'Contributions & grants' : 'Revenue share'}</strong><small>{selected.sections.funding.basis === 'contributions' ? 'Conditions recorded in the funding draft' : percent(selected.sections.funding.shareBps) + ' of the agreed revenue basis'}</small></div>
        </div>
        {state.daoPanel === 'launch' ? <div className="dao-launch-grid">
          <section className="dao-checklist" aria-label="Launch checklist"><div className="dao-checklist-head"><h2>Launch checklist</h2><span>Prepare independent steps while approvals are pending</span></div>
            {selected.steps.map((step, index) => <article className={'dao-task ' + step.state} key={step.id}>
              <span className="dao-task-number">{step.state === 'prepared' ? <Check size={17} /> : index + 1}</span>
              <div className="dao-task-body"><div className="dao-task-title"><h3>{step.title}</h3><Status state={step.state} /></div><p>{step.description}</p>
                <div className="dao-task-meta"><span>Owner: {step.owner}</span><button onClick={() => open(step.id)}>{step.state === 'prepared' ? 'View preparation' : step.id === 'banking' ? 'Prepare documents' : 'Open setup'} <ArrowUpRight size={12} /></button></div>
                {step.state === 'next' && <button className="dao-button primary small" onClick={() => open(step.id)}>Open {step.id === 'review' ? 'review' : step.id + ' setup'} <ArrowRight size={14} /></button>}
              </div></article>)}
          </section>
          <aside className="dao-next-column"><div className="dao-next-card"><div className="dao-eyebrow">A clear next move</div><h2>{next ? next.id === 'legal' ? 'Give your DAO a legal home.' : next.title : 'Your launch draft is prepared.'}</h2>
            <p>{next?.description || 'Keep this reviewed version with your entity documents. Signed authority and verified provider connections are required to activate real funds.'}</p>
            {next && <div className="dao-needs"><strong>Have these ready</strong><ul>{(next.missing.length ? next.missing : ['Previous preparation steps']).slice(0, 5).map(item => <li key={item}>{item}</li>)}</ul></div>}
            <button className="dao-button primary" onClick={() => open(next?.id || 'review')}>{next ? 'Review next step' : 'View reviewed charter'} <ArrowRight size={16} /></button>
          </div><div className="dao-help-card"><h3>Useful work while you wait</h3><p>Prepare banking documents and proposed treasury signers while the legal team reviews your entity.</p><button onClick={() => open('banking')}>Prepare banking setup <ArrowRight size={13} /></button></div></aside>
        </div> : <SectionOverview panel={state.daoPanel} record={selected} open={open} />}
        <footer className="dao-footnote"><LockKeyhole size={13} />Prepared steps are not provider approvals. Legal authority, bank verification and treasury authorization must be confirmed before real funds activate.</footer>
      </>}
    </section>
    <Modal open={state.daoNew} onOpenChange={value => { void setState({ daoNew: value }); }} title="Create an organization" description="Start with a saved draft. Legal formation and financial activation are separate." contentClassName="dao-modal" contentStyle={{ width: 580 }}>
      <EditorHeading title="Create an organization" onClose={() => { void setState({ daoNew: false }); }} />
      <CreateOrganization onSaved={saved} />
    </Modal>
    <Modal open={!!state.daoEdit && !!selected} onOpenChange={value => { if (!value) void setState({ daoEdit: '' }); }} title={state.daoEdit ? titles[state.daoEdit] : 'Organization setup'} contentClassName="dao-modal" contentStyle={{ width: 690 }}>
      <EditorHeading title={state.daoEdit ? titles[state.daoEdit] : 'Organization setup'} onClose={() => { void setState({ daoEdit: '' }); }} />
      {selected && state.daoEdit && (state.daoEdit === 'review' ? <ReviewPreparation key={selected.id + ':' + selected.revision} record={selected} onSaved={saved} />
        : <DraftEditor key={selected.id + ':' + state.daoEdit} record={selected} editor={state.daoEdit} onSaved={saved} />)}
    </Modal>
  </main></div>;
}

function EditorHeading({ title, onClose }: { title: string; onClose: () => void }) {
  return <div className="dao-editor-heading"><h2>{title}</h2><button type="button" aria-label="Close" onClick={onClose}><X size={18} /></button></div>;
}

function Status({ state }: { state: DaoLaunchProjection['steps'][number]['state'] }) {
  return <span className={'dao-status ' + state}>{({ prepared: 'Prepared', next: 'Your next step', waiting: 'Dependency pending', todo: 'Draft' })[state]}</span>;
}
function SectionOverview({ panel, record, open }: { panel: Panel; record: DaoLaunchProjection; open: (editor: Editor | 'review') => void }) {
  const s = record.sections;
  const content: Record<Exclude<Panel, 'launch'>, { title: string; detail: ReactNode; editor: Editor | 'review' }> = {
    overview: { title: record.name, detail: <><p>{s.purpose}</p><p>{s.founders.length} founding team records · Draft version {record.revision}</p><p>Preparation belongs to this workspace. Founding team entries are draft records, not sent invitations or signed membership.</p></>, editor: 'organization' },
    governance: { title: 'Rules your team can review', detail: <><p>{s.governance.voting === 'members' ? 'One member, one vote' : 'Eligible ownership determines voting weight'}</p><p>{percent(s.governance.quorumBps)} quorum · {percent(s.governance.approvalBps)} approval · {s.governance.votingDays}-day voting window</p><p>{s.governance.delegation ? 'Delegation allowed.' : 'Delegation disabled.'} These draft rules are not an enacted governance policy.</p></>, editor: 'governance' },
    funding: { title: 'How money reaches your DAO', detail: <><div className="dao-flow"><span>Customer payments</span><ArrowRight size={16} /><span>Costs, refunds & reserves</span><ArrowRight size={16} /><span>Agreed DAO share</span></div><p>Your agreement defines the revenue basis. Fiat payments pass through the entity’s banking and reconciliation; stablecoin payments settle through approved channels.</p><p>Papercusp’s marketplace allocation is separately 10% of identity markup. This organization’s settings do not change that allocation.</p></>, editor: 'funding' },
    legal: { title: s.legal.route === 'existing' ? 'Connect an existing legal entity' : 'Prepare a new legal entity', detail: <><p>{s.legal.entityName || 'Entity name not recorded'} · {s.legal.country || 'Jurisdiction not chosen'}</p><p>Legal review: {s.legal.reviewState.replace('-', ' ')}</p><p>Use counsel or a formation provider to confirm structure, membership rights, liability, ownership and revenue agreements. A draft or wallet does not create a legal entity.</p></>, editor: 'legal' },
    banking: { title: 'Business banking + treasury Safe', detail: <><p>{s.banking.provider || 'Banking provider not selected'} · {s.banking.chain}</p><p>{s.banking.signers.length} proposed signers · {s.banking.threshold} required for treasury approval</p><p>{s.banking.reservePlan}</p><p>Provider approval is not verified by saving these details. Never enter bank account numbers, API keys, recovery phrases or private keys here.</p></>, editor: 'banking' },
  };
  const item = content[panel as Exclude<Panel, 'launch'>];
  return <article className="dao-section-overview"><h2>{item.title}</h2>{item.detail}<button className="dao-button primary" onClick={() => open(item.editor)}>Edit {panel === 'overview' ? 'organization' : panel} <ArrowRight size={15} /></button>
    {panel === 'governance' && <button className="dao-button" onClick={() => open('funding')}>Review funding model</button>}
  </article>;
}

function CreateOrganization({ onSaved }: { onSaved: (record: DaoLaunchProjection) => void }) {
  const form = useFormWith(createDaoLaunchSchema, { defaultValues: { name: '', purpose: '' } });
  return <form className="dao-form" onSubmit={form.submit(async values => {
    try { onSaved(await writeDraft('', 'POST', values)); } catch (e) { form.setError('root', { message: (e as Error).message }); }
  })}>
    <FormField label="Organization name" error={form.errors.name}><input aria-label="Organization name" placeholder="Moss Collective" {...form.register('name')} /></FormField>
    <FormField label="Shared purpose" error={form.errors.purpose}><textarea aria-label="Shared purpose" rows={3} placeholder="What are you building together?" {...form.register('purpose')} /></FormField>
    <p className="dao-form-hint">You will be recorded as the first founder. Add other founding team records in the organization setup.</p>
    {form.errors.root && <p role="alert" className="dao-form-error">{form.errors.root.message}</p>}
    <button className="dao-button primary" disabled={form.isSubmitting}>{form.isSubmitting ? 'Creating…' : 'Create organization draft'} <ArrowRight size={15} /></button>
  </form>;
}

function DraftEditor({ record, editor, onSaved }: { record: DaoLaunchProjection; editor: Editor; onSaved: (record: DaoLaunchProjection) => void }) {
  const form = useFormWith(updateDaoLaunchSchema, { defaultValues: { name: record.name, expectedRevision: record.revision, sections: record.sections } });
  const founders = useFieldArray({ control: form.control, name: 'sections.founders' });
  const values = form.watch();
  const select = (label: string, value: string, options: { value: string; label: string }[], onChange: (value: string) => void) =>
    <FormField label={label}><Select ariaLabel={label} value={value} options={options} onChange={onChange} /></FormField>;
  const choice = (label: string, checked: boolean, onChange: (value: boolean) => void) =>
    <label className="dao-checkbox-row"><Checkbox ariaLabel={label} checked={checked} onChange={onChange} />{label}</label>;
  const field = (label: string, key: Parameters<typeof form.register>[0], opts?: Parameters<typeof form.register>[1], type = 'text') =>
    <FormField label={label} error={form.methods.getFieldState(key, form.methods.formState).error}><input aria-label={label} type={type} {...form.register(key, opts)} /></FormField>;
  const percentageField = (label: string, key: 'sections.governance.quorumBps' | 'sections.governance.approvalBps' | 'sections.funding.shareBps') =>
    <FormField label={label} error={form.methods.getFieldState(key, form.methods.formState).error}><input aria-label={label} type="number" min="0" max="100" step="0.01"
      value={Number.isFinite(form.watch(key)) ? form.watch(key) / 100 : ''} onChange={event => form.setValue(key, event.target.value === '' ? NaN : Math.round(Number(event.target.value) * 100), { shouldDirty: true })} /></FormField>;
  const share = values.sections.funding.shareBps;
  const example = daoFundingExample(Number.isInteger(share) && share >= 0 && share <= 10_000 ? share : 0);
  return <form noValidate className="dao-form" onSubmit={form.submit(async data => {
    try { onSaved(await writeDraft('/' + record.id, 'PATCH', data)); } catch (e) { form.setError('root', { message: (e as Error).message }); }
  })}>
    {record.revision !== form.getValues('expectedRevision') && <p className="dao-form-error">This draft has changed since you opened it. Close this panel and reopen the latest version before saving.</p>}
    {editor === 'organization' && <>
      {field('Organization name', 'name')}
      <FormField label="Shared purpose"><textarea aria-label="Shared purpose" rows={3} {...form.register('sections.purpose')} /></FormField>
      <h3>Founding team records</h3><p className="dao-form-hint">Add the people preparing this organization. This does not send invitations or grant access.</p>
      {founders.fields.map((founder, i) => <div className="dao-founder" key={founder.id}>
        {field('Founder name ' + (i + 1), ('sections.founders.' + i + '.name') as Parameters<typeof form.register>[0])}
        {field('Founder contact ' + (i + 1), ('sections.founders.' + i + '.contact') as Parameters<typeof form.register>[0])}
        {founders.fields.length > 1 && <button type="button" className="dao-text-button" onClick={() => founders.remove(i)}>Remove</button>}
      </div>)}
      <button type="button" className="dao-button" disabled={founders.fields.length >= 30} onClick={() => founders.append({ name: '', contact: '', role: 'member' })}><Plus size={14} />Add founder record</button>
    </>}
    {editor === 'governance' && <>
      <p className="dao-form-hint">Prepare the charter rules. Saving does not enact a signed policy or deploy a voting contract.</p>
      {select('Voting model', values.sections.governance.voting, [{ value: 'members', label: 'One member, one vote' }, { value: 'ownership', label: 'Eligible ownership-weighted voting' }],
        value => form.setValue('sections.governance.voting', value as 'members' | 'ownership', { shouldDirty: true }))}
      <div className="dao-form-grid">{percentageField('Quorum (%)', 'sections.governance.quorumBps')}
      {percentageField('Approval (%)', 'sections.governance.approvalBps')}
      {field('Voting window in days', 'sections.governance.votingDays', { valueAsNumber: true }, 'number')}</div>
      {values.sections.governance.voting === 'ownership' && field('Ownership register reference', 'sections.governance.ownershipReference')}
      {choice('Allow vote delegation', values.sections.governance.delegation, value => form.setValue('sections.governance.delegation', value, { shouldDirty: true }))}
      {choice('Governance draft is prepared for founder review', values.sections.governance.prepared, value => form.setValue('sections.governance.prepared', value, { shouldDirty: true }))}
      <button type="button" className="dao-text-button" onClick={() => { form.setValue('sections.governance.quorumBps', 5000, { shouldDirty: true }); form.setValue('sections.governance.approvalBps', 6700, { shouldDirty: true }); }}>Use collective preset: 50% quorum, 67% approval</button>
    </>}
    {editor === 'funding' && <>
      {select('Funding basis', values.sections.funding.basis, [{ value: 'net-revenue', label: 'Agreed net revenue' }, { value: 'identity-markup', label: 'Our own identity markup' }, { value: 'contributions', label: 'Contributions and grants' }],
        value => form.setValue('sections.funding.basis', value as 'net-revenue' | 'identity-markup' | 'contributions', { shouldDirty: true }))}
      {values.sections.funding.basis !== 'contributions' && <>{percentageField('DAO revenue share (%)', 'sections.funding.shareBps')}
      {field('Revenue agreement reference', 'sections.funding.agreementReference')}
      <div className="dao-example"><span>Example: {money(example.eligibleCents)} eligible revenue</span><strong>{money(example.daoCents)} to this DAO</strong><span>{money(example.remainingCents)} remaining allocation</span></div></>}
      {choice('Accept member contributions and grants', values.sections.funding.acceptContributions, value => form.setValue('sections.funding.acceptContributions', value, { shouldDirty: true }))}
      {choice('Funding draft is prepared for review', values.sections.funding.prepared, value => form.setValue('sections.funding.prepared', value, { shouldDirty: true }))}
      <p className="dao-form-hint">The agreement defines eligible revenue after costs, refunds and reserves. Unused customer credits are liabilities. Papercusp’s separate 10% identity-markup allocation stays unchanged.</p>
    </>}
    {editor === 'legal' && <>
      {select('Legal route', values.sections.legal.route, [{ value: 'existing', label: 'Use an existing legal entity' }, { value: 'new', label: 'Prepare a new entity with an advisor' }],
        value => form.setValue('sections.legal.route', value as 'existing' | 'new', { shouldDirty: true }))}
      {field('Country / jurisdiction', 'sections.legal.country')}
      {field('Legal entity name', 'sections.legal.entityName')}
      {field(values.sections.legal.route === 'existing' ? 'Registration reference' : 'Formation application reference', 'sections.legal.registrationReference')}
      {field('Charter / legal document reference', 'sections.legal.documentReference')}
      {field('Counsel or formation advisor', 'sections.legal.advisor')}
      {select('Preparation review', values.sections.legal.reviewState, [{ value: 'not-started', label: 'Not started' }, { value: 'in-review', label: 'With legal advisor' }, { value: 'prepared', label: 'Documents prepared for review' }],
        value => form.setValue('sections.legal.reviewState', value as 'not-started' | 'in-review' | 'prepared', { shouldDirty: true }))}
      <p className="dao-form-hint">Record references to your documents. Entity formation, legal authority and signed rights must be confirmed with counsel. This record is not that confirmation.</p>
    </>}
    {editor === 'banking' && <>
      {field('Banking provider', 'sections.banking.provider')}
      {field('Application or non-sensitive account reference', 'sections.banking.applicationReference')}
      <FormField label="Reserve accounting plan"><textarea aria-label="Reserve accounting plan" rows={3} {...form.register('sections.banking.reservePlan')} /></FormField>
      <div className="dao-form-grid">{field('Treasury network', 'sections.banking.chain')}{field('Safe address (optional until deployed)', 'sections.banking.safeAddress')}</div>
      <FormField label="Proposed signer addresses" description="One EVM address per line. These are proposals; no wallets are connected."><textarea aria-label="Proposed signer addresses" rows={3} value={values.sections.banking.signers.join('\n')} onChange={e => form.setValue('sections.banking.signers', e.target.value.split('\n').map(s => s.trim()).filter(Boolean), { shouldDirty: true })} /></FormField>
      {field('Required signer approvals', 'sections.banking.threshold', { valueAsNumber: true }, 'number')}
      {choice('Banking and signer preparation is reviewed', values.sections.banking.prepared, value => form.setValue('sections.banking.prepared', value, { shouldDirty: true }))}
      <p className="dao-form-hint">Business verification and account approval happen with your provider. Never enter account numbers, passwords, API keys or wallet secrets here.</p>
    </>}
    {field('Responsible person', ('sections.owners.' + (editor === 'funding' ? 'governance' : editor)) as Parameters<typeof form.register>[0])}
    {!!Object.keys(form.errors).length && <div role="alert" className="dao-form-error">{form.errors.root?.message || 'Some fields need attention. Check names, numeric ranges, signer addresses and threshold.'}</div>}
    <div className="dao-form-footer"><span>Draft version {form.getValues('expectedRevision')}</span><button className="dao-button primary" disabled={form.isSubmitting || record.revision !== form.getValues('expectedRevision')}>{form.isSubmitting ? 'Saving…' : 'Save preparation'} <ArrowRight size={15} /></button></div>
  </form>;
}

function ReviewPreparation({ record, onSaved }: { record: DaoLaunchProjection; onSaved: (record: DaoLaunchProjection) => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const ready = record.steps.slice(0, 4).every(step => step.state === 'prepared');
  return <div className="dao-form"><div className="dao-charter"><div className="dao-eyebrow">Founding charter · draft v{record.revision}</div><h2>{record.name}</h2><p>{record.sections.purpose}</p>
    <h3>Governance</h3><p>{percent(record.sections.governance.quorumBps)} quorum; {percent(record.sections.governance.approvalBps)} approval; {record.sections.governance.votingDays}-day voting window.</p>
    <h3>Funding</h3><p>{record.sections.funding.basis === 'contributions' ? 'Contributions and grants' : percent(record.sections.funding.shareBps) + ' of the agreed ' + record.sections.funding.basis}.</p>
    <h3>Legal & treasury</h3><p>{record.sections.legal.entityName || 'Entity preparation incomplete'} · {record.sections.legal.country || 'Jurisdiction pending'}</p><p>{record.sections.banking.threshold} of {record.sections.banking.signers.length} proposed treasury signers.</p></div>
    {!ready && <div className="dao-form-hint"><strong>Preparation still needed</strong><ul>{record.steps.slice(0, 4).filter(step => step.state !== 'prepared').map(step => <li key={step.id}>{step.title}: {step.missing.join(', ') || 'dependency pending'}</li>)}</ul></div>}
    <label className="dao-checkbox-row"><Checkbox ariaLabel="This completes preparation only" checked={acknowledged} onChange={setAcknowledged} />I understand this completes preparation only. It does not sign the charter, open accounts or activate funds.</label>
    {record.preparationReady && <p className="dao-notice">This exact draft version has been reviewed. Editing any section requires another review.</p>}
    {error && <p role="alert" className="dao-form-error">{error}</p>}
    <button className="dao-button primary" disabled={!ready || !acknowledged || saving || record.preparationReady} onClick={async () => {
      setSaving(true); setError('');
      try { onSaved(await writeDraft('/' + record.id + '/review', 'POST', { expectedRevision: record.revision, acknowledgePreparationOnly: true })); }
      catch (e) { setError((e as Error).message); } finally { setSaving(false); }
    }}>{saving ? 'Saving review…' : 'Complete launch preparation'} <ArrowRight size={16} /></button>
  </div>;
}
