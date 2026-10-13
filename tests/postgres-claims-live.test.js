import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {PostgresStore} from '../src/postgres-store.js';
const dsn=process.env.SOURCE_TEST_DATABASE_URL;

test('Postgres concurrent claim snapshots cannot lease an already claimed job', {skip:!dsn}, async()=>{
  const schema=`source_claim_race_${Date.now()}_${process.pid}`;
  const store=new PostgresStore({dsn,schema,connectionOptions:{maxConnections:16}});
  try {
    for(let round=0;round<12;round++) {
      const queued=await store.enqueueJobsAsync({jobs:Array.from({length:100},()=>({kind:'claim-race'}))});
      const batches=await Promise.all(Array.from({length:8},(_,i)=>store.claimJobsAsync({workerId:`worker-${i}`,limit:20,leaseMs:120000})));
      const claims=batches.flat();
      assert.equal(new Set(claims.map(j=>j.id)).size,claims.length,'each active lease has one owner');
      assert.deepEqual(new Set(claims.map(j=>j.id)),new Set(queued.map(j=>j.id)),'all ready jobs claimed once');
      for(const job of claims) assert.equal(await store.completeJobAsync({id:job.id,workerId:job.workerId,leaseToken:job.leaseToken}),true);
    }
  } finally {
    await store.closeAsync();
    execFileSync('psql',['-d',dsn,'-v','ON_ERROR_STOP=1','-c',`DROP SCHEMA IF EXISTS "${schema}" CASCADE`],{stdio:'ignore'});
  }
});
