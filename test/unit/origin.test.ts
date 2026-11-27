import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest } from '../../src/drivers/playwright/origin.ts';

const PAGE = 'http://127.0.0.1:8080/app/index.html';
const TARGET = 'http://127.0.0.1:8080/api/items';

// 终审 I-5：frame 地址同源还不够：沙箱 iframe（sandbox 不带 allow-same-origin）的文档 origin 是 null，请求带 `Origin: null`，浏览器按跨源处理。
test('same origin: the frame and the target agree, and a request Origin header (if any) is the target origin too', () => {
  assert.equal(isSameOriginRequest(PAGE, TARGET, undefined), true, 'no Origin header (a plain same-origin GET)');
  assert.equal(isSameOriginRequest(PAGE, TARGET, 'http://127.0.0.1:8080'), true, 'Origin equal to the target origin');
});

test('an Origin header of null, or of another origin, is cross-origin even when the frame URL is same-origin (sandboxed iframe)', () => {
  assert.equal(isSameOriginRequest(PAGE, TARGET, 'null'), false);
  assert.equal(isSameOriginRequest(PAGE, TARGET, 'http://localhost:8080'), false);
  assert.equal(isSameOriginRequest(PAGE, TARGET, 'http://127.0.0.1:9090'), false);
  assert.equal(isSameOriginRequest(PAGE, TARGET, 'https://127.0.0.1:8080'), false);
  assert.equal(isSameOriginRequest(PAGE, TARGET, ''), false, 'an empty Origin is not a match');
  assert.equal(isSameOriginRequest(PAGE, TARGET, 'not a url'), false);
});

test('the frame check still applies: another origin, a non-http frame, an unparsable address are cross-origin', () => {
  assert.equal(isSameOriginRequest('http://localhost:8080/', TARGET, undefined), false);
  assert.equal(isSameOriginRequest('about:srcdoc', TARGET, undefined), false);
  assert.equal(isSameOriginRequest('data:text/html,x', TARGET, undefined), false);
  assert.equal(isSameOriginRequest('not a url', TARGET, undefined), false);
  assert.equal(isSameOriginRequest(PAGE, 'not a url', undefined), false);
  assert.equal(isSameOriginRequest('http://127.0.0.1:8080/', 'http://127.0.0.1:8080/x', 'http://127.0.0.1:8080'), true);
});
