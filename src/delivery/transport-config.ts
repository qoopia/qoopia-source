import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {publicIdentity,type Identity} from '../bridges/protocol.ts';
import {durableWrite,privateDirectory,readJson,safePath} from '../utils/fs.ts';
const coordinate=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const publicDevice=z.object({id:z.string().uuid(),installation_id:z.string().uuid(),workspace_id:z.string().min(1).max(128),label:z.string().min(1).max(120),
  public_origin:z.string().url(),state:z.enum(['provisioning','active','revoked']),created_at:z.number(),revoked_at:z.number().nullable()}).strict();
export const transportConfigSchema=z.object({format:z.literal('qoopia-transport/1'),owner_id:z.string().min(1),workspace_id:z.string().min(1).max(128),installation_id:z.string().uuid(),
  identity:publicIdentity.extend({signPrivate:publicIdentity.shape.sign.extend({d:coordinate}),encryptPrivate:publicIdentity.shape.encrypt.extend({d:coordinate})}).strict(),
  tunnel_secret:z.string().regex(/^[A-Za-z0-9+/]{43}=$/),enabled:z.boolean(),device:publicDevice.optional(),
  tunnel:z.object({id:z.string().uuid(),account:z.string().regex(/^[a-f0-9]{32}$/)}).strict().optional(),
  flow:z.object({id:coordinate,verifier:coordinate,expires:z.number()}).strict().optional(),grant:coordinate.optional(),grant_expires:z.number().optional()}).strict();
export type TransportConfig=z.infer<typeof transportConfigSchema>&{identity:Identity};
function file(root:string){return safePath(path.join(root,'config/transport.json'));}
export function readTransport(root:string):TransportConfig|null {
  const name=file(root);if(!fs.existsSync(name))return null;
  const stat=fs.lstatSync(name);
  if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.mode&0o077||stat.size>16_384)throw new Error('Unsafe transport configuration');
  const value=transportConfigSchema.parse(readJson(name));
  if(value.device){
    const url=new URL(value.device.public_origin);
    if(url.protocol!=='https:'||url.port||url.pathname!=='/'||url.search||url.hash||url.username||url.password||
      value.device.installation_id!==value.installation_id||value.device.workspace_id!==value.workspace_id)throw new Error('Invalid device binding');
  }
  return value;
}
export function writeTransport(root:string,value:TransportConfig) {
  privateDirectory(path.join(root,'config'));durableWrite(file(root),JSON.stringify(transportConfigSchema.parse(value)));
}
