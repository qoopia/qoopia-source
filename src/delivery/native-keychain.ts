import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativeCommand} from '../utils/native-command.ts';
import {privateDirectory,safePath} from './files.ts';

let desktopHome:string|undefined;
// Bun derives os.userInfo().homedir from HOME too. Capture the desktop home
// before the standalone launcher replaces its own HOME with the data root.
export function bindNativeOwnerHome(home:string){desktopHome=safePath(home);}
export function nativeOwnerHome(){return desktopHome??os.homedir();}

/** Keychain references only. The isolated HOME never receives credential bytes or the owner's other preferences. */
export async function prepareNativeKeychain(home:string) {
  if(process.platform!=='darwin')return;
  const target=safePath(home),ownerHome=safePath(nativeOwnerHome());
  if(target===ownerHome)throw new Error('Native Keychain context must use an isolated HOME');
  privateDirectory(target);
  const run=(args:string[],selectedHome:string)=>nativeCommand('/usr/bin/security',args,{env:{HOME:selectedHome,PATH:'/usr/bin:/bin'}});
  const selected=await run(['default-keychain','-d','user'],ownerHome);
  let keychain:string;try{keychain=JSON.parse(selected.stdout.trim());}catch{throw new Error('Your default login Keychain is unavailable');}
  if(selected.status!==0||typeof keychain!=='string'||!path.isAbsolute(keychain))throw new Error('Your default login Keychain is unavailable');
  const file=fs.lstatSync(safePath(keychain));if(!file.isFile()||file.uid!==process.getuid?.())throw new Error('Login Keychain must belong to the local owner');
  privateDirectory(path.join(target,'Library','Preferences'));
  for(const command of ['default-keychain','list-keychains'])
    if((await run([command,'-d','user','-s',keychain],target)).status!==0)throw new Error('Could not connect isolated HOME to your login Keychain');
}
