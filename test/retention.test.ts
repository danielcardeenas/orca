import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HubStore } from '../src/hub/persist.ts';
import { History } from '../src/hub/history.ts';
import { readJsonlTail } from '../src/hub/jsonl.ts';
import { emptyWorld } from '../src/shared/types.ts';
import { test, ok } from './harness.ts';
export default { suite: 'Disk retention', tests: [
  test('daily telemetry is bounded, old logs removed, conversations preserved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-retention-'));
    const store = new HubStore({ dir, maxDailyBytes: 1024, retentionDays: 2, flushMs: 60000 });
    try {
      await store.prune();
      const now = Date.now(), day = new Date(now).toISOString().slice(0,10);
      const old = join(dir, 'events', '2000-01-01.jsonl'); writeFileSync(old, '{}\n');
      const custom = join(dir, 'events', 'notes.jsonl'); writeFileSync(custom, '{}\n');
      const conversation = join(dir, 'ceo.jsonl'); writeFileSync(conversation, JSON.stringify({id:'saved',role:'human',text:'Keep this conversation'})+'\n');
      const maintenance = store.prune(now);
      for(let i=0;i<100;i++)store.logEvent({at:now,kind:'cmd',text:`event ${i} ${'x'.repeat(100)}`});
      await Promise.all([maintenance,store.flush(),store.prune(now)]);
      const file = join(dir,'events',day+'.jsonl');
      assert(statSync(file).size <= 1024);
      const lines = readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l));
      assert(lines.at(-1).text.startsWith('event 99'));
      assert(!existsSync(old)); assert(existsSync(custom));
      assert.equal(store.loadCeo()[0]!.text,'Keep this conversation');
      return ok('age and size budgets preserve newest records and durable data',true);
    } finally {await store.close();rmSync(dir,{recursive:true,force:true});}
  }),
  test('timeline compaction and concurrent appends preserve order exactly once', async () => {
    const dir=mkdtempSync(join(tmpdir(),'orca-history-race-'));const file=join(dir,'history.jsonl');
    const now=Date.now();const h=new History({file,now:()=>now,flushMs:60000,maxFileBytes:2048});
    try{
      const w=emptyWorld();
      h.push(w,now-3);const first=h.flush();
      const compact=h.compact();h.push(w,now-2);const next=h.flush();
      const compact2=h.compact();h.push(w,now-1);
      await Promise.all([first,compact,next,compact2,h.flush()]);
      assert.deepEqual(readJsonlTail(file,2048).map(l=>JSON.parse(l).at),[now-3,now-2,now-1]);
      for(let i=0;i<100;i++){h.push(w,now+i);await h.flush();}
      assert(statSync(file).size<=2048);
      assert.equal(JSON.parse(readJsonlTail(file,2048).at(-1)!).at,now+99);
      return ok('serialized compaction, bounded timeline, newest snapshot retained',true);
    }finally{await h.close();rmSync(dir,{recursive:true,force:true});}
  }),
  test('bounded tail skips partial UTF-8 records and corrupt lines',()=>{
    const dir=mkdtempSync(join(tmpdir(),'orca-tail-'));const file=join(dir,'tail.jsonl');
    try{
      writeFileSync(file,JSON.stringify({text:'á'.repeat(1000)})+'\n'+JSON.stringify({text:'recent'})+'\n{broken');
      assert.deepEqual(readJsonlTail(file,128).map(l=>JSON.parse(l)),[{text:'recent'}]);
      return ok('complete recent records survive bounded reads',true);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }),
] };
