/** Advisory expiry metadata from this workspace's selected native login store only.
 * Access-token expiry is not a subscription/session deadline: official CLIs may refresh it.
 * Missing metadata (including OS Keychain stores) stays unknown; inference remains the authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {MemoryProfile} from './memory-model.ts';
export const MEMORY_SIGN_IN_WARNING_MS=30*60_000;
export function memorySignInExpiry(profile:MemoryProfile,now=Date.now()) {
  let expires:number|null=null,refresh=false;
  let fd:number|undefined;
  try {
    const file=path.join(profile.login_store,profile.runtime==='codex'?'auth.json':'.credentials.json');
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>65536||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw Error('unsafe');
    const value=JSON.parse(fs.readFileSync(fd,'utf8'));
    if(profile.runtime==='claude_code') {
      const oauth=value?.claudeAiOauth;
      if(typeof oauth?.expiresAt==='number')expires=oauth.expiresAt;
      refresh=typeof oauth?.refreshToken==='string'&&oauth.refreshToken.length>0;
    } else {
      // The id token's expiry is an identity assertion, not the model's access expiry.
      const token=value?.tokens?.access_token;
      if(typeof token==='string'&&token.length<16384) {
        const payload=JSON.parse(Buffer.from(token.split('.')[1]??'','base64url').toString('utf8'));
        if(typeof payload?.exp==='number')expires=payload.exp*1000;
      }
      refresh=typeof value?.tokens?.refresh_token==='string'&&value.tokens.refresh_token.length>0;
    }
  }catch{/* Unknown is honest; never expose credential bytes or parser errors. */}
  finally{if(fd!==undefined)fs.closeSync(fd);}
  if(expires===null||!Number.isFinite(expires)||expires<=0||expires>8.64e15)return {state:'unknown' as const,access_expires_at:null,refresh_available:refresh};
  return {state:expires<=now?'expired' as const:expires-now<=MEMORY_SIGN_IN_WARNING_MS?'expiring' as const:'valid' as const,
    access_expires_at:new Date(expires).toISOString(),refresh_available:refresh};
}
