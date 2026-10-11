// F-520-activity: Overview > Live activity printed the server's English summaries with raw note ids
// ("Created note 01M4MNWQV43XF4Y0TEMNJK8SQX") on Russian and English pages alike.
import {expect,test} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {dashboardScript} from './helpers/dashboard-source.ts';

const ru:Record<string,string>=JSON.parse(readFileSync(new URL('../src/public/brand/i18n.ru.json',import.meta.url),'utf8'));
const code=dashboardScript.slice(dashboardScript.indexOf('  const NOTE_EVENTS'),dashboardScript.indexOf('  // One line per event'));
const QI={msg:(s:string,p:Record<string,string>={})=>{expect(ru[s],s).toBeString();return ru[s]!.replace(/\{(\w+)\}/g,(_,k)=>p[k]!);}};
const {activityText}=runInNewContext(code+';({activityText})',{QI});
const row=(action:string,entity_type:string,summary:string)=>activityText({action,entity_type,summary});

test('events Qoopia records read in the page language without raw ids; names and agent-written text stay verbatim',()=>{
 expect(row('created','note','Created note 01M4MNWQV43XF4Y0TEMNJK8SQX')).toBe('Заметка сохранена');
 expect(row('created','note','Created memory (private)')).toBe('Заметка сохранена');
 expect(row('updated','note','Updated note: text, tags')).toBe('Заметка изменена');
 expect(row('deleted','note','Deleted note 01ABC')).toBe('Заметка удалена');
 expect(row('note_superseded','note','Superseded 01A with 01B')).toBe('Заметка заменена новой версией');
 expect(row('relation_created','note_relation','Created supports note relation')).toBe('Заметки связаны');
 expect(row('file_upload','file','Uploaded report to Q3.pdf to /inbox')).toBe('Файл report to Q3.pdf загружен в /inbox');
 expect(row('file_delete','file','Deleted a.txt from /tmp')).toBe('Файл a.txt удалён из /tmp');
 expect(row('agent_session_create','agent_comm_session','Created agent session: План релиза')).toBe('Начат разговор агентов: План релиза');
 expect(row('agent_session_close','agent_comm_session','Closed agent session')).toBe('Разговор агентов завершён');
 expect(row('agent_send','agent_comm_message','Agent message request to Aizek')).toBe('Сообщение для Aizek');
 // An agent's own words (compat activity_log) and unknown events are not rewritten.
 expect(row('deploy','task','Выкатил сборку 42')).toBe('Выкатил сборку 42');
 expect(row('agent_wake_sent','agent','')).toBe('agent_wake_sent · agent');
 for(const [action,type,summary] of [['created','note','Created note 01M4MNWQV43XF4Y0TEMNJK8SQX'],['deleted','note','Deleted note 01M4MNWQV43XF4Y0TEMNJK8SQX']])expect(row(action!,type!,summary!)).not.toMatch(/01M4|Created|Deleted/);
});
