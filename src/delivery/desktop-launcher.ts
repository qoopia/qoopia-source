import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {hash,safePath,readJsonBytes,durableWrite,privateDirectory} from './files.ts';
import {stdioBindingSchema,stdioFolder} from './stdio-oauth.ts';

const receiptSchema=z.object({format:z.literal('qoopia-desktop-launcher/1'),binding_hash:z.string().regex(/^[a-f0-9]{64}$/),
  script_hash:z.string().regex(/^[a-f0-9]{64}$/),previous_script_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),state:z.enum(['pending','applied'])}).strict();
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
function owned(file:string){
  const bytes=readJsonBytes(file),stat=fs.lstatSync(file);
  if(stat.uid!==process.getuid!()||stat.mode&0o077)throw new Error('Local adapter file must belong to this user and be private');return bytes;
}

/** macOS ships plutil; the launcher follows the installation pointer across updates.
 * A server-only selection uses the installed app executable and never creates a local memory database.
 */
export function prepareDesktopLauncher(root:string,raw:unknown,binary:string,apply=false,allowTestFixture=false) {
  const binding=stdioBindingSchema.parse(raw),folder=stdioFolder(root,binding),file=path.join(folder,'binding.json'),launcher=path.join(folder,'launch.sh');
  root=safePath(root);binary=safePath(binary);
  if(/[\0\r\n]/.test(root+binary))throw new Error('Invalid adapter installation path');
  const bindingBytes=JSON.stringify(binding),bindingHash=hash(bindingBytes),receiptFile=path.join(folder,'desktop-launcher.json');
  const receipt=fs.existsSync(receiptFile)?receiptSchema.parse(JSON.parse(owned(receiptFile).toString())):null;
  if(receipt&&receipt.binding_hash!==bindingHash)throw new Error('Local adapter belongs to another connection');
  const script='#!/bin/sh\nset -eu\nroot='+quote(root)+'\nbinary='+quote(binary)+'\n'+
    'if [ -f "$root/current.json" ]; then\n'+
    '  selected=$(/usr/bin/plutil -extract bundle raw -o - "$root/current.json") || exit 64\n'+
    '  case "$selected" in ""|*[!0-9a-f]*) exit 64 ;; esac\n'+
    '  [ "${#selected}" -eq 64 ] || exit 64\n'+
    '  binary="$root/bundles/$selected/qoopia"\nfi\n'+
    'exec "$binary" client-stdio --root "$root" --file '+quote(file)+(allowTestFixture?' --allow-test-fixture':'')+'\n';
  const scriptHash=hash(script),existing=fs.existsSync(launcher)?owned(launcher):null;
  if(existing&&(!receipt||![receipt.script_hash,receipt.previous_script_hash].includes(hash(existing))))throw new Error('Local adapter launcher changed outside Qoopia; it was preserved');
  if(fs.existsSync(file)&&(!receipt||hash(owned(file))!==bindingHash))throw new Error('Local adapter selection changed outside Qoopia; it was preserved');
  const result={entry:{command:'/bin/sh',args:[launcher]},binding_file:file,launcher_digest:scriptHash};
  if(!apply)return result;
  privateDirectory(root);privateDirectory(folder);
  durableWrite(receiptFile,JSON.stringify({format:'qoopia-desktop-launcher/1',binding_hash:bindingHash,script_hash:scriptHash,
    ...(existing?{previous_script_hash:hash(existing)}:{}),state:'pending'}));
  // Recover a retry after either file's publication; tokens live in a separate protected file.
  durableWrite(file,bindingBytes);durableWrite(launcher,script,0o700);
  durableWrite(receiptFile,JSON.stringify({format:'qoopia-desktop-launcher/1',binding_hash:bindingHash,script_hash:scriptHash,state:'applied'}));
  return result;
}
