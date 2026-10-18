import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {memorySignInExpiry} from '../src/services/memory-sign-in.ts';

test('advisory expiry uses only the selected store, never exposes tokens, and distinguishes refresh from login',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-expiry-'));
  const now=Date.now(),profile={runtime:'claude_code' as const,model:'claude-haiku-4-5',login_backend:'config-dir' as const,login_store:root};
  try{
    expect(memorySignInExpiry(profile,now).state).toBe('unknown');
    const file=path.join(root,'.credentials.json');
    fs.writeFileSync(file,JSON.stringify({claudeAiOauth:{expiresAt:now+600_000,refreshToken:'synthetic-refresh',accessToken:'synthetic-access'}}),{mode:0o600});
    expect(memorySignInExpiry(profile,now)).toMatchObject({state:'expiring',refresh_available:true,access_expires_at:new Date(now+600_000).toISOString()});
    expect(JSON.stringify(memorySignInExpiry(profile,now))).not.toContain('synthetic-');
    expect(memorySignInExpiry(profile,now+700_000).state).toBe('expired');
    fs.chmodSync(file,0o644);expect(memorySignInExpiry(profile,now).state).toBe('unknown');
    fs.unlinkSync(file);fs.symlinkSync('/no-such-fixture',file);expect(memorySignInExpiry(profile,now).state).toBe('unknown');
    const jwt='header.'+Buffer.from(JSON.stringify({exp:Math.floor((now+3600_000)/1000)})).toString('base64url')+'.signature';
    fs.writeFileSync(path.join(root,'auth.json'),JSON.stringify({tokens:{access_token:jwt,refresh_token:'synthetic-refresh',id_token:'ignore-me'}}),{mode:0o600});
    expect(memorySignInExpiry({...profile,runtime:'codex'},now)).toMatchObject({state:'valid',refresh_available:true});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
