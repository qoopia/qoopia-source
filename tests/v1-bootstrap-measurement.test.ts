import {test,expect} from 'bun:test';
import {measureBootstrap} from '../scripts/measure-bootstrap.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// This fake executable is only the INPUT fixture for the resource-measurement helper,
// not a Qoopia/model/release qualification result. The helper measures the real child.
test('bootstrap measurement inspects the child output file and actual resource usage',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qoopia-measure-test-')));
 try {
  const exe=path.join(root,'fixture');
  // _embed-probe stands in for the first built-in embedding, whose model stays resident (F-307).
  fs.writeFileSync(exe,`#!/bin/sh\n[ "$2" = "--root" ] || exit 2\ncase "$1" in\n_migrate) mkdir -p "$3/data"; printf "fixture bytes" > "$3/data/qoopia.db";;\n_embed-probe) exec '${process.execPath}' -e 'Buffer.alloc(2e8).fill(1)';;\n*) exit 2;;\nesac\n`,{mode:0o700});
  const sample=measureBootstrap(exe);
  expect(sample.initial_database_bytes).toBe(Buffer.byteLength('fixture bytes'));
  expect(sample.bootstrap_peak_rss_bytes).toBeGreaterThan(2e8);
  expect<string>(sample.target).toBe(`${process.platform}-${process.arch}`);
  fs.writeFileSync(exe,'#!/bin/sh\nexit 42\n',{mode:0o700});
  expect(()=>measureBootstrap(exe)).toThrow('Bootstrap measurement failed');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
