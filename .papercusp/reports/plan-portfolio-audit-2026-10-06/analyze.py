"""Produce the owner-directed report from an immutable, read-only portfolio snapshot.

This is a report source, not a lifecycle writer. Canonical semantics are cited in
the output; retained test history is evidence, not a fresh execution of a suite.
"""
import collections
import datetime as dt
import hashlib
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
SOURCE = json.loads((HERE / 'snapshot.json').read_text())
BASE = json.loads((ROOT / '.papercusp/reports/unshipped-plans-audit/latest.json').read_text())
CANONICAL = {r['slug']: r for r in json.loads((HERE / 'canonical.json').read_text())}
NOW = dt.datetime.fromisoformat(SOURCE['snapshotAt'])
TERMINAL = {'passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'}
PLAN_TERMINAL = {'done', 'dropped'}
portfolio = {p['slug']: p for p in SOURCE['portfolio']}
baseline = {p['slug']: p for p in BASE['rows'] if p['harness'] == 'papercusp'}
presence = {p['owner_id']: p for p in SOURCE['presence'] or []}
sessions = {p['owner']: p for p in SOURCE['sessions'] or []}
revisions = {r['plan_slug']: r for r in SOURCE['revisions'] or []}
work = {w['id']: w for w in SOURCE['work'] or []}
plan_work = collections.defaultdict(dict)
item_work = collections.defaultdict(list)
claims = collections.defaultdict(list)
audits = collections.defaultdict(list)
tests = {}
file_cache = {}


def clean(s):
    s = str(s or '')
    s = re.sub(r'```.*?```', ' ', s, flags=re.S)
    s = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = re.sub(r'[*`#]', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def clip(s, n=200):
    s = clean(s)
    if len(s) <= n:
        return s
    return s[:n-1].rsplit(' ', 1)[0].rstrip(' ,;:') + '…'


def time(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except ValueError:
        return None


def age_minutes(s):
    value = time(s)
    return (NOW-value).total_seconds()/60 if value else None


def normpath(path):
    path = str(path or '').replace('\\', '/')
    root = str(ROOT) + '/'
    if path.startswith(root):
        path = path[len(root):]
    for prefix in ('/home/marsh-office/papercupai-workspace/papercup-release/',
                   '/home/marsh-office/papercupai-workspace/papercusp-checkpoint/',
                   '/home/marsh-office/papercupai-workspace/papercusp-staging/'):
        if path.startswith(prefix):
            path = path[len(prefix):]
    return path.removeprefix('./')


for row in SOURCE['testFiles'] or []:
    key = normpath(row['file_path'])
    if key not in tests or str(row['finished_at']) > str(tests[key]['finished_at']):
        tests[key] = row
for row in SOURCE['audits'] or []:
    audits[row['plan_slug']].append(row)
for row in SOURCE['claims'] or []:
    claims[row['plan_slug']].append(row)


def associate(slug, wid, item=None):
    if slug not in portfolio or wid not in work:
        return
    plan_work[slug][wid] = work[wid]
    if item and wid not in item_work[(slug, item)]:
        item_work[(slug, item)].append(wid)


for row in SOURCE['work'] or []:
    stamp = row.get('stamp') or {}
    if row.get('sourcePlan'):
        associate(row['sourcePlan'], row['id'])
        for item in row.get('sourceItems') or []:
            associate(row['sourcePlan'], row['id'], item)
    if stamp.get('plan_slug'):
        associate(stamp['plan_slug'], row['id'], stamp.get('item_id'))
for edge in SOURCE['edges'] or []:
    if edge['dst_kind'] == 'plan_item' and '#' in edge['dst_ref']:
        slug, item = edge['dst_ref'].rsplit('#', 1)
        wid = edge['src_ref'].rsplit('#', 1)[-1]
        if edge['rel'] in ('fixes', 'relates', 'duplicates'):
            associate(slug, wid, item)


def owner_evidence(owner):
    p, s = presence.get(owner), sessions.get(owner)
    activity = age_minutes(p.get('last_active_at')) if p else None
    heartbeat = age_minutes(p.get('heartbeat_at')) if p else None
    if s and s.get('endedAt'):
        state = 'ended'
    elif s and s.get('sessionState') in ('live', 'parked', 'ended'):
        state = s['sessionState']
    elif p and heartbeat is not None and heartbeat < 3:
        state = 'present; session state unmeasured'
    else:
        state = 'unknown; no recent liveness evidence'
    return {'owner': owner, 'state': state, 'lastActivityMinutes': round(activity, 1) if activity is not None else None,
            'heartbeatMinutes': round(heartbeat, 1) if heartbeat is not None else None,
            'intent': clip(p.get('intent'), 300) if p else '', 'fleet': p.get('fleet_slug') if p else None,
            'recentlyActive': state != 'ended' and activity is not None and activity < 30}


def sections(content):
    content = re.sub(r'\A---\n.*?\n---\n', '', content or '', flags=re.S)
    out = []
    matches = list(re.finditer(r'(?m)^#{1,3}\s+(.+)$', content))
    for index, match in enumerate(matches):
        end = matches[index+1].start() if index+1 < len(matches) else len(content)
        out.append((clean(match.group(1)).lower(), content[match.end():end].strip()))
    return out


def summary(plan):
    data = plan.get('templateData') or {}
    if plan.get('template') == 'rubric':
        subject = data.get('subjectPlan')
        kind = data.get('kind') or 'evaluation'
        target = (portfolio.get(subject) or {}).get('title') or subject
        characteristic = data.get('characteristic') or data.get('description') or ''
        return clip((f'{kind.capitalize()} criteria for {target}. ' if target else f'{kind.capitalize()} rubric. ') + str(characteristic or plan.get('title') or ''), 300)
    chunks = sections(plan.get('content', ''))
    for needle in ('purpose', 'objective', 'goal', 'problem', 'summary', 'intent', 'overview', 'motivation', 'why', 'scope'):
        for heading, body in chunks:
            if heading == needle or heading.startswith(needle + ' '):
                prose = re.sub(r'(?m)^\s*[-*]\s*\[[^\]]*\].*$', '', body)
                prose = clean(prose)
                if len(prose) >= 35:
                    return clip(prose, 330)
    requests=[]
    for block in re.findall(r'```requirement\s*\n(.*?)\n```',plan.get('content',''),re.S):
        try:
            request=json.loads(block).get('intent',{}).get('request')
            if request:
                requests.append(clean(request))
        except (ValueError,AttributeError):
            pass
    if requests:
        return clip(' '.join(requests[:3]),330)
    title = clean(plan.get('title') or CANONICAL[plan['slug']].get('parsedTitle') or plan['slug'])
    item = next((i for i in CANONICAL[plan['slug']]['items'] if i.get('text')), None)
    return clip(title + ('. Scope includes ' + clean(item['text']).split('— note:')[0] if item else '. No executable scope is recorded.'), 330)


def check_citation(citation):
    key = normpath(citation.get('path'))
    path = ROOT / key
    if key not in file_cache:
        if path.is_file() and path.resolve().is_relative_to(ROOT):
            raw = path.read_bytes()
            digest = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
            file_cache[key] = {'exists': True, 'blobSha': digest, 'lines': raw.count(b'\n')+1,
                               'body': raw.decode('utf8', errors='replace')}
        else:
            file_cache[key] = {'exists': False}
    current = file_cache[key]
    symbol = citation.get('symbol')
    out = {'path': key, 'kind': citation.get('kind'), 'symbol': symbol, 'line': citation.get('line'),
           'exists': current['exists'], 'sameBlob': bool(citation.get('blobSha') and citation.get('blobSha') == current.get('blobSha')),
           'symbolPresent': symbol in current.get('body', '') if symbol else None,
           'latestTestRun': tests.get(key) if citation.get('kind') == 'test' else None}
    return out


def resolve_items(plan):
    items = [dict(i) for i in CANONICAL[plan['slug']]['items']]
    canonical_ids={i['id'] for i in items}
    indexed=plan.get('items') or []
    indexed_by_id={i['id']:i for i in indexed}
    for saved in indexed:
        if saved['id'] not in canonical_ids:
            item=dict(saved)
            item['storedStatus']=saved.get('status','todo')
            item['unresolvedBlockers']=[ref for ref in saved.get('blockedBy') or [] if ref not in indexed_by_id or indexed_by_id[ref].get('status') not in PLAN_TERMINAL]
            item['effectiveStatus']=item['storedStatus'] if item['storedStatus'] in PLAN_TERMINAL or item['storedStatus']=='blocked' else ('blocked' if item['unresolvedBlockers'] else item['storedStatus'])
            item['staleBlockedHint']='index-only status ambiguity' if item['storedStatus']=='blocked' and saved.get('blockedBy') and not item['unresolvedBlockers'] else None
            item['indexOnly']=True
            items.append(item)
    by_id = {i['id']: i for i in items}
    # Same stored-status/dependency precedence as @papercusp/plan-parser.
    for item in items:
        stored = item.get('storedStatus', 'todo')
        unresolved = item.get('unresolvedBlockers', [])
        item['unresolved'] = unresolved
        item['effective'] = item['effectiveStatus']
        item['staleBlocked'] = stored == 'blocked' and bool(item.get('staleBlockedHint'))
        item['linkedWork'] = item_work[(plan['slug'], item['id'])]
    return items


def closeout_step(gate):
    message=gate.get('message','')
    steps=[]
    for token,text in [('proof_stale','refresh proof for the current scope'),('proof_missing','add missing acceptance proof'),('proof_inadequate','strengthen the acceptance tests and independent falsifiers'),('vetting_missing','vet the acceptance criteria'),('audit_coverage_stale','refresh the stale code-truth citations'),('grading_missing','obtain independent acceptance grading'),('author_verdict','record the author’s current acceptance decision')]:
        if token in message or token in gate.get('code',''):
            steps.append(text)
    return '; then '.join(steps[:3]) or 'resolve the acceptance refusal recorded in the evidence'


rows = []
for plan in SOURCE['plans']:
    slug = plan['slug']
    b = baseline.get(slug, {})
    items = resolve_items(plan)
    linked = sorted(plan_work[slug].values(), key=lambda w: w['id'])
    counts = collections.Counter(i['effective'] for i in items)
    done = counts['done']; dropped = counts['dropped']; remaining = len(items)-done-dropped
    open_work = [w for w in linked if w['status'] not in TERMINAL]
    succeeded = [w for w in linked if w['status'] in {'done', 'passed', 'resolved', 'closed'}]
    authority_owners = {w['holder'] for w in open_work if w.get('holder')}
    authority_owners.update(c['owner'] for c in claims[slug] if time(c['expires_ts']) and time(c['expires_ts']) > NOW)
    authority_owners.update(p['owner_id'] for p in SOURCE['presence'] or [] if p.get('current_plan_slug') == slug)
    authority_owners.update(o['ownerId'] for o in b.get('owners') or [])
    owners = [owner_evidence(o) for o in sorted(authority_owners)]
    recent = [o for o in owners if o['recentlyActive']]
    parked = [o for o in owners if o['state'] == 'parked']
    ended = [o for o in owners if o['state'] == 'ended']
    stale = [i['id'] for i in items if i['staleBlocked']]
    missing_deps = [{'item': i['id'], 'ref': ref} for i in items for ref in i['unresolved'] if ref not in {x['id'] for x in items}]
    reconcile = [i['id'] for i in items if i['effective'] not in PLAN_TERMINAL and i['linkedWork'] and all(work[w]['status'] in TERMINAL for w in i['linkedWork'])]
    contrary = [i['id'] for i in items if i['effective'] == 'done' and any(work[w]['status'] not in TERMINAL for w in i['linkedWork'])]
    audit_rows = sorted(audits[slug], key=lambda a: a['audit_seq'], reverse=True)
    completion_audits = [a for a in audit_rows if a.get('audit_kind') != 'activation']
    latest_by_item = {}
    for audit in completion_audits:
        for item in audit.get('items') or []:
            latest_by_item.setdefault(item.get('itemId'), (item, audit))
    citations = []
    for audit_item, _ in latest_by_item.values():
        for citation in audit_item.get('citations') or []:
            if citation.get('path') and citation.get('kind') in ('code', 'test', 'doc'):
                c = check_citation(citation)
                if c not in citations:
                    citations.append(c)
    audit_coverage = sum(i['id'] in latest_by_item for i in items if i['effective'] == 'done')
    missing_files = sum(not c['exists'] for c in citations)
    same_blob = sum(c['sameBlob'] for c in citations)
    cited_tests = [c for c in citations if c['kind'] == 'test']
    matched_test_runs = [c for c in cited_tests if c['latestTestRun']]
    proof_work = [w for w in succeeded if w.get('completionEvidence') or w.get('completion')]
    gate = b.get('gateVerdict') or {}
    now_state = clean(plan.get('nowState') or '')
    contradictions = []
    if (done or succeeded) and re.search(r'\b(nothing (?:built|started)|not(?:hing)? (?:yet )?(?:built|started)|no (?:implementation|code changes)|draft.{0,30}not started)\b', now_state, re.I):
        contradictions.append('The Now prose says implementation has not started, but completed work is recorded.')
    if remaining and re.match(r'^(?:plan )?(?:complete|completed|done|shipped)\b', now_state, re.I):
        contradictions.append('The Now prose says complete, but unfinished plan items remain.')
    if reconcile:
        contradictions.append('Open plan items have only terminal linked work: ' + ', '.join(reconcile) + '. Reconcile before reimplementing.')
    if contrary:
        contradictions.append('Done plan items still have unfinished linked work: ' + ', '.join(contrary) + '.')
    if plan['status'] == 'superseded' and remaining:
        contradictions.append('The plan is superseded but still contains unfinished item labels; surviving obligations need a replacement mapping.')
    if stale:
        contradictions.append('Stored blocked labels outlast all their declared dependencies: ' + ', '.join(stale) + '. An external blocker may still be legitimate.')
    if missing_deps:
        contradictions.append('Unfinished items reference unknown local dependencies; repair the references before restarting.')
    parsed_count=CANONICAL[slug]['parsedCount']
    index_count=CANONICAL[slug]['indexCount']
    index_disagrees=index_count is not None and index_count!=parsed_count
    if index_disagrees:
        contradictions.append(f'Item index/content parse disagreement: index {index_count}, parse {parsed_count}. Both sets of obligations are retained; implementation confidence needs reconciliation.')
    types = 'rubric' if plan.get('template') == 'rubric' else ('run-instance' if plan.get('templateSlug') else 'delivery')
    title=plan.get('title') or CANONICAL[slug].get('parsedTitle') or slug
    fixture = types=='delivery' and bool(re.search(r'\b(?:throwaway|dummy.demo|dummy.plan|fixture|pipeline test|flow exercise|e2e.verify)\b',title+' '+slug,re.I))
    if types == 'rubric':
        target = (plan.get('templateData') or {}).get('subjectPlan')
        target_record = portfolio.get(target)
        if target_record and target_record['status'] == 'shipped':
            bucket = 'Acceptance records for shipped work'
            recommendation = f'The linked deliverable {target} is shipped. Keep the grading history; retire or archive this rubric only after confirming it is no longer reused.'
        elif target_record and target_record['status'] == 'superseded':
            bucket = 'Acceptance records for superseded work'
            recommendation = f'The subject {target} is superseded. Carry only surviving criteria to its replacement and retain this rubric as history.'
        elif target_record:
            bucket = 'Acceptance and evaluation records'
            recommendation = f'Keep this as the {str((plan.get("templateData") or {}).get("kind") or "evaluation")} criteria for {target}. Bind current evidence and grade the subject when implementation is ready; do not staff the rubric as a separate product build.'
        else:
            bucket = 'Acceptance and evaluation records'
            recommendation = 'Keep the evaluation contract if it is actively used; establish its subject and reviewer before scheduling any work. No product implementation is implied by a rubric record.'
        implementation = 'Evaluation criteria, not a product implementation plan. ' + (f'Subject: {target_record["status"]}.' if target_record else 'Subject not resolved in this Papercusp census.')
    elif slug=='adhoc-work-item-specs':
        bucket='System specification carrier'
        implementation='System carrier for ad hoc work-item specifications; not a standalone product build.'
        recommendation='Preserve this shared specification carrier. Audit the individual work-item contracts that use it rather than retiring it because it has no ordinary plan-item graph.'
    elif plan['status'] == 'superseded':
        bucket = 'Superseded delivery history'
        target = plan.get('supersededBy')
        if not target:
            for candidate in SOURCE['portfolio']:
                if slug in (candidate.get('supersedes') or []):
                    target = candidate['slug']; break
        replacement = portfolio.get(target) if target else None
        implementation = f'Superseded; {done} done, {dropped} dropped, {remaining} residual item labels.'
        if replacement:
            recommendation = f'Continue the replacement {target} ({replacement["status"]}); preserve completed work and map residual obligations there. Do not restart this historical plan.'
        elif remaining or open_work:
            recommendation = 'Keep this retired. Identify which unfinished obligations still matter and map them to a current plan before archiving the residual labels; do not restart the entire old scope.'
        else:
            recommendation = 'Keep as historical context. No implementation restart is warranted; archive only after confirming all surviving obligations are represented elsewhere.'
    elif fixture:
        bucket='Retained fixture or workflow exercise'
        implementation=f'Fixture/exercise record; {done} done, {dropped} dropped, {remaining} unfinished item labels.'
        recommendation='Confirm whether the fixture still validates a maintained workflow. Retain its evidence and terminalize obsolete exercise labels; do not staff it as a new product feature.'
    elif types == 'run-instance':
        bucket = 'Scheduled run records'
        implementation = f'Run of {plan["templateSlug"]}; {done}/{len(items)} done, {remaining} unfinished.'
        recommendation = f'Inspect this run through its parent {plan["templateSlug"]}; retry or close only the failed run boundary. Avoid starting a parallel project from the instance.'
    elif plan['archived']:
        bucket = 'Archived plans requiring disposition'
        implementation = f'Archived, still {plan["status"]}; {done}/{len(items)} done, {remaining} unfinished.'
        recommendation = 'Establish whether this archived scope is still wanted and has a current replacement. Resume only the surviving gap with fresh evidence; supersede obsolete scope through the normal lifecycle gate.'
    elif recent and (remaining or open_work):
        bucket = 'Implementation in progress'
        implementation = f'{done} done, {dropped} dropped, {remaining} left; {len(recent)} recently active holder(s).'
        head=next((i for i in items if i['effective'] not in PLAN_TERMINAL and not i['unresolved']),None)
        recommendation = ('Finish '+head['id']+': '+clip(head.get('text'),140)+'. ' if head else 'Finish the currently held critical-path work. ')+'Keep the existing active holder(s), ' + ', '.join(o['owner'][:11] for o in recent) + '; refresh acceptance evidence after the source stops changing.'
    elif owners and (remaining or open_work):
        bucket = 'Assigned work requiring pickup'
        implementation = f'{done}/{len(items)} done, {remaining} unfinished; assigned custody, recent progress not established.'
        if parked:
            recommendation = 'Resume the existing parked custodian, ' + ', '.join(o['owner'][:11] for o in parked) + ', on the exact saved next action. Check actual pickup before treating the assignment as progress.'
        elif ended:
            recommendation = 'Recover the saved checkpoint and transfer only the remaining work from the ended holder(s). Recheck current claims before reassignment; retain completed implementation.'
        else:
            recommendation = 'Confirm the current custodian and its saved next action; an assignment alone does not establish progress. Resume it or explicitly allocate the remaining work.'
    elif reconcile or contrary or index_disagrees:
        bucket = 'Reconcile implementation records'
        implementation = f'Records disagree; {done}/{len(items)} done and {len(open_work)} open work. Implementation confidence requires reconciliation.'
        if index_disagrees:
            recommendation = f'Reconcile the {index_count}-item saved index with the {parsed_count}-item content parse; retain every obligation and recover its evidence before implementing or shipping. '
        else:
            recommendation = 'Reconcile ' + ', '.join((reconcile + contrary)[:8]) + ' against linked work and completion evidence before implementing or shipping. '
        recommendation+='Preserve real completed work and allocate only proven residue.'
    elif items and not remaining and not open_work:
        bucket = 'Implementation recorded complete; acceptance pending'
        implementation = f'Ledger complete: {done} done, {dropped} dropped. ' + (f'{audit_coverage}/{done} completed items audited; acceptance still pending.' if done else 'No implemented items are recorded.')
        if gate.get('satisfied'):
            recommendation = 'Current read-only acceptance gate passed. Have the accountable owner perform final promotion/shipment verification and the normal shipped transition; no further implementation is indicated.'
        elif gate.get('code'):
            recommendation = 'Next closeout step: '+closeout_step(gate)+'. Preserve the completed implementation; then obtain final shipment evidence. Exact refusal: '+gate['code']+'.'
        elif audit_coverage < done or not citations:
            recommendation = 'Check current code truth for the completed items, recover missing audit/test evidence, and run acceptance closeout. A terminal item ledger alone is not sufficient to mark the plan shipped.'
        else:
            recommendation = 'Refresh stale/moved code and test citations, grade current acceptance criteria, and complete final shipment verification. The item ledger indicates closeout work, not a new build.'
    elif not items and not linked:
        bucket = 'Proposal or empty scope requiring a decision'
        implementation = 'No executable item graph or linked implementation work is recorded.'
        recommendation = 'Decide whether the proposal is still useful. If yes, re-baseline it into explicit deliverables and acceptance conditions and choose an execution owner; otherwise supersede it with its rationale.'
    elif counts['needs-human'] or any(w.get('needsOwner') or w['status'] == 'needs-human' for w in open_work):
        bucket = 'Owner action recorded'
        implementation = f'{done}/{len(items)} done; a structured owner-action state remains.'
        recommendation = 'Extract the exact owner-only action from the responsible item and its decisions, and deliver one answerable request. Complete independent work first; do not infer an owner blocker from stale prose.'
    elif counts['blocked'] or any(w['status'] == 'blocked' for w in open_work):
        bucket = 'Dependencies or blockers require resolution'
        implementation = f'{done}/{len(items)} done; {counts["blocked"]} plan items dependency-blocked; {len(open_work)} open work.'
        if stale:
            recommendation = 'Revalidate the external blocker on ' + ', '.join(stale[:6]) + '; all listed dependencies are terminal. Clear only demonstrably obsolete holds, then finish the surviving work.'
        else:
            heads = [i for i in items if i['effective'] not in PLAN_TERMINAL and not i['unresolved']]
            if heads:
                lead = heads[0]
                recommendation = f'Allocate {lead["id"]}: {clip(lead.get("text"), 140)}. It is a dependency root; finishing it unlocks downstream work. Resolve external holds through their named clearer.'
            else:
                recommendation = 'Trace the unresolved dependency to its actual owner, confirm that the producer is advancing, and allocate the smallest unblock. Re-baseline missing/cyclic dependencies before resuming the plan.'
    else:
        bucket = 'Unowned implementation or unstarted work'
        implementation = f'{done}/{len(items)} done, {remaining} unfinished; no recently active holder established.'
        lead = next((i for i in items if i['effective'] not in PLAN_TERMINAL), None)
        if lead:
            recommendation = f'Reconfirm priority and assign {lead["id"]}: {clip(lead.get("text"), 150)}. Keep prior implementation; restart only the remaining acceptance gap or supersede the obsolete proposal.'
        else:
            recommendation = 'Resolve the still-open linked work and define executable scope before staffing this plan. If the original outcome is no longer wanted, retire it explicitly.'
    if plan.get('status') not in ('superseded',) and types == 'delivery' and contradictions:
        recommendation += ' Correct the contradictory status narrative as part of that disposition.'
    if citations and missing_files:
        recommendation += f' {missing_files} cited path(s) no longer resolve; locate renamed sources before relying on the saved audit.'
    next_items = [dict(id=i['id'], text=clip(i.get('text'), 280), status=i['effective'], blockedBy=i['unresolved'], linkedWork=i['linkedWork']) for i in items if i['effective'] not in PLAN_TERMINAL]
    rows.append({'slug':slug, 'title':title,'summary':summary(plan),'status':plan['status'],'type':types,'archived':plan['archived'],'legacy':plan['legacy'],
                 'category':bucket,'implementation':implementation,'recommendation':recommendation,'counts':dict(counts),'itemTotal':len(items),'done':done,'dropped':dropped,'remaining':remaining,
                 'workTotal':len(linked),'workStates':dict(collections.Counter(w['status'] for w in linked)),'completedWorkWithSavedEvidence':len(proof_work),
                 'owners':owners,'declaredOwner':plan.get('owner'),'ageDays':round((NOW-time(plan['updatedAt'])).total_seconds()/86400,1),'updatedAt':plan['updatedAt'],
                 'version':plan['version'],'revisionRows':(revisions.get(slug) or {}).get('revisions',0),'decisionCount':len(plan.get('decisions') or []),
                 'contradictions':contradictions,'nextItems':next_items,'nowState':clip(plan.get('nowState'),1800),'nowNext':clip(plan.get('nowNext'),1000),
                 'acceptanceGate':gate,'acceptanceRubric':plan.get('acceptanceRubric') or (b.get('acceptanceRubric') or {}).get('rubricId'),
                 'auditCoverage':audit_coverage,'citationCount':len(citations),'sameBlobCitations':same_blob,'missingCitationPaths':missing_files,'testCitationCount':len(cited_tests),
                 'testCitationsWithRecordedRun':len(matched_test_runs),'citations':citations,'contentHash':plan['contentHash'],
                 'workerTurnover':max([len(w.get('workerHistory') or []) for w in linked] or [0]),
                 'workIds':[w['id'] for w in linked],'savedWorkEvidence':[{'id':w['id'],'summary':clip((w.get('completionEvidence') or {}).get('summary'),500),'testsRun':clip((w.get('completionEvidence') or {}).get('testsRun'),800)} for w in proof_work],
                 'baselineCategory':b.get('category'),'baselineScopeCovered':bool(b),'cycleMembers':CANONICAL[slug]['cycleMembers'],'missingDependencyRefs':CANONICAL[slug]['missingRefs'],
                 'parsedItemCount':parsed_count,'storedIndexCount':index_count,'indexDisagrees':index_disagrees})

priority = {name:index for index,name in enumerate(['Implementation in progress','Assigned work requiring pickup','Reconcile implementation records','Implementation recorded complete; acceptance pending','Dependencies or blockers require resolution','Owner action recorded','Unowned implementation or unstarted work','Proposal or empty scope requiring a decision','Archived plans requiring disposition','Retained fixture or workflow exercise','Scheduled run records','System specification carrier','Acceptance and evaluation records','Acceptance records for shipped work','Acceptance records for superseded work','Superseded delivery history'])}
rows.sort(key=lambda r:(priority.get(r['category'],99),r['ageDays'],r['title'].lower()))
for index,row in enumerate(rows,1):
    row['number']=index
stats={'totalPortfolio':len(SOURCE['portfolio']),'nonShipped':len(rows),'shippedExcluded':sum(p['status']=='shipped' for p in SOURCE['portfolio']),
       'byStatus':dict(collections.Counter(r['status'] for r in rows)),'byType':dict(collections.Counter(r['type'] for r in rows)),
       'byRecommendation':dict(collections.Counter(r['category'] for r in rows)),'plansWithContradictions':sum(bool(r['contradictions']) for r in rows),
       'plansWithMissingCitationPaths':sum(bool(r['missingCitationPaths']) for r in rows),'sourceCitationsChecked':sum(r['citationCount'] for r in rows),
       'sameBlobCitations':sum(r['sameBlobCitations'] for r in rows),'storedTestFilesRead':len(SOURCE['testFiles']),
       'baselineCovered':sum(r['baselineScopeCovered'] for r in rows),'extendedBeyondBaseline':sum(not r['baselineScopeCovered'] for r in rows),
       'itemIndexCountDisagreements':sum(r['indexDisagrees'] for r in rows),'missingItemIndexes':sum(r['storedIndexCount'] is None for r in rows)}
assert len(rows)==len({r['slug'] for r in rows})==stats['nonShipped']
assert {r['slug'] for r in rows}=={p['slug'] for p in SOURCE['portfolio'] if p['status']!='shipped'}
audit={'snapshotAt':SOURCE['snapshotAt'],'baselineMeasuredAt':BASE['generatedAt'],'generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'scope':'Papercusp harness, papercusp-workspace; all records whose stored status is not shipped, including archives, superseded plans, rubrics and instances.',
       'stats':stats,'limitations':['Point-in-time audit; source and ownership can move after the snapshot.','Every plan was reviewed against its available ledger and content. Citation paths, symbols and saved blob identities were checked where present.','Canonical plan parsing was used for every record. When the derived item index disagrees, both obligation sets are retained and the disagreement is explicit.','Test results are stored history, not a fresh execution of every plan’s tests; missing or stale proof remains an explicit gap.','Acceptance-gate refusals were measured in the built-in baseline at '+BASE['generatedAt']+'; the full census and owner snapshot are separately timestamped.','The baseline evaluates the plan acceptance gate, not current LIVE_GATE_OPS or deployment health. No release-gate operation was performed.','A stale dependency hint alone does not prove that a genuine external blocker has cleared.','No lifecycle, assignment, blocker, plan, implementation or release state was changed.'],
       'writerRefs':['packages/operator-core/lib/agent-tools/plans/list.ts','packages/operator-core/lib/agent-tools/plans/source.ts','libs/generic/plan-parser/src/effective-status.ts','packages/operator-core/lib/plan-item-coverage.ts','packages/operator-core/lib/unshipped-plans-audit.ts','packages/operator-core/lib/work-items.ts:3119'],
       'coverage':{'population':[r['slug'] for r in rows],'checked':[r['slug'] for r in rows],'notChecked':[],'notApplicable':[],'residue':[]},'rows':rows}
(HERE/'audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')

header=f'''# Papercusp plans: implementation audit and recommended next steps

Snapshot: **{SOURCE['snapshotAt']}**. Audited **{len(rows):,} non-shipped records** from **{stats['totalPortfolio']:,} total Papercusp plans**; {stats['shippedExcluded']:,} shipped plans are excluded from the action inventory. Archived, superseded, rubric and scheduled-run records remain visible.

The recommendation is to finish the active implementation lanes, reconcile completed work before rebuilding it, and address acceptance closeout separately from new implementation. Rubrics are evaluation contracts, and superseded plans are history; neither should silently inflate the unfinished product backlog.

This is a point-in-time audit. Item ledgers, linked work, saved code-truth audits, acceptance refusals, owner liveness and recent stored test-file histories were cross-checked. Tests were not rerun for every historical plan. “Ledger complete” is a recorded implementation state, not a claim that final acceptance or shipment has passed.

## Recommended execution order

1. Continue existing active implementation lanes; avoid duplicating work held by a progressing agent.
2. Reconcile plan/work-item disagreements and recover stranded or parked custody on the precise saved next action.
3. Close out completed implementation through current code-truth, acceptance and final shipment evidence; repair the specific refusal rather than redoing the feature.
4. Resolve actual dependency roots and owner-only actions, then staff the highest-value remaining work.
5. Re-approve or retire stale proposals. Retain rubric and supersession history without treating it as fresh implementation demand.

## Portfolio breakdown

| Recommended disposition | Records |
| --- | ---: |
'''+''.join(f'| {k} | {v} |\n' for k,v in stats['byRecommendation'].items())+f'''
**{stats['plansWithContradictions']} records contain status/dependency inconsistencies.** These are findings to reconcile, not automatic authorization to change state. Current source citations were checked where available; {stats['plansWithMissingCitationPaths']} plans have at least one unresolved citation path. Missing paths may be renamed sources, not missing implementation.

## Every non-shipped plan

All {len(rows):,} records appear below. Use browser Find to locate a plan title. The companion detailed evidence volumes and the full audit source contain exact slugs, item-level residue, owner states, acceptance refusals, source citations and test-history references.

'''


def markdown_cell(s):
    return clean(s).replace('|','\\|')


def main_markdown(limits):
    output=[header]
    for category in stats['byRecommendation']:
        output.append(f'### {category}\n\n| Plan | Brief summary | Implementation status | Recommended next step |\n| --- | --- | --- | --- |\n')
        for r in rows:
            if r['category']==category:
                vals=[f'{r["number"]}. {clip(r["title"],limits[0])}',clip(r['summary'],limits[1]),clip(r['implementation'],limits[2]),clip(r['recommendation'],limits[3])]
                output.append('| '+' | '.join(markdown_cell(v) for v in vals)+' |\n')
        output.append('\n')
    output.append('## Scope and evidence limits\n\n'+ '\n'.join('- '+v for v in audit['limitations'])+'\n')
    return ''.join(output)

for limits in [(100,145,120,155),(85,115,100,130),(75,95,85,105)]:
    md=main_markdown(limits)
    if len(md.encode())<490000:
        break
assert len(md.encode())<512*1024
(HERE/'report.md').write_text(md)

embedded=json.dumps(audit,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c').replace('&','\\u0026')
page='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Papercusp plan audit</title><style>
:root{color-scheme:light;--ink:#182c38;--muted:#556773;--line:#dce3e7;--accent:#007a73}*{box-sizing:border-box}body{margin:0;background:#f4f7f8;color:var(--ink);font:16px/1.55 system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:36px 30px}header{max-width:960px}h1{font-size:42px;line-height:1.12;margin:8px 0 18px}h2{font-size:23px;margin:28px 0 12px}p{margin:10px 0}.muted{color:var(--muted)}.stats{display:flex;flex-wrap:wrap;gap:16px;margin:24px 0}.stat{background:white;border:1px solid var(--line);padding:16px 22px;border-radius:10px}.stat strong{display:block;font-size:29px}.filters{position:sticky;top:0;background:#f4f7f8f5;z-index:3;display:flex;gap:12px;flex-wrap:wrap;padding:16px 0}input,select,button{font:inherit;padding:10px 12px;border:1px solid #bdcbd2;border-radius:7px;background:white;color:var(--ink)}input{flex:1;min-width:240px}button{cursor:pointer}#list{display:grid;gap:12px}article{padding:21px 24px;border:1px solid var(--line);border-radius:9px;background:white}article h3{margin:0;font-size:20px}article .slug{font-size:13px;color:var(--muted);overflow-wrap:anywhere}.badge{display:inline-block;font-size:12px;font-weight:650;padding:3px 8px;border-radius:4px;background:#e7f1f0;color:#12635b;margin:6px 5px 5px 0}.row{display:grid;grid-template-columns:1fr 1fr;gap:26px}.label{font-size:12px;text-transform:uppercase;font-weight:750;letter-spacing:.08em;color:var(--muted);margin-top:12px}.recommendation{color:#145d55}.warning{color:#925021}details{border-top:1px solid var(--line);margin-top:14px;padding-top:10px}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace;background:#f4f7f8;padding:14px;border-radius:6px}ul{padding-left:22px}a{color:var(--accent)}@media(max-width:750px){main{padding:24px 15px}h1{font-size:32px}.row{grid-template-columns:1fr;gap:0}article{padding:17px}.filters{position:static}}@media print{.filters,button{display:none}details{display:block}article{break-inside:avoid}}
</style></head><body><main><header><p class="muted">Papercusp · owner-directed portfolio audit</p><h1>What is built, what is left,<br>and what should happen next.</h1><p id="snapshot"></p><p>Continue active implementation. Reconcile contradictory records. Close out completed work through acceptance. Decide which old proposals remain useful. Evaluation rubrics and superseded history are kept visible without treating them as new builds.</p><p class="muted">Every non-shipped Papercusp record is included. Source citations and stored test histories were inspected where available; this report does not claim fresh tests or shipment verification for every historical plan.</p></header><div class="stats" id="stats"></div><h2>Recommended order</h2><ol><li>Protect and finish active implementation lanes.</li><li>Reconcile recorded completion and recover custody where pickup is missing.</li><li>Repair the exact acceptance refusal and verify final shipment.</li><li>Resolve dependency roots and confirmed owner-only actions.</li><li>Re-approve or retire old proposals; preserve evaluation and supersession history.</li></ol><div class="filters"><input id="search" aria-label="Search plans" placeholder="Search title, slug, summary, work item, or recommendation"><select id="category" aria-label="Recommendation"><option value="">All recommendations</option></select><select id="status" aria-label="Stored status"><option value="">All stored statuses</option></select><button id="export">Download complete audit JSON</button></div><p id="shown" class="muted" aria-live="polite"></p><div id="list"></div><h2>Evidence and limits</h2><ul id="limits"></ul></main><script type="application/json" id="audit">'''+embedded+'''</script><script>
const audit=JSON.parse(document.getElementById('audit').textContent),rows=audit.rows;const el=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));el('snapshot').textContent='Snapshot '+audit.snapshotAt+' · '+audit.stats.nonShipped.toLocaleString()+' non-shipped records inspected.';el('stats').innerHTML=[['Non-shipped records',audit.stats.nonShipped],['Shipped, excluded',audit.stats.shippedExcluded],['Rubric records',audit.stats.byType.rubric||0],['Status inconsistencies',audit.stats.plansWithContradictions]].map(([label,value])=>'<div class="stat"><strong>'+value.toLocaleString()+'</strong>'+label+'</div>').join('');for(const[id,values]of [['category',rows.map(r=>r.category)],['status',rows.map(r=>r.status)]])for(const v of [...new Set(values)].sort()){let o=document.createElement('option');o.value=v;o.textContent=v;el(id).append(o)}el('limits').innerHTML=audit.limitations.map(v=>'<li>'+esc(v)+'</li>').join('');function render(){const q=el('search').value.toLowerCase(),category=el('category').value,status=el('status').value;const found=rows.filter(r=>(!category||r.category===category)&&(!status||r.status===status)&&(!q||[r.title,r.slug,r.summary,r.recommendation,...r.workIds].join(' ').toLowerCase().includes(q)));el('shown').textContent=found.length.toLocaleString()+' of '+rows.length.toLocaleString()+' records';el('list').innerHTML=found.map(r=>'<article id="plan-'+r.number+'"><h3>'+r.number+'. '+esc(r.title)+'</h3><div class="slug">'+esc(r.slug)+'</div><span class="badge">'+esc(r.status)+'</span><span class="badge">'+esc(r.category)+'</span>'+(r.archived?'<span class="badge">Archived</span>':'')+'<p>'+esc(r.summary)+'</p><div class="row"><div><div class="label">Current implementation</div><p>'+esc(r.implementation)+'</p></div><div><div class="label">Recommendation</div><p class="recommendation">'+esc(r.recommendation)+'</p></div></div>'+(r.contradictions.length?'<p class="warning">'+r.contradictions.map(esc).join('<br>')+'</p>':'')+'<details><summary>Implementation evidence and remaining work</summary><p>Plan revision '+r.version+'; '+r.decisionCount+' decisions; '+r.workTotal+' linked work items; '+r.auditCoverage+' completed items covered by saved code-truth audits.</p><p>'+r.citationCount+' citations inspected; '+r.sameBlobCitations+' retain their saved source blob; '+r.missingCitationPaths+' paths unresolved. '+r.testCitationsWithRecordedRun+' of '+r.testCitationCount+' test citations have a stored file-run record in the 90-day history.</p><div class="label">Current owners</div><pre>'+esc(JSON.stringify(r.owners,null,2))+'</pre><div class="label">Unfinished items</div><pre>'+esc(JSON.stringify(r.nextItems,null,2))+'</pre><div class="label">Acceptance</div><pre>'+esc(JSON.stringify(r.acceptanceGate,null,2))+'</pre><div class="label">Saved completion evidence</div><pre>'+esc(JSON.stringify(r.savedWorkEvidence,null,2))+'</pre><div class="label">Source and test citations</div><pre>'+esc(JSON.stringify(r.citations,null,2))+'</pre><div class="label">Plan narrative (cross-checked, not assumed current)</div><p>'+esc(r.nowState)+'</p><p>'+esc(r.nowNext)+'</p><p class="slug">Content hash: '+esc(r.contentHash)+'</p></details></article>').join('')}for(const id of ['search','category','status'])el(id).addEventListener(id==='search'?'input':'change',render);el('export').addEventListener('click',()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(audit,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='papercusp-plan-audit-2026-10-06.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),2000)});render();
</script></body></html>'''
page=page.replace('</head>','<style>select,.filters>*{max-width:100%}article h3,p{overflow-wrap:anywhere}#list{grid-template-columns:minmax(0,1fr)}article,.row>div{min-width:0}</style></head>')
(HERE/'report.html').write_text(page)
print(json.dumps({'stats':stats,'reportBytes':len(md.encode()),'htmlBytes':len(page.encode()),'auditBytes':(HERE/'audit.json').stat().st_size,'mainLimits':limits},ensure_ascii=False))
