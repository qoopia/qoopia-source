import fs from 'node:fs';
import {hash} from '../src/delivery/files.ts';

const materialsDigest='58e26a5f5c683b375133756853f8b4b12011e68823fa7e3820dde4fd819aee04';
const noticesDigest='ba284661f932abdd1685b7a202224d3c2e8e44d27348d205202560dcd4e82910';
type Module={module:string;version:string;sum:string;replacement?:{module:string;version:string;sum:string}};
type Platform={binary_sha256:string;go_version:string;dependencies:Module[];settings:Record<string,string>};

/** Attribution is bound to each exact upstream binary, including its Go toolchain
 * and replacement modules. This inventory does not authorize a public release.
 */
export function cloudflaredMaterials(target:string,binaryDigest:string) {
  const materials=fs.readFileSync('scripts/vendor/licenses/cloudflared-2026.9.1-MATERIALS.json');
  const notices=fs.readFileSync('scripts/vendor/licenses/cloudflared-2026.9.1-NOTICES.txt');
  if(hash(materials)!==materialsDigest||hash(notices)!==noticesDigest)throw new Error('Tunnel transitive attribution provenance drift');
  const inventory=JSON.parse(materials.toString()) as {platforms:Record<string,Platform>};
  const platform=Object.hasOwn(inventory.platforms,target)?inventory.platforms[target]:undefined;
  if(!platform||platform.binary_sha256!==binaryDigest)throw new Error('Tunnel attribution belongs to another platform binary');
  return {materials,notices,platform,materials_sha256:materialsDigest,notices_sha256:noticesDigest};
}
