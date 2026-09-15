import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hash } from '../src/utils/fs.ts';

describe('generated third-party notice coverage', () => {
  test('covers the complete production graph with authentic notice bodies', () => {
    const run=spawnSync(process.execPath,['scripts/build-bundle.ts','--notice-check'],{encoding:'utf8'});
    expect(run.status).toBe(0);
    const result=JSON.parse(run.stdout.trim());
    const provenance=JSON.parse(fs.readFileSync('scripts/vendor/licenses/isarray-1.0.0.json','utf8'));
    const readme=fs.readFileSync('node_modules/isarray/README.md','utf8');
    expect(result).toMatchObject({
      status:'NOTICE_COVERAGE_CHECK',dependencies:120,covered:120,missing:[],
      runtime_notice:{version:'1.3.11',source_commit:'a04817ce2b7f1a1e8b7cbf8af8f2c027ab072f1d',license_file:'LICENSE.md',license_source:'https://raw.githubusercontent.com/oven-sh/bun/a04817ce2b7f1a1e8b7cbf8af8f2c027ab072f1d/LICENSE.md',license_sha256:'7068a9711ef8196d654e143447ed7976b3678ce21145b9da16e1f786528f15bb',third_party_licenses:'INTEGRATED_IN_CANONICAL_LICENSE_MD'},
    });
    const bunLicense=fs.readFileSync('scripts/vendor/licenses/bun-1.3.11-LICENSE.md','utf8');
    expect(hash(bunLicense)).toBe(result.runtime_notice.license_sha256);
    for(const marker of ['## JavaScriptCore','## Linked libraries','## Polyfills','## Additional credits','boringssl','libarchive','uWebsockets'])expect(bunLicense).toContain(marker);
    expect(provenance.body).toBe(readme.slice(readme.indexOf('(MIT)')));
    expect(hash(provenance.body)).toBe(result.overrides[0].body_sha256);
    expect(hash(fs.readFileSync('node_modules/isarray/README.md'))).toBe(result.overrides[0].source_sha256);
    expect(result.overrides[0].package).toBe('isarray@1.0.0');
    expect(JSON.parse(fs.readFileSync('node_modules/dingbat-to-unicode/package.json','utf8')).name).toBe('@qoopia/transpect-fontmap-to-unicode');
  });
});
