// Qualification helpers are deliberately test-only, even when launched from a production-configured shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const qualificationAmbientRoot=process.env.QOOPIA_ROOT;
if(!process.env.QOOPIA_ROOT&&!process.env.QOOPIA_DATA_DIR){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-qualification-environment-'));
  Object.assign(process.env,{QOOPIA_ROOT:root,QOOPIA_DATA_DIR:path.join(root,'data'),QOOPIA_LOG_DIR:path.join(root,'logs'),QOOPIA_BACKUP_DIR:path.join(root,'backups')});
  process.once('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
}
process.env.NODE_ENV='test';
process.env.QOOPIA_SERVER_ROLE='canonical';
process.env.QOOPIA_HOST='127.0.0.1';
process.env.QOOPIA_PORT='0';
