import {test,expect} from 'bun:test';
import {cloudflaredMaterials} from '../scripts/cloudflared-materials.ts';

test('Cloudflared attribution follows the actual platform module graph and refuses a different binary',()=>{
  const mac=cloudflaredMaterials('darwin-arm64','9a0b19f67dc7a3011bc6b972c7ce06a5fcea8784ac6bd599ffa382ea4aeb5a6e');
  const linux=cloudflaredMaterials('linux-x64','03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc');
  expect(mac.platform.go_version).toBe('go1.26.2');expect(linux.platform.go_version).toBe('go1.26.8');
  expect(mac.platform.dependencies.length).toBe(66);expect(linux.platform.dependencies.length).toBe(67);
  const inventory=JSON.parse(mac.materials.toString());
  const covered=new Map(inventory.modules.map((m:any)=>[m.module+'@'+m.version,m]));
  for(const platform of [mac.platform,linux.platform])for(const original of platform.dependencies){
    const module=original.replacement??original,record:any=covered.get(module.module+'@'+module.version);
    expect(record.h1_verified).toBe(true);expect(record.module_sum).toBe(module.sum);expect(record.notices.length).toBeGreaterThan(0);
    for(const notice of record.notices)expect(mac.notices.toString()).toContain('===== SHA256 '+notice.sha256+' =====');
  }
  expect(()=>cloudflaredMaterials('darwin-arm64',linux.platform.binary_sha256)).toThrow('another platform binary');
  expect(()=>cloudflaredMaterials('linux-x64','0'.repeat(64))).toThrow('another platform binary');
  expect(()=>cloudflaredMaterials('toString',mac.platform.binary_sha256)).toThrow('another platform binary');
});
