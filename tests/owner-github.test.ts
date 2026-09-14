import {test,expect} from 'bun:test';
import {githubPanel} from '../src/identity/owner-github.ts';
import {githubFixture} from './helpers/owner-github-fixture.ts';
test('owner GitHub distinguishes unavailable clones, empty forks, stale collection and escapes external content',()=>{
 const report=githubFixture(),html=githubPanel(report,[],true,true);
 expect(html).toContain('Данные GitHub свежие');expect(html).toContain('HTTP_403');expect(html).toContain('GitHub не вернул записей');
 expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('href="javascript:');
 expect(html).toContain('https://github.com/qoopia/qoopia-source/pull/1');expect(html).toContain('<td>25</td>');
 expect(githubPanel(report,[],true,false)).toContain('устарел');report.observed_at='2020-01-01';expect(githubPanel(report,[],true,true)).toContain('устарел');
 expect(githubPanel(null,[],false,false)).toContain('not arrived');
});
test('history preserves daily uniques without summing people and separates repository scopes',()=>{
 const history=[{metric:'views_uniques',day:'2026-09-14',value:7,dimensions:{repository:'qoopia/qoopia-source',period:'day'}},{metric:'views_uniques',day:'2026-09-14',value:999,dimensions:{repository:'qoopia/private',period:'day'}}];
 const html=githubPanel(githubFixture(),history,true,true);expect(html).toContain('<td>7</td>');expect(html).not.toContain('999');expect(html).toContain('нельзя складывать');
});
