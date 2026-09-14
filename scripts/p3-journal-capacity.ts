// DESIGN measurement only. No production journal writer/compactor is invoked.
import { hash, MAX_JSON_BYTES } from '../src/delivery/files.ts';
import { opsPayload, RECOVERY_DELIVERY_HOLD, type OpsAlert } from '../src/delivery/ops-state.ts';
const event:OpsAlert={id:'00000000-0000-4000-8000-000000000001',installation:'capacity-fixture',component:'maintenance',subject:'daily',cause:'BACKUP_FAILED',active:false,state:'confirmed',attempts:1,next_attempt_at:1000,last_error:null,receipt:null};
event.receipt={event_id:event.id,payload_sha256:hash(JSON.stringify({id:event.id,event_type:'operational_alert',payload:opsPayload(event)})),accepted:true};
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),'utf8');
const measure=(installation:string)=>{
 const full={...event,installation};full.receipt={...event.receipt!,payload_sha256:hash(JSON.stringify({id:full.id,event_type:'operational_alert',payload:opsPayload(full)}))};
 const tombstone={installation,event_id:full.id,payload_sha256:full.receipt.payload_sha256,accepted:true};
 // /3 is a proposed future compact envelope, NOT an implemented format.
 const envelope={format:'qoopia-ops/3',delivery_hold:RECOVERY_DELIVERY_HOLD,last_run:{at:'2026-01-01T00:00:00.000Z',ok:true,cause:null},alerts:[],receipts:[]};
 const envelopeBytes=bytes(envelope),receiptBytes=bytes(tombstone),fullBytes=bytes(full);
 const capacity=Math.floor((MAX_JSON_BYTES-envelopeBytes+1)/(receiptBytes+1));
 const serializedAtCapacity=envelopeBytes+capacity*receiptBytes+Math.max(0,capacity-1);
 if(serializedAtCapacity>MAX_JSON_BYTES || serializedAtCapacity+receiptBytes+1<=MAX_JSON_BYTES)throw new Error('capacity calculation invalid');
 // Verify formula against actual serialization, not just handwritten arithmetic.
 const actual=bytes({...envelope,receipts:Array.from({length:capacity},()=>tombstone)});
 if(actual!==serializedAtCapacity)throw new Error('serialized size mismatch');
 return {installation_utf8_bytes:Buffer.byteLength(installation),full_event_bytes:fullBytes,receipt_bytes:receiptBytes,full_to_receipt_ratio:fullBytes/receiptBytes,envelope_bytes:envelopeBytes,receipt_only_capacity:capacity,serialized_bytes_at_capacity:actual,assumed_distinct_confirmed_events_per_day:[1,24,1440].map(rate=>({rate,days:capacity/rate,years_at_365_days:capacity/rate/365}))};
};
console.log(JSON.stringify({design_only:true,ceiling_bytes:MAX_JSON_BYTES,assumptions:'Resolved confirmations only; no pending/active event reserve. Rates are explicit scenarios, not observed production load. Repeated sample receipts measure serialized bytes only; actual IDs must be distinct.',cases:[measure('capacity-fixture'),measure('x'.repeat(200)),measure('界'.repeat(200))]},null,2));
