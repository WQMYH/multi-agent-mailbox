import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktop as invokeDesktop, queueOwnerId } from './desktop.mjs';

test('fixed desktop reads enforce local endpoint and product before business calls', async () => {
  const saved = { fetch, WebSocket };
  const desktop=(operation,args)=>invokeDesktop(operation,args,{cdpPort:19327});
  const directory=await mkdtemp(join(tmpdir(),'qoder-desktop-test-'));
  let sendCase=0;
  const send=(args,operation='send')=>{const config={cdpPort:19327,workspaceId:'workspace',root:'E:/owned',
    deliveryDir:join(directory,String(++sendCase))};const ownerId=queueOwnerId(config);
    return invokeDesktop(operation,args,config,{messageBudget:{status:()=>({}),check:({usedBytes,additionalBytes=0})=>
      ({ok:true,ownerId,allocatedBytes:20_000_000,usedBytes,additionalBytes,projectedBytes:usedBytes+additionalBytes,remainingBytes:20_000_000-usedBytes-additionalBytes,deltaBytes:0})}});};
  const target = {type:'page',url:'qoder-cn-app://renderer/index.html',webSocketDebuggerUrl:'ws://127.0.0.1:19327/devtools/page/probe'};
  let productId='qoder-cn', version='0.3.4', listCalls=0, closes=0, task=null, enabled=true, sent=[], interrupted=[];
  const missing=new Set();let updateFailure=false;
  try {
    await assert.rejects(invokeDesktop('identity'), /Explicit local/);
    globalThis.fetch=async()=>({ok:true,json:async()=>[target]});
    globalThis.WebSocket=class extends EventTarget {
      constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
      close(){closes++;}
      async send(raw){
        const request=JSON.parse(raw);assert.equal(request.method,'Runtime.evaluate');
        let result;
        try {
          const native={
            getStartupState:async()=>({productId,status:'ready'}),
            getProductUpdateState:async()=>{if(updateFailure)throw Error('diagnostics unavailable');return {currentVersion:version};},
            listChatSessions:async(limit,offset,archived)=>{listCalls++;assert.ok([20,100].includes(limit));assert.equal(offset,0);assert.equal(typeof archived,'boolean');return task?[task]:[];},
            listLocalWorkspaces:async()=>[{workspaceId:'workspace',rootPaths:['E:/owned']}],
            listChatComposerModels:async()=>[{key:'qfmodel',enabled}],
            sendChatMessage:async(args)=>{sent.push(JSON.parse(JSON.stringify(args)));if(args.model===null||args.permissionMode===null)throw Error('Invalid native optional field');},
            interruptChatSession:async(id)=>interrupted.push(id)
          };
          for(const name of missing)delete native[name];
          const value=await vm.runInNewContext(request.params.expression,{window:{qoderDesktop:native}});
          result={result:{value}};
        } catch(error) { result={exceptionDetails:{text:error.message}}; }
        this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:1,result})}));
      }
    };
    assert.equal((await desktop('identity')).value.startupStatus,'ready');
    assert.deepEqual((await desktop('list',{limit:20,offset:0})).value,[]);
    assert.equal(listCalls,1);assert.equal(closes,2);
    version='0.4.2';assert.equal((await desktop('identity')).identity.version,'0.4.2');
    assert.deepEqual((await desktop('list',{limit:20,offset:0})).value,[]);
    assert.equal(listCalls,2);
    for(version of ['0.4.3','9.9.9-canary.1',undefined]){
      assert.equal((await desktop('identity')).identity.version,version??null);
      assert.deepEqual((await desktop('list',{limit:20,offset:0})).value,[]);
    }
    missing.add('getProductUpdateState');assert.equal((await desktop('identity')).identity.version,null);missing.clear();
    updateFailure=true;assert.equal((await desktop('identity')).identity.version,null);updateFailure=false;
    const beforeWrongProduct=listCalls;
    version='0.4.2';productId='qoder-cn-ide';await assert.rejects(desktop('list',{limit:20,offset:0}),/Unverified product/);assert.equal(listCalls,beforeWrongProduct);
    target.webSocketDebuggerUrl='ws://example.com:19327/devtools/page/probe';
    await assert.rejects(desktop('identity'),/Unexpected local/);
    await assert.rejects(desktop('eval',{script:'bad'}),/Unsupported/);
    productId='qoder-cn';target.webSocketDebuggerUrl='ws://127.0.0.1:19327/devtools/page/probe';
    task={sessionId:'owned',workspaceId:'workspace',cwd:'E:\\owned',runtimeProfileId:'runtime:qoder',executionKind:'local',runtimeState:'cold',model:'qfmodel',permissionMode:'acceptEdits',productMode:'coding'};
    const args={sessionId:'owned',workspaceId:'workspace',cwd:'E:/owned',requestId:'request',prompt:'test'};
    for(const change of [{workspaceId:'wrong'},{cwd:'E:/elsewhere'}])await assert.rejects(send({...args,...change}),/Operator scope changed/);
    await assert.rejects(send({...args,sessionId:'missing'}),/rejected/);
    enabled=false;await assert.rejects(send(args),/rejected/);enabled=true;
    task.runtimeState='running';await assert.rejects(send(args),/rejected/);task.runtimeState='cold';
    assert.equal(sent.length,0);
    assert.equal((await send(args)).value.accepted,true);
    assert.equal(sent.length,1);assert.equal(sent[0].agentId,'agent:default');assert.equal(sent[0].inputId,'request');assert.equal(sent[0].model,'qfmodel');assert.equal(sent[0].permissionMode,'acceptEdits');
    task.model=null;task.permissionMode=null;enabled=false;
    missing.add('listChatComposerModels');
    assert.equal((await send({...args,requestId:'default-request'})).value.accepted,true);
    assert.equal(sent[1].inputId,'default-request');assert.equal(Object.hasOwn(sent[1],'model'),false);assert.equal(Object.hasOwn(sent[1],'permissionMode'),false);
    for(version of ['0.3.4','0.4.3','9.9.9-canary.1']){
      assert.equal((await send({...args,requestId:`default-${version}`})).value.accepted,true);
      assert.equal(Object.hasOwn(sent.at(-1),'model'),false);assert.equal(Object.hasOwn(sent.at(-1),'permissionMode'),false);
    }
    task.model='qfmodel';enabled=true;
    await assert.rejects(send({...args,requestId:'missing-model-interface'}),/Missing desktop interface: listChatComposerModels/);
    missing.clear();version='0.3.4';
    assert.equal((await send({...args,requestId:'legacy-permission-null'})).value.accepted,true);
    assert.equal(sent.at(-1).model,'qfmodel');assert.equal(Object.hasOwn(sent.at(-1),'permissionMode'),false);
    version='0.4.2';delete task.model;task.permissionMode='acceptEdits';
    const beforeMissingModel=sent.length;
    await assert.rejects(send({...args,requestId:'missing-model'}),/rejected/);assert.equal(sent.length,beforeMissingModel);
    await assert.rejects(desktop('interrupt',{...args,workspaceId:'wrong'}),/rejected/);
    await desktop('interrupt',args);assert.deepEqual(interrupted,['owned']);
    version='9.9.9-canary.1';task=null;
    assert.equal((await send({...args,sessionId:'fresh',requestId:'new-future-session'},'send_new_session')).value.accepted,true);
    assert.equal(sent.at(-1).sessionId,'fresh');assert.equal(Object.hasOwn(sent.at(-1),'model'),false);
    assert.equal(Object.hasOwn(sent.at(-1),'permissionMode'),false);
  } finally {
    globalThis.fetch=saved.fetch;globalThis.WebSocket=saved.WebSocket;
    await rm(directory,{recursive:true,force:true});
  }
});

test('each fixed operation rejects a missing required interface before business calls; failed send IDs never replay', async () => {
  const saved={fetch,WebSocket},directory=await mkdtemp(join(tmpdir(),'qoder-capability-test-'));
  const methods=['listChatSessions','listChatComposerModels','searchChatSession','loadChatHistoryAround',
    'openChatSession','respondChatInteraction','sendChatMessage','listLocalWorkspaces','interruptChatSession'];
  let native,businessCalls=0;
  const cases=[['identity','getStartupState'],['inspect','getStartupState'],['list','listChatSessions'],
    ['models','listChatComposerModels'],['search','searchChatSession'],
    ...['listChatSessions','loadChatHistoryAround'].map(name=>['verify_turn',name]),
    ...['read_interactions','respond_permission'].flatMap(op=>['listChatSessions','openChatSession'].map(name=>[op,name])),
    ['respond_permission','respondChatInteraction'],['send','listChatSessions'],['send','sendChatMessage'],
    ...['listLocalWorkspaces','listChatSessions','sendChatMessage'].map(name=>['send_new_session',name]),
    ['interrupt','listChatSessions'],['interrupt','interruptChatSession']];
  try{
    globalThis.fetch=async()=>({ok:true,json:async()=>[{type:'page',url:'qoder-cn-app://renderer/index.html',
      webSocketDebuggerUrl:'ws://127.0.0.1:19327/devtools/page/capabilities'}]});
    globalThis.WebSocket=class extends EventTarget{
      constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
      close(){}
      async send(raw){let result;
        try{result={result:{value:await vm.runInNewContext(JSON.parse(raw).params.expression,{window:{qoderDesktop:native}})}};}
        catch(error){result={exceptionDetails:{text:error.message}};}
        this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:1,result})}));
      }
    };
    for(const [index,[operation,missing]] of cases.entries()){
      native=Object.fromEntries(methods.map(name=>[name,()=>{businessCalls++;throw Error('Unexpected business call');}]));
      native.getStartupState=async()=>({productId:'qoder-cn',status:'ready'});
      native.getProductUpdateState=async()=>({currentVersion:'9.9.9'});
      native[missing]=null;
      const config={cdpPort:19327,workspaceId:'workspace',root:'E:/owned',deliveryDir:join(directory,String(index))};
      const context={providerWorker:true,messageBudget:{status:()=>({}),check:()=>({ok:true})}};
      const args={sessionId:'owned',workspaceId:'workspace',cwd:'E:/owned',requestId:'preflight',prompt:'offline'};
      await assert.rejects(invokeDesktop(operation,args,config,context),
        error=>error.message===`Desktop rejected operation: Missing desktop interface: ${missing}`);
      assert.equal(businessCalls,0);
      if(['send','send_new_session'].includes(operation)){
        assert.equal((await invokeDesktop('queue_status',args,config,context)).items[0].state,'needs_attention');
        assert.equal((await invokeDesktop(operation,args,config,context)).delivery,'not-resent');
      }
    }
  }finally{Object.assign(globalThis,saved);await rm(directory,{recursive:true,force:true});}
});
