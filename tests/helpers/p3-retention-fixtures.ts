import { hash, MAX_JSON_BYTES } from '../../src/delivery/files.ts';
import { OPS_JOURNAL_FORMAT, opsPayload, opsSerializedSize, type OpsAlert, type OpsState } from '../../src/delivery/ops-state.ts';
export const fixtureId=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
export function retentionAlert(n:number, confirmed=false, instance='scopeb-fixture'):OpsAlert {
 const a:OpsAlert={id:fixtureId(n),installation:instance,component:'maintenance',subject:'daily',cause:'BACKUP_FAILED',active:false,state:confirmed?'confirmed':'pending',attempts:confirmed?1:0,next_attempt_at:0,last_error:confirmed?null:'NO_CHANNEL',receipt:null};
 if(confirmed)a.receipt={event_id:a.id,payload_sha256:hash(JSON.stringify({id:a.id,event_type:'operational_alert',payload:opsPayload(a)})),accepted:true};
 return a;
}
export const retentionState=(alerts:OpsAlert[]):OpsState=>({format:OPS_JOURNAL_FORMAT,last_run:null,alerts});
/** Deterministic distinct IDs; tune valid integer widths to exactly 16 MiB, no padding. */
export function exactPendingBoundary(offset=0, confirmed=false, instance='scopeb-fixture'):OpsState {
 const state=retentionState([]), seed=retentionAlert(offset+1,confirmed,instance);
 const count=Math.floor((MAX_JSON_BYTES-opsSerializedSize(state)+1)/(Buffer.byteLength(JSON.stringify(seed))+1));
 state.alerts=Array.from({length:count},(_,i)=>retentionAlert(offset+i+1,confirmed,instance));
 let remaining=MAX_JSON_BYTES-opsSerializedSize(state);
 for(const a of state.alerts){
  const growth=Math.min(remaining,15);a.attempts=10**growth;remaining-=growth;
  if(!remaining)break;
 }
 if(remaining || opsSerializedSize(state)!==MAX_JSON_BYTES)throw new Error('Boundary fixture invalid');
 return state;
}
