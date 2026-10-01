import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe,call } from './adapter.mjs';
import { queueOwnerId } from './desktop.mjs';
import { ModuleRegistry } from '../agent-core/src/registry.mjs';

test('domain boundaries and durable uncertain-send reservation, no live calls',async()=>{
  const description=await describe();assert.equal(description.length,12);
  const identity=description.find(operation=>operation.name==='identity');identity.annotations.readOnlyHint=false;
  assert.equal((await describe()).find(operation=>operation.name==='identity').annotations.readOnlyHint,true);
  for(const [op,args] of [['eval',{}],['list_tasks',{limit:101}],['models',{script:'bad'}],['search_task',{sessionId:'bad',query:'x'}],['send',{}],['send_new_session',{}]])await assert.rejects(call(op,args));
  for(const args of [{constructor:'extra'},JSON.parse('{"__proto__":{"extra":true}}')])await assert.rejects(call('identity',args),/Unknown argument/);
  const names=['QODER_DESKTOP_CDP_PORT','QODER_CONTROL_WORKSPACE_ID','QODER_CONTROL_ROOT','QODER_DELIVERY_DIR','USERPROFILE','HOME'];
  const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  const directory=await mkdtemp(join(tmpdir(),'qoder-delivery-test-'));
  try{
    process.env.USERPROFILE=directory;process.env.HOME=directory;
    delete process.env.QODER_DESKTOP_CDP_PORT;
    process.env.QODER_CONTROL_WORKSPACE_ID='f7e9fc37-179d-4893-ada5-fb2464f38273';
    process.env.QODER_CONTROL_ROOT=directory;process.env.QODER_DELIVERY_DIR=directory;
    const ownerId=queueOwnerId({deliveryDir:directory});
    const services={messageBudget:{status:()=>({schemaVersion:1,totalBytes:20_000_000,allocations:[{ownerId,bytes:20_000_000}]}),
      check:({usedBytes,additionalBytes=0})=>({ok:usedBytes+additionalBytes<=20_000_000,ownerId,allocatedBytes:20_000_000,usedBytes,additionalBytes,projectedBytes:usedBytes+additionalBytes,remainingBytes:20_000_000-usedBytes-additionalBytes,deltaBytes:0})},
      startProviderWorker:()=>({status:'started',pid:123})};
    const plain=await call('launch',{executable:'D:/verified/Qoder CN.exe'},{launchQoder:async(executable,options)=>{
      assert.equal(executable,'D:/verified/Qoder CN.exe');assert.deepEqual(options,{debugPort:undefined});return {state:'spawned'};
    }});
    assert.equal(plain.state,'spawned');
    await call('launch',{executable:'D:/verified/Qoder CN.exe',debugPort:19327},{launchQoder:async(executable,options)=>{
      assert.deepEqual(options,{debugPort:19327});return {state:'spawned'};
    }});
    const args={sessionId:'46f8b225-398b-4820-9a9e-a1241f2bd02c',requestId:'12345678-1234-1234-1234-123456789abc',prompt:'test only'};
    await assert.rejects(call('send',args,services),/Explicit local/);
    const duplicate=await call('send',args,services);assert.equal(duplicate.delivery,'not-resent');assert.equal(duplicate.completion,'unknown');
    assert.equal(duplicate.messageReceipt.ownerId,ownerId);assert.equal(duplicate.messageReceipt.correlation,args.requestId);
    assert.equal((await call('send',{...args,requestId:args.requestId.toUpperCase()},services)).delivery,'not-resent');
    const queue=await call('queue_status',{sessionId:args.sessionId},services);
    assert.equal(queue.items.length,1);assert.equal(queue.items[0].state,'needs_attention');
    assert.equal(queue.items[0].nativeAck,false);
    const correlated={...args,sessionId:'56f8b225-398b-4820-9a9e-a1241f2bd02c',requestId:'22345678-1234-1234-1234-123456789abc',correlation:'Root-Work:42'};
    await assert.rejects(call('send',correlated,services),/Explicit local/);
    const correlatedDuplicate=await call('send',correlated,services);
    assert.equal(correlatedDuplicate.messageReceipt.correlation,'Root-Work:42');
    assert.equal(correlatedDuplicate.messageReceipt.requestId,correlated.requestId);
    assert.equal(correlatedDuplicate.messageReceipt.deliveryId,`qoder-delivery:${correlated.requestId}`);
    assert.equal(correlatedDuplicate.messageReceipt.target.address,correlated.sessionId);
    assert.deepEqual((await call('recover_queue',{},services)).worker,{status:'started',pid:123});
  }finally{for(const k of names){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}await rm(directory,{recursive:true,force:true});}
});

test('v1 core discovers the real module and enforces read/write separation in an isolated registry',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'qoder-registry-test-'));
  try{
    const registry=new ModuleRegistry({registryPath:join(directory,'registry.json')});
    registry.install(fileURLToPath(new URL('.',import.meta.url)));
    const found=await registry.agentDiscover({moduleId:'agent-qoder'});assert.equal(found.operations.length,12);
    await assert.rejects(registry.agentRead({moduleId:'agent-qoder',operation:'send',args:{}}),/mutating/);
    await assert.rejects(registry.agentAct({moduleId:'agent-qoder',operation:'identity',args:{}}),/read-only/);
    registry.disable('agent-qoder');await assert.rejects(registry.agentRead({moduleId:'agent-qoder',operation:'identity'}),/disabled/);
    registry.uninstall('agent-qoder');assert.equal((await registry.agentDiscover()).modules.length,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
