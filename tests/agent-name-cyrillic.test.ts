import {beforeAll,expect,test} from 'bun:test';
import {runMigrations} from '../src/db/migrate.ts';
import {db} from '../src/db/connection.ts';
import {createWorkspace} from '../src/admin/workspaces.ts';
import {createAgent} from '../src/admin/agents.ts';
import {agentStatus} from '../src/services/agent-comm.ts';
import {resolveAgentByName} from '../src/services/memory-policy.ts';
import {AGENT_NAME_RE,agentNameSkeleton} from '../src/utils/agent-name.ts';

let slug:string,workspace:string;
beforeAll(()=>{runMigrations();const ws=createWorkspace({name:'Cyrillic names',slug:'cyrillic-names'});slug=ws.slug;workspace=ws.id;});

test('Cyrillic agent names are accepted, NFC-normalized and trimmed',()=>{
  for(const name of ['Ассистент','Қазақ агент','ёжик-1','Бот_2'])expect(createAgent({name,workspaceSlug:slug}).name).toBe(name);
  // A decomposed «й» (и + combining breve) is stored composed.
  const decomposed='  Сергей  ';
  const created=createAgent({name:decomposed,workspaceSlug:slug});
  expect(created.name).toBe('Сергей');
  expect((db.query('SELECT name FROM agents WHERE id=?').get(created.id) as {name:string}).name).toBe('Сергей');
  expect(()=>createAgent({name:'Сергей',workspaceSlug:slug})).toThrow(/already exists/);
});

test('a name mixing scripts is refused, so a Cyrillic letter cannot hide inside a Latin name',()=>{
  for(const name of ['aаron','Аlex','Ivan Иван'])expect(()=>createAgent({name,workspaceSlug:slug})).toThrow(/invalid characters/);
  expect(AGENT_NAME_RE.test('aaron')).toBe(true);expect(AGENT_NAME_RE.test('Иван 2')).toBe(true);
  expect(AGENT_NAME_RE.test('Agent̆')).toBe(false);
});

test('uniqueness is case-insensitive for Cyrillic and catches look-alikes across scripts',()=>{
  expect(()=>createAgent({name:'АССИСТЕНТ',workspaceSlug:slug})).toThrow(/already exists/);
  createAgent({name:'TOM',workspaceSlug:slug});createAgent({name:'cop',workspaceSlug:slug});
  // All-Cyrillic spellings that read as the Latin names.
  expect(()=>createAgent({name:'ТОМ',workspaceSlug:slug})).toThrow(/reads the same/);
  expect(()=>createAgent({name:'сор',workspaceSlug:slug})).toThrow(/reads the same/);
  expect(agentNameSkeleton('\u0421l\u0430ude')).toBe(agentNameSkeleton('Claude'));
  // Different words stay distinct.
  expect(createAgent({name:'Том Сойер',workspaceSlug:slug}).name).toBe('Том Сойер');
});

test('AgentComm and memory-policy lookups match Cyrillic names in any case',()=>{
  expect(agentStatus({workspace_id:workspace,agent:'ассистент'}).agents.map(a=>a.name)).toEqual(['Ассистент']);
  expect(agentStatus({workspace_id:workspace,agent:'ҚАЗАҚ АГЕНТ'}).agents.map(a=>a.name)).toEqual(['Қазақ агент']);
  expect(resolveAgentByName(workspace,'ЁЖИК-1').name).toBe('ёжик-1');
});
