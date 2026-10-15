/**
 * canonical-lexical-search.integration.test.ts — the PG lexical leg's RANKING,
 * against real Postgres.
 *
 * The leg (`CanonicalVectorStore.lexicalSearch`) is one half of the `hybrid-pg`
 * backend (plan memory-pg-lexical-own-injection-2026-07-13 P-002/P-003): an
 * embed-free, field-weighted token match over `memory_canonical`, RRF-fused with
 * the mem0 cosine leg. Its scoring is computed IN SQL, so a fake-pool unit test
 * can only assert the query SHAPE — the semantics need a real database, which is
 * what this file is.
 *
 * ⚠ THE GUARD (the bug this file exists to prevent recurring): the leg used to
 * pull candidates `ORDER BY created_at DESC LIMIT max(topK*5, 50)` and score them
 * in JS. That truncates the pool BEFORE scoring, so the best lexical match is
 * dropped without ever being scored whenever it loses a RECENCY race to rows that
 * merely share a common word. It cost lexical-gap MRR on the frozen bench (0.68 vs
 * the claude-file leg's 0.75) and — far worse — silently breaks EXACT-IDENTIFIER
 * recall on a live store, which is this leg's entire reason to exist. Ranking must
 * be by SCORE over the whole matching set. `ranks an OLD strong match above many
 * NEWER weak ones` below fails if anyone reintroduces a recency-ordered candidate cap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { CanonicalVectorStore, EMBEDDER_DIM_SPECS, MEMORY_VECTOR_STORAGE_PROFILES } from '@papercusp/memory';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const SCOPE = 'lex-scope';
const storageConfig = {
  vecTable:'memory_vec_local' as const,embeddingModelDims:EMBEDDER_DIM_SPECS.local.targetDims,
  embeddingProfile:EMBEDDER_DIM_SPECS.local,storageProfile:MEMORY_VECTOR_STORAGE_PROFILES.local,
};

describe('CanonicalVectorStore.lexicalSearch (real PG ranking)', () => {
  let db: OrgTestDb;
  let store: CanonicalVectorStore;

  beforeAll(async () => {
    db = await createOrgTestDb();
    const u = new URL(db.adminDsn);
    store = new CanonicalVectorStore({
      ...storageConfig,
      host: u.hostname,
      port: Number(u.port),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      dbname: u.pathname.slice(1),
      schema: 'harness_shared',
    });
  }, 180_000);

  afterAll(async () => {
    await store?.dispose();
    await db?.cleanup();
  });

  /** Use the real query builder/admission and real PG, rewriting only what the
   * counterfactual arms differ in:
   *  - 'ilike' — the pre-P-004 matcher: ILIKE over the RAW fields;
   *  - 'like'  — the P-004 matcher (production until P-007): LIKE over lowered fields;
   *  - 'current' — the builder's SQL untouched (strpos + canonical row_kind).
   * Both counterfactuals are pre-P-007, so they take each token as the escaped
   * `%…%` pattern the builder used to send, and drop the canonical row_kind
   * predicate — i.e. they are byte-for-byte the old queries, with no extra per-row
   * work that would bias a timing comparison. */
  function comparisonStore(arm: 'ilike' | 'like' | 'current') {
    const u = new URL(db.adminDsn);
    const variant = new CanonicalVectorStore({ ...storageConfig,host:u.hostname,port:Number(u.port),
      user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),
      dbname:u.pathname.slice(1),schema:'harness_shared' });
    const calls: {text:string;params:unknown[]}[]=[];
    (variant as unknown as {pool:unknown}).pool = {
      query: async (text:string,params:unknown[]) => {
        if(arm!=='current') {
          const tokenParams=new Set<number>();
          text=text.replace(/strpos\((nm|ds|dt), \$(\d+)\) > 0/g,(_m,field:string,n:string)=>{
            tokenParams.add(Number(n)-1);
            return `${field} ${arm==='ilike'?'ILIKE':'LIKE'} $${n}`;
          }).replace(/row_kind = '(?:memory|entity)' AND /g,'');
          if(arm==='ilike') text=text.replace(/lower\((payload->>'(?:name|description|data)')\)/g,(_m,e:string)=>e);
          params=params.map((p,i)=>tokenParams.has(i)?`%${String(p).replace(/[\\%_]/g,(m)=>`\\${m}`)}%`:p);
        }
        calls.push({text,params});
        return {rows:await db.adminSql.unsafe(text,params as never[])};
      },
      on:()=>{},end:async()=>{},
    };
    return {variant,calls};
  }

  /** Seed one canonical memory row. `created` drives the recency the old bug ranked by. */
  async function seed(payload: Record<string, unknown>, created = '2026-01-01T00:00:00Z'): Promise<string> {
    const rows = await db.adminSql<Array<{ id: string }>>`
      INSERT INTO harness_shared.memory_canonical (payload, state, created_at, updated_at)
      VALUES (${db.adminSql.json({ ...payload, user_id: SCOPE })}, 'active', ${created}, ${created})
      RETURNING id::text AS id`;
    return rows[0].id;
  }

  it('weights name ×3 > description ×2 > data ×1, normalized by tokens×3', async () => {
    const nameHit = await seed({ name: 'embed pipeline', data: 'unrelated' });
    const descHit = await seed({ description: 'about the embed path', data: 'unrelated' });
    const dataHit = await seed({ data: 'embed embed embed everywhere' });

    const out = await store.lexicalSearch('embed', 5, { user_id: SCOPE });

    expect(out.map((r) => r.id)).toEqual([nameHit, descHit, dataHit]);
    expect(out[0].score).toBeCloseTo(3 / 3); // name ×3
    expect(out[1].score).toBeCloseTo(2 / 3); // description ×2
    expect(out[2].score).toBeCloseTo(1 / 3); // data ×1 — repeats don't stack
  });

  it('counts a token at its BEST field only (a name hit shadows the same token in data)', async () => {
    const id = await seed({ name: 'embed', data: 'embed sidecar' });

    const out = await store.lexicalSearch('embed sidecar', 5, { user_id: SCOPE });

    // 'embed': name ×3 (its data hit is shadowed); 'sidecar': data ×1 → 4/(2×3).
    expect(out.find((r) => r.id === id)?.score).toBeCloseTo(4 / 6);
  });

  it('ranks an OLD strong match above many NEWER weak ones (no recency-truncated candidate pool)', async () => {
    // The needle: an OLD row carrying the rare identifier.
    const needle = await seed(
      { name: 'PAPERCUSP_MEMORY_TIMEOUT default', data: 'the op deadline knob' },
      '2020-01-01T00:00:00Z',
    );
    // 60 NEWER rows that match only the common word 'default' — more than the old
    // max(topK*5, 50) cap, so under the recency-ordered pull they evicted the needle
    // from the candidate set entirely and it was never scored.
    for (let i = 0; i < 60; i++) {
      await seed({ data: `unrelated note ${i} about a default value` }, `2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`);
    }

    const out = await store.lexicalSearch('PAPERCUSP_MEMORY_TIMEOUT default', 5, { user_id: SCOPE });

    expect(out[0].id).toBe(needle);
    // Every other returned row is a weak 'default'-only match, strictly below it.
    expect(out[0].score!).toBeGreaterThan(out[1]?.score ?? 0);
  });

  it('returns only scoring rows, ordered by score, capped at topK', async () => {
    await seed({ data: 'sidecar one' });
    await seed({ data: 'sidecar two' });
    await seed({ data: 'sidecar three' });
    await seed({ data: 'nothing relevant here' });

    const out = await store.lexicalSearch('sidecar', 2, { user_id: SCOPE });

    expect(out).toHaveLength(2);
    for (const r of out) expect(r.score!).toBeGreaterThan(0);
  });

  it('matches a compound identifier literally — `_` is escaped, not a LIKE wildcard', async () => {
    const literal = await seed({ data: 'the user_id column is the scope key' });
    // `user_id` unescaped would be a LIKE pattern (`_` = any single char) and would
    // match this decoy too. It must not — and it must not outrank the literal row.
    const decoy = await seed({ data: 'userxid is not the same token' });

    const out = await store.lexicalSearch('user_id', 5, { user_id: SCOPE });

    // The literal row scores on the whole compound (`user_id`) AND both subtokens;
    // the decoy can only ever score on the 'user'/'id' subtokens, so it ranks below.
    expect(out[0].id).toBe(literal);
    const decoyScore = out.find((r) => r.id === decoy)?.score ?? 0;
    expect(out[0].score!).toBeGreaterThan(decoyScore);
  });

  it('preserves mixed-case, Unicode, null, numeric, scope, kind and validity ranking against ILIKE', async () => {
    const scope='normalization-parity';
    const payloads=[
      {name:'PAPERCUSP_MEMORY_TIMEOUT',description:'Mixed CASE',data:'Alpha user_id'},
      {name:'αβ İI Iı ßSS Σσς',description:'Éé é CAFÉ',data:'userxid PATH\\NAME 100%'},
      {name:null,description:'MEMORY',data:'ALPHA'},
      {name:123,description:true,data:['ALPHA','MEMORY']},
      {},{data:'unrelated'},
    ];
    for(let i=0;i<payloads.length;i++) {
      await db.adminSql`INSERT INTO harness_shared.memory_canonical(payload,state,created_at)
        VALUES(${db.adminSql.json({...payloads[i],user_id:scope})},'active',${new Date(Date.UTC(2026,0,i+1)).toISOString()})`;
    }
    for(const [extra,state,invalidAt] of [
      [{user_id:'foreign-scope'},'active',null],
      [{entityType:'THING'},'active',null],[{},'archived',null],[{},'active','2026-02-01T00:00:00Z'],
    ] as const) {
      await db.adminSql`INSERT INTO harness_shared.memory_canonical(payload,state,created_at,invalid_at)
        VALUES(${db.adminSql.json({user_id:scope,name:'ALPHA MEMORY',...extra})},${state},'2026-01-20T00:00:00Z',${invalidAt})`;
    }
    const legacy=comparisonStore('ilike').variant;
    // P-007: the strpos + row_kind builder must also agree with the LIKE builder it
    // replaced — on `PATH\NAME 100%`, `user_id` vs `userxid`, NULL/non-text fields,
    // the entity row, the archived row and the closed-window row above.
    const like=comparisonStore('like').variant;
    for(const query of ['MEMORY alpha','PAPERCUSP_MEMORY_TIMEOUT','user_id','SS ii cafe PATH','123 true','nothing','100% path\\name']) {
      for(const filters of [{user_id:scope},{user_id:scope,include_superseded:true},{user_id:scope,as_of:'2026-01-25T00:00:00Z'}]) {
        const expected=await legacy.lexicalSearch(query,20,filters);
        const actual=await store.lexicalSearch(query,20,filters);
        expect(actual).toEqual(expected);
        expect(await like.lexicalSearch(query,20,filters)).toEqual(actual);
        expect(await store.lexicalSearch(query,20,filters)).toEqual(actual);
      }
    }
  });

  it('reduces repeated case-folding cost on a frozen wide-text workload without changing top-K', async () => {
    const scope='normalization-benchmark';
    await db.adminSql`INSERT INTO harness_shared.memory_canonical(payload,state,created_at)
      SELECT jsonb_build_object('user_id',${scope}::text,'name',CASE WHEN n%5=0 THEN 'PAPERCUSP MEMORY' ELSE 'NOTE' END,
        'description',CASE WHEN n%3=0 THEN 'LEXICAL RANKING' ELSE 'DETAIL' END,
        'data',repeat('MixedCase long contextual MEMORY text with PERFORMANCE and QUERY references. ',40)),
        'active','2026-01-01'::timestamptz+n*interval '1 second'
      FROM generate_series(1,2000) n`;
    await db.adminSql`ANALYZE harness_shared.memory_canonical`;
    const query='papercusp memory lexical retrieval ranking scope deterministic query performance timeout lineage candidate exclusion active history search';
    const legacy=comparisonStore('ilike'),like=comparisonStore('like'),current=comparisonStore('current');
    const expected=await legacy.variant.lexicalSearch(query,10,{user_id:scope});
    const times={legacy:[] as number[],like:[] as number[],current:[] as number[]};
    // Interleaved so drift in box load lands on every arm, not one.
    for(const key of ['legacy','like','current','current','like','legacy'] as const) {
      const variant=key==='legacy'?legacy:key==='like'?like:current;
      for(let i=0;i<5;i++) {
        const started=performance.now();
        expect(await variant.variant.lexicalSearch(query,10,{user_id:scope})).toEqual(expected);
        times[key].push(performance.now()-started);
      }
    }
    const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length/2)-1];
    const plans:Record<string,unknown>={};
    for(const [key,arm] of [['legacy',legacy],['like',like],['current',current]] as const) {
      const call=arm.calls.at(-1)!;
      const [row]=await db.adminSql.unsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+call.text,call.params as never[]);
      const p=row['QUERY PLAN'][0];
      plans[key]={executionMs:p['Execution Time'],hits:p.Plan['Shared Hit Blocks']};
    }
    console.info('P004_LEXICAL_NORMALIZATION',JSON.stringify({rows:2000,tokens:16,legacyMedian:median(times.legacy),likeMedian:median(times.like),currentMedian:median(times.current),plans}));
    // P-004: lowering once beats ILIKE's per-token case folding.
    expect(median(times.current)).toBeLessThan(median(times.legacy));
    // P-007 (papercusp-performance-audit-2026-10-12): strpos beats the LIKE
    // `%…%` walker it replaced, on the same lowered fields and the same top-K.
    expect(median(times.current)).toBeLessThan(median(times.like));
  },90_000);
});
