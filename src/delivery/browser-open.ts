import os from 'node:os';
import { spawnSync } from 'node:child_process';

export function browserEnvironment(source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const result:NodeJS.ProcessEnv={HOME:source.HOME??os.homedir()};
  for(const key of ['PATH','DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR',
    'XDG_CURRENT_DESKTOP','XDG_SESSION_DESKTOP','XDG_SESSION_TYPE','DESKTOP_SESSION','XDG_CONFIG_HOME','XDG_DATA_HOME',
    'XDG_CONFIG_DIRS','XDG_DATA_DIRS','LANG','LC_ALL','LC_MESSAGES'])if(source[key]!==undefined)result[key]=source[key];
  return result;
}

/** A missing desktop utility may fall back; a launched opener must never be retried with a second browser. */
export function openBrowser(url:string,environment:NodeJS.ProcessEnv,platform:NodeJS.Platform=process.platform):boolean {
  const commands=platform==='darwin'?[['/usr/bin/open',url]]:platform==='linux'
    ?[['xdg-open',url],['exo-open','--launch','WebBrowser',url],['gio','open',url]]:[];
  for(const [command,...args] of commands){
    const child=spawnSync(command!,args,{stdio:'ignore',env:environment,timeout:15_000});
    if(!child.error)return child.status===0;
    if((child.error as NodeJS.ErrnoException).code!=='ENOENT')return false;
  }
  return false;
}
