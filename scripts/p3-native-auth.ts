// Controller selection only. Native credential validation/redaction stays in the existing adapter.
import { nativeLaunch, QUALIFICATION_MODELS } from '../src/skills/adapter.ts';

export function claudeAuthMode(mode:string|undefined,store:string|undefined,execute:boolean){
  const selected=mode??'subscription-store';
  if(!['subscription','subscription-store'].includes(selected))throw new Error('Select Claude subscription or subscription-store explicitly; no API/keychain/automatic mode');
  if(selected==='subscription'&&store!==undefined)throw new Error('Claude subscription cannot select a login store');
  if(!execute&&store!==undefined)throw new Error('No real stores in no-model checks');
  if(execute&&selected==='subscription-store'&&!store)throw new Error('Claude subscription-store requires an explicit config-dir path');
  return selected as 'subscription'|'subscription-store';
}

export function bindAuthSelector(selected:unknown,previous:unknown){
  if(JSON.stringify(selected)!==JSON.stringify(previous))throw new Error('Native auth selector changed; resume refused');
}

export function claudeEnvironment(root:string,source:NodeJS.ProcessEnv){
  // Pure launch preparation: no process, file/store read or auth probe. The adapter validates the selected env credential.
  return nativeLaunch('claude_code',root,'Explicit subscription environment selection only',
    {auth_mode:'subscription',...QUALIFICATION_MODELS.claude_code},source,root);
}
