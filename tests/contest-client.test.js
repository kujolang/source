import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { monitorClient } from '../scripts/contest/client-lifecycle.js';

function client(source) {
  return fork('--eval', [source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

test('contest client clean early exit rejects the ready barrier', async () => {
  const task = monitorClient(client('process.exit(0)'), 'early', 5_000);
  await assert.rejects(task.ready, /exited before its result/);
  await assert.rejects(task.done, /exited before its result/);
});

test('contest client termination after ready rejects its result', async () => {
  const child = client("process.send({type:'ready'}); setInterval(()=>{},1000)");
  const task = monitorClient(child, 'terminated', 5_000);
  await task.ready;
  child.kill();
  await assert.rejects(task.done, /exited before its result/);
});

test('contest client result survives its normal disconnect', async () => {
  const task = monitorClient(client("process.send({type:'ready'});process.send({type:'done',value:42});process.disconnect()"), 'normal', 5_000);
  await task.ready;
  assert.equal((await task.done).value, 42);
});

test('contest client out-of-order result cannot strand the ready barrier', async () => {
  const task = monitorClient(client("process.send({type:'done'});process.disconnect()"), 'out-of-order', 5_000);
  await assert.rejects(task.ready, /before ready/);
  await assert.rejects(task.done, /before ready/);
});
