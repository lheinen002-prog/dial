(function(){
"use strict";

const V2_SCHEMA = 2;
const MAX_RECOVERY_DEBT = 60;
const SNAPSHOT_KEY = "dial-auto-snapshots-v2";
const SYNC_BASE_KEY = "dial-sync-base-v2";
const DEVICE_KEY = "dial-device-id-v2";
const CALENDAR_KEY = "dial-calendar-url-v2";
const IDB_NAME = "dial-v2";
const CFA_TOPICS = [
  "Ethical and Professional Standards","Quantitative Methods","Economics",
  "Financial Statement Analysis","Corporate Issuers","Equity Investments",
  "Fixed Income","Derivatives","Alternative Investments","Portfolio Management"
];
const BLOCKERS = [
  ["too-big","Too big"],["unclear","Unclear"],["interrupted","Interrupted"],
  ["low-energy","Low energy"],["missing-info","Missing info"]
];
const storageHealth = {ok:true, message:"Saved locally", lastSnapshot:0};
let v2NativeToken = "";
let focusTick = null;
let idbTimer = null;
let lastSnapshotState = null;

function clone(v){ return v==null ? v : JSON.parse(JSON.stringify(v)); }
function nowIso(){ return new Date().toISOString(); }
function newId(prefix){
  const id = (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36)+"-"+Math.random().toString(36).slice(2);
  return prefix+"-"+id;
}
function addDaysKey(key, n){ const d=parseKey(key); d.setDate(d.getDate()+n); return dkey(d); }
function keyOrdinal(key){
  const d=parseKey(key); return Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86400000;
}
function daysBetween(a,b){ return Math.max(0,Math.round(keyOrdinal(b)-keyOrdinal(a))); }
function safeDateKey(v, fallback){
  if (typeof v!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return fallback;
  const d=parseKey(v);
  return Number.isFinite(d.getTime()) && dkey(d)===v ? v : fallback;
}
function clampNum(v,lo,hi,fallback){
  const n=Number(v); return Number.isFinite(n) ? Math.max(lo,Math.min(hi,n)) : fallback;
}
function sameId(a,b){ return String(a)===String(b); }
function hasLegacyActivity(raw){
  return !!((raw.updatedAt||0) || Object.keys(raw.log||{}).length || (raw.todos||[]).length ||
    (raw.sched||[]).length || Object.keys(raw.studyAdd||{}).length);
}
function normalizeTodo(t){
  t=t&&typeof t==="object"?t:{};
  const created=safeDateKey(t.createdOn,tkey());
  const status=t.status || (t.done?"done":"active");
  return Object.assign({},t,{
    id:t.id!=null?t.id:newId("todo"),
    label:String(t.label||"Untitled task").slice(0,500),
    xp:clampNum(t.xp,0,30,5),
    done:!!t.done,
    doneOn:t.doneOn||null,
    createdOn:created,
    estimateMin:clampNum(t.estimateMin||t.estimate,5,480,t.xp>=15?60:30),
    importance:clampNum(t.importance,1,3,t.xp>=15?3:2),
    energy:["low","medium","high"].includes(t.energy)?t.energy:"medium",
    scheduledFor:safeDateKey(t.scheduledFor||t.plannedDate,created),
    dueDate:t.dueDate?safeDateKey(t.dueDate,null):null,
    status:["active","scheduled","triage","backlog","blocked","done","archived"].includes(status)?status:"active",
    rolloverCount:clampNum(t.rolloverCount,0,999,0),
    lastRolledOn:t.lastRolledOn||created,
    lastTriagedOn:t.lastTriagedOn||null,
    blockerReason:String(t.blockerReason||"").slice(0,300),
    reviewOn:t.reviewOn?safeDateKey(t.reviewOn,null):null,
    updatedAt:t.updatedAt||0
  });
}
function normalizeState(raw, legacyDebt){
  raw = raw && typeof raw==="object" ? clone(raw) : {};
  const today=tkey();
  const defaults={
    schemaVersion:V2_SCHEMA,migratedAt:nowIso(),updatedAt:raw.updatedAt||0,
    log:{},todos:[],sched:[],studyOrder:{},planOrder:{},studyAdd:{},subs:{},
    collapsed:{},briefNonce:{},planVersion:PLAN_VERSION,baseXP:990,calUrl:"",
    settings:{
      goalName:"CFA Level I",goalDate:"2026-08-20",dailyTarget:40,weeklyTarget:300,
      defaultFocusMin:50,deepWorkMin:180,triageAfterDays:2,
      workEnd:{1:840,2:840,3:840,4:840,5:780,6:null,0:null}
    },
    activeFocus:null,focusSessions:[],studySessions:[],cfaReviews:[],
    recovery:{debt:Math.max(0,legacyDebt||0),initialDebt:Math.max(0,legacyDebt||0),cleared:0,
      processedThrough:addDaysKey(today,-1),history:[]},
    contacts:[],touches:[],weeklyReviews:[],archive:[],
    syncMeta:{protocol:2}
  };
  const out=Object.assign({},defaults,raw);
  out.settings=Object.assign({},defaults.settings,raw.settings||{});
  out.settings.workEnd=Object.assign({},defaults.settings.workEnd,(raw.settings&&raw.settings.workEnd)||{});
  out.recovery=Object.assign({},defaults.recovery,raw.recovery||{});
  out.syncMeta=Object.assign({},defaults.syncMeta,raw.syncMeta||{});
  out.baseXP=clampNum(out.baseXP,-100000,1000000,990);
  out.updatedAt=clampNum(out.updatedAt,0,Number.MAX_SAFE_INTEGER,0);
  out.settings.goalName=String(out.settings.goalName||defaults.settings.goalName).slice(0,100);
  out.settings.goalDate=safeDateKey(out.settings.goalDate,defaults.settings.goalDate);
  out.settings.dailyTarget=clampNum(out.settings.dailyTarget,10,300,defaults.settings.dailyTarget);
  out.settings.weeklyTarget=clampNum(out.settings.weeklyTarget,50,3000,defaults.settings.weeklyTarget);
  out.settings.defaultFocusMin=clampNum(out.settings.defaultFocusMin,5,480,defaults.settings.defaultFocusMin);
  out.settings.deepWorkMin=clampNum(out.settings.deepWorkMin,30,600,defaults.settings.deepWorkMin);
  out.settings.triageAfterDays=clampNum(out.settings.triageAfterDays,1,14,defaults.settings.triageAfterDays);
  Object.keys(defaults.settings.workEnd).forEach(k=>{
    const v=out.settings.workEnd[k];
    out.settings.workEnd[k]=v==null?null:clampNum(v,0,1439,defaults.settings.workEnd[k]);
  });
  out.recovery.debt=clampNum(out.recovery.debt,0,100000,0);
  out.recovery.initialDebt=clampNum(out.recovery.initialDebt,0,100000,out.recovery.debt);
  out.recovery.cleared=clampNum(out.recovery.cleared,0,100000,0);
  out.recovery.progressQuestions=clampNum(out.recovery.progressQuestions,0,100000,0);
  out.recovery.progressMistakes=clampNum(out.recovery.progressMistakes,0,100000,0);
  out.recovery.processedThrough=safeDateKey(out.recovery.processedThrough,addDaysKey(today,-1));
  ["log","studyOrder","planOrder","studyAdd","subs","collapsed","briefNonce"].forEach(k=>{
    if (!out[k] || typeof out[k]!=="object" || Array.isArray(out[k])) out[k]={};
  });
  ["sched","focusSessions","studySessions","cfaReviews","contacts","touches","weeklyReviews","archive"].forEach(k=>{
    if (!Array.isArray(out[k])) out[k]=[];
  });
  out.todos=(Array.isArray(raw.todos)?raw.todos:[]).map(normalizeTodo);
  out.sched=out.sched.map(s=>Object.assign({},s,{
    id:s.id!=null?s.id:newId("event"),label:String(s.label||"Untitled event").slice(0,500),
    date:safeDateKey(s.date,today),done:!!s.done,updatedAt:s.updatedAt||0
  }));
  out.studySessions=out.studySessions.map(ss=>Object.assign({},ss,{
    id:ss.id||newId("study"),date:safeDateKey(ss.date,today),
    topic:CFA_TOPICS.includes(ss.topic)?ss.topic:String(ss.topic||"General"),
    questions:clampNum(ss.questions,0,1000,0),correct:clampNum(ss.correct,0,1000,0),
    confidence:clampNum(ss.confidence,1,5,3),minutes:clampNum(ss.minutes,0,1000,0),
    mistakesReviewed:clampNum(ss.mistakesReviewed,0,1000,0),
    errorTypes:Array.isArray(ss.errorTypes)?ss.errorTypes.slice(0,6):[],
    xp:clampNum(ss.xp,0,10,5)
  })).map(ss=>Object.assign(ss,{correct:Math.min(ss.questions,ss.correct)}));
  out.cfaReviews=out.cfaReviews.map(r=>Object.assign({},r,{
    id:r.id||newId("review"),dueOn:safeDateKey(r.dueOn,today),
    status:["queued","done","skipped"].includes(r.status)?r.status:"queued"
  }));
  out.contacts=out.contacts.map(c=>Object.assign({},c,{
    id:c.id||newId("contact"),name:String(c.name||"Unnamed").slice(0,150),
    company:String(c.company||"").slice(0,150),context:String(c.context||"").slice(0,500),
    nextAction:String(c.nextAction||"").slice(0,300),
    nextDate:c.nextDate?safeDateKey(c.nextDate,null):null,status:c.status||"active"
  }));
  Object.keys(out.log).forEach(k=>{
    if (!safeDateKey(k,null) || !out.log[k] || typeof out.log[k]!=="object" || Array.isArray(out.log[k])){
      delete out.log[k]; return;
    }
    const e=out.log[k];
    e.calls=clampNum(e.calls,0,1000,0);
    e.followups=clampNum(e.followups,0,1000,0);
    e.outreach=clampNum(e.outreach,0,1000,0);
    if (!e.tasks || typeof e.tasks!=="object" || Array.isArray(e.tasks)) e.tasks={};
  });
  if (out.activeFocus && typeof out.activeFocus==="object" && !Array.isArray(out.activeFocus)){
    const f=out.activeFocus;
    out.activeFocus=Object.assign({},f,{
      id:f.id||newId("focus"),kind:String(f.kind||"todo"),key:String(f.key||""),
      label:String(f.label||"Focus block").slice(0,500),
      plannedMin:clampNum(f.plannedMin,5,480,out.settings.defaultFocusMin),
      startedAt:clampNum(f.startedAt,0,Date.now()+86400000,Date.now()),
      pausedAt:f.pausedAt?clampNum(f.pausedAt,0,Date.now()+86400000,null):null,
      pausedMs:clampNum(f.pausedMs,0,31536000000,0),
      date:safeDateKey(f.date,today)
    });
  } else out.activeFocus=null;
  out.schemaVersion=V2_SCHEMA;
  if (!out.migratedAt) out.migratedAt=nowIso();
  return out;
}
function applySettings(){
  EXAM=parseKey(S.settings.goalDate);
  DAILY_TARGET=clampNum(S.settings.dailyTarget,10,300,40);
  PASS_LINE=clampNum(S.settings.weeklyTarget,50,3000,300);
  Object.keys(S.settings.workEnd||{}).forEach(k=>{ WORK_END[k]=S.settings.workEnd[k]; });
}
function rollOpenTasks(){
  const today=tkey();
  const after=clampNum(S.settings.triageAfterDays,1,14,2);
  for (const t of S.todos){
    if (t.done || ["backlog","archived","triage"].includes(t.status)) continue;
    if (t.status==="scheduled" && t.scheduledFor>today) continue;
    if (t.status==="scheduled"){
      t.status="active";
      t.lastRolledOn=t.scheduledFor||today;
    }
    if (t.status==="blocked"){
      if (!t.reviewOn || t.reviewOn>today) continue;
      t.status="active";t.lastRolledOn=today;t.rolloverCount=0;
    }
    const start=safeDateKey(t.lastRolledOn||t.createdOn,today);
    const elapsed=daysBetween(start,today);
    if (elapsed>0){
      t.rolloverCount=(t.rolloverCount||0)+elapsed;
      t.lastRolledOn=today;
    }
    if (t.status==="active" && t.rolloverCount>=after && t.lastTriagedOn!==today) t.status="triage";
  }
}

function accrueRecoveryDebt(){
  const rec=S.recovery,today=tkey();
  let key=addDaysKey(rec.processedThrough||addDaysKey(today,-1),1),guard=0;
  while(key<today&&guard++<400){
    const owed=dayDebt(key);
    const added=Math.min(owed,Math.max(0,MAX_RECOVERY_DEBT-rec.debt));
    if(added>0){
      rec.debt+=added;rec.initialDebt+=added;
      rec.history.push({id:newId("recovery-miss"),type:"missed",date:key,debtAdded:added,recordedAt:nowIso()});
    }
    rec.processedThrough=key;
    key=addDaysKey(key,1);
  }
}

const wasV2=!!(S&&S.schemaVersion>=2);
const computedLegacyDebt=wasV2 ? Number(S.recovery&&S.recovery.debt)||0
  : (hasLegacyActivity(S||{}) ? totalDebt() : 0);
const migratedRecoveryDebt=wasV2?computedLegacyDebt:Math.min(MAX_RECOVERY_DEBT,computedLegacyDebt);
S=normalizeState(S,migratedRecoveryDebt);
if(!wasV2&&computedLegacyDebt>migratedRecoveryDebt){
  const absorbed=computedLegacyDebt-migratedRecoveryDebt;
  S.baseXP-=absorbed;
  S.recovery.legacyDebt=computedLegacyDebt;
  S.recovery.absorbedDebt=absorbed;
}
if (!S.calUrl) S.calUrl=localStorage.getItem(CALENDAR_KEY)||"";
accrueRecoveryDebt();
rollOpenTasks();
applySettings();

function snapshotMaybe(force){
  try{
    const last=Number(localStorage.getItem(SNAPSHOT_KEY+"-at")||0);
    if (!force && Date.now()-last<3600000) return;
    const list=JSON.parse(localStorage.getItem(SNAPSHOT_KEY)||"[]");
    list.unshift({at:nowIso(),state:clone(S)});
    localStorage.setItem(SNAPSHOT_KEY,JSON.stringify(list.slice(0,5)));
    localStorage.setItem(SNAPSHOT_KEY+"-at",String(Date.now()));
    storageHealth.lastSnapshot=Date.now();
  }catch(e){}
}
function openIDB(){
  return new Promise((resolve,reject)=>{
    if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
    const req=indexedDB.open(IDB_NAME,1);
    req.onupgradeneeded=()=>{ if (!req.result.objectStoreNames.contains("state")) req.result.createObjectStore("state"); };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error||new Error("IndexedDB failed"));
  });
}
async function idbWrite(){
  try{
    const db=await openIDB();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction("state","readwrite");
      tx.objectStore("state").put(clone(S),"current");
      tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
    });
    db.close();
  }catch(e){}
}
function scheduleIDB(){
  clearTimeout(idbTimer);
  idbTimer=setTimeout(idbWrite,300);
}
persist=function(silent){
  try{
    if (!silent) S.updatedAt=Date.now();
    localStorage.setItem(STORE_KEY,JSON.stringify(S));
    if (S.calUrl) localStorage.setItem(CALENDAR_KEY,S.calUrl);
    else localStorage.removeItem(CALENDAR_KEY);
    storageHealth.ok=true; storageHealth.message="Saved locally";
    if (!silent){ snapshotMaybe(false); scheduleIDB(); syncSchedulePush(); }
  }catch(e){
    storageHealth.ok=false; storageHealth.message="Save failed — export a backup";
    flash(storageHealth.message,"error");
  }
};
persist(true);
snapshotMaybe(true);
lastSnapshotState=clone(S);

async function hydrateIDB(){
  try{
    const db=await openIDB();
    const saved=await new Promise((resolve,reject)=>{
      const tx=db.transaction("state","readonly"), req=tx.objectStore("state").get("current");
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
    db.close();
    if (saved && (saved.updatedAt||0)>(S.updatedAt||0)){
      const cal=S.calUrl;
      S=normalizeState(saved,S.recovery.debt);
      if (!S.calUrl) S.calUrl=cal;
      accrueRecoveryDebt();rollOpenTasks();applySettings(); persist(true); refreshAll();
    } else scheduleIDB();
  }catch(e){}
}

function updateEntity(collection,id,fn){
  const item=(S[collection]||[]).find(x=>sameId(x.id,id));
  if (!item) return null;
  fn(item); item.updatedAt=Date.now(); return item;
}
function cascadeSubs(prefix){
  Object.keys(S.subs||{}).forEach(k=>{ if (k===prefix){ delete S.subs[k]; delete S.collapsed[k]; } });
}
function softDelete(collection,id){
  const arr=S[collection]||[], item=arr.find(x=>sameId(x.id,id));
  if (!item) return;
  S.archive.push({id:newId("archive"),collection,item:clone(item),deletedAt:nowIso()});
  S[collection]=arr.filter(x=>!sameId(x.id,id));
  if (collection==="todos") cascadeSubs("t:"+id);
  if (collection==="sched") cascadeSubs("e:"+id);
}

/* ---------- conflict-aware Gist sync ---------- */
function deepEqual(a,b){ try{return JSON.stringify(a)===JSON.stringify(b);}catch(e){return false;} }
function plain(v){ return v && typeof v==="object" && !Array.isArray(v); }
function identifiedArray(a){ return Array.isArray(a) && a.length>0 && a.every(x=>plain(x)&&x.id!=null); }
function merge3(base,local,remote,preferLocal){
  if (deepEqual(local,remote)) return clone(local);
  if (deepEqual(local,base)) return clone(remote);
  if (deepEqual(remote,base)) return clone(local);
  if (plain(local)&&plain(remote)){
    const out={}, keys=new Set([...Object.keys(base||{}),...Object.keys(local),...Object.keys(remote)]);
    keys.forEach(k=>{ out[k]=merge3(base&&base[k],local[k],remote[k],preferLocal); });
    return out;
  }
  if (Array.isArray(local)&&Array.isArray(remote)&&
      (identifiedArray(local)||identifiedArray(remote)||identifiedArray(base||[]))){
    const bm=new Map((base||[]).map(x=>[String(x.id),x]));
    const lm=new Map(local.map(x=>[String(x.id),x]));
    const rm=new Map(remote.map(x=>[String(x.id),x]));
    const ids=new Set([...bm.keys(),...lm.keys(),...rm.keys()]), out=[];
    ids.forEach(id=>{
      const b=bm.get(id),l=lm.get(id),r=rm.get(id);
      if (!l&&!r) return;
      if (!l){ if (b&&deepEqual(r,b)) return; out.push(clone(r)); return; }
      if (!r){ if (b&&deepEqual(l,b)) return; out.push(clone(l)); return; }
      out.push(merge3(b,l,r,preferLocal));
    });
    return out;
  }
  if (local===undefined) return clone(remote);
  if (remote===undefined) return clone(local);
  return clone(preferLocal?local:remote);
}
function syncSafeState(){
  const out=clone(S);
  out.calUrl=""; // calendar subscription credentials remain device-local
  return out;
}
function getSyncBase(){ try{return JSON.parse(localStorage.getItem(SYNC_BASE_KEY)||"null");}catch(e){return null;} }
function setSyncBase(v){ try{localStorage.setItem(SYNC_BASE_KEY,JSON.stringify(v));}catch(e){} }
function deviceId(){
  let id=localStorage.getItem(DEVICE_KEY);
  if (!id){ id=newId("device"); localStorage.setItem(DEVICE_KEY,id); }
  return id;
}
deviceId();
const oldToken=localStorage.getItem(SYNC.TOKEN_KEY)||"";
Object.defineProperty(SYNC,"token",{configurable:true,get(){
  return v2NativeToken || sessionStorage.getItem(SYNC.TOKEN_KEY) || localStorage.getItem(SYNC.TOKEN_KEY) || "";
}});
async function storeToken(token){
  v2NativeToken=token||"";
  if (window.dialKeychain){
    if (token) await window.dialKeychain.setToken(token); else await window.dialKeychain.deleteToken();
    localStorage.removeItem(SYNC.TOKEN_KEY);
    sessionStorage.removeItem(SYNC.TOKEN_KEY);
  } else {
    // Browser/PWA fallback. The native Mac build moves this credential to Keychain.
    if (token) localStorage.setItem(SYNC.TOKEN_KEY,token); else localStorage.removeItem(SYNC.TOKEN_KEY);
  }
}
async function initSecureToken(){
  try{
    if (window.dialKeychain){
      const fromKeychain=await window.dialKeychain.getToken();
      if (fromKeychain) v2NativeToken=fromKeychain;
      else if (oldToken){ await storeToken(oldToken); }
      localStorage.removeItem(SYNC.TOKEN_KEY);
    }
    if (SYNC.token) await syncPull();
  }catch(e){}
}
syncConnect=async function(token){
  await storeToken(token);
  localStorage.removeItem(SYNC.GIST_KEY);
  setSyncBase(null);
  await syncPush();
};
syncDisconnect=function(){
  storeToken("");
  localStorage.removeItem(SYNC.GIST_KEY); setSyncBase(null);
  SYNC.status="off"; SYNC.last=0;
};
async function fetchRemoteState(id){
  const res=await fetch("https://api.github.com/gists/"+id,{headers:syncHeaders(),cache:"no-store"});
  if (!res.ok) throw new Error("gist get "+res.status);
  const etag=res.headers.get("etag")||"";
  const file=(await res.json()).files[SYNC.FILE];
  if (!file) return {state:null,etag};
  let content=file.content||"";
  if (file.truncated&&file.raw_url){
    const rr=await fetch(file.raw_url,{headers:syncHeaders(),cache:"no-store"});
    if (!rr.ok) throw new Error("gist raw "+rr.status);
    content=await rr.text();
  }
  return {state:content?JSON.parse(content):null,etag};
}
function applyMergedState(next){
  const localCal=S.calUrl;
  S=normalizeState(next,S.recovery.debt);
  S.calUrl=localCal;
  accrueRecoveryDebt();rollOpenTasks();applySettings(); persist(true); scheduleIDB(); refreshAll();
}
let syncBusy=false;
async function syncCycle(push){
  if (!SYNC.token||syncBusy) return false;
  syncBusy=true;
  try{
    SYNC.status="syncing"; syncBadge();
    const id=await syncFindOrCreateGist();
    for(let attempt=0;attempt<3;attempt++){
      const snapshot=await fetchRemoteState(id);
      const remote=normalizeState(snapshot.state||{},S.recovery.debt);
      remote.calUrl="";
      const local=syncSafeState(), base=getSyncBase()||{};
      const preferLocal=(local.updatedAt||0)>=(remote.updatedAt||0);
      const merged=merge3(base,local,remote,preferLocal);
      merged.calUrl="";
      if (push||!deepEqual(merged,remote)){
        const body=JSON.stringify({files:{[SYNC.FILE]:{content:JSON.stringify(merged)}}});
        const headers=Object.assign({},syncHeaders(),snapshot.etag?{"If-Match":snapshot.etag}:{});
        const res=await fetch("https://api.github.com/gists/"+id,{
          method:"PATCH",headers,body,keepalive:true
        });
        if(res.status===412) continue;
        if (!res.ok) throw new Error("gist patch "+res.status);
      }
      setSyncBase(merged);
      if (!deepEqual(local,merged)) applyMergedState(merged);
      SYNC.status="ok"; SYNC.last=Date.now(); syncBadge();
      return true;
    }
    throw new Error("gist changed during sync");
  }catch(e){
    SYNC.status="error"; syncBadge(); return false;
  }finally{ syncBusy=false; }
}
syncPull=function(){ return syncCycle(false); };
syncPush=function(){ return syncCycle(true); };

function refreshAll(){
  updateHeader(); renderBrief(); renderContent(false); updateNav(); renderFocus();
}

syncFindOrCreateGist=async function(){
  if (SYNC.gistId) return SYNC.gistId;
  const res=await fetch("https://api.github.com/gists?per_page=100",{headers:syncHeaders()});
  if (!res.ok) throw new Error("gist list "+res.status);
  const found=(await res.json()).find(g=>g.files&&g.files[SYNC.FILE]);
  let id;
  if (found) id=found.id;
  else {
    const body={description:"DIAL sync data",public:false,
      files:{[SYNC.FILE]:{content:JSON.stringify(syncSafeState())}}};
    const created=await fetch("https://api.github.com/gists",{
      method:"POST",headers:syncHeaders(),body:JSON.stringify(body)
    });
    if (!created.ok) throw new Error("gist create "+created.status);
    id=(await created.json()).id;
  }
  localStorage.setItem(SYNC.GIST_KEY,id);
  return id;
};

/* ---------- adaptive planning ---------- */
function taskAge(t){ return daysBetween(t.createdOn||tkey(),tkey()); }
function triageTasks(){
  return S.todos.filter(t=>!t.done && t.status==="triage");
}
function openTodosForToday(){
  const today=tkey();
  return S.todos.filter(t=>!t.done && ["active","scheduled"].includes(t.status) &&
    (!t.scheduledFor||t.scheduledFor<=today) && !triageTasks().some(x=>sameId(x.id,t.id)));
}
function dueReviews(){
  const today=tkey();
  return S.cfaReviews.filter(r=>r.status==="queued"&&r.dueOn<=today)
    .sort((a,b)=>a.dueOn.localeCompare(b.dueOn));
}
function recoveryRequirement(){
  const rec=S.recovery;
  const q=Math.max(0,25-(rec.progressQuestions||0));
  const m=Math.max(0,3-(rec.progressMistakes||0));
  return {questions:q,mistakes:m,label:q+" questions + review "+m+" mistake"+(m===1?"":"s")};
}
function incompleteStudy(){
  const key=tkey(), e=S.log[key]||{}, plan=planFor(key);
  return plan.map((label,i)=>({label,index:i})).filter(x=>!(e.tasks&&e.tasks[x.index]));
}
function nowCandidates(){
  const today=tkey(), candidates=[];
  if ((S.recovery.debt||0)>0){
    const req=recoveryRequirement();
    candidates.push({kind:"recovery",key:"recovery",label:"Recovery · "+req.label,
      estimate:45,priority:130,source:"Recovery"});
  }
  for (const r of dueReviews()){
    candidates.push({kind:"review",key:"review:"+r.id,label:"Review "+r.topic,
      estimate:20,priority:120+daysBetween(r.dueOn,today),source:"CFA review"});
  }
  for (const s of incompleteStudy()){
    candidates.push({kind:"study",key:"study:"+today+":"+s.index,label:s.label,
      estimate:50,priority:95-s.index,source:"CFA"});
  }
  for (const t of openTodosForToday()){
    const overdue=t.dueDate&&t.dueDate<today?daysBetween(t.dueDate,today):0;
    const hour=new Date().getHours();
    const energyFit=(t.energy==="high"&&hour<17)||(t.energy==="low"&&hour>=17)?8:
      (t.energy==="high"&&hour>=19?-5:0);
    const score=(t.importance||2)*30+overdue*9+(t.dueDate===today?18:0)+energyFit;
    candidates.push({kind:"todo",key:"todo:"+t.id,label:t.label,
      estimate:t.estimateMin||30,priority:score,source:t.importance===3?"Must-win":"Today"});
  }
  return candidates.sort((a,b)=>b.priority-a.priority);
}
function todayCapacity(){
  const total=clampNum(S.settings.deepWorkMin,30,600,180);
  const used=S.focusSessions.filter(x=>x.date===tkey()).reduce((n,x)=>n+(Number(x.actualMin)||0),0);
  return Math.max(0,total-used);
}
function nowPlan(){
  const c=nowCandidates(), must=c[0]||null, optional=c.slice(1,3);
  return {must,optional,total:[must,...optional].filter(Boolean).reduce((n,x)=>n+x.estimate,0),capacity:todayCapacity()};
}
function taskMetaHTML(t){
  const bits=[(t.estimateMin||30)+"m",t.importance===3?"Must-win":t.importance===1?"Could":"Should"];
  if (t.dueDate) bits.push("Due "+t.dueDate.slice(5).replace("-","/"));
  return bits.map((x,i)=>"<span class='v2-pill"+(i===1&&t.importance===3?" hot":"")+"'>"+esc(x)+"</span>").join("");
}
function nowCardHTML(){
  const p=nowPlan(), af=S.activeFocus;
  if (af){
    return "<div class='card v2-card wide'><div class='v2-head'><div><div class='v2-kicker'>Focus paused</div>"
      +"<div class='v2-title'>"+esc(af.label)+"</div><div class='v2-meta'><span class='v2-pill hot'>"
      +af.plannedMin+"m target</span></div></div><button class='v2-btn primary' data-v2='focus-resume'>Resume</button></div></div>";
  }
  if (!p.must){
    return "<div class='card v2-card wide'><div class='v2-head'><div><div class='v2-kicker'>Now</div>"
      +"<div class='v2-title'>The board is clear.</div><div class='v2-copy'>Add one concrete task or log a CFA session.</div>"
      +"</div></div></div>";
  }
  const over=p.total>p.capacity;
  return "<div class='card v2-card wide'><div class='v2-head'><div><div class='v2-kicker'>Now · "
    +p.capacity+" minutes available</div><div class='v2-title'>Your next useful move</div></div>"
    +"<span class='v2-pill"+(over?" warn":" good")+"'>"+p.total+" / "+p.capacity+"m committed</span></div>"
    +"<div class='now-main'><div class='now-eyebrow'>Must win · "+esc(p.must.source)+"</div>"
    +"<div class='now-label'>"+esc(p.must.label)+"</div><div class='v2-meta'><span class='v2-pill hot'>"
    +p.must.estimate+" min</span></div><div class='v2-actions' style='margin-top:12px'>"
    +"<button class='v2-btn primary' data-v2='focus-start' data-kind='"+p.must.kind+"' data-key='"+esc(p.must.key)
    +"' data-label='"+esc(p.must.label)+"' data-min='"+p.must.estimate+"'>Start "+p.must.estimate+"m</button></div></div>"
    +(p.optional.length?"<div style='margin-top:8px'>"+p.optional.map(o=>"<div class='now-option'><div class='now-option-main'>"
      +"<div class='now-option-label'>"+esc(o.label)+"</div><div class='review-sub'>"+esc(o.source)+" · "+o.estimate+"m</div></div>"
      +"<button class='v2-btn sm' data-v2='focus-start' data-kind='"+o.kind+"' data-key='"+esc(o.key)
      +"' data-label='"+esc(o.label)+"' data-min='"+o.estimate+"'>Start</button></div>").join("")+"</div>":"")
    +"<div class='capacity-row"+(over?" capacity-over":"")+"'><span>"+(over?"Over capacity — triage an optional":"Plan fits the deep-work window")
    +"</span><span>"+Math.max(0,p.capacity-p.total)+"m uncommitted</span></div></div>";
}
function triageHTML(){
  const items=triageTasks();
  if (!items.length) return "";
  const t=items[0], mode=UI.v2TriageMode&&sameId(UI.v2TriageId,t.id)?UI.v2TriageMode:null;
  let editor="";
  if (mode==="break"){
    editor="<div class='v2-formgrid v2-disclosure'><label class='wide'><span class='v2-flabel'>Concrete next action</span>"
      +"<input id='triageLabel' class='v2-field' value='"+esc(t.label)+"'></label><label><span class='v2-flabel'>Estimate</span>"
      +"<select id='triageEstimate' class='v2-select'><option value='15'>15 minutes</option><option value='30' selected>30 minutes</option>"
      +"<option value='50'>50 minutes</option><option value='90'>90 minutes</option></select></label>"
      +"<div class='v2-actions' style='align-self:end'><button class='v2-btn primary' data-v2='triage-save' data-mode='break' data-id='"+t.id+"'>Commit today</button></div></div>";
  } else if (mode==="schedule"||mode==="blocked"){
    editor="<div class='v2-formgrid v2-disclosure'><label><span class='v2-flabel'>"+(mode==="blocked"?"Review on":"Schedule for")+"</span>"
      +"<input id='triageDate' type='date' class='v2-field' min='"+tkey()+"' value='"+addDaysKey(tkey(),1)+"'></label>"
      +(mode==="blocked"?"<label><span class='v2-flabel'>What is blocking it?</span><input id='triageReason' class='v2-field' placeholder='Waiting on…'></label>":"")
      +"<div class='v2-actions wide'><button class='v2-btn primary' data-v2='triage-save' data-mode='"+mode+"' data-id='"+t.id+"'>Save decision</button></div></div>";
  }
  return "<div class='card v2-card wide'><div class='v2-head'><div><div class='v2-kicker'>Triage · "+items.length+" carryover"
    +(items.length===1?"":"s")+"</div><div class='v2-title'>Decide it once.</div></div><span class='v2-pill warn'>"
    +(t.rolloverCount||taskAge(t))+" days</span></div><div class='triage-item'><div class='triage-label'>"+esc(t.label)
    +"</div><div class='triage-age'>Carried since "+esc(t.createdOn)+"</div><div class='v2-actions' style='margin-top:10px'>"
    +"<button class='v2-btn sm' data-v2='triage-open' data-mode='break' data-id='"+t.id+"'>Break down</button>"
    +"<button class='v2-btn sm' data-v2='triage-open' data-mode='schedule' data-id='"+t.id+"'>Schedule</button>"
    +"<button class='v2-btn sm' data-v2='triage-backlog' data-id='"+t.id+"'>Backlog</button>"
    +"<button class='v2-btn sm' data-v2='triage-open' data-mode='blocked' data-id='"+t.id+"'>Blocked</button>"
    +"<button class='v2-btn sm danger' data-v2='triage-delete' data-id='"+t.id+"'>Archive</button></div>"
    +editor+"</div></div>";
}

/* ---------- CFA evidence and review queue ---------- */
function studyAccuracy(ss){ return ss.questions>0 ? ss.correct/ss.questions*100 : null; }
function masteryByTopic(){
  const grouped={};
  for (const ss of S.studySessions){
    if (!ss.questions) continue;
    (grouped[ss.topic]||(grouped[ss.topic]=[])).push(ss);
  }
  const out=[];
  Object.keys(grouped).forEach(topic=>{
    const recent=grouped[topic].slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
    const q=recent.reduce((n,x)=>n+x.questions,0), c=recent.reduce((n,x)=>n+x.correct,0);
    out.push({topic,accuracy:q?c/q*100:0,questions:q,last:recent[0].date});
  });
  return out.sort((a,b)=>a.accuracy-b.accuracy);
}
function readiness(){
  const topics=masteryByTopic();
  const totalQ=topics.reduce((n,x)=>n+x.questions,0);
  const mocks=S.studySessions.filter(x=>x.mode==="mock"&&x.questions).slice(-2);
  if(!totalQ&&!mocks.length) return {score:0,mastery:0,adherence:0,topics:0};
  const mastery=totalQ?topics.reduce((n,x)=>n+x.accuracy*x.questions,0)/totalQ:0;
  const due=S.cfaReviews.filter(r=>r.dueOn<=tkey()).length;
  const done=S.cfaReviews.filter(r=>r.status==="done"&&r.dueOn<=tkey()).length;
  const adherence=(due?done/due:1)*100;
  const mock=mocks.length?mocks.reduce((n,x)=>n+studyAccuracy(x),0)/mocks.length:null;
  const evidence=mock==null ? .85*mastery+.15*adherence : .55*mastery+.35*mock+.10*adherence;
  const coverage=Math.min(1,topics.length/10);
  const score=evidence*(.25+.75*coverage);
  return {score:Math.round(score||0),mastery:Math.round(mastery||0),adherence:Math.round(adherence||0),topics:topics.length};
}
function learningFormHTML(){
  const pre=UI.v2StudyPrefill||{};
  const topic=pre.topic||CFA_TOPICS[0];
  const reading=pre.mode==="reading";
  return "<div class='v2-formgrid v2-disclosure'><label><span class='v2-flabel'>Topic</span><select id='studyTopicV2' class='v2-select'>"
    +CFA_TOPICS.map(t=>"<option"+(t===topic?" selected":"")+">"+esc(t)+"</option>").join("")+"</select></label>"
    +"<label><span class='v2-flabel'>Mode</span><select id='studyModeV2' class='v2-select'>"
    +[["qbank","Questions"],["review","Review"],["reading","Reading"],["mock","Mock · boss battle"]].map(x=>"<option value='"+x[0]+"'"
      +(pre.mode===x[0]?" selected":"")+">"+x[1]+"</option>").join("")+"</select></label>"
    +"<label"+(reading?" style='opacity:.5'":"")+"><span class='v2-flabel'>Questions attempted</span><input id='studyQuestionsV2' type='number' min='0' max='1000' class='v2-field' value='"+(reading?0:25)+"'"+(reading?" disabled":"")+"></label>"
    +"<label"+(reading?" style='opacity:.5'":"")+"><span class='v2-flabel'>Correct</span><input id='studyCorrectV2' type='number' min='0' max='1000' class='v2-field' value='"+(reading?0:"")+"'"+(reading?" disabled":"")+"></label>"
    +"<label><span class='v2-flabel'>Minutes</span><input id='studyMinutesV2' type='number' min='1' max='1000' class='v2-field' value='"+(pre.minutes||30)+"'></label>"
    +"<label><span class='v2-flabel'>Confidence</span><select id='studyConfidenceV2' class='v2-select'>"
    +[1,2,3,4,5].map(n=>"<option value='"+n+"'"+(n===3?" selected":"")+">"+n+" / 5</option>").join("")+"</select></label>"
    +"<label><span class='v2-flabel'>Mistakes reviewed</span><input id='studyMistakesV2' type='number' min='0' max='1000' class='v2-field' value='0'></label>"
    +"<label><span class='v2-flabel'>Primary error</span><select id='studyErrorV2' class='v2-select'><option value=''>None</option>"
    +["Knowledge","Formula","Misread","Careless","Time pressure"].map(x=>"<option>"+x+"</option>").join("")+"</select></label>"
    +"<label class='wide'><span class='v2-flabel'>Note</span><input id='studyNoteV2' class='v2-field' placeholder='What should future-you remember?'></label>"
    +"<div class='v2-actions wide'><button class='v2-btn primary' data-v2='study-save'>Save evidence · +5 XP</button>"
    +"<button class='v2-btn' data-v2='study-close'>Cancel</button></div></div>";
}
function learningCardHTML(){
  const r=readiness(), due=dueReviews(), weak=masteryByTopic().slice(0,3);
  return "<div class='card v2-card'><div class='v2-head'><div><div class='v2-kicker'>CFA command center</div>"
    +"<div class='v2-title'>Readiness "+r.score+"%</div><div class='v2-copy'>Accuracy is the truth; XP is the consistency reward.</div></div>"
    +"<div class='accuracy-ring' style='--pct:"+r.score+"'><span>"+r.score+"%</span></div></div>"
    +"<div class='mastery-statgrid'><div class='mastery-stat'><strong>"+r.mastery+"%</strong><span>Mastery</span></div>"
    +"<div class='mastery-stat'><strong>"+due.length+"</strong><span>Due reviews</span></div>"
    +"<div class='mastery-stat'><strong>"+r.topics+"/10</strong><span>Topics logged</span></div></div>"
    +(weak.length?"<div class='v2-copy'>Weakest measured topics</div><div class='weak-list'>"
      +weak.map(x=>"<span class='v2-pill'>"+esc(x.topic)+" · "+Math.round(x.accuracy)+"%</span>").join("")+"</div>":"")
    +(due.length?"<div class='review-list'>"+due.slice(0,3).map(x=>"<div class='review-row'><div class='review-row-main'>"
      +"<div class='review-topic'>"+esc(x.topic)+"</div><div class='review-sub'>Due "+esc(x.dueOn)
      +" · "+x.intervalDays+"-day retrieval</div></div><button class='v2-btn sm primary' data-v2='review-start' data-id='"
      +x.id+"'>Start</button></div>").join("")+"</div>":"")
    +"<div class='v2-actions' style='margin-top:12px'><button class='v2-btn primary' data-v2='study-open'>Log study session</button></div>"
    +(UI.v2StudyOpen?learningFormHTML():"")+"</div>";
}
function addStudyEvidence(){
  const mode=qs("#studyModeV2")?qs("#studyModeV2").value:"qbank";
  const q=mode==="reading"?0:clampNum(qs("#studyQuestionsV2")&&qs("#studyQuestionsV2").value,0,1000,0);
  const correct=mode==="reading"?0:clampNum(qs("#studyCorrectV2")&&qs("#studyCorrectV2").value,0,q,0);
  if (mode!=="reading"&&q<=0){ flash("Add questions attempted","error"); return; }
  const ss={
    id:newId("study"),date:tkey(),createdAt:nowIso(),
    topic:qs("#studyTopicV2").value,mode,questions:q,correct,
    confidence:clampNum(qs("#studyConfidenceV2").value,1,5,3),
    minutes:clampNum(qs("#studyMinutesV2").value,1,1000,30),
    mistakesReviewed:clampNum(qs("#studyMistakesV2").value,0,1000,0),
    errorTypes:qs("#studyErrorV2").value?[qs("#studyErrorV2").value]:[],
    note:String(qs("#studyNoteV2").value||"").slice(0,500),xp:5
  };
  const pending=UI.v2StudyPrefill||{};
  if (pending.reviewId){
    const review=S.cfaReviews.find(x=>sameId(x.id,pending.reviewId));
    if (review){ review.status="done"; review.completedAt=nowIso(); review.completionSessionId=ss.id; }
    ss.reviewId=pending.reviewId;
  } else {
    const intervals=mode==="reading"?[1]:[1,3,7];
    intervals.forEach(n=>S.cfaReviews.push({
      id:"review-"+ss.id+"-"+n,sourceSessionId:ss.id,topic:ss.topic,
      intervalDays:n,dueOn:addDaysKey(ss.date,n),status:"queued"
    }));
  }
  S.studySessions.push(ss);
  if ((S.recovery.debt||0)>0){
    S.recovery.progressQuestions=(S.recovery.progressQuestions||0)+q;
    S.recovery.progressMistakes=(S.recovery.progressMistakes||0)+ss.mistakesReviewed;
    while (S.recovery.debt>0&&S.recovery.progressQuestions>=25&&S.recovery.progressMistakes>=3){
      const cleared=Math.min(20,S.recovery.debt);
      S.recovery.debt-=cleared; S.recovery.cleared=(S.recovery.cleared||0)+cleared;
      S.recovery.progressQuestions-=25; S.recovery.progressMistakes-=3;
      S.recovery.history.push({id:newId("recovery"),completedOn:tkey(),cleared,studySessionId:ss.id});
      showBanner("Recovery cleared","+"+cleared+" XP restored");
    }
  }
  UI.v2StudyOpen=false; UI.v2StudyPrefill=null;
  persist(); refreshAll(); bigReward("Evidence banked",q?correct+"/"+q+" correct · "+ss.topic:ss.topic);
}

/* ---------- weekly calibration ---------- */
function weekKey(){ return dkey(mondayOf(new Date())); }
function weekRangeContains(date,mon){
  return date>=mon&&date<=addDaysKey(mon,6);
}
function weekMetricsV2(){
  const mon=weekKey();
  const tasks=S.todos.filter(t=>weekRangeContains(t.scheduledFor||t.createdOn,mon));
  const must=tasks.filter(t=>t.importance===3);
  const focuses=S.focusSessions.filter(x=>weekRangeContains(x.date||tkey(),mon)&&x.outcome!=="active");
  const studies=S.studySessions.filter(x=>weekRangeContains(x.date,mon));
  const touches=S.touches.filter(x=>weekRangeContains(x.date,mon));
  let planned=0,actual=0;
  focuses.forEach(x=>{planned+=x.plannedMin||0;actual+=x.actualMin||0;});
  const q=studies.reduce((n,x)=>n+x.questions,0),c=studies.reduce((n,x)=>n+x.correct,0);
  let gym=0,lights=0;
  for (let i=0;i<7;i++){const e=S.log[addDaysKey(mon,i)]||{};if(e.gym)gym++;if(e.lights)lights++;}
  const oldest=S.todos.filter(t=>!t.done&&!["archived","backlog"].includes(t.status))
    .sort((a,b)=>(a.createdOn||"").localeCompare(b.createdOn||""))[0];
  return {
    mon,mustTotal:must.length,mustDone:must.filter(t=>t.done).length,planned,actual,
    estimateRatio:planned?actual/planned:null,questions:q,correct:c,accuracy:q?c/q*100:null,
    touches:touches.length,meetings:touches.filter(t=>t.outcome==="meeting").length,
    gym,lights,oldest:oldest?{label:oldest.label,days:taskAge(oldest)}:null,
    weakest:masteryByTopic()[0]||null
  };
}
function weeklySuggestion(m){
  if (m.estimateRatio&&m.estimateRatio>1.3) return "Protect capacity: future focus blocks need about "+Math.round(m.estimateRatio*10)/10+"× their current estimate.";
  if (m.mustTotal>=2&&m.mustDone/m.mustTotal<.7) return "Reduce the board: commit to one must-win before adding optionals.";
  if (m.weakest&&m.weakest.questions>=20) return "Schedule two retrieval blocks for "+m.weakest.topic+" next week.";
  if (m.oldest&&m.oldest.days>=3) return "Resolve the oldest carryover before accepting new discretionary work.";
  return "Keep the system small: one must-win, two optionals, and a clean shutdown.";
}
function weeklyCardHTML(){
  const m=weekMetricsV2(), existing=S.weeklyReviews.find(x=>x.weekStart===m.mon);
  const open=!!UI.v2WeeklyOpen;
  return "<div class='card v2-card'><div class='v2-head'><div><div class='v2-kicker'>Weekly calibration</div>"
    +"<div class='v2-title'>"+(existing?"Review saved":"Learn how you work")+"</div>"
    +"<div class='v2-copy'>Three facts, one pattern, one rule for next week.</div></div>"
    +(existing?"<span class='v2-pill good'>Complete</span>":"")+"</div>"
    +"<div class='week-snapshot'><div><strong>"+m.mustDone+"/"+m.mustTotal+"</strong><span>Must-wins</span></div>"
    +"<div><strong>"+(m.accuracy==null?"—":Math.round(m.accuracy)+"%")+"</strong><span>CFA accuracy</span></div>"
    +"<div><strong>"+m.touches+"</strong><span>Touches</span></div></div>"
    +"<div class='pattern-note'>"+esc(weeklySuggestion(m))+"</div>"
    +"<div class='v2-actions' style='margin-top:12px'><button class='v2-btn"+(open?"":" primary")
    +"' data-v2='weekly-toggle'>"+(open?"Close":existing?"Update review":"Run 5-minute review")+"</button></div>"
    +(open?weeklyFormHTML(m,existing):"")+"</div>";
}
function weeklyFormHTML(m,existing){
  const r=existing&&existing.reflection||{};
  const rating=UI.v2WeeklyRating||(existing&&existing.rating)||0;
  return "<div class='v2-disclosure'><fieldset class='v2-fieldset'><legend class='v2-flabel'>Did DIAL help you spend time as intended?</legend>"
    +"<div class='rating-row'>"+[1,2,3,4,5].map(n=>"<button class='rating-btn"+(rating===n?" sel":"")
    +"' data-v2='weekly-rate' data-rate='"+n+"' aria-label='"+n+" out of 5' aria-pressed='"+(rating===n)+"'>"+n+"</button>").join("")+"</div></fieldset>"
    +"<div class='v2-formgrid' style='margin-top:10px'><label class='wide'><span class='v2-flabel'>Biggest win</span>"
    +"<input id='weekWinV2' class='v2-field' value='"+esc(r.win||"")+"'></label>"
    +"<label class='wide'><span class='v2-flabel'>Main friction</span><input id='weekFrictionV2' class='v2-field' value='"
    +esc(r.friction||"")+"'></label><label class='wide'><span class='v2-flabel'>One rule for next week</span>"
    +"<input id='weekChangeV2' class='v2-field' value='"+esc(r.change||weeklySuggestion(m))+"'></label>"
    +"<div class='v2-actions wide'><button class='v2-btn primary' data-v2='weekly-save'>Save calibration</button></div></div></div>";
}
function saveWeeklyReview(){
  const m=weekMetricsV2();
  let wr=S.weeklyReviews.find(x=>x.weekStart===m.mon);
  const first=!wr;
  if (!wr){wr={id:newId("week"),weekStart:m.mon};S.weeklyReviews.push(wr);}
  wr.completedAt=nowIso(); wr.completedOn=tkey(); wr.rating=clampNum(UI.v2WeeklyRating,1,5,wr.rating||3);
  wr.metricsSnapshot=clone(m); wr.suggestion=weeklySuggestion(m);
  wr.reflection={
    win:String(qs("#weekWinV2").value||"").slice(0,500),
    friction:String(qs("#weekFrictionV2").value||"").slice(0,500),
    change:String(qs("#weekChangeV2").value||"").slice(0,500)
  };
  const sunday=parseKey(tkey()).getDay()===0;
  wr.xp=sunday?0:20;
  if (sunday){
    const e=S.log[tkey()]||{}; S.log[tkey()]=Object.assign({},e,{review:true});
  }
  UI.v2WeeklyOpen=false;
  persist(); refreshAll();
  if (first) bigReward("Week calibrated","One rule locked for next week");
}

/* ---------- task capture ---------- */
function taskCaptureHTML(){
  if (!UI.v2TaskOpen) return "<div class='card v2-card'><div class='v2-head'><div><div class='v2-kicker'>Commitment capture</div>"
    +"<div class='v2-title'>Make it concrete.</div><div class='v2-copy'>Estimate first; XP is locked when you commit.</div></div></div>"
    +"<button class='v2-btn primary' data-v2='task-open'>Add planned task</button></div>";
  return "<div class='card v2-card'><div class='v2-head'><div><div class='v2-kicker'>New commitment</div>"
    +"<div class='v2-title'>What does done look like?</div></div></div><div class='v2-formgrid'>"
    +"<label class='wide'><span class='v2-flabel'>Concrete action</span><input id='taskLabelV2' class='v2-field' placeholder='Send the completed…'></label>"
    +"<label><span class='v2-flabel'>Estimate</span><select id='taskEstimateV2' class='v2-select'>"
    +"<option value='15'>15 minutes</option><option value='30' selected>30 minutes</option><option value='50'>50 minutes</option><option value='90'>90 minutes</option></select></label>"
    +"<label><span class='v2-flabel'>Importance</span><select id='taskImportanceV2' class='v2-select'>"
    +"<option value='3'>Must-win · +15</option><option value='2' selected>Should · +5</option><option value='1'>Could · +5</option></select></label>"
    +"<label><span class='v2-flabel'>Energy</span><select id='taskEnergyV2' class='v2-select'><option value='high'>High focus</option>"
    +"<option value='medium' selected>Medium</option><option value='low'>Low energy</option></select></label>"
    +"<label><span class='v2-flabel'>Schedule for</span><input id='taskScheduleV2' type='date' class='v2-field' min='"+tkey()+"' value='"+tkey()+"'></label>"
    +"<label><span class='v2-flabel'>Due date · optional</span><input id='taskDueV2' type='date' class='v2-field' min='"+tkey()+"'></label>"
    +"<div class='v2-actions wide'><button class='v2-btn primary' data-v2='task-save'>Commit</button>"
    +"<button class='v2-btn' data-v2='task-close'>Cancel</button></div></div></div>";
}
function savePlannedTask(){
  const label=String(qs("#taskLabelV2").value||"").trim();
  if (!label){flash("Name the concrete action","error");return;}
  const importance=clampNum(qs("#taskImportanceV2").value,1,3,2);
  const scheduledFor=safeDateKey(qs("#taskScheduleV2").value,tkey());
  if (importance===3){
    S.todos.filter(t=>!t.done&&t.scheduledFor===scheduledFor&&t.importance===3).forEach(t=>{t.importance=2;t.xp=5;});
  }
  S.todos.push(normalizeTodo({
    id:Date.now(),label,xp:importance===3?15:5,createdOn:tkey(),scheduledFor,
    estimateMin:qs("#taskEstimateV2").value,importance,energy:qs("#taskEnergyV2").value,
    dueDate:qs("#taskDueV2").value||null,status:scheduledFor>tkey()?"scheduled":"active"
  }));
  UI.v2TaskOpen=false; persist(); refreshAll(); audioCue("add");
}

/* ---------- relationship pipeline ---------- */
function activeContacts(){
  const today=tkey();
  return S.contacts.filter(c=>c.status!=="archived").sort((a,b)=>{
    const ad=a.nextDate||"9999-12-31",bd=b.nextDate||"9999-12-31";
    if ((ad<=today)!==(bd<=today)) return ad<=today?-1:1;
    return ad.localeCompare(bd);
  });
}
function contactsCardHTML(){
  const contacts=activeContacts(), open=!!UI.v2ContactOpen;
  return "<div class='card v2-card crm-wide'><div class='v2-head'><div><div class='v2-kicker'>Relationship pipeline</div>"
    +"<div class='v2-title'>Next actions, not vanity counts.</div><div class='v2-copy'>Every touch should leave a dated next step.</div></div>"
    +"<button class='v2-btn primary' data-v2='contact-toggle'>"+(open?"Close":"Add contact")+"</button></div>"
    +(open?contactFormHTML():"")
    +(contacts.length?"<div class='contact-list' style='margin-top:10px'>"+contacts.slice(0,8).map(contactHTML).join("")+"</div>"
      :"<div class='v2-empty'>Add the people you want to stay meaningfully in touch with.</div>")+"</div>";
}
function contactFormHTML(){
  return "<div class='v2-formgrid v2-disclosure'><label><span class='v2-flabel'>Name</span><input id='contactNameV2' class='v2-field'></label>"
    +"<label><span class='v2-flabel'>Company</span><input id='contactCompanyV2' class='v2-field'></label>"
    +"<label class='wide'><span class='v2-flabel'>Context</span><input id='contactContextV2' class='v2-field' placeholder='What matters to them / last conversation'></label>"
    +"<label><span class='v2-flabel'>Next action</span><input id='contactNextV2' class='v2-field' placeholder='Send article, schedule call…'></label>"
    +"<label><span class='v2-flabel'>Next-action date</span><input id='contactDateV2' type='date' min='"+tkey()+"' class='v2-field' value='"+tkey()+"'></label>"
    +"<div class='v2-actions wide'><button class='v2-btn primary' data-v2='contact-save'>Save contact</button></div></div>";
}
function contactHTML(c){
  const today=tkey(), overdue=c.nextDate&&c.nextDate<today;
  const logging=UI.v2ContactLogId&&sameId(UI.v2ContactLogId,c.id);
  const outcomeLabel={
    "no-answer":"No answer",replied:"Replied",meeting:"Meeting booked","follow-up":"Follow-up needed"
  }[c.lastOutcome]||"Active";
  return "<div class='contact-item"+(overdue?" contact-overdue":"")+"'><div class='contact-top'><div><div class='contact-name'>"
    +esc(c.name)+(c.company?" · "+esc(c.company):"")+"</div><div class='contact-context'>"+esc(c.context||"No context yet")
    +"</div></div><span class='contact-stage'>"+esc(outcomeLabel)+"</span></div>"
    +"<div class='contact-next'><strong>"+(overdue?"Overdue: ":"Next: ")+"</strong>"+esc(c.nextAction||"Set a next action")
    +(c.nextDate?" · "+esc(c.nextDate):"")+"</div><div class='v2-actions' style='margin-top:9px'>"
    +"<button class='v2-btn sm primary' data-v2='contact-log-open' data-id='"+c.id+"'>Log touch</button>"
    +"<button class='v2-btn sm' data-v2='contact-snooze' data-id='"+c.id+"'>+7 days</button>"
    +"<button class='v2-btn sm danger' data-v2='contact-archive' data-id='"+c.id+"'>Archive</button></div>"
    +(logging?touchFormHTML(c):"")+"</div>";
}
function touchFormHTML(c){
  return "<div class='v2-formgrid v2-disclosure'><label><span class='v2-flabel'>Touch type</span>"
    +"<select id='touchTypeV2' class='v2-select'><option value='call'>Call</option><option value='followup'>Follow-up</option>"
    +"<option value='outreach'>New outreach</option><option value='meeting'>Meeting</option></select></label>"
    +"<label><span class='v2-flabel'>Outcome</span><select id='touchOutcomeV2' class='v2-select'><option value='no-answer'>No answer</option>"
    +"<option value='replied'>Replied</option><option value='meeting'>Meeting booked</option><option value='follow-up'>Follow-up needed</option></select></label>"
    +"<label><span class='v2-flabel'>Next action</span><input id='touchNextV2' class='v2-field' value='"+esc(c.nextAction||"")+"'></label>"
    +"<label><span class='v2-flabel'>Next date</span><input id='touchDateV2' type='date' min='"+tkey()+"' class='v2-field' value='"+addDaysKey(tkey(),7)+"'></label>"
    +"<label class='wide'><span class='v2-flabel'>Note</span><input id='touchNoteV2' class='v2-field'></label>"
    +"<div class='v2-actions wide'><button class='v2-btn primary' data-v2='touch-save' data-id='"+c.id+"'>Save touch</button></div></div>";
}
function saveContact(){
  const name=String(qs("#contactNameV2").value||"").trim();
  if (!name){flash("Add a name","error");return;}
  S.contacts.push({id:newId("contact"),name,company:String(qs("#contactCompanyV2").value||"").trim(),
    context:String(qs("#contactContextV2").value||"").trim(),nextAction:String(qs("#contactNextV2").value||"").trim(),
    nextDate:qs("#contactDateV2").value||null,status:"active",createdAt:nowIso()});
  UI.v2ContactOpen=false;persist();refreshAll();audioCue("add");
}
function saveTouch(contactId){
  const c=S.contacts.find(x=>sameId(x.id,contactId));if(!c)return;
  const type=qs("#touchTypeV2").value,outcome=qs("#touchOutcomeV2").value;
  const next=String(qs("#touchNextV2").value||"").trim(),date=qs("#touchDateV2").value||null;
  S.touches.push({id:newId("touch"),contactId:c.id,date:tkey(),occurredAt:nowIso(),type,outcome,
    note:String(qs("#touchNoteV2").value||"").trim(),nextAction:next,nextDate:date,xp:type==="call"?10:5});
  c.lastTouchAt=nowIso();c.lastOutcome=outcome;c.nextAction=next;c.nextDate=date;c.updatedAt=Date.now();
  const e=S.log[tkey()]||{},field=type==="call"?"calls":type==="outreach"?"outreach":"followups";
  S.log[tkey()]=Object.assign({},e,{[field]:(e[field]||0)+1});
  UI.v2ContactLogId=null;persist();refreshAll();smallReward();
}

/* ---------- focus mode ---------- */
function startFocus(kind,key,label,plannedMin){
  if (S.activeFocus){ UI.v2FocusHidden=false; renderFocus(); return; }
  S.activeFocus={
    id:newId("focus"),kind,key,label:String(label||"Focus block").slice(0,500),
    plannedMin:clampNum(plannedMin,5,480,S.settings.defaultFocusMin||50),
    startedAt:Date.now(),pausedAt:null,pausedMs:0,date:tkey()
  };
  UI.v2FocusClosing=false;UI.v2FocusOutcome=null;UI.v2FocusHidden=false;
  persist();renderFocus();audioCue("unlock");
}
function focusElapsed(){
  const f=S.activeFocus;
  return f?Math.max(0,(f.pausedAt||Date.now())-f.startedAt-(f.pausedMs||0)):0;
}
function pauseFocus(){
  const f=S.activeFocus;if(!f)return;
  if(!f.pausedAt)f.pausedAt=Date.now();
  UI.v2FocusHidden=true;persist();renderFocus();refreshAll();
}
function resumeFocus(){
  const f=S.activeFocus;if(!f)return;
  if(f.pausedAt){f.pausedMs=(f.pausedMs||0)+Math.max(0,Date.now()-f.pausedAt);f.pausedAt=null;}
  UI.v2FocusHidden=false;persist();renderFocus();refreshAll();
}
function beginFocusCloseout(){
  const f=S.activeFocus;if(!f)return;
  if(!f.pausedAt)f.pausedAt=Date.now();
  UI.v2FocusClosing=true;persist();renderFocus();
}
function setFocusIsolation(active){
  const main=qs("main"),nav=qs("nav");
  if(main)main.inert=!!active;
  if(nav)nav.inert=!!active;
  document.body.classList.toggle("focus-open",!!active);
}
function focusClock(ms){
  const total=Math.floor(ms/1000),m=Math.floor(total/60),s=total%60;
  return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}
function renderFocus(){
  const root=qs("#focusLayer"); if(!root)return;
  clearInterval(focusTick);focusTick=null;
  const f=S.activeFocus;
  if(!f||UI.v2FocusHidden){root.innerHTML="";setFocusIsolation(false);return;}
  setFocusIsolation(true);
  if(!UI.v2FocusClosing){
    const paused=!!f.pausedAt;
    root.innerHTML="<div class='focus-shell' role='dialog' aria-modal='true' aria-labelledby='focusTitleV2'>"
      +"<div class='focus-kicker'>Focus · "+esc(f.kind)+"</div><div class='focus-title' id='focusTitleV2'>"+esc(f.label)+"</div>"
      +"<div class='focus-clock' id='focusClockV2'>"+focusClock(focusElapsed())+"</div><div class='focus-target'>"
      +f.plannedMin+" minute target · "+(paused?"paused safely":"timer survives reloads")+"</div><div class='v2-actions' style='margin-top:22px'>"
      +(paused?"<button class='v2-btn primary' data-v2='focus-resume'>Resume focus</button>":
        "<button class='v2-btn primary' data-v2='focus-finish'>Finish session</button>"
        +"<button class='v2-btn' data-v2='focus-pause'>Pause & return to board</button>")+"</div></div>";
    if(!paused)focusTick=setInterval(()=>{const el=qs("#focusClockV2");if(el)el.textContent=focusClock(focusElapsed());},1000);
    setTimeout(()=>{const b=root.querySelector("button");if(b)b.focus();},0);
    return;
  }
  const outcome=UI.v2FocusOutcome;
  root.innerHTML="<div class='focus-shell' role='dialog' aria-modal='true' aria-labelledby='focusTitleV2'>"
    +"<div class='focus-kicker'>Close the loop</div><div class='focus-title' id='focusTitleV2'>How did the block end?</div>"
    +"<div class='focus-target'>"+esc(f.label)+" · "+Math.max(1,Math.round(focusElapsed()/60000))+" actual minutes</div>"
    +(!outcome?"<div class='focus-closegrid'><button class='focus-outcome' data-v2='focus-outcome' data-outcome='done'>✓ Done</button>"
      +"<button class='focus-outcome' data-v2='focus-outcome' data-outcome='partial'>◐ Partial</button>"
      +"<button class='focus-outcome' data-v2='focus-outcome' data-outcome='blocked'>! Blocked</button></div>"
      :"<div class='v2-disclosure'><div class='v2-flabel'>"+(outcome==="blocked"?"What blocked you?":"What remains?")+"</div>"
      +"<div class='v2-actions'>"+BLOCKERS.map(x=>"<button class='v2-btn sm"+(UI.v2Blocker===x[0]?" primary":"")
        +"' data-v2='focus-blocker' data-blocker='"+x[0]+"'>"+x[1]+"</button>").join("")+"</div>"
      +"<label style='display:block;margin-top:10px'><span class='v2-flabel'>Optional note</span><input id='focusNoteV2' class='v2-field' placeholder='One sentence is enough'></label>"
      +"<div class='v2-actions' style='margin-top:12px'><button class='v2-btn primary' data-v2='focus-save'>Save closeout</button>"
      +"<button class='v2-btn' data-v2='focus-back'>Back</button></div></div>")
    +"</div>";
  setTimeout(()=>{const b=root.querySelector("button");if(b)b.focus();},0);
}
function finishFocus(outcome){
  const f=S.activeFocus;if(!f)return;
  const actual=Math.max(0,Math.round(focusElapsed()/60000));
  const session={
    id:f.id,kind:f.kind,key:f.key,label:f.label,date:f.date,plannedMin:f.plannedMin,
    actualMin:actual,startedAt:new Date(f.startedAt).toISOString(),endedAt:nowIso(),
    outcome,blocker:UI.v2Blocker||"",note:qs("#focusNoteV2")?String(qs("#focusNoteV2").value||"").slice(0,500):""
  };
  S.focusSessions.push(session);
  if(f.kind==="todo"){
    const id=f.key.slice(5),t=S.todos.find(x=>sameId(x.id,id));
    if(t){
      if(outcome==="done"){t.done=true;t.doneOn=tkey();t.status="done";}
      else if(outcome==="blocked"){t.status="blocked";t.blockerReason=session.blocker||session.note;t.reviewOn=addDaysKey(tkey(),1);}
      else t.estimateMin=Math.max(5,Math.round((t.estimateMin||f.plannedMin)/2));
      t.updatedAt=Date.now();
    }
  } else if(f.kind==="study"){
    const p=f.key.split(":"),date=p[1],idx=+p[2];
    if(outcome==="done"){
      const e=S.log[date]||{},tasks=Object.assign({},e.tasks||{});tasks[idx]=true;
      S.log[date]=Object.assign({},e,{tasks});
      UI.v2StudyOpen=true;UI.v2StudyPrefill={minutes:actual};
    }
  } else if(f.kind==="review"&&outcome==="done"){
    const id=f.key.slice(7),r=S.cfaReviews.find(x=>sameId(x.id,id));
    if(r){UI.v2StudyOpen=true;UI.v2StudyPrefill={topic:r.topic,mode:"review",reviewId:r.id,minutes:actual};}
  } else if(f.kind==="recovery"&&outcome==="done"){
    UI.v2StudyOpen=true;UI.v2StudyPrefill={mode:"qbank",minutes:actual,recovery:true};
  }
  S.activeFocus=null;UI.v2FocusClosing=false;UI.v2FocusOutcome=null;UI.v2Blocker=null;
  UI.v2FocusHidden=false;
  persist();refreshAll();
  if(outcome==="done")smallReward();else flash(outcome==="blocked"?"Blocker captured":"Progress captured");
}

/* ---------- settings and trust ---------- */
function trustCardHTML(){
  const secure=!!window.dialKeychain;
  return "<div class='card v2-card'><div class='v2-head'><div><div class='v2-kicker'>Data trust</div>"
    +"<div class='v2-title'>Your system remembers.</div></div><span class='v2-pill "+(storageHealth.ok?"good":"warn")+"'>"
    +(storageHealth.ok?"Healthy":"Attention")+"</span></div><div class='trust-row'><span class='trust-status"
    +(storageHealth.ok?"":" error")+"'>"+esc(storageHealth.message)+"</span><span>Hourly snapshots · 5 retained</span></div>"
    +"<div class='trust-row' style='margin-top:8px'><span>Sync credential</span><span>"+(secure?"macOS Keychain":"Browser storage fallback")+"</span></div>"
    +"<div class='v2-actions' style='margin-top:12px'><button class='v2-btn' data-v2='settings-toggle'>"
    +(UI.v2SettingsOpen?"Close settings":"Goal & system settings")+"</button></div>"
    +(UI.v2SettingsOpen?settingsFormHTML():"")+"</div>";
}
function settingsFormHTML(){
  const s=S.settings;
  return "<div class='v2-formgrid v2-disclosure'><label><span class='v2-flabel'>Primary goal</span>"
    +"<input id='settingGoalV2' class='v2-field' value='"+esc(s.goalName)+"'></label>"
    +"<label><span class='v2-flabel'>Target date</span><input id='settingDateV2' type='date' class='v2-field' value='"+s.goalDate+"'></label>"
    +"<label><span class='v2-flabel'>Daily XP target</span><input id='settingDailyV2' type='number' min='10' max='300' class='v2-field' value='"+s.dailyTarget+"'></label>"
    +"<label><span class='v2-flabel'>Weekly XP target</span><input id='settingWeeklyV2' type='number' min='50' max='3000' class='v2-field' value='"+s.weeklyTarget+"'></label>"
    +"<label><span class='v2-flabel'>Deep-work capacity</span><input id='settingCapacityV2' type='number' min='30' max='600' class='v2-field' value='"+s.deepWorkMin+"'></label>"
    +"<label><span class='v2-flabel'>Triage after days</span><input id='settingTriageV2' type='number' min='1' max='14' class='v2-field' value='"+s.triageAfterDays+"'></label>"
    +"<div class='v2-actions wide'><button class='v2-btn primary' data-v2='settings-save'>Save settings</button></div></div>";
}
function saveSettings(){
  S.settings.goalName=String(qs("#settingGoalV2").value||"Primary goal").slice(0,100);
  S.settings.goalDate=safeDateKey(qs("#settingDateV2").value,S.settings.goalDate);
  S.settings.dailyTarget=clampNum(qs("#settingDailyV2").value,10,300,40);
  S.settings.weeklyTarget=clampNum(qs("#settingWeeklyV2").value,50,3000,300);
  S.settings.deepWorkMin=clampNum(qs("#settingCapacityV2").value,30,600,180);
  S.settings.triageAfterDays=clampNum(qs("#settingTriageV2").value,1,14,2);
  applySettings();UI.v2SettingsOpen=false;persist();refreshAll();flash("System settings saved");
}

/* ---------- complete backup/restore ---------- */
async function sha256(text){
  if(!crypto.subtle)return"";
  const bytes=new TextEncoder().encode(text),hash=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
exportBackup=async function(){
  const state=clone(S),raw=JSON.stringify(state);
  const envelope={format:"dial-backup",formatVersion:2,build:BUILD,exportedAt:nowIso(),
    checksum:await sha256(raw),state};
  const blob=new Blob([JSON.stringify(envelope,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="dial-backup-"+tkey()+".json";a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);snapshotMaybe(true);flash("Complete backup saved");audioCue("select");
};
importBackup=function(file){
  const r=new FileReader();
  r.onload=async()=>{
    const previous=clone(S);
    try{
      const parsed=JSON.parse(r.result);
      const envelope=parsed&&parsed.format==="dial-backup"?parsed:null;
      if(envelope&&envelope.formatVersion>2)throw new Error("newer backup");
      const raw=envelope?envelope.state:parsed;
      if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("invalid state");
      if(envelope&&envelope.checksum){
        const actual=await sha256(JSON.stringify(raw));
        if(actual&&actual!==envelope.checksum)throw new Error("checksum");
      }
      snapshotMaybe(true);
      try{localStorage.setItem("dial-before-restore-v2",JSON.stringify(S));}catch(_){}
      const localCal=S.calUrl;
      const candidate=normalizeState(raw,(raw.recovery&&raw.recovery.debt)||0);
      if(!candidate.calUrl)candidate.calUrl=localCal;
      S=candidate;
      accrueRecoveryDebt();rollOpenTasks();applySettings();persist();refreshAll();audioCue("unlock");flash("Backup restored completely");
    }catch(e){
      S=previous;applySettings();persist(true);refreshAll();
      audioCue("remove");flash("Import rejected — current data is unchanged","error");
    }
  };
  r.readAsText(file);
};
resetAll=function(){
  snapshotMaybe(true);
  try{localStorage.setItem("dial-before-reset-v2",JSON.stringify(S));}catch(_){}
  const cal=S.calUrl;
  S=normalizeState({baseXP:0,calUrl:cal,settings:S.settings},0);
  UI.confirmReset=false;applySettings();persist();refreshAll();
};

/* ---------- calendar reconciliation ---------- */
const legacyParseICS=parseICS;
mergeICS=function(text,replaceFeed){
  const evs=legacyParseICS(text),start=new Date();start.setHours(0,0,0,0);
  const end=new Date(start);end.setDate(end.getDate()+60);
  const incoming=new Set(),byUid=new Map(S.sched.filter(s=>s.uid).map(s=>[s.uid,s]));
  let changed=0;
  for(const ev of evs){
    if(!(ev.dt>=start&&ev.dt<end))continue;
    const date=dkey(ev.dt),label=(ev.hasTime?fmtTime(ev.dt.getHours()*60+ev.dt.getMinutes())+" · ":"")+ev.summary;
    const uid=ev.uid?ev.uid+"|"+date:null;
    if(uid)incoming.add(uid);
    const existing=uid&&byUid.get(uid);
    if(existing){
      if(existing.date!==date||existing.label!==label){existing.date=date;existing.label=label;existing.updatedAt=Date.now();changed++;}
      existing.calendarFeed=true;continue;
    }
    if(!uid&&S.sched.some(s=>s.date===date&&s.label===label))continue;
    S.sched.push({id:Date.now()+changed,label,date,done:false,uid,calendarFeed:!!replaceFeed});changed++;
  }
  if(replaceFeed){
    const before=S.sched.length;
    S.sched=S.sched.filter(s=>!s.calendarFeed||!s.uid||incoming.has(s.uid)||s.date<tkey());
    changed+=before-S.sched.length;
  }
  if(changed){persist();updateHeader();renderBrief();renderContent(false);}
  return changed;
};
calSync=async function(announce){
  if(!S.calUrl||calSyncing)return;
  calSyncing=true;
  try{
    const url=S.calUrl.replace(/^webcal:\/\//i,"https://");
    if(!/^https:\/\//i.test(url))throw new Error("https required");
    const res=await fetch("https://dial-cal-relay.lheinen002.workers.dev/?url="+encodeURIComponent(url),{cache:"no-store"});
    if(!res.ok)throw new Error("calendar "+res.status);
    const text=await res.text();if(!/BEGIN:VCALENDAR/i.test(text))throw new Error("not calendar");
    const changed=mergeICS(text,true);
    if(announce){flash(changed?changed+" calendar changes applied":"Calendar up to date");audioCue(changed?"unlock":"select");}
  }catch(e){if(announce){flash("Calendar sync failed — check the secure URL","error");audioCue("remove");}}
  finally{calSyncing=false;}
};

/* ---------- integrate v2 with the existing three-tab shell ---------- */
const legacyHeaderV2=updateHeader;
updateHeader=function(){
  legacyHeaderV2();
  const right=qs(".hero .right");
  if(right){
    const label=right.querySelector(".label"),sub=right.querySelector(".sub");
    if(label)label.textContent=S.settings.goalName;
    if(sub){
      const d=parseKey(S.settings.goalDate);
      sub.textContent=d.toLocaleDateString([], {month:"short",day:"numeric"});
    }
  }
  qs("#tminus").textContent="T-"+Math.max(0,Math.ceil((EXAM-new Date(new Date().getFullYear(),new Date().getMonth(),new Date().getDate()))/86400000));
  qs("#briefDays").textContent=Math.max(0,daysToExam());
  const debt=totalDebt(),dc=qs("#debtChip");
  if(dc&&debt>0){dc.textContent="RECOVERY · "+debt+" XP";dc.classList.add("v2-recovery-chip");}
  if(debt>0&&qs("#saying"))qs("#saying").textContent="RE-ENTRY IS THE WIN.";
};
const legacyBriefingV2=briefingText;
briefingText=function(){
  const p=nowPlan(),lead=p.must
    ? "Best next move: "+p.must.label+" ("+p.must.estimate+" min)."
    : "The board is clear; choose one concrete win.";
  const last=S.weeklyReviews.slice().sort((a,b)=>(b.completedAt||"").localeCompare(a.completedAt||""))[0];
  const rule=last&&last.reflection&&last.reflection.change?" This week's rule: "+last.reflection.change+".":"";
  return lead+" "+legacyBriefingV2()+rule;
};
const legacyTodayV2=todayHTML;
todayHTML=function(){
  return "<section class='v2-stack' aria-label='Adaptive execution'><div class='v2-grid'>"
    +triageHTML()+nowCardHTML()+learningCardHTML()+weeklyCardHTML()+taskCaptureHTML()+trustCardHTML()
    +"</div></section>"+legacyTodayV2();
};
const legacyNetworkV2=networkHTML;
networkHTML=function(){return contactsCardHTML()+legacyNetworkV2();};
const legacyPlanV2=planHTML;
planHTML=function(){
  const r=readiness(),due=dueReviews().length,weak=masteryByTopic()[0];
  const command="<div class='card v2-card wide'><div class='v2-head'><div><div class='v2-kicker'>CFA command center</div>"
    +"<div class='v2-title'>"+r.score+"% readiness · "+due+" review"+(due===1?"":"s")+" due</div>"
    +"<div class='v2-copy'>"+(weak?"Weakest measured topic: "+esc(weak.topic)+" at "+Math.round(weak.accuracy)+"%.":"Log a scored session to establish your baseline.")
    +"</div></div><button class='v2-btn primary' data-v2='go-today-learning'>Log evidence</button></div></div>";
  return command+legacyPlanV2();
};
const legacyAddQuestV2=addQuest;
addQuest=function(){
  const inp=qs("#questInput"),label=inp?inp.value.trim():"";
  if(!label)return;
  if(inp)inp.value="";
  const importance=UI.newQuestXP>=15?3:2;
  if(importance===3)S.todos.filter(t=>!t.done&&t.scheduledFor===tkey()&&t.importance===3).forEach(t=>{t.importance=2;t.xp=5;});
  S.todos.push(normalizeTodo({id:Date.now(),label,xp:importance===3?15:5,done:false,
    createdOn:tkey(),scheduledFor:tkey(),estimateMin:importance===3?60:15,importance,status:"active"}));
  persist();refreshAll();audioCue("add");
};
toggleQuest=function(id,ev){
  const t=S.todos.find(x=>sameId(x.id,id));if(!t)return;
  const on=!t.done;lastFX.key=on?"quest-"+id:null;
  mutate(()=>{t.done=on;t.doneOn=on?tkey():null;t.status=on?"done":"active";t.updatedAt=Date.now();},ev);
  if(!on)audioCue("undo");
};

function refreshV2StateFromStorage(next){
  const remote=normalizeState(next,S.recovery.debt);
  const merged=merge3(lastSnapshotState||S,S,remote,(S.updatedAt||0)>=(remote.updatedAt||0));
  const cal=S.calUrl;
  S=normalizeState(merged,S.recovery.debt);S.calUrl=cal||remote.calUrl;
  accrueRecoveryDebt();rollOpenTasks();lastSnapshotState=clone(S);applySettings();persist(true);refreshAll();
}
window.addEventListener("storage",e=>{
  if(e.key===STORE_KEY&&e.newValue){
    try{refreshV2StateFromStorage(JSON.parse(e.newValue));}catch(_){}
  }
});

function stopV2(e){e.preventDefault();e.stopImmediatePropagation();audioCue("press");}
document.addEventListener("click",e=>{
  const v=e.target.closest&&e.target.closest("[data-v2]");
  if(v){
    stopV2(e);
    const a=v.dataset.v2;
    if(a==="focus-start")startFocus(v.dataset.kind,v.dataset.key,v.dataset.label,+v.dataset.min);
    else if(a==="focus-resume")resumeFocus();
    else if(a==="focus-pause")pauseFocus();
    else if(a==="focus-finish")beginFocusCloseout();
    else if(a==="focus-outcome"){
      if(v.dataset.outcome==="done")finishFocus("done");
      else{UI.v2FocusOutcome=v.dataset.outcome;UI.v2Blocker=null;renderFocus();}
    }
    else if(a==="focus-blocker"){UI.v2Blocker=v.dataset.blocker;renderFocus();}
    else if(a==="focus-save"){
      if(UI.v2FocusOutcome==="blocked"&&!UI.v2Blocker){flash("Choose the blocker","error");return;}
      finishFocus(UI.v2FocusOutcome||"partial");
    }
    else if(a==="focus-back"){UI.v2FocusOutcome=null;UI.v2Blocker=null;renderFocus();}
    else if(a==="study-open"){UI.v2StudyOpen=true;UI.v2StudyPrefill=null;renderContent(false);}
    else if(a==="study-close"){UI.v2StudyOpen=false;UI.v2StudyPrefill=null;renderContent(false);}
    else if(a==="study-save")addStudyEvidence();
    else if(a==="review-start"){
      const r=S.cfaReviews.find(x=>sameId(x.id,v.dataset.id));if(!r)return;
      startFocus("review","review:"+r.id,"Review "+r.topic,20);
    }
    else if(a==="weekly-toggle"){UI.v2WeeklyOpen=!UI.v2WeeklyOpen;UI.v2WeeklyRating=null;renderContent(false);}
    else if(a==="weekly-rate"){
      UI.v2WeeklyRating=+v.dataset.rate;
      qsa("[data-v2='weekly-rate']").forEach(btn=>{
        const selected=+btn.dataset.rate===UI.v2WeeklyRating;
        btn.classList.toggle("sel",selected);
        btn.setAttribute("aria-pressed",String(selected));
      });
    }
    else if(a==="weekly-save")saveWeeklyReview();
    else if(a==="task-open"){UI.v2TaskOpen=true;renderContent(false);}
    else if(a==="task-close"){UI.v2TaskOpen=false;renderContent(false);}
    else if(a==="task-save")savePlannedTask();
    else if(a==="triage-open"){UI.v2TriageId=v.dataset.id;UI.v2TriageMode=v.dataset.mode;renderContent(false);}
    else if(a==="triage-save"){
      const t=S.todos.find(x=>sameId(x.id,v.dataset.id));if(!t)return;
      const mode=v.dataset.mode,date=qs("#triageDate")&&qs("#triageDate").value;
      if(mode==="break"){
        const label=String(qs("#triageLabel").value||"").trim();if(!label){flash("Name the next action","error");return;}
        t.label=label;t.estimateMin=clampNum(qs("#triageEstimate").value,5,480,30);t.status="active";t.scheduledFor=tkey();
      }else if(mode==="schedule"){if(!date){flash("Choose a date","error");return;}t.status="scheduled";t.scheduledFor=date;}
      else{if(!date){flash("Choose a review date","error");return;}t.status="blocked";t.reviewOn=date;
        t.blockerReason=String(qs("#triageReason").value||"").trim();}
      t.rolloverCount=0;t.lastTriagedOn=tkey();t.lastRolledOn=tkey();t.updatedAt=Date.now();
      UI.v2TriageId=null;UI.v2TriageMode=null;persist();refreshAll();
    }
    else if(a==="triage-backlog"){
      updateEntity("todos",v.dataset.id,t=>{t.status="backlog";t.lastTriagedOn=tkey();});persist();refreshAll();
    }
    else if(a==="triage-delete"){softDelete("todos",v.dataset.id);persist();refreshAll();flash("Task archived");}
    else if(a==="contact-toggle"){UI.v2ContactOpen=!UI.v2ContactOpen;renderContent(false);}
    else if(a==="contact-save")saveContact();
    else if(a==="contact-log-open"){UI.v2ContactLogId=UI.v2ContactLogId&&sameId(UI.v2ContactLogId,v.dataset.id)?null:v.dataset.id;renderContent(false);}
    else if(a==="contact-snooze"){
      updateEntity("contacts",v.dataset.id,c=>{c.nextDate=addDaysKey(c.nextDate&&c.nextDate>=tkey()?c.nextDate:tkey(),7);});
      persist();refreshAll();
    }
    else if(a==="contact-archive"){updateEntity("contacts",v.dataset.id,c=>{c.status="archived";});persist();refreshAll();}
    else if(a==="touch-save")saveTouch(v.dataset.id);
    else if(a==="settings-toggle"){UI.v2SettingsOpen=!UI.v2SettingsOpen;renderContent(false);}
    else if(a==="settings-save")saveSettings();
    else if(a==="go-today-learning"){setTab("today");UI.v2StudyOpen=true;renderContent(false);}
    return;
  }
  const old=e.target.closest&&e.target.closest("[data-act]");
  if(!old)return;
  const a=old.dataset.act;
  if(a==="delquest"){
    stopV2(e);softDelete("todos",old.dataset.id);persist();refreshAll();flash("Task archived");return;
  }
  if(a==="delsched"){
    stopV2(e);softDelete("sched",old.dataset.id);persist();refreshAll();flash("Event archived");return;
  }
  if(a==="delstudy"){
    stopV2(e);const idx=+old.dataset.id,label=planFor(tkey())[idx];if(label)cascadeSubs("s:"+tkey()+"|"+label);
    delStudy(idx);return;
  }
  if(a==="export"){stopV2(e);exportBackup();return;}
  if(a==="resetconfirm"){stopV2(e);resetAll();return;}
  if(a==="toggle"&&old.dataset.key==="review"&&new Date().getDay()===0){
    stopV2(e);UI.v2WeeklyOpen=true;renderContent(false);return;
  }
},true);

document.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&S.activeFocus&&!UI.v2FocusHidden){
    e.preventDefault();pauseFocus();
  }
});
document.addEventListener("change",e=>{
  if(e.target&&e.target.id==="studyModeV2"){
    const reading=e.target.value==="reading";
    ["#studyQuestionsV2","#studyCorrectV2"].forEach((sel,i)=>{
      const input=qs(sel);if(!input)return;
      input.disabled=reading;
      if(reading)input.value="0";
      else if(i===0&&Number(input.value)===0)input.value="25";
      const label=input.closest("label");if(label)label.style.opacity=reading?".5":"";
    });
  }
});

// Apply v2 UI after the legacy shell's first paint (the intro masks this migration).
document.body.classList.add("v2-ready");
applySettings();
persist(true);
refreshAll();
hydrateIDB();
initSecureToken();
if(S.calUrl)calSync(false);
renderFocus();

})();
