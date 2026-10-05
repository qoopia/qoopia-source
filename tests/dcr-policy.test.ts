import {expect,test} from 'bun:test';
import {stringArrayEquals,stringArraySubsetOf,isChatGptRedirectUri,isChatGptRedirectArray,isClaudeRedirectArray,connectionRedirectsAllowed} from '../src/auth/dcr-policy.ts';

test('redirects are accepted only for https ChatGPT hosts, never by prefix or userinfo tricks',()=>{
  for(const ok of ['https://chatgpt.com/connector_platform_oauth_redirect','https://CHAT.openai.com/x','https://www.chatgpt.com/'])expect(isChatGptRedirectUri(ok)).toBe(true);
  for(const bad of ['http://chatgpt.com/x','https://chatgpt.com.evil.example/x','https://evil.example/chatgpt.com','https://chatgpt.com@evil.example/x','javascript:alert(1)','not a url',''])
    expect(isChatGptRedirectUri(bad)).toBe(false);
  expect(isChatGptRedirectArray(['https://chatgpt.com/a','https://chat.openai.com/b'])).toBe(true);
  for(const bad of [[],['https://chatgpt.com/a','https://evil.example/b'],[42],'https://chatgpt.com/a',undefined])expect(isChatGptRedirectArray(bad)).toBe(false);
});

test('grant and response type lists are compared exactly or as a non-empty subset',()=>{
  expect(stringArrayEquals(['code'],['code'])).toBe(true);
  for(const bad of [['code','token'],['token'],[],'code',undefined])expect(stringArrayEquals(bad,['code'])).toBe(false);
  expect(stringArrayEquals(['a','b'],['b','a'])).toBe(false);
  expect(stringArraySubsetOf(undefined,['a'])).toBe(true);
  expect(stringArraySubsetOf(['a'],['a','b'])).toBe(true);
  for(const bad of [[],['c'],['a',1],'a',null])expect(stringArraySubsetOf(bad,['a','b'])).toBe(false);
});

test('Claude registers with its claude.ai callback, the claude.com one Anthropic asks to allowlist, or both — nothing else',()=>{
  const ai='https://claude.ai/api/mcp/auth_callback',com='https://claude.com/api/mcp/auth_callback';
  for(const ok of [[ai],[com],[ai,com],[com,ai]]){expect(isClaudeRedirectArray(ok)).toBe(true);expect(connectionRedirectsAllowed('claude_web',ok)).toBe(true);}
  for(const bad of [[],[ai,ai],[ai,'https://evil.example/api/mcp/auth_callback'],['https://claude.com.evil.example/api/mcp/auth_callback'],['http://claude.com/api/mcp/auth_callback'],ai,undefined])
    {expect(isClaudeRedirectArray(bad)).toBe(false);expect(connectionRedirectsAllowed('claude_web',bad)).toBe(false);}
});
