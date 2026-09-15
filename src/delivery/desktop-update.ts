import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {verifyBundle} from './bundle.ts';
import {readJson} from '../utils/fs.ts';
import {Delivery,readCurrent,dataFile} from './operations.ts';
import {openWritableDatabase,configureReadonlyDatabase} from '../db/sqlite.ts';

export const desktopReleaseSchema=z.object({format:z.literal('qoopia-desktop-release/1'),build:z.number().int().positive().safe(),version:z.string().regex(/^\d+\.\d+\.\d+$/),public_ed_key:z.string().regex(/^[A-Za-z0-9+/]{43}=$/),feed_url:z.literal('https://qoopia.ai/updates/macos/appcast.xml')}).strict();
export const DESKTOP_RELEASE='DESKTOP-RELEASE.json';
/** Opening an updated, signed app adopts its bundled runtime through the existing
 * backup + writer barrier + atomic cutover. Never replace the data directory. */
export function prepareDesktopUpdate(delivery:Delivery,bundle:string,trust:string,allowTest=false){
  const target=verifyBundle(bundle,trust,allowTest);
  const targetRelease=target.manifest.members[DESKTOP_RELEASE]?desktopReleaseSchema.parse(readJson(path.join(bundle,DESKTOP_RELEASE))):null;
  if(!targetRelease)throw new Error('Desktop release metadata is missing');
  if(!fs.existsSync(path.join(delivery.root,'current.json')))return {state:'first_install',binary:path.join(bundle,'qoopia')};
  const current=readCurrent(delivery.root),selected=path.join(delivery.root,'bundles',current.bundle);
  if(current.bundle===target.digest)return {state:'current',binary:path.join(selected,'qoopia')};
  const installed=verifyBundle(selected,trust,allowTest);
  const previous=installed.manifest.members[DESKTOP_RELEASE]?desktopReleaseSchema.parse(readJson(path.join(selected,DESKTOP_RELEASE))):null;
  if(previous&&previous.build>=targetRelease.build)throw new Error('This app is older than the installed Qoopia. Open the newer application.');
  // A cleanly closed WAL database may have no -wal/-shm files. SQLite needs
  // a read/write opener to initialize them before the read-only snapshot checks.
  // Keep this query-only handle alive through cutover; no application rows change.
  const source=openWritableDatabase(dataFile(delivery.root,current));
  try {
  configureReadonlyDatabase(source);
  source.query('SELECT count(*) FROM sqlite_master').get();
  const plan=delivery.previewUpdate(bundle);
  const updated=delivery.update(bundle,plan,plan.plan_digest);
  return {state:'updated',binary:path.join(delivery.root,'bundles',updated.bundle,'qoopia'),memory_preserved:true,backup_created:true};
  } finally { source.close(); }
}
