import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {privateDirectory,safePath} from './files.ts';

let desktopHome:string|undefined;
// Bun derives os.userInfo().homedir from HOME too. Capture the desktop home
// before the standalone launcher replaces its own HOME with the data root.
export function bindNativeOwnerHome(home:string){desktopHome=safePath(home);}
export function nativeOwnerHome(){return desktopHome??os.homedir();}

/** Keychain references only. The isolated HOME never receives credential bytes or the owner's other preferences. */
export function prepareNativeKeychain(home:string) {
  if(process.platform!=='darwin')return;
  const target=safePath(home),ownerHome=safePath(nativeOwnerHome());
  if(target===ownerHome)throw new Error('Native Keychain context must use an isolated HOME');
  privateDirectory(target);
  const run=(args:string[],selectedHome:string)=>spawnSync('/usr/bin/security',args,{env:{HOME:selectedHome,PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:10_000,maxBuffer:65536});
  const selected=run(['default-keychain','-d','user'],ownerHome);
  let keychain:string;try{keychain=JSON.parse(selected.stdout.trim());}catch{throw new Error('Your default login Keychain is unavailable');}
  if(selected.status!==0||typeof keychain!=='string'||!path.isAbsolute(keychain))throw new Error('Your default login Keychain is unavailable');
  const file=fs.lstatSync(safePath(keychain));if(!file.isFile()||file.uid!==process.getuid?.())throw new Error('Login Keychain must belong to the local owner');
  privateDirectory(path.join(target,'Library','Preferences'));
  for(const command of ['default-keychain','list-keychains'])
    if(run([command,'-d','user','-s',keychain],target).status!==0)throw new Error('Could not connect isolated HOME to your login Keychain');
}
