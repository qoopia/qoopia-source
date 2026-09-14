import path from 'node:path';
import {safePath} from './files.ts';

type Surface='codex'|'claude_code';
let captured:Partial<Record<Surface,string>>|undefined;
const variable=(surface:Surface)=>surface==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR';
export function nativeClientDirectory(surface:Surface,source:NodeJS.ProcessEnv=process.env) {
  const value=source[variable(surface)];
  if(value===undefined)return undefined;
  if(!value||!path.isAbsolute(value)||/[\0\r\n]/.test(value))throw new Error('Native client directory must be an absolute path');
  return safePath(value);
}
/** Capture only nonsecret path preferences before the service isolates its environment. */
export function bindNativeClientDirectories(source:NodeJS.ProcessEnv) {
  captured={codex:nativeClientDirectory('codex',source),claude_code:nativeClientDirectory('claude_code',source)};
}
export function selectedNativeDirectory(surface:Surface) {
  return captured?captured[surface]:nativeClientDirectory(surface);
}
