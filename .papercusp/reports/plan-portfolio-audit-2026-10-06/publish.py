"""Publish bounded report volumes using attributed ptool JSON stdin, and retain receipts."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

HERE=Path(__file__).resolve().parent
AUDIT=json.loads((HERE/'audit.json').read_text())
RECEIPTS=HERE/'receipts.json'
records=json.loads(RECEIPTS.read_text()) if RECEIPTS.exists() else []


def unpack(value):
    if isinstance(value,dict):
        if value.get('report_id') and value.get('path'):
            return value
        for key in ('data','structuredContent','result'):
            found=unpack(value.get(key))
            if found:
                return found
        for block in value.get('content',[]):
            text=block.get('text','')
            try:
                found=unpack(json.loads(text))
                if found:
                    return found
            except (ValueError,TypeError):
                pass
    return None


def publish(key,title,body,summary):
    previous=next((r for r in records if r['key']==key),None)
    digest=hashlib.sha256(body.encode()).hexdigest()
    if previous:
        if previous['bodySha256']!=digest:
            raise RuntimeError('Publication already exists with different source; inspect it before a replacement: '+key)
        return previous
    args={'title':title,'summary':summary,'body_md':body,'kind':'audit',
          'subject':{'kind':'work_item','ref':'WI-10006272','label':'Full Papercusp non-shipped plan audit'},
          'visibility':'owner','tags':['papercusp','plan-portfolio','non-shipped','2026-10-06']}
    proc=subprocess.run(['ptool','reports:publish','--json','-'],input=json.dumps(args,ensure_ascii=False),text=True,capture_output=True,timeout=90)
    try:
        result=json.loads(proc.stdout)
    except ValueError:
        raise RuntimeError('Publication outcome needs inspection: '+proc.stdout[-1200:]+' '+proc.stderr[-400:])
    receipt=unpack(result)
    if proc.returncode!=0 or not receipt:
        raise RuntimeError('Report publication refused or inconclusive: '+str(result)[:1500])
    record={'key':key,'reportId':receipt['report_id'],'path':receipt['path'],'title':title,
            'bodyBytes':len(body.encode()),'bodySha256':digest,'receipt':receipt,'source':str(HERE/'report.md') if key=='main' else str(HERE/'volumes.json')}
    records.append(record)
    RECEIPTS.write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:record[k] for k in ['key','reportId','path','bodyBytes']},ensure_ascii=False),flush=True)
    return record


def record_markdown(row):
    out=[f'## {row["number"]}. {row["title"]}\n\n',f'`{row["slug"]}` · stored status **{row["status"]}** · **{row["category"]}**\n\n',
         '**Brief summary:** '+row['summary']+'\n\n','**Current implementation:** '+row['implementation']+'\n\n',
         '**Recommendation:** '+row['recommendation']+'\n\n',
         f'**Ledger:** {row["done"]} done, {row["dropped"]} dropped, {row["remaining"]} unfinished; {row["workTotal"]} linked work records ({json.dumps(row["workStates"])}). Plan version {row["version"]}; {row["decisionCount"]} decisions; {row["revisionRows"]} recorded revisions.\n\n']
    if row['owners']:
        out.append('**Owner evidence:** '+ '; '.join(o['owner']+' — '+o['state']+'; last tool activity '+(str(o['lastActivityMinutes'])+' minutes before the snapshot' if o['lastActivityMinutes'] is not None else 'not measured') for o in row['owners'])+'.\n\n')
    else:
        out.append('**Owner evidence:** no currently linked holder was established in the snapshot.\n\n')
    if row['contradictions']:
        out.append('**Records to reconcile:**\n\n'+''.join('- '+s+'\n' for s in row['contradictions'])+'\n')
    if row['nextItems']:
        out.append('**Remaining tracked work:**\n\n')
        for item in row['nextItems']:
            out.append('- '+item['id']+' ('+item['status']+'): '+item['text']+(' Dependencies: '+', '.join(item['blockedBy'])+'.' if item['blockedBy'] else '')+(' Work: '+', '.join(item['linkedWork'])+'.' if item['linkedWork'] else '')+'\n')
        out.append('\n')
    gate=row['acceptanceGate']
    if gate:
        out.append('**Acceptance evidence:** '+('Read-only gate passed.' if gate.get('satisfied') else (gate.get('code') or gate.get('skipped') or 'No passing verdict recorded.'))+'\n\n')
        if gate.get('message'):
            out.append('> '+gate['message'].replace('\n','\n> ')+'\n\n')
    else:
        out.append('**Acceptance evidence:** no current gate verdict was measured for this record in the built-in baseline.\n\n')
    if row['acceptanceRubric']:
        out.append('Acceptance rubric: `'+row['acceptanceRubric']+'`.\n\n')
    out.append(f'**Source verification:** {row["auditCoverage"]} completed plan items have saved code-truth coverage. {row["citationCount"]} saved citations checked; {row["sameBlobCitations"]} still match their recorded source blob; {row["missingCitationPaths"]} paths unresolved. {row["testCitationsWithRecordedRun"]}/{row["testCitationCount"]} test citations have a latest file-run record in the 90-day stored history. This is not a fresh full-plan test run.\n\n')
    for c in row['citations']:
        source='`'+c['path']+'`'+(':'+str(c['line']) if c.get('line') else '')
        state='path unresolved' if not c['exists'] else ('saved blob unchanged' if c['sameBlob'] else 'path exists; saved blob changed or unavailable')
        run=c.get('latestTestRun')
        if run:
            state+='; latest stored run '+str(run['id'])+' '+str(run['status'])+' at '+str(run['finished_at'])
        out.append('- '+source+': '+state+'.\n')
    if row['citations']:
        out.append('\n')
    for w in row['savedWorkEvidence']:
        out.append('**Saved completion '+w['id']+':** '+w['summary']+'\n\n')
        if w['testsRun']:
            out.append('Tests recorded by implementer: '+w['testsRun']+'\n\n')
    out.append('**Plan narrative (cross-checked):** '+(row['nowState'] or 'No Now state is recorded.')+'\n\n')
    if row['nowNext']:
        out.append('Recorded next action: '+row['nowNext']+'\n\n')
    out.append('Evidence identity: `'+row['contentHash']+'`.\n\n---\n\n')
    return ''.join(out)


prefix=f'# Papercusp plan audit — detailed evidence\n\nSnapshot {AUDIT["snapshotAt"]}; built-in acceptance checks {AUDIT["baselineMeasuredAt"]}. Record numbers match the main audit page. Recommendations do not change plan state. Tests shown are stored evidence, not fresh execution.\n\n'
chunks=[];chunk=[];body=prefix
for row in AUDIT['rows']:
    entry=record_markdown(row)
    if len((body+entry).encode())>450000 and chunk:
        chunks.append({'first':chunk[0]['number'],'last':chunk[-1]['number'],'body':body})
        body=prefix;chunk=[]
    chunk.append(row);body+=entry
if chunk:
    chunks.append({'first':chunk[0]['number'],'last':chunk[-1]['number'],'body':body})
assert sum(c['last']-c['first']+1 for c in chunks)==len(AUDIT['rows'])
assert all(len(c['body'].encode())<512*1024 for c in chunks)
(HERE/'volumes.json').write_text(json.dumps(chunks,ensure_ascii=False,indent=2)+'\n')
volume_receipts=[]
for index,chunk in enumerate(chunks,1):
    volume_receipts.append(publish('volume-'+str(index),f'Papercusp plan audit — evidence {index}: records {chunk["first"]}–{chunk["last"]}',chunk['body'],
       f'Detailed summary, implementation status, recommendation, remaining items, liveness, acceptance refusal and source/test evidence for records {chunk["first"]}–{chunk["last"]} in Avi’s full non-shipped plan audit.'))
main=(HERE/'report.md').read_text()
marker='## Detailed evidence volumes'
if marker in main:
    main=main[:main.index(marker)].rstrip()+'\n'
main+='\n## Detailed evidence volumes\n\n'
main+='Every plan’s full summary and recommendation, exact slug, unfinished items, ownership, acceptance refusal, saved completion evidence and source/test citations are included in these volumes. Record numbers match the inventory above.\n\n'
for receipt,chunk in zip(volume_receipts,chunks):
    main+=f'- [Records {chunk["first"]}–{chunk["last"]}]({receipt["path"]})\n'
main+='\nAudit source and searchable HTML: `.papercusp/reports/plan-portfolio-audit-2026-10-06/`. Full snapshot and coverage: `audit.json`; read-only collection: `collect.sql`; canonical parsing: `canonical.mjs`; analysis: `analyze.py`.\n\n'
main+='Follow-up **WI-10006302** is filed and assigned to this audit session for evidence-preserving reconciliation of item-index/content divergence and status contradictions. It is not a completed repair. No audited plan was changed.\n'
assert len(main.encode())<512*1024
(HERE/'report.md').write_text(main)
publish('main',f'Papercusp — full audit of {len(AUDIT["rows"]):,} non-shipped plan records',main,
        f'All {len(AUDIT["rows"]):,} non-shipped Papercusp plans, including archived, superseded and rubric records: a brief summary, recorded implementation status and recommended next action for each, with detailed implementation evidence and an explicit point-in-time scope.')
