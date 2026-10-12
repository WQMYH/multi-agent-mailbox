import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { desktop, desktopCapabilities, queueOwnerId, reservePermission } from './desktop.mjs';
import { nativeAvailable } from './native.mjs';
import { readOperatorConfig } from './config.mjs';
import { launchQoder } from './launch.mjs';
import { startProviderWorker } from './worker.mjs';
import { messageObserveInputSchema, validateMessageObserveArgs } from './runtime/core-contracts.mjs';
import { observeReturns } from './return-observe.mjs';

const target={id:'qoder-cn-desktop',kind:'desktop',label:'Qoder CN standalone'};
const uuid={type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'};
const messageId={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'};
const definitions=[
  ['message_observe','Read retained operator-owned outbound messages, exact details or scoped statistics without contacting the desktop, dispatching or recovering sends.',true,messageObserveInputSchema.properties,['view']],
  ['message_observe_return','Read retained Qoder return receipts and custom-message reservations in the configured return owner; no host contact or resend.',true,messageObserveInputSchema.properties,['view']],
  ['launch','Explicitly start the verified Qoder CN standalone build, or report an existing instance without stopping, duplicating or reusing it.',false,{executable:{type:'string',minLength:1,maxLength:1024},debugPort:{type:'integer',minimum:1024,maximum:65535}},['executable']],
  ['identity','Read configured CN SDK/runtime identity (SDK import only, not CLI startup/query health), or live explicitly enabled desktop identity; versions are diagnostic.',true,{},[]],
  ['list_tasks','Read an operator-root-scoped page of native sessions; runtime state can be unknown. Explicit desktop transport lists non-archived tasks.',true,{limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:10000}},[]],
  ['models','Read live platform model availability; no model changes.',true,{},[]],
  ['search_task','Read bounded operator-root native message search hits with actual message IDs; no inferred turn IDs.',true,{sessionId:uuid,query:{type:'string',minLength:1,maxLength:512},limit:{type:'integer',minimum:1,maximum:100}},['sessionId','query']],
  ['queue_status','Read local outbound queue state for an operator-scoped task; no prompt body.',true,{sessionId:uuid},['sessionId']],
  ['recover_queue','Start the provider-owned recovery worker for persisted Qoder sends. Does not create or resend a message.',false,{},[]],
  ['read_interactions','Read pending interactions in operator scope, including the exact snapshot required for a separately authorized response.',true,{sessionId:uuid},['sessionId']],
  ['respond_permission','Respond once to a reviewed ordinary tool permission. Caller must authorize the full input effects; cwd is not a command sandbox. No credentials, grants, input updates or automatic approval. ACK is not completion.',false,{sessionId:uuid,toolUseId:{type:'string',maxLength:256,pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'},decision:{type:'string',enum:['allow','deny']},expectedSnapshot:{type:'string',minLength:1,maxLength:65536}},['sessionId','toolUseId','decision','expectedSnapshot']],
  ['send','Send once to a Core-created native session at a verified idle boundary; external desktop native injection is unsupported. No model/permission override or implicit approval. Reusing requestId never resends.',false,{sessionId:uuid,requestId:uuid,correlation:messageId,prompt:{type:'string',minLength:1,maxLength:8000}},['sessionId','requestId','prompt']],
  ['send_new_session','Send the first message to create an operator-scoped task. Caller supplies fresh sessionId and requestId; neither is replayed after uncertainty.',false,{sessionId:uuid,requestId:uuid,correlation:messageId,prompt:{type:'string',minLength:1,maxLength:8000}},['sessionId','requestId','prompt']],
  ['interrupt','Request interruption only within operator-scoped workspace. Does not prove the task stopped.',false,{sessionId:uuid},['sessionId']]
].map(([name,description,readOnlyHint,properties,required])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint,...(name==='message_observe_return'?{messageObservationHint:true}:{})}}));

export async function describe(services={}){
  let config;
  try { config=readOperatorConfig(); }
  catch { return structuredClone(definitions.filter(d=>['message_observe','queue_status','recover_queue','launch'].includes(d.name))); }
  const available=new Set(['message_observe','queue_status','recover_queue','launch']);
  if(config.returnModulePath&&config.returnDataDir)available.add('message_observe_return');
  if(nativeAvailable(config,services))for(const name of ['identity','list_tasks','search_task','send','send_new_session'])available.add(name);
  const cdp=await (services.desktopCapabilities??desktopCapabilities)(config,services);
  for(const name of cdp){
    const operation=name==='list'?'list_tasks':name==='search'?'search_task':name;
    if(!config.cliExecutable||!['identity','list_tasks','search_task','send','send_new_session'].includes(operation))available.add(operation);
  }
  return structuredClone(definitions.filter(d=>available.has(d.name)));
}

export async function call(operation,args={},services={}){
  const definition=definitions.find(d=>d.name===operation);
  if(!definition)throw Error('Unknown Qoder operation');
  if(!args||Array.isArray(args)||![Object.prototype,null].includes(Object.getPrototypeOf(args)))throw Error('Arguments must be an object');
  const {properties,required}=definition.inputSchema;
  for(const key of Object.keys(args)){
    const rule=properties[key],value=args[key];
    if(!Object.hasOwn(properties,key))throw Error(`Unknown argument: ${key}`);
    if(rule.type==='string'&&(typeof value!=='string'||!value.trim()||value.length<(rule.minLength||1)||value.length>(rule.maxLength||100)||rule.pattern&&!new RegExp(rule.pattern).test(value)))throw Error(`Invalid ${key}`);
    if(rule.type==='integer'&&(!Number.isInteger(value)||value<rule.minimum||value>rule.maximum))throw Error(`Invalid ${key}`);
    if(rule.enum&&!rule.enum.includes(value))throw Error(`Invalid ${key}`);
  }
  for(const key of required)if(!Object.hasOwn(args,key))throw Error(`Missing ${key}`);
  const config=readOperatorConfig();
  if(operation==='message_observe_return')return observeReturns(config,validateMessageObserveArgs(args));
  if(operation==='message_observe'){
    if(!config.workspaceId||!new RegExp(uuid.pattern).test(config.workspaceId)||!config.root||!isAbsolute(config.root))throw Error('Operator-owned workspace ID and absolute root are required');
    return desktop(operation,validateMessageObserveArgs(args),config,services);
  }
  if(operation==='launch'){
    const debugPort=args.debugPort??config.cdpPort;
    services.assertCurrent?.();
    return {target:{...target},experimental:true,...await (services.launchQoder??launchQoder)(args.executable,{debugPort})};
  }
  if(operation==='recover_queue'){
    if(!config.workspaceId||!new RegExp(uuid.pattern).test(config.workspaceId)||!config.root||!isAbsolute(config.root)||!config.deliveryDir||!isAbsolute(config.deliveryDir))throw Error('Operator-owned workspace, root and deliveryDir are required');
    return {target:{...target},experimental:true,ownerId:queueOwnerId(config),worker:(services.startProviderWorker??startProviderWorker)(config,services)};
  }
  let native=operation,params={...args};
  if(operation==='list_tasks'){native='list';params={limit:args.limit??20,offset:args.offset??0};}
  if(operation==='models')params={fetchStrategy:'live',workspaceDirectories:[]};
  if(operation==='search_task'){native='search';params.limit??=20;}
  if(config.cliExecutable&&['list_tasks','search_task'].includes(operation)&&(!config.root||!isAbsolute(config.root)))throw Error('Operator-owned native Qoder root required');
  if(!definition.annotations.readOnlyHint||operation==='read_interactions'||operation==='queue_status'){
    const workspaceId=config.workspaceId,cwd=config.root;
    if(!workspaceId||!new RegExp(uuid.pattern).test(workspaceId)||!cwd||!isAbsolute(cwd))throw Error('Operator-owned workspace ID and absolute root are required');
    params={...params,workspaceId,cwd};
    if(operation==='send'||operation==='send_new_session'||operation==='queue_status'){
      if(!config.deliveryDir||!isAbsolute(config.deliveryDir))throw Error('Absolute QODER_DELIVERY_DIR required for queue state');
    }
    if(operation==='respond_permission'){
      const directory=config.deliveryDir;
      if(!directory||!isAbsolute(directory))throw Error('Absolute deliveryDir required for uncertain-response protection');
      // A fixed-size, filesystem-safe key for native IDs; not an authorization token.
      const key=createHash('sha256').update(JSON.stringify([args.sessionId.toLowerCase(),args.toolUseId])).digest('hex');
      const reservation=JSON.stringify({...args,workspaceId,cwd,createdAt:new Date().toISOString(),state:'reserved-outcome-unknown'});
      if(!reservePermission(config,services,key,reservation))return {target:{...target},sessionId:args.sessionId,toolUseId:args.toolUseId,delivery:'not-resent',completion:'unknown',reason:'Permission response already reserved; read native evidence, never replay automatically'};
    }
  }
  const result=await desktop(native,params,config,services);
  if(operation!=='send'&&operation!=='send_new_session')return {target:{...target},experimental:true,...result};
  const messageReceipt={schemaVersion:1,requestId:result.requestId,deliveryId:result.deliveryId,
    ownerId:result.ownerId,target:{moduleId:'agent-qoder',address:args.sessionId},correlation:result.correlation,
    acceptance:{owner:{state:'accepted',evidence:`send-queue.sqlite:${result.deliveryId}`},
      provider:result.nativeAck?{state:'accepted',evidence:`qoder-send-ack:${result.requestId}`}:{state:'unknown'}}};
  services.validateMessageReceipt?.(messageReceipt);
  return {target:{...target},experimental:true,...result,messageReceipt};
}
