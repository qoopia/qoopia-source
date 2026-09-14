import {test,expect} from 'bun:test';
import {ownerFixture} from './helpers/p1-fixtures.ts';
import {bootstrapOwner} from '../src/auth/pairings.ts';
import {stewardCommand} from '../src/delivery/steward.ts';

test('local steward assignment previews, detects stale policy and preserves owner/key/profile with an audit record',()=>{
  const {database:d,owner}=ownerFixture(41);
  try{
    d.query("INSERT INTO agents(id,workspace_id,name,type,api_key_hash,tool_profile) VALUES ('native',?,'Native','standard','fixture-hash','no-destructive')").run(owner.workspace_id);
    const before=d.query("SELECT * FROM agents WHERE id='native'").get() as Record<string,unknown>;
    const preview=stewardCommand(d,{agentId:'native'});
    expect(d.query("SELECT type FROM agents WHERE id='native'").get()).toEqual({type:'standard'});
    expect(()=>stewardCommand(d,{agentId:'native',commit:true,approve:'wrong'})).toThrow('preview again');
    d.query("UPDATE agents SET tool_profile='full' WHERE id='native'").run();
    expect(()=>stewardCommand(d,{agentId:'native',commit:true,approve:preview.plan_digest})).toThrow('preview again');
    const plan=stewardCommand(d,{agentId:'native'});
    expect(stewardCommand(d,{agentId:'native',commit:true,approve:plan.plan_digest}).state).toBe('assigned');
    const after=d.query("SELECT * FROM agents WHERE id='native'").get() as Record<string,unknown>;
    expect(after.api_key_hash).toBe(before.api_key_hash);
    expect(after.principal_kind).toBe('agent');expect(after.authority_profile).toBe(before.authority_profile);
    expect(after.tool_profile).toBe('full');expect(Number(after.policy_epoch)).toBeGreaterThan(Number(before.policy_epoch));
    expect(after.session_version).toBe(Number(before.session_version)+1);
    expect(stewardCommand(d,{}).steward?.id).toBe('native');
    const repeat=stewardCommand(d,{agentId:'native'});
    expect(stewardCommand(d,{agentId:'native',commit:true,approve:repeat.plan_digest}).state).toBe('already_assigned');
    expect(d.query("SELECT COUNT(*) AS n FROM activity WHERE action='agent.steward_assigned'").get()).toEqual({n:1});
    expect(d.query('SELECT actor_id FROM workspace_owners').get()).toEqual({actor_id:owner.agent_id});
  }finally{d.close();}
});

test('steward selection refuses foreign, revoked, read-only and human identities and preserves an existing steward',()=>{
  const {database:d,owner}=ownerFixture(41);
  try{
    for(const [id,profile,active] of [['one','full',1],['two','full',1],['reader','read-only',1],['revoked','full',0]] as const)
      d.query("INSERT INTO agents(id,workspace_id,name,type,api_key_hash,tool_profile,active) VALUES (?,?,?,'standard',?,?,?)").run(id,owner.workspace_id,id,id,profile,active);
    for(const id of ['missing','reader','revoked',owner.agent_id])expect(()=>stewardCommand(d,{agentId:id})).toThrow();
    expect(()=>stewardCommand(d,{commit:true})).toThrow('agent-id');
    d.query("INSERT INTO workspaces(id,name,slug) VALUES('foreign','Foreign','foreign')").run();
    const foreign=bootstrapOwner(d,'Other owner',undefined,'foreign');
    expect(()=>stewardCommand(d,{agentId:'one'})).toThrow('Select');
    expect(()=>stewardCommand(d,{ownerId:foreign.agent_id,agentId:'one'})).toThrow('this owner workspace');
    const plan=stewardCommand(d,{ownerId:owner.agent_id,agentId:'one'});
    stewardCommand(d,{ownerId:owner.agent_id,agentId:'one',commit:true,approve:plan.plan_digest});
    expect(()=>stewardCommand(d,{ownerId:owner.agent_id,agentId:'two'})).toThrow('already assigned');
    d.query('UPDATE agents SET active=0 WHERE id=?').run(owner.agent_id);
    expect(()=>stewardCommand(d,{ownerId:owner.agent_id})).toThrow('active human');
  }finally{d.close();}
});
