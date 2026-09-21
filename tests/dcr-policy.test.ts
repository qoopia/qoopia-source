import {expect,test} from 'bun:test';
import {stringArrayEquals,stringArraySubsetOf,isChatGptRedirectUri,isChatGptRedirectArray} from '../src/auth/dcr-policy.ts';

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
