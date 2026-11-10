// Explicit live Workcell smoke. Failures retain owned evidence; no host fallback.
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkcellExecutor } from '../src/workcell-executor.js';
import { digest } from '../src/integration-planner.js';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const exec=promisify(execFile);
const { SOURCE_TEST_CONTAINER_IMAGE: image, SOURCE_TEST_CONTAINER_NODE_VERSION: nodeVersion, SOURCE_TEST_WORKCELL_EXECUTABLE: executable, SOURCE_TEST_KUJO: kujo, SOURCE_TEST_WORKCELL_REVISION: workcellRevision } = process.env;
if (![image, nodeVersion, executable, kujo, workcellRevision].every(Boolean)) throw new Error('set image digest, exact Node version, Workcell executable/revision and Kujo path; see workcell-execution.md');
const root=await mkdtemp(path.join(tmpdir(),'source-workcell-live-'));
console.error('owned root',root);
const git=async(...args)=>(await exec('git',args,{cwd:root})).stdout.trim();
await git('init','-b','main');await git('config','user.name','Source fixture');await git('config','user.email','fixture@example.com');
await writeFile(path.join(root,'expected'),'exact-candidate');await git('add','expected');await git('commit','-m','fixture');
const body={headCommit:await git('rev-parse','HEAD'),tree:await git('rev-parse','HEAD^{tree}'),proposals:[]};const candidate={...body,id:digest(body)};
const source=fileURLToPath(new URL('..', import.meta.url));
const definition=JSON.parse(await readFile(path.join(source,'examples/verification/workcell-definition.json'),'utf8'));
definition.workload.image.reference=image;
const executor=new WorkcellExecutor({root:path.join(root,'attempts'),executable,kujo,workcellRevision,definition,profiles:JSON.parse(await readFile(path.join(source,'examples/verification/workcell-profiles.json'),'utf8')),profile:'docker',toolVersions:{workcell:'1.3.0',node:nodeVersion}});
const command=['node','-e',`const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(process.version,${JSON.stringify(nodeVersion)});assert.equal(fs.readFileSync('expected','utf8'),'exact-candidate');console.log('live Workcell exact candidate passed')`];
const check={command,environment:executor.environment,toolVersions:executor.config.toolVersions,inputs:{},externalState:{}};
const result=await executor.execute({repository:path.join(root,'.git'),candidate,check,identity:digest({candidate,check}),job:{id:'workcell-live',leaseToken:'attempt1'}});
const receipt=JSON.parse(result.output);
console.log(JSON.stringify({version:1,ok:result.execution.status==='pass',root,execution:result.execution,receipt},null,2));
assert.equal(result.execution.status,'pass',JSON.stringify(receipt.errors));
assert.equal(result.execution.workcell.cleanupConfirmed,true);
assert.equal(result.execution.workcell.integrityVerified,true);
assert.match(receipt.source_capture.stdout,/live Workcell exact candidate passed/);
// Full original Workcell evidence remains in root for inspection/recovery.

