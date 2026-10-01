import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, describe } from './adapter.mjs';
import { claimWorker, desktop, queueOwnerId } from './desktop.mjs';
import { checkMessageBudget } from '../agent-core/src/contracts.mjs';

const sessionId='11111111-1111-4111-8111-111111111111';
const workspaceId='22222222-2222-4222-8222-222222222222';
const turnId='33333333-3333-4333-8333-333333333333';

async function fixture(run){
  const directory=await mkdtemp(join(tmpdir(),'qoder-interactions-test-'));
  const keys=['USERPROFILE','HOME','QODER_DESKTOP_CDP_PORT','QODER_CONTROL_WORKSPACE_ID','QODER_CONTROL_ROOT','QODER_DELIVERY_DIR'];
  const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const globals={fetch,WebSocket,setTimeout};
  const state={summary:{sessionId,workspaceId,cwd:directory,runtimeProfileId:'runtime:qoder',executionKind:'local',runtimeState:'waiting-user',archived:false},
    activeTurn:{turnId},pending:[],responses:[],reads:0,fetches:0,productId:'qoder-cn',loseReply:false,
    budgetMode:'allocated',quota:10_000_000,budgetTrace:[],version:'0.4.3',missingInterface:null};
  const pending=(toolUseId='call_read',toolName='Read',input={file_path:'E:/explicitly-authorized-reference.md'})=>({type:'permission',toolUseId,toolName,input,requestedAt:'2026-09-19T04:02:30.975Z',permissionSuggestions:[{id:'session-0'}]});
  state.pending=[pending()];
  try{
    process.env.USERPROFILE=directory;process.env.HOME=directory;
    process.env.QODER_DESKTOP_CDP_PORT='19327';process.env.QODER_CONTROL_WORKSPACE_ID=workspaceId;
    process.env.QODER_CONTROL_ROOT=directory;process.env.QODER_DELIVERY_DIR=directory;
    const config={cdpPort:19327,workspaceId,root:directory,deliveryDir:directory},ownerId=queueOwnerId(config);
    const budget=()=>state.budgetMode==='missing'?null:{schemaVersion:1,totalBytes:20_000_000,allocations:state.budgetMode==='unallocated'
      ?[{ownerId:'other-owner',bytes:20_000_000}]
      :[{ownerId,bytes:state.quota},{ownerId:'other-owner',bytes:20_000_000-state.quota}]};
    const services={registrationKey:'interaction-test',messageBudget:{status:budget,check:input=>{
      const result=checkMessageBudget(budget(),input);state.budgetTrace.push({...result});return result;
    }}};
    const invoke=(operation,args)=>call(operation,args,services);
    globalThis.fetch=async()=>{state.fetches++;return {ok:true,json:async()=>[{type:'page',url:'qoder-cn-app://renderer/index.html',webSocketDebuggerUrl:'ws://127.0.0.1:19327/devtools/page/mock'}]};};
    globalThis.WebSocket=class extends EventTarget{
      constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
      close(){}
      async send(raw){
        const request=JSON.parse(raw);let result;
        try{
          const native={
            getStartupState:async()=>({productId:state.productId,status:'ready'}),
            getProductUpdateState:async()=>({currentVersion:state.version}),
            listChatSessions:async()=>[state.summary],
            openChatSession:async id=>{assert.equal(id,sessionId);state.reads++;return structuredClone({summary:state.detailSummary??state.summary,activeTurn:state.activeTurn,pendingInteractions:state.pending,messages:[{text:'not exported'}]});},
            respondChatInteraction:async args=>{state.responses.push(JSON.parse(JSON.stringify(args)));if(state.loseReply)await new Promise(()=>{});}
          };
          if(state.missingInterface)delete native[state.missingInterface];
          const value=await vm.runInNewContext(request.params.expression,{window:{qoderDesktop:native}});
          result={result:{value}};
        }catch(error){result={exceptionDetails:{text:error.message}};}
        this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:1,result})}));
      }
    };
    const read=()=>invoke('read_interactions',{sessionId});
    const args=async()=>{const p=(await read()).value.pendingInteractions[0];return {sessionId,toolUseId:p.toolUseId,decision:'allow',expectedSnapshot:p.expectedSnapshot};};
    const direct=a=>desktop('respond_permission',{...a,workspaceId,cwd:directory},{cdpPort:19327});
    await run({state,directory,pending,read,args,direct,invoke,config,services});
  }finally{
    Object.assign(globalThis,globals);
    for(const key of keys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}
    await rm(directory,{recursive:true,force:true});
  }
}

test('future-version permissions retain scoped reads, explicit missing-interface errors and reserved no-replay',()=>fixture(async({state,read,args,invoke})=>{
  state.version='9.9.9-canary.1';
  const response=await args();
  state.missingInterface='openChatSession';const reads=state.reads;
  await assert.rejects(read(),/Missing desktop interface: openChatSession/);assert.equal(state.reads,reads);
  state.missingInterface='respondChatInteraction';
  await assert.rejects(invoke('respond_permission',response),/Missing desktop interface: respondChatInteraction/);
  assert.equal(state.responses.length,0);
  state.missingInterface=null;
  assert.equal((await invoke('respond_permission',response)).delivery,'not-resent');
  assert.equal(state.responses.length,0);
}));

test('interaction reads are scoped and bounded; response arguments reject overrides and invalid decisions',()=>fixture(async({state,read,args,invoke})=>{
  const operations=await describe();assert.equal(operations.find(x=>x.name==='read_interactions').annotations.readOnlyHint,true);
  assert.equal(operations.find(x=>x.name==='respond_permission').annotations.readOnlyHint,false);
  delete process.env.QODER_CONTROL_ROOT;await assert.rejects(read(),/Operator-owned/);assert.equal(state.fetches,0);
  process.env.QODER_CONTROL_ROOT=state.summary.cwd;
  state.summary.workspaceId='wrong';await assert.rejects(read(),/rejected/);assert.equal(state.reads,0);state.summary.workspaceId=workspaceId;
  state.detailSummary={...state.summary,cwd:'E:/changed'};await assert.rejects(read(),/rejected/);delete state.detailSummary;
  state.productId='qoder-ide';await assert.rejects(read(),/rejected/);state.productId='qoder-cn';
  const result=(await read()).value;assert.equal(result.runtimeState,'waiting-user');assert.equal(result.activeTurnId,turnId);assert.equal(result.messages,undefined);
  const response=await args(),fetches=state.fetches;
  for(const change of [{decision:'ALLOW'},{decision:'session'},{updatedInput:{}},{grantType:'once'},{permissionSuggestionId:'session-0'},{expectedSnapshot:'x'.repeat(65537)},{toolUseId:'bad\0id'},{constructor:'extra'}])await assert.rejects(invoke('respond_permission',{...response,...change}));
  assert.equal(state.fetches,fetches);assert.equal(state.responses.length,0);
  state.pending[0].input={text:'x'.repeat(65536)};await assert.rejects(read(),/rejected/);
}));

test('response requires exact reviewed type, ID, tool, full input, timestamp, turn and scope; no special grants',()=>fixture(async({state,pending,args,direct})=>{
  const response=await args(),original=structuredClone(state.pending[0]);
  for(const change of [{type:'userQuestion'},{toolUseId:'call_other'},{toolName:'Write'},{input:{file_path:'E:/other'}},{input:{...original.input,extra:true}},{requestedAt:'later'}]){
    state.pending=[{...original,...change}];await assert.rejects(direct(response),/rejected/);
  }
  state.pending=[];await assert.rejects(direct(response),/rejected/);state.pending=[original];
  state.activeTurn={turnId:'changed'};await assert.rejects(direct(response),/rejected/);
  state.activeTurn=null;await assert.rejects(direct(response),/rejected/);state.activeTurn={turnId};
  state.summary.cwd='E:/changed';await assert.rejects(direct(response),/rejected/);
  state.summary.cwd=process.env.QODER_CONTROL_ROOT;
  for(const tool of ['AskUserQuestion','RequestPermission','RequestDirectory','RequestAccessToken','EnterPlanMode','ExitPlanMode','unrecognized']){
    state.pending=[pending('call_special',tool)];await assert.rejects(direct(await args()),/rejected/);
  }
  state.pending=[original];await assert.rejects(direct({...response,decision:'permanent'}),/rejected/);
  assert.equal(state.responses.length,0);
  await direct(response);
  assert.deepEqual(state.responses[0],{type:'permission',sessionId,toolUseId:'call_read',decision:'allow'});
}));

test('only the three reviewed bridge MCP tools accept exact mcp_call inputs and snapshots',()=>fixture(async({state,pending,args,direct,invoke})=>{
  const prefix='mcp__plugin_qoder-codex-bridge_qoder-codex-bridge__';
  for(const [index,tool] of ['list_codex_tasks','select_codex_task','send_codex_message'].entries()){
    state.pending=[pending(`call_mcp_${index}`,'mcp_call',{arguments:{},toolName:prefix+tool})];
    const response=await args();
    assert.equal((await invoke('respond_permission',{...response,decision:index===2?'deny':'allow'})).value.acknowledged,true);
  }
  assert.deepEqual(state.responses.map(x=>[x.toolUseId,x.decision]),
    [['call_mcp_0','allow'],['call_mcp_1','allow'],['call_mcp_2','deny']]);

  state.pending=[pending('call_other_mcp','mcp_call',{arguments:{},toolName:'mcp__other__list_codex_tasks'})];
  await assert.rejects(direct(await args()),/rejected/);
  for(const input of [{arguments:[],toolName:prefix+'list_codex_tasks'},
    {arguments:{},toolName:prefix+'list_codex_tasks',extra:true}]){
    state.pending=[pending('call_bad_mcp','mcp_call',input)];
    await assert.rejects(direct(await args()),/rejected/);
  }
  state.pending=[pending('call_changed_mcp','mcp_call',{arguments:{task:'reviewed'},toolName:prefix+'send_codex_message'})];
  const reviewed=await args();state.pending[0].input.arguments.task='changed';
  await assert.rejects(direct(reviewed),/rejected/);
  assert.equal(state.responses.length,3);
}));

test('ordinary tool responses allow only explicit one-shot decisions, concurrency reserves once, lost ACK never replays',()=>fixture(async({state,directory,pending,args,invoke})=>{
  state.pending=[pending('call_bash','Bash',{command:'node --test',description:'reviewed local test'})];
  const response=await args();
  const results=await Promise.all([invoke('respond_permission',response),invoke('respond_permission',response)]);
  assert.equal(results.filter(r=>r.value?.acknowledged).length,1);assert.equal(results.filter(r=>r.delivery==='not-resent').length,1);
  assert.equal(state.responses.length,1);
  assert.equal((await invoke('respond_permission',{...response,decision:'deny'})).delivery,'not-resent');
  state.pending=[pending('call_powershell','PowerShell',{command:'node --test'})];
  assert.equal((await invoke('respond_permission',{...await args(),decision:'deny'})).value.acknowledged,true);
  assert.deepEqual(state.responses[1],{type:'permission',sessionId,toolUseId:'call_powershell',decision:'deny'});
  state.pending=[pending('call_timeout','Edit',{file_path:state.summary.cwd+'/test.mjs',old_string:'a',new_string:'b'})];
  const uncertain=await args();state.loseReply=true;
  const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...rest)=>timer(fn,ms===20000?10:ms,...rest);
  await assert.rejects(invoke('respond_permission',uncertain),/outcome unknown/);
  assert.equal(state.responses.length,3);assert.equal((await invoke('respond_permission',uncertain)).delivery,'not-resent');assert.equal(state.responses.length,3);
  const markers=(await readdir(directory)).filter(x=>x.startsWith('permission-'));
  assert.equal(markers.length,3);
  for(const file of markers){const receipt=JSON.parse(await readFile(directory+'/'+file,'utf8'));assert.equal(receipt.state,'reserved-outcome-unknown');assert.equal(receipt.sessionId,sessionId);assert.ok(receipt.expectedSnapshot);}
}));

test('permission reservation budgets its exact persisted bytes and deduplicates without a live budget',t=>fixture(async({state,directory,pending,args,invoke})=>{
  state.pending=[pending('call_large','Read',{file_path:'E:/reviewed.txt',note:''})];
  const base=await args();state.pending[0].input.note='x'.repeat(65_536-base.expectedSnapshot.length);
  const response=await args();assert.equal(response.expectedSnapshot.length,65_536);state.budgetTrace.length=0;
  assert.equal((await invoke('respond_permission',response)).value.acknowledged,true);
  const marker=(await readdir(directory)).find(name=>name.startsWith('permission-'));
  const bytes=statSync(directory+'/'+marker).size;
  const reservationCheck=state.budgetTrace.reduce((left,right)=>left.additionalBytes>right.additionalBytes?left:right);
  const persistedCheck=state.budgetTrace.at(-1);
  assert.equal(reservationCheck.projectedBytes,persistedCheck.projectedBytes);
  assert.equal(reservationCheck.additionalBytes-persistedCheck.additionalBytes,bytes,
    'the exact UTF-8 reservation moves from prewrite additional bytes to persisted managed bytes');
  assert.equal(persistedCheck.usedBytes-reservationCheck.usedBytes,bytes);
  assert.equal(Buffer.byteLength(await readFile(directory+'/'+marker,'utf8')),bytes);
  t.diagnostic(JSON.stringify({expectedSnapshotChars:response.expectedSnapshot.length,reservationBytes:bytes,
    peakAdditionalBytes:reservationCheck.additionalBytes}));
  state.budgetMode='missing';const fetches=state.fetches,responses=state.responses.length;
  assert.equal((await invoke('respond_permission',{...response,decision:'deny'})).delivery,'not-resent');
  assert.equal(state.fetches,fetches);assert.equal(state.responses.length,responses);
}));

test('missing, unallocated and tight budgets create no permission reservation or native call; permission, send and worker share one owner boundary',()=>fixture(async({state,directory,pending,args,invoke,config,services})=>{
  for(const [mode,quota] of [['missing',10_000_000],['unallocated',10_000_000],['allocated',9000]]){
    state.pending=[pending(`call_${mode}`,'PowerShell',{command:'node --test'})];
    const response=await args(),fetches=state.fetches;
    state.budgetMode=mode;state.quota=quota;
    await assert.rejects(invoke('respond_permission',response),error=>error.code==='QODER_BUDGET_BLOCKED');
    assert.equal(state.fetches,fetches);assert.equal(state.responses.length,0);
    assert.equal((await readdir(directory)).some(name=>name.startsWith('permission-')),false);
  }

  state.budgetMode='allocated';state.quota=10_000_000;
  state.pending=[pending('call_reserved','Bash',{command:'node --test'})];
  assert.equal((await invoke('respond_permission',await args())).value.acknowledged,true);
  const physical=(await readdir(directory)).reduce((sum,name)=>sum+statSync(directory+'/'+name).size,0);
  state.quota=physical;state.pending=[pending('call_blocked','Edit',{file_path:directory+'/x',old_string:'a',new_string:'b'})];
  const blocked=await args(),fetches=state.fetches,files=(await readdir(directory)).sort();
  const attempts=await Promise.allSettled([
    invoke('respond_permission',blocked),
    desktop('send',{sessionId,requestId:'44444444-4444-4444-8444-444444444444',prompt:'blocked',workspaceId,cwd:directory},config,{...services,providerWorker:true}),
    Promise.resolve().then(()=>claimWorker(config,services,'worker-token'))
  ]);
  assert.ok(attempts.every(result=>result.status==='rejected'&&result.reason.code==='QODER_BUDGET_BLOCKED'));
  assert.equal(state.fetches,fetches);assert.deepEqual((await readdir(directory)).sort(),files);
  assert.equal((await readdir(directory)).filter(name=>name.startsWith('permission-')).length,1);
  assert.ok(state.budgetTrace.slice(-8).every(row=>row.ownerId===queueOwnerId(config)));
  assert.ok((await readdir(directory)).reduce((sum,name)=>sum+statSync(directory+'/'+name).size,0)<=physical);
  assert.equal(existsSync(directory+'/44444444-4444-4444-8444-444444444444.json'),false);
}));
