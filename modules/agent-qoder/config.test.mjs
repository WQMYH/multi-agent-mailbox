import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOperatorConfig } from './config.mjs';

test('operator JSON validates strictly, overlays environment, and rereads without mutating inputs', () => {
  const root=mkdtempSync(join(tmpdir(),'qoder-config-test-')), file=join(root,'config.json');
  const good={cdpPort:19327,workspaceId:'11111111-1111-1111-1111-111111111111',root,deliveryDir:join(root,'delivery')};
  try {
    assert.deepEqual(readOperatorConfig({},file),{});assert.equal(existsSync(file),false);
    writeFileSync(file,JSON.stringify(good));assert.deepEqual(readOperatorConfig({},file),good);
    const bridged={...good,returnModulePath:join(root,'native-turn-return.mjs'),returnDataDir:join(root,'return')};
    writeFileSync(file,JSON.stringify(bridged));assert.deepEqual(readOperatorConfig({},file),bridged);
    writeFileSync(file,JSON.stringify(good));
    const env={QODER_DESKTOP_CDP_PORT:'19328',QODER_CONTROL_WORKSPACE_ID:'22222222-2222-2222-2222-222222222222',QODER_CONTROL_ROOT:join(root,'other'),QODER_DELIVERY_DIR:join(root,'other-delivery')}, before={...env};
    const first=readOperatorConfig(env,file);assert.deepEqual(first,{cdpPort:19328,workspaceId:env.QODER_CONTROL_WORKSPACE_ID,root:env.QODER_CONTROL_ROOT,deliveryDir:env.QODER_DELIVERY_DIR});assert.deepEqual(env,before);
    writeFileSync(file,JSON.stringify({...good,cdpPort:19329}));assert.equal(readOperatorConfig({},file).cdpPort,19329);assert.equal(first.cdpPort,19328);
    for(const bad of [null,[],{extra:true},{cdpPort:0},{cdpPort:65536},{cdpPort:'19327'},{cdpPort:1.5},{workspaceId:'bad'},{root:'relative'},{deliveryDir:'C:relative'},{root:'bad\0path'},
      {...good,returnModulePath:join(root,'native-turn-return.mjs')},{...good,returnDataDir:join(root,'return')},
      {...good,returnModulePath:'relative',returnDataDir:join(root,'return')}]) {
      writeFileSync(file,JSON.stringify(bad));assert.throws(()=>readOperatorConfig({},file));
      assert.throws(()=>readOperatorConfig(env,file)); // Overrides never conceal an invalid file.
    }
    writeFileSync(file,'{');assert.throws(()=>readOperatorConfig({},file),/Cannot read/);
    assert.throws(()=>readOperatorConfig({},root),/Cannot read/);
    writeFileSync(file,'{}');
    for(const value of ['', '0', '65536', '19327x', ' 19327'])assert.throws(()=>readOperatorConfig({QODER_DESKTOP_CDP_PORT:value},file),/cdpPort/);
    assert.throws(()=>readOperatorConfig({QODER_CONTROL_ROOT:'relative'},file),/absolute/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('default-path file routes real adapter without QODER env, hot reads stay isolated in concurrent calls', () => {
  const home=mkdtempSync(join(tmpdir(),'qoder-config-host-test-'));
  const env={...process.env,USERPROFILE:home,HOME:home};
  for(const key of Object.keys(env))if(key.startsWith('QODER_'))delete env[key];
  mkdirSync(join(home,'.codex-agent-core'));
  const file=join(home,'.codex-agent-core','agent-qoder.json');
  const adapter=new URL('./adapter.mjs',import.meta.url).href;
  try {
    writeFileSync(file,'{'); // Import/describe must not read even an invalid file.
    const script=`
      import assert from 'node:assert/strict'; import vm from 'node:vm';
      import {writeFileSync} from 'node:fs'; import {homedir} from 'node:os';
      import {call,describe} from ${JSON.stringify(adapter)};
      assert.equal(homedir(),${JSON.stringify(home)});assert.equal((await describe()).length,12);
      const before={...process.env}, ports=[];
      globalThis.fetch=async(url)=>{const port=new URL(url).port;ports.push(port);await new Promise(r=>setTimeout(r,5));return {ok:true,json:async()=>[{type:'page',url:'qoder-cn-app://renderer/index.html',webSocketDebuggerUrl:'ws://127.0.0.1:'+port+'/devtools/page/mock'}]};};
      globalThis.WebSocket=class extends EventTarget {
        constructor(url){super();this.port=new URL(url).port;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
        close(){}
        async send(raw){const request=JSON.parse(raw);assert.equal(request.method,'Runtime.evaluate');
          const value=await vm.runInNewContext(request.params.expression,{window:{qoderDesktop:{getStartupState:async()=>({productId:'qoder-cn',status:this.port}),getProductUpdateState:async()=>({currentVersion:'0.3.4'})}}});
          this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:1,result:{result:{value}}})}));
        }
      };
      await assert.rejects(call('identity'),/Cannot read/);assert.equal(ports.length,0);
      writeFileSync(${JSON.stringify(file)},JSON.stringify({cdpPort:19327}));const first=call('identity');
      writeFileSync(${JSON.stringify(file)},JSON.stringify({cdpPort:19328}));const second=call('identity');
      const results=await Promise.all([first,second]);assert.deepEqual(results.map(r=>r.value.startupStatus),['19327','19328']);
      assert.deepEqual(ports,['19327','19328']);assert.deepEqual({...process.env},before);
      process.env.QODER_DESKTOP_CDP_PORT='19329';assert.equal((await call('identity')).value.startupStatus,'19329');
      delete process.env.QODER_DESKTOP_CDP_PORT;assert.equal((await call('identity')).value.startupStatus,'19328');
      console.log('file-only fixed-business dispatch, environment override and concurrent hot reads passed');
    `;
    const output=execFileSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',windowsHide:true,timeout:15000});
    assert.match(output,/passed/);
  } finally { rmSync(home,{recursive:true,force:true}); }
});
