import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveModelEndpoint, sameModelEndpoint} from '../studio/model-endpoint.mjs';

test('standard API base URLs resolve to the selected protocol route', () => {
  const paths = {'openai-chat-completions':'chat/completions','openai-responses':'responses','anthropic-messages':'messages'};
  for (const [protocol, path] of Object.entries(paths)) {
    for (const base of ['https://api.example.test', 'https://api.example.test/']) {
      assert.equal(resolveModelEndpoint(base, protocol), `https://api.example.test/v1/${path}`);
    }
    for (const base of ['https://api.example.test/v1', 'https://api.example.test/v1/']) {
      assert.equal(resolveModelEndpoint(base, protocol), `https://api.example.test/v1/${path}`);
    }
    assert.equal(resolveModelEndpoint('http://127.0.0.1:4321/proxy/v2/', protocol), `http://127.0.0.1:4321/proxy/v2/${path}`);
  }
  assert.equal(resolveModelEndpoint('https://api.minimax.cn/v1', 'openai-chat-completions'), 'https://api.minimax.cn/v1/chat/completions');
});

test('complete custom endpoints and JSON HTTP base URLs are preserved', () => {
  for (const endpoint of ['https://api.example.test/v1/chat/completions','https://api.example.test/custom-handler/','https://api.example.test/v1beta']) {
    assert.equal(resolveModelEndpoint(endpoint, 'openai-chat-completions'), endpoint);
  }
  for (const endpoint of ['https://api.example.test', 'https://api.example.test/v1/','http://localhost:4321/custom']) {
    assert.equal(resolveModelEndpoint(endpoint, 'json-http'), endpoint);
  }
  assert.equal(resolveModelEndpoint('https://api.example.test/v1', 'unknown'), 'https://api.example.test/v1');
  assert.equal(resolveModelEndpoint('https://api.example.test/v1', 'constructor'), 'https://api.example.test/v1');
});

test('invalid or credential-bearing endpoints remain invalid for the existing validator', () => {
  for (const endpoint of ['not a url','file:///v1','https://user:secret@api.example.test/v1','https://api.example.test/v1?key=secret','https://api.example.test/v1#secret','https://api.example.test/v1?','https://api.example.test/v1#']) {
    assert.equal(resolveModelEndpoint(endpoint, 'openai-chat-completions'), endpoint);
  }
});

test('credential retention compares actual targets without weakening custom path or protocol boundaries', () => {
  const protocol = 'openai-chat-completions', original = 'https://api.minimax.cn/v1';
  for (const endpoint of [original + '/', original + '/chat/completions', 'https://API.MINIMAX.CN:443/v1/']) assert.equal(sameModelEndpoint(original, protocol, endpoint, protocol), true);
  for (const endpoint of ['https://other.example/v1', 'https://api.minimax.cn/other/v1', 'https://api.minimax.cn/v1?key=fixture', 'https://user:fixture@api.minimax.cn/v1']) assert.equal(sameModelEndpoint(original, protocol, endpoint, protocol), false);
  assert.equal(sameModelEndpoint(original, protocol, original, 'openai-responses'), false);
  assert.equal(sameModelEndpoint(original, 'json-http', original + '/', 'json-http'), false);
  assert.equal(sameModelEndpoint(original + '/custom', protocol, original + '/custom/', protocol), false);
  assert.equal(sameModelEndpoint('invalid', protocol, 'invalid', protocol), false);
});
