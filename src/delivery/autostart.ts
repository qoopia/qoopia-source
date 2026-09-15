import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {Database} from 'bun:sqlite';
import { durableWrite, hash, privateDirectory, readJson, safePath, syncDirectory } from '../utils/fs.ts';

const ledgerSchema=z.object({format:z.literal('qoopia-autostart-ledger/1'),installation:z.string().min(1),platform:z.enum(['darwin','linux']),
  native_config:z.string(),config_sha256:z.string().regex(/^[a-f0-9]{64}$/),executable_sha256:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['pending','enabled'])}).strict();
type Ledger=z.infer<typeof ledgerSchema>;
export type ServiceExecutor=(command:string,args:string[])=>void;
export interface AutostartLifecycle { remove():{autostart:'never_enabled'|'removed';native_files_touched:number}; }

export function linuxUserManagerEnvironment(platform:NodeJS.Platform,source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  if(platform!=='linux')return {};
  const runtime=source.XDG_RUNTIME_DIR,bus=source.DBUS_SESSION_BUS_ADDRESS,env:NodeJS.ProcessEnv={};
  if(runtime!==undefined){if(!path.isAbsolute(runtime)||/[\0\r\n]/.test(runtime))throw new Error('Invalid XDG_RUNTIME_DIR for Linux user manager');env.XDG_RUNTIME_DIR=runtime;}
  if(bus!==undefined){if(!/^unix:(?:path|abstract)=/.test(bus)||/[\0\r\n]/.test(bus))throw new Error('Invalid DBUS_SESSION_BUS_ADDRESS for Linux user manager');env.DBUS_SESSION_BUS_ADDRESS=bus;}
  return env;
}

function clean(value:string){if(/[\0\r\n]/.test(value))throw new Error('Autostart paths cannot contain control characters');return value;}
function xml(value:string){return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
function systemd(value:string){return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';}
function ownedDirectory(directory:string){
  if(!fs.existsSync(directory))return privateDirectory(directory);
  const stat=fs.lstatSync(safePath(directory));
  if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o022))throw new Error('Autostart directory must be owner-controlled');
  return directory;
}
function regular(file:string){
  const fd=fs.openSync(safePath(file),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw new Error('Autostart config must be one regular file');return {bytes:fs.readFileSync(fd),dev:stat.dev,ino:stat.ino};}finally{fs.closeSync(fd);}
}

export class UserAutostart implements AutostartLifecycle {
  readonly root:string;readonly configFile:string;readonly ledgerFile:string;
  constructor(readonly options:{root:string;installation:string;platform:'darwin'|'linux';configFile:string;execute:ServiceExecutor;allowTestFixture?:boolean}) {
    this.root=safePath(options.root);this.configFile=safePath(clean(options.configFile));this.ledgerFile=path.join(this.root,'config','autostart.json');
  }
  private bytes(executable:string){
    const binary=clean(safePath(executable)),root=clean(this.root),allow=this.options.allowTestFixture?'--allow-test-fixture':'';
    if(this.options.platform==='darwin')return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.qoopia.server</string><key>ProgramArguments</key><array><string>${xml(binary)}</string><string>start</string><string>--root</string><string>${xml(root)}</string>${allow?`<string>${allow}</string>`:''}</array><key>RunAtLoad</key><true/></dict></plist>\n`;
    return `[Unit]\nDescription=Qoopia user service\n[Service]\nExecStart=${systemd(binary)} start --root ${systemd(root)}${allow?' '+allow:''}\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`;
  }
  private ledger():Ledger|null {
    if(!fs.existsSync(this.ledgerFile))return null;
    const value=ledgerSchema.parse(readJson(this.ledgerFile));
    if(value.installation!==this.options.installation)throw new Error('Autostart ledger belongs to another installation');
    if(value.platform!==this.options.platform||safePath(value.native_config)!==this.configFile)throw new Error('Autostart native config identity mismatch');
    return value;
  }
  private run(action:'install'|'remove'){
    if(this.options.platform==='darwin')this.options.execute('/bin/launchctl',[action==='install'?'load':'unload',this.configFile]);
    else if(action==='install'){
      this.options.execute('/usr/bin/systemctl',['--user','daemon-reload']);
      this.options.execute('/usr/bin/systemctl',['--user','enable','--now',this.configFile]);
    }else this.options.execute('/usr/bin/systemctl',['--user','disable','--now',path.basename(this.configFile)]);
  }
  private locked<T>(operation:()=>T):T {
    privateDirectory(path.join(this.root,'config'));
    const file=safePath(path.join(this.root,'config','autostart-control.sqlite'));
    if(fs.existsSync(file)){
      const stat=fs.lstatSync(file);if(stat.uid!==process.getuid?.()||stat.mode&0o077)throw new Error('Unsafe autostart control lock');
    }
    const database=new Database(file,{create:true});fs.chmodSync(file,0o600);
    try{
      database.run('PRAGMA busy_timeout=0');database.run('CREATE TABLE IF NOT EXISTS lock_state(id INTEGER PRIMARY KEY)');
      database.run('BEGIN IMMEDIATE');
      try{return operation();}finally{database.run('ROLLBACK');}
    }finally{database.close();}
  }
  install(executable:string){return this.locked(()=>this.installUnlocked(executable));}
  private installUnlocked(executable:string){
    const bytes=this.bytes(executable),config_sha256=hash(bytes),executable_sha256=hash(regular(executable).bytes),old=this.ledger();
    if(old){
      if(old.config_sha256!==config_sha256||old.executable_sha256!==executable_sha256)throw new Error('Autostart executable/config changed; remove the owned service before replacing it');
      const current=regular(this.configFile).bytes;if(hash(current)!==old.config_sha256)throw new Error('Autostart native config changed; installer ownership check refused');
      if(old.state==='enabled')return {autostart:'enabled' as const,native_files_touched:0};
      this.run('install');durableWrite(this.ledgerFile,JSON.stringify({...old,state:'enabled'}));return {autostart:'enabled' as const,native_files_touched:0};
    }
    if(fs.existsSync(this.configFile))throw new Error('Autostart native config is not installer-owned');
    ownedDirectory(path.dirname(this.configFile));privateDirectory(path.dirname(this.ledgerFile));
    durableWrite(this.configFile,bytes);
    const ledger:Ledger={format:'qoopia-autostart-ledger/1',installation:this.options.installation,platform:this.options.platform,native_config:this.configFile,config_sha256,executable_sha256,state:'pending'};
    durableWrite(this.ledgerFile,JSON.stringify(ledger));this.run('install');if(hash(regular(this.configFile).bytes)!==config_sha256)throw new Error('Autostart native config changed during install');durableWrite(this.ledgerFile,JSON.stringify({...ledger,state:'enabled'}));
    return {autostart:'enabled' as const,native_files_touched:1};
  }
  remove(){return this.locked(()=>this.removeUnlocked());}
  private removeUnlocked(){
    const ledger=this.ledger();if(!ledger)return {autostart:'never_enabled' as const,native_files_touched:0};
    const exists=fs.existsSync(this.configFile),before=exists?regular(this.configFile):null;
    if(before&&hash(before.bytes)!==ledger.config_sha256)throw new Error('Autostart native config changed; ownership-safe removal refused');
    this.run('remove');
    if(before){const after=regular(this.configFile);if(after.dev!==before.dev||after.ino!==before.ino||hash(after.bytes)!==ledger.config_sha256)throw new Error('Autostart native config changed during removal; replacement preserved');fs.unlinkSync(this.configFile);syncDirectory(path.dirname(this.configFile));}
    if(this.options.platform==='linux')this.options.execute('/usr/bin/systemctl',['--user','daemon-reload']);
    fs.unlinkSync(this.ledgerFile);syncDirectory(path.dirname(this.ledgerFile));
    return {autostart:'removed' as const,native_files_touched:exists?1:0};
  }
}

export const disabledAutostart:AutostartLifecycle={remove:()=>({autostart:'never_enabled',native_files_touched:0})};
