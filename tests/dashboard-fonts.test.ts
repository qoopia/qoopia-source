// F-520-fonts: Chromium has no ui-monospace, so "ui-monospace,monospace" fell back to Courier, whose Cyrillic is a
// serif substitute; and a save waiting for confirmation (note prose) was set in the browser's default <pre> Courier.
import {expect,test} from 'bun:test';
import {dashboardStyles} from './helpers/dashboard-source.ts';

const rule=(selector:string)=>dashboardStyles.match(new RegExp('(?:^|\\n)'+selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' *\\{([^}]*)\\}'))?.[1]??'';

test('technical text names real monospace faces and note prose waiting for confirmation uses the body font',()=>{
 const mono=dashboardStyles.match(/--mono:([^;]+);/)![1]!.split(',').map(s=>s.trim().replace(/"/g,''));
 expect(mono[0]).toBe('ui-monospace');expect(mono.at(-1)).toBe('monospace');
 for(const face of ['SFMono-Regular','Menlo','Consolas'])expect(mono).toContain(face);
 expect(dashboardStyles).toContain('.mono, pre, code { font-family: var(--mono); }');
 expect(dashboardStyles).not.toMatch(/[:\s/]ui-monospace,monospace/); // every monospace use goes through --mono
 expect(rule('.memory-saves pre')).toContain('font:inherit');
});
