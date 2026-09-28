import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createShotAnalysisProvider, shotAnalysisProviderStatus, modelConnectionFailure} from '../studio/shot-analysis-provider.mjs';
import {validateAnnotation, validateSubjects, ANNOTATION_ENUMS} from '../studio/shot-analysis-schema.mjs';

async function server(handler) {
  const service = http.createServer(async (req, res) => {let body = '';for await (const chunk of req) body += chunk;handler(req, res, JSON.parse(body));});
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${service.address().port}/analyze`, close: async () => {service.closeAllConnections();await new Promise(resolve => service.close(resolve));}};
}
const payload = {shots: [{id: 'S01'}], evidenceFrames: [{frameIndex: 12, ptsUs: 410001, shotId: 'S01', dataUrl: 'data:image/jpeg;base64,/9j/AA=='}], subjectCatalog: []};
const options = url => ({provider: 'fixture-only', model: 'fixture-vision', endpoint: url, protocol: 'json-http', maxAttempts: 1, apiKey: ''});

test('provider has no implicit supplier, validates endpoint, and public status omits secret', () => {
  assert.equal(shotAnalysisProviderStatus({provider: '', model: '', endpoint: '', protocol: ''}).configured, false);
  assert.equal(shotAnalysisProviderStatus({...options('http://remote.invalid/analyze')}).configured, false);
  assert.equal(shotAnalysisProviderStatus({...options('https://remote.invalid/analyze?key=secret')}).configured, false);
  assert.deepEqual(shotAnalysisProviderStatus({...options('https://remote.invalid/analyze'), apiKey: 'test-only-secret'}), {configured: true, provider: 'fixture-only', model: 'fixture-vision'});
});

test('json-http sends exact model, images and source frame references to localhost only', async () => {
  let sent;
  const f = await server((req, res, body) => {sent = body;assert.equal(req.headers.authorization, 'Bearer fixture-token');res.writeHead(200, {'Content-Type': 'application/json'});res.end(JSON.stringify({summary: '测试概览', subjects: [], issues: []}));});
  try {const provider = createShotAnalysisProvider({...options(f.url), apiKey: 'fixture-token'});const out = await provider.overview(payload);assert.equal(out.output.summary, '测试概览');assert.equal(sent.mode, 'overview');assert.equal(sent.model, 'fixture-vision');assert.equal(sent.input.evidenceFrames[0].ptsUs, 410001);assert.equal(sent.input.evidenceFrames[0].dataUrl, payload.evidenceFrames[0].dataUrl);assert.match(sent.prompt, /unknown/);} finally {await f.close();}
});

test('OpenAI-compatible visual chat protocol parses content and usage without selecting a supplier', async () => {
  let sent;
  const f = await server((_req, res, body) => {sent = body;res.end(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({annotations: [], subjects: [], issues: []})}}], usage: {total_tokens: 42}}));});
  try {const p = createShotAnalysisProvider({...options(f.url), protocol: 'openai-chat-completions'});const result = await p.analyzeBatch(payload);assert.equal(result.usage.totalTokens, 42);assert.equal(sent.response_format.type, 'json_object');assert.equal(sent.messages[0].content[2].type, 'image_url');assert.equal(sent.messages[0].content[2].image_url.url, payload.evidenceFrames[0].dataUrl);} finally {await f.close();}
});

test('Responses uses documented image inputs and strict JSON text output', async () => {
  let sent;
  const f = await server((req, res, body) => {sent = body;assert.equal(req.headers.authorization, undefined);res.end(JSON.stringify({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: '{"subjects":[]}'}]}], usage: {input_tokens: 3, output_tokens: 5}}));});
  try {const p = createShotAnalysisProvider({...options(f.url), protocol: 'openai-responses'});const result = await p.overview(payload);assert.deepEqual(result.output, {subjects: []});assert.equal(sent.text.format.type, 'json_object');assert.equal(sent.input[0].content[2].type, 'input_image');assert.equal(sent.input[0].content[2].image_url, payload.evidenceFrames[0].dataUrl);assert.equal(result.usage.totalTokens, 8);} finally {await f.close();}
});

test('Anthropic uses x-api-key and base64 source without bearer auth', async () => {
  let sent;
  const f = await server((req, res, body) => {sent = body;assert.equal(req.headers.authorization, undefined);assert.equal(req.headers['x-api-key'], 'fixture-anthropic');assert.equal(req.headers['anthropic-version'], '2023-06-01');res.end(JSON.stringify({stop_reason: 'end_turn', content: [{type: 'text', text: '{"subjects":[]}'}], usage: {input_tokens: 4, output_tokens: 6}}));});
  try {const p = createShotAnalysisProvider({...options(f.url), protocol: 'anthropic-messages', apiKey: 'fixture-anthropic'});const result = await p.overview(payload);assert.deepEqual(result.output, {subjects: []});assert.equal(sent.max_tokens, 8192);assert.deepEqual(sent.messages[0].content[2], {type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: '/9j/AA=='}});assert.equal(result.usage.totalTokens, 10);} finally {await f.close();}
});

test('Responses and Anthropic reject truncated or non-object JSON results', async () => {
  let response;
  const f = await server((_req, res) => res.end(JSON.stringify(response)));
  try {
    for (const [protocol, raw] of [['openai-responses', {status: 'incomplete', output: []}], ['anthropic-messages', {stop_reason: 'max_tokens', content: []}]]) {response = raw;await assert.rejects(createShotAnalysisProvider({...options(f.url), protocol}).overview(payload), e => e.code === 'truncated_response');}
    response = {status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: 'null'}]}]};
    await assert.rejects(createShotAnalysisProvider({...options(f.url), protocol: 'openai-responses'}).overview(payload), e => e.code === 'invalid_json');
  } finally {await f.close();}
});

test('429 retries boundedly while 401 never retries or returns remote response secrets', async () => {
  let calls = 0;
  const f = await server((_req, res) => {calls++;res.writeHead(calls === 1 ? 429 : 401);res.end('sensitive upstream diagnostic MUST NOT escape');});
  try {const p = createShotAnalysisProvider({...options(f.url), maxAttempts: 3});await assert.rejects(p.overview(payload), e => e.code === 'http_401' && !e.message.includes('sensitive'));assert.equal(calls, 2);} finally {await f.close();}
});

test('provider enforces timeout, cancellation, pure JSON and response truncation', async () => {
  let mode = 'wait';
  const f = await server((_req, res) => {if (mode === 'wait') return;if (mode === 'bad') return res.end('not json');res.end(JSON.stringify({choices: [{finish_reason: 'length', message: {content: '{}'}}]}));});
  try {
    const p = createShotAnalysisProvider({...options(f.url), timeoutMs: 100});await assert.rejects(p.overview(payload), e => e.code === 'timeout');
    const ctrl = new AbortController();setTimeout(() => ctrl.abort(new Error('fixture cancelled')), 20);await assert.rejects(p.overview(payload, {signal: ctrl.signal}), /fixture cancelled/);
    mode = 'bad';await assert.rejects(p.overview(payload), e => e.code === 'invalid_json');
    mode = 'truncated';await assert.rejects(createShotAnalysisProvider({...options(f.url), protocol: 'openai-chat-completions'}).overview(payload), e => e.code === 'truncated_response');
  } finally {await f.close();}
});

test('schema uses real upstream vocabulary and rejects fabricated timing, subjects or evidence', () => {
  assert.ok(ANNOTATION_ENUMS.camera.includes('micro-push'));
  const a = {size: 'medium', category: 'subject', camera: 'unknown', frame: '男子站在画面左侧，窗户位于右侧背景', action: '站立', composition: '左侧主体', scene: '室内', subjects: ['A'], evidenceFrames: [2], uncertainties: ['无法判断背景运动']};
  assert.equal(validateAnnotation(a, {allowedFrames: [2], subjectIds: ['A']}).valid, true);
  assert.equal(validateAnnotation({...a, startFrame: 4}).valid, false);
  assert.equal(validateAnnotation(a, {allowedFrames: [3], subjectIds: ['A']}).valid, false);
  assert.equal(validateAnnotation(a, {allowedFrames: [2], subjectIds: ['B']}).valid, false);
  assert.equal(validateAnnotation({...a, uncertainties: []}).valid, false);
  assert.equal(validateAnnotation({action: '人工修正'}, {partial: true}).valid, true);
  assert.equal(validateSubjects([{id: 'A', kind: 'person', name: '甲', description: '红衣', referenceFrames: [42]}], {allowedFrames: [2]}).valid, false);
});

test('saved Base URL uses the same origin API route and MiniMax separates thinking from JSON', async () => {
  const calls = [];
  const f = await server((req, res, body) => {
    calls.push({url: req.url, body});
    assert.equal(req.headers.authorization, 'Bearer fixture-only-token');
    res.end(JSON.stringify({choices: [{message: {content: '{"subjects":[]}'}}]}));
  });
  try {
    const p = createShotAnalysisProvider({...options(new URL('/v1', f.url).href), provider: 'minimax', model: 'MiniMax-M3', protocol: 'openai-chat-completions', apiKey: 'fixture-only-token'});
    await p.visionTest(payload);await p.overview(payload);
    assert.ok(calls.every(call => call.url === '/v1/chat/completions' && call.body.model === 'MiniMax-M3' && call.body.reasoning_split === true));
    assert.deepEqual(calls[0].body.thinking, {type: 'disabled'});
    assert.equal(calls[0].body.max_completion_tokens, 1024);
    assert.equal(calls[1].body.thinking, undefined, 'analysis retains the model default thinking');
    assert.equal(calls[0].body.messages[0].content[2].image_url.url, payload.evidenceFrames[0].dataUrl);
  } finally {await f.close();}
});

test('redirects are identified without following or disclosing upstream body or Location', async () => {
  let calls = 0;
  const f = await server((_req, res) => {
    calls++;res.writeHead(301, {Location: 'http://127.0.0.1:1/never?token=fixture-private-value'});
    res.end('fixture-private-value');
  });
  try {
    await assert.rejects(createShotAnalysisProvider({...options(f.url), maxAttempts: 3, apiKey: 'fixture-only-token'}).visionTest(payload), error => {
      assert.equal(error.code, 'redirect_response');
      assert.match(modelConnectionFailure(error).message, /重定向/);
      assert.equal(JSON.stringify(error).includes('fixture-private'), false);
      return true;
    });
    assert.equal(calls, 1);
  } finally {await f.close();}
});

test('network causes produce safe specific diagnostics and permanent failures are not retried', async t => {
  const cases = [['ENOTFOUND', 'dns_error'], ['EAI_AGAIN', 'dns_error'], ['ECONNREFUSED', 'connection_refused'], ['ECONNRESET', 'connection_reset'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['CERT_HAS_EXPIRED', 'tls_error'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_error'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_error'], ['UNKNOWN_FIXTURE', 'network_error']];
  for (const [systemCode, expected] of cases) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      const cause = new AggregateError([Object.assign(new Error('fixture-private-network-message'), {code: systemCode})]);
      throw new TypeError('fixture-private-fetch-message', {cause});
    });
    const permanent = ['connection_refused', 'tls_error'].includes(expected);
    await assert.rejects(createShotAnalysisProvider({...options('https://unused.invalid/analyze'), maxAttempts: permanent ? 3 : 1}).visionTest(payload), error => {
      assert.equal(error.code, expected);
      assert.ok(modelConnectionFailure(error).message);
      assert.equal(JSON.stringify(error).includes('fixture-private'), false);
      return true;
    });
    assert.equal(calls, 1);mock.mock.restore();
  }
  assert.equal(modelConnectionFailure({code: 'untrusted', message: 'fixture-private'}).message.includes('fixture-private'), false);
  assert.match(modelConnectionFailure({code: 'http_401', status: 'fixture-private'}).message, /HTTP 401/);
});
