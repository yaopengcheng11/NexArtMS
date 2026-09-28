import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
import {spawn} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {createShotAnalysisProvider, shotAnalysisProviderStatus, modelConnectionFailure} from './shot-analysis-provider.mjs';
import {sameModelEndpoint} from './model-endpoint.mjs';

const fail = (message, status = 400, code = 'model_settings_error') => Object.assign(new Error(message), {status, code});
const revision = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
export const MODEL_PROTOCOLS = [
  {id: 'openai-chat-completions', name: 'OpenAI Chat Completions 兼容'},
  {id: 'openai-responses', name: 'OpenAI Responses'},
  {id: 'anthropic-messages', name: 'Anthropic Messages'},
  {id: 'json-http', name: '自定义 JSON HTTP（拉片契约）'},
];
export const MODEL_PRESETS = [
  {id: 'custom', name: '创建自定义供应商', provider: 'custom', protocol: 'openai-chat-completions', endpoint: ''},
  {id: 'openai-chat', name: 'OpenAI', provider: 'openai', protocol: 'openai-chat-completions', endpoint: 'https://api.openai.com/v1'},
  {id: 'openai-responses', name: 'OpenAI Responses', provider: 'openai', protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1'},
  {id: 'anthropic', name: 'Anthropic', provider: 'anthropic', protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com/v1'},
  ...[['zai', 'Z.ai'], ['bigmodel', '智谱 BigModel'], ['qwen', '阿里云百炼'], ['minimax', 'MiniMax'], ['kimi', 'Kimi'], ['deepseek', 'DeepSeek'], ['openrouter', 'OpenRouter']].map(([id, name]) => ({id, name, provider: id, protocol: 'openai-chat-completions', endpoint: ''})),
];

function windowsCodec() {
  const operation = (mode, value) => new Promise((resolve, reject) => {
    // Secrets travel through stdin/stdout pipes only; never command arguments or logs.
    const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; $b=[Convert]::FromBase64String($v.value); if($v.mode -eq 'protect'){$r=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)}; [Console]::Out.Write([Convert]::ToBase64String($r))";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', bytes = 0, settled = false;
    const finish = (error, result) => {if (settled) return;settled = true;clearTimeout(timer);error ? reject(error) : resolve(result);};
    const timer = setTimeout(() => {child.kill();finish(fail('Windows 凭据加密操作超时', 503, 'secret_codec_failed'));}, 15000);
    child.stdout.on('data', chunk => {bytes += chunk.length;if (bytes > 65536) {child.kill();finish(fail('Windows 凭据操作返回异常', 503));}else output += chunk;});
    child.stderr.resume();
    child.on('error', () => finish(fail('无法启动 Windows 凭据加密', 503, 'secret_codec_failed')));
    child.on('close', code => code === 0 ? finish(null, output.trim()) : finish(fail('Windows 凭据加解密失败，请重新填写密钥', 503, 'secret_unavailable')));
    child.stdin.on('error', () => finish(fail('Windows 凭据加密管道失败', 503, 'secret_codec_failed')));
    child.stdin.end(JSON.stringify({mode, value}));
  });
  return {kind: 'windows-dpapi', persistent: true, available: () => true, encrypt: value => operation('protect', Buffer.from(value).toString('base64')), decrypt: async value => Buffer.from(await operation('unprotect', value), 'base64').toString('utf8')};
}
function memoryCodec() {
  const values = new Map();
  return {kind: 'session-memory', persistent: false, available: value => values.has(value), encrypt: async value => {const id = revision();values.set(id, value);return id;}, decrypt: async value => {if (!values.has(value)) throw fail('此平台密钥仅保留在当前会话，重启后请重新输入', 422, 'secret_unavailable');return values.get(value);}};
}
const isLoopback = hostname => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase());
const requiresApiKey = profile => MODEL_PRESETS.some(p => p.provider !== 'custom' && p.provider === profile.provider) && !isLoopback(new URL(profile.endpoint).hostname);
function isPrivateIp(ip) {
  if (ip.includes(':')) return /^(?:0*:){0,6}(?:0*1|0*)$/.test(ip) || /^(?:fc|fd|fe[89ab]|ff)/i.test(ip) || /^::ffff:/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224;
}
function validateEndpoint(endpoint) {
  let url;
  try {url = new URL(endpoint);} catch {throw fail('请输入有效的模型 API 地址（Base URL 或完整请求地址）');}
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !isLoopback(url.hostname)) throw fail('模型地址须为无凭据、查询参数的 HTTPS 地址；本机服务允许 HTTP');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!isLoopback(hostname) && (net.isIP(hostname) && isPrivateIp(hostname) || /(?:^|\.)(?:local|internal|localhost)$/.test(hostname))) throw fail('模型地址不允许私网或元数据服务；本机 localhost 服务可显式填写');
  return url.toString();
}
async function validateDestination(endpoint) {
  const hostname = new URL(validateEndpoint(endpoint)).hostname.replace(/^\[|\]$/g, '');
  if (isLoopback(hostname) || net.isIP(hostname)) return;
  let addresses;
  try {addresses = await lookup(hostname, {all: true});} catch {throw fail('无法解析模型服务地址', 502, 'dns_error');}
  if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) throw fail('模型域名解析到私网或元数据地址，已拒绝连接', 422, 'destination_blocked');
}
function checkedString(value, name, max = 200) {if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw fail(`${name}不能为空、含控制字符或超过 ${max} 字符`);return value.trim();}
function validateProfile(body, old) {
  const profile = {...old};
  for (const [key, name, max] of [['name', '供应商名称', 100], ['provider', '供应商标识', 100], ['protocol', '协议', 100], ['endpoint', '请求地址', 2000]]) if (body[key] !== undefined || !old) profile[key] = checkedString(body[key], name, max);
  if (!MODEL_PROTOCOLS.some(p => p.id === profile.protocol)) throw fail('不支持的模型协议');
  profile.endpoint = validateEndpoint(profile.endpoint);
  if (body.models !== undefined || !old) {
    if (!Array.isArray(body.models) || body.models.length < 1 || body.models.length > 50) throw fail('请填写 1 到 50 个模型 ID');
    profile.models = [...new Set(body.models.map(value => checkedString(value, '模型 ID', 200)))];
  }
  if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 16000 || /[\r\n]/.test(body.apiKey))) throw fail('API Key 格式无效');
  return profile;
}

function crc32(buffer) {let crc = 0xffffffff;for (const byte of buffer) {crc ^= byte;for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);}return (crc ^ 0xffffffff) >>> 0;}
function pngChunk(type, data) {const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name, data])));return Buffer.concat([size, name, data, crc]);}
export function createVisionChallenge() {
  const palette = [['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]], ['yellow', [255, 255, 0]], ['magenta', [255, 0, 255]], ['cyan', [0, 255, 255]]];
  for (let i = palette.length - 1; i > 0; i--) {const j = crypto.randomInt(i + 1);[palette[i], palette[j]] = [palette[j], palette[i]];}
  const selected = palette.slice(0, 3), width = 192, height = 128, raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {const offset = y * (width * 3 + 1) + 1 + x * 3;selected[Math.floor(x / 64)][1].forEach((v, c) => raw[offset + c] = v);}
  const ihdr = Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height, 4);ihdr[8] = 8;ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  return {payload: {evidenceFrames: [{frameIndex: 0, ptsUs: 0, dataUrl: `data:image/png;base64,${png.toString('base64')}`}]}, expected: selected.map(item => item[0])};
}

/**
 * The vision test is advisory, so a failure must stay diagnosable: show what the
 * model actually answered. Model output never carries the key (it only ever sees
 * a synthetic image), yet redact credential-shaped text and control characters
 * anyway so nothing unexpected can reach the browser.
 */
function safeSample(rawContent, output, expected) {
  const redact = text => String(text ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\b(?:sk|eyJ)[-_A-Za-z0-9]{16,}\b/g, '«redacted»')
    .trim();
  const trimmed = redact(rawContent);
  const parsed = {
    pattern: output?.pattern ?? null,
    count: output?.count ?? null,
    colorsLeftToRight: Array.isArray(output?.colorsLeftToRight) ? output.colorsLeftToRight : null,
  };
  const mismatches = [];
  if (output?.pattern !== 'vertical-stripes') mismatches.push('pattern 不是 vertical-stripes');
  if (output?.count !== 3) mismatches.push('count 不是 3');
  if (!Array.isArray(output?.colorsLeftToRight)) mismatches.push('colorsLeftToRight 不是数组');
  else {
    const got = output.colorsLeftToRight.map(c => typeof c === 'string' ? c.toLowerCase().trim() : c);
    if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches.push(`色名不匹配：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}（需用英文小写色名）`);
  }
  return {content: trimmed ? trimmed.slice(0, 600) : '', parsed, mismatches};
}

export function createModelSettings(root, {secretCodec, providerFactory = createShotAnalysisProvider} = {}) {
  const codec = secretCodec || (process.platform === 'win32' ? windowsCodec() : memoryCodec());
  const directory = path.join(root, 'data', 'private'), file = path.join(directory, 'model-settings.json'), lockFile = file + '.lock';
  let state = {schemaVersion: 1, revision: revision(), profiles: [], active: null, selectionMode: 'environment'};
  let persistedRevision = null;
  function readDisk() {
    let encoded;
    try {encoded = fs.readFileSync(file, 'utf8');} catch (cause) {if (cause.code === 'ENOENT') return null;throw fail('无法读取模型配置文件', 500);}
    try {const value = JSON.parse(encoded);if (value.schemaVersion !== 1 || !Array.isArray(value.profiles) || !value.revision) throw new Error();return value;} catch {throw fail('模型配置文件损坏，未覆盖原文件', 500);}
  }
  function refresh() {const disk = readDisk();if (disk) {state = disk;persistedRevision = disk.revision;} else if (persistedRevision !== null) throw fail('模型配置文件已被移除，请检查数据目录后重试', 409, 'settings_conflict');}
  refresh();
  let queued = Promise.resolve();
  const serial = work => {const next = queued.then(work);queued = next.catch(() => {});return next;};
  const assertRevision = value => {refresh();if (!value || state.revision !== value) throw fail('模型设置已变化，请刷新后重试', 409, 'settings_conflict');};
  const find = id => {const p = state.profiles.find(item => item.id === id);if (!p) throw fail('模型供应商不存在', 404);return p;};
  const hasKey = p => !!p.encryptedSecret && (!codec.available || codec.available(p.encryptedSecret));
  const save = (next, {expectedDiskRevision = persistedRevision, commitGuard} = {}) => {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    let lock;
    try {lock = fs.openSync(lockFile, 'wx', 0o600);} catch (cause) {throw fail(cause.code === 'EEXIST' ? '模型配置正在被其他服务写入，请稍后重试；若持续存在请检查服务状态' : '无法创建模型配置写入锁', 503);}
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const disk = readDisk();
      if ((disk?.revision ?? null) !== expectedDiskRevision) {if (disk) {state = disk;persistedRevision = disk.revision;}throw fail('模型设置已被其他服务修改，请刷新后重试', 409, 'settings_conflict');}
      // The guard and final write share one synchronous critical section. A job cannot
      // start between the in-use check and commit after slow DPAPI encryption.
      if (commitGuard) {const result = commitGuard();if (result && typeof result.then === 'function') throw fail('模型提交校验必须同步执行', 500);}
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', {mode: 0o600});fs.renameSync(temp, file);
      state = next;persistedRevision = next.revision;
    } catch (cause) {try {fs.unlinkSync(temp);} catch {}if (cause.status) throw cause;throw fail('保存模型配置失败，原配置未更新', 500);}
    finally {fs.closeSync(lock);fs.unlinkSync(lockFile);}
  };
  const secretStorage = {kind: codec.kind || 'injected', persistent: !!codec.persistent, message: codec.persistent ? 'API Key 使用当前 Windows 账户的 DPAPI 加密存储，仅服务器端解密。' : '此平台的 API Key 仅保存在服务进程内，重启后需要重新输入。'};
  const environment = () => ({provider: process.env.STUDIO_SHOT_ANALYSIS_PROVIDER || '', model: process.env.STUDIO_SHOT_ANALYSIS_MODEL || '', endpoint: process.env.STUDIO_SHOT_ANALYSIS_ENDPOINT || '', protocol: process.env.STUDIO_SHOT_ANALYSIS_PROTOCOL || ''});
  const envSettings = () => createShotAnalysisProvider().settings;
  const envVersion = () => hash({...environment(), settings: envSettings(), secretHash: hash(process.env.STUDIO_SHOT_ANALYSIS_API_KEY || '')});
  function snapshot() {
    refresh();
    let value;
    if (state.active) {const p = find(state.active.profileId);value = {source: 'profile', profileId: p.id, profileRevision: p.revision, provider: p.provider, model: state.active.modelId, protocol: p.protocol, endpoint: p.endpoint, settings: {timeoutMs: 60000, maxAttempts: 2, batchSize: 4, maxCalls: 64, protocol: p.protocol}};}
    else if (state.selectionMode === 'disabled') value = {source: 'disabled', profileId: null, profileRevision: null, provider: '', model: '', protocol: '', endpoint: '', settings: {}};
    else {
      const configured = environment();
      // Snapshots are public provenance. Invalid legacy URLs may accidentally hold
      // credentials in userinfo/query strings; never persist them even when blocked.
      try {configured.endpoint = validateEndpoint(configured.endpoint);} catch {configured.endpoint = '';}
      value = {source: 'environment', profileId: null, profileRevision: envVersion(), ...configured, settings: envSettings()};
    }
    return {...value, fingerprint: hash(value)};
  }
  function status() {
    const selected = snapshot();
    if (selected.source === 'disabled') return {configured: false, provider: null, model: null, reason: '尚未选择默认视觉模型；可添加供应商并选择支持图片的模型。'};
    const result = shotAnalysisProviderStatus(selected);
    if (selected.source === 'profile') {
      const p = find(selected.profileId);
      if (!p.encryptedSecret && requiresApiKey(p)) return {...result, configured: false, reason: '尚未保存 API 密钥，请在模型设置中重新填写并保存。'};
      if (p.encryptedSecret && !hasKey(p)) return {...result, configured: false, reason: '密钥不在当前服务会话中，请重新输入 API Key'};
      return {...result, source: selected.source, visionVerified: (p.lastTests || []).some(t => t.modelId === selected.model && t.profileRevision === p.revision && t.visionPassed)};
    }
    return {...result, source: 'environment', ...(!selected.endpoint && environment().endpoint ? {configured: false, reason: '环境配置的模型地址无效或含凭据/查询参数；请改为完整、无凭据的 HTTPS 请求地址。'} : {})};
  }
  function publicState() {refresh();const runtime = status();return {revision: state.revision, capabilities: {modelConnectionTestVersion: 2}, profiles: state.profiles.map(({encryptedSecret, secretStorageKind, ...profile}) => ({...clone(profile), hasApiKey: hasKey({encryptedSecret}), secretUnavailable: !!encryptedSecret && !hasKey({encryptedSecret})})), active: clone(state.active), presets: clone(MODEL_PRESETS), protocols: clone(MODEL_PROTOCOLS), secretStorage, runtime};}
  async function providerFor(selected) {
    refresh();
    if (!selected || selected.fingerprint !== hash(Object.fromEntries(Object.entries(selected).filter(([key]) => key !== 'fingerprint')))) throw fail('任务模型快照无效', 409, 'model_configuration_changed');
    if (selected.source === 'profile') {
      const p = find(selected.profileId);
      if (p.revision !== selected.profileRevision || p.provider !== selected.provider || p.endpoint !== selected.endpoint || p.protocol !== selected.protocol || !p.models.includes(selected.model)) throw fail('任务使用的模型配置已变化，请新建分析运行', 409, 'model_configuration_changed');
      if (!p.encryptedSecret && requiresApiKey(p)) throw fail('尚未保存 API 密钥', 422, 'missing_api_key');
      await validateDestination(p.endpoint);
      const apiKey = p.encryptedSecret ? await codec.decrypt(p.encryptedSecret) : '';
      // Recheck after asynchronous credential access before using the captured endpoint/key pair.
      refresh();
      if (find(p.id).revision !== p.revision) throw fail('任务使用的模型配置已变化，请新建分析运行', 409, 'model_configuration_changed');
      return providerFactory({...selected, ...selected.settings, apiKey});
    }
    if (selected.source === 'disabled') return providerFactory({provider: '', model: '', protocol: '', endpoint: '', apiKey: ''});
    if (selected.source !== 'environment' || selected.profileRevision !== envVersion()) throw fail('环境中的模型配置已变化，请新建分析运行', 409, 'model_configuration_changed');
    if (shotAnalysisProviderStatus(selected).configured) await validateDestination(selected.endpoint);
    return providerFactory({...selected, ...selected.settings, apiKey: process.env.STUDIO_SHOT_ANALYSIS_API_KEY || ''});
  }
  async function writeProfile(id, body, commitGuard) {
    return serial(async () => {
      assertRevision(body.baseRevision);
      const expectedDiskRevision = persistedRevision;
      const old = id ? find(id) : null, p = validateProfile(body, old);
      if (body.clearApiKey === true || old && old.endpoint !== p.endpoint && !sameModelEndpoint(old.endpoint, old.protocol, p.endpoint, p.protocol)) delete p.encryptedSecret;
      if (body.apiKey !== undefined) p.encryptedSecret = body.apiKey ? await codec.encrypt(body.apiKey) : undefined;
      p.id = old?.id || 'provider-' + crypto.randomUUID();p.revision = revision();p.lastTests = [];delete p.lastTest;
      p.secretStorageKind = codec.kind || 'injected';
      const profiles = old ? state.profiles.map(item => item.id === id ? p : item) : [...state.profiles, p];
      const active = state.active?.profileId === id && !p.models.includes(state.active.modelId) ? null : state.active;
      save({...state, revision: revision(), profiles, active, selectionMode: state.active && !active ? 'disabled' : state.selectionMode}, {expectedDiskRevision, commitGuard});
      return publicState();
    });
  }
  return {
    publicState, status, snapshot, providerFor,
    addProfile: (body, commitGuard) => writeProfile(null, body, commitGuard), updateProfile: (id, body, commitGuard) => writeProfile(id, body, commitGuard),
    deleteProfile: (id, body, commitGuard) => serial(() => {assertRevision(body.baseRevision);find(id);const active = state.active?.profileId === id ? null : state.active;save({...state, revision: revision(), profiles: state.profiles.filter(p => p.id !== id), active, selectionMode: state.active && !active ? 'disabled' : state.selectionMode}, {commitGuard});return publicState();}),
    select: (body, commitGuard) => serial(() => {assertRevision(body.baseRevision);let active = null;if (body.profileId !== null) {const p = find(body.profileId);if (!p.models.includes(body.modelId)) throw fail('所选模型不在供应商模型列表中');active = {profileId: p.id, modelId: body.modelId};}save({...state, revision: revision(), active, selectionMode: active ? 'profile' : 'disabled'}, {commitGuard});return publicState();}),
    async testProfile(id, body, commitGuard) {
      assertRevision(body.baseRevision);const p = find(id);if (!p.models.includes(body.modelId)) throw fail('所选模型不在供应商模型列表中');
      const selected = {source: 'profile', profileId: p.id, profileRevision: p.revision, provider: p.provider, model: body.modelId, protocol: p.protocol, endpoint: p.endpoint, settings: {timeoutMs: 30000, maxAttempts: 1, batchSize: 1, maxCalls: 1, protocol: p.protocol}};
      const currentSnapshot = {...selected, fingerprint: hash(selected)};
      let test;
      try {
        // Fail fast on an undecryptable credential: without it the request would go
        // out unauthenticated and return a misleading 401 from the provider.
        const candidate = find(p.id);
        if (candidate.encryptedSecret && !hasKey(candidate)) throw fail('已保存的密钥不在当前服务会话中，无法解密。请在模型设置里重新填写 API Key 并保存。', 422, 'secret_unavailable');
        const provider = await providerFor(currentSnapshot), challenge = createVisionChallenge();
        const {output, rawContent} = await provider.visionTest(challenge.payload);
        const visionPassed = output?.pattern === 'vertical-stripes' && output.count === 3 && Array.isArray(output.colorsLeftToRight) && JSON.stringify(output.colorsLeftToRight.map(c => typeof c === 'string' ? c.toLowerCase().trim() : c)) === JSON.stringify(challenge.expected);
        test = {status: visionPassed ? 'success' : 'failed', visionPassed, message: visionPassed ? '测试图识别正确，图片输入和 JSON 输出验证通过。' : '请求返回成功，但测试图识别不正确；不能确认此模型支持视觉输入。', ...(visionPassed ? {} : {sample: safeSample(rawContent, output, challenge.expected)})};
      } catch (cause) {test = {status: 'failed', visionPassed: false, ...modelConnectionFailure(cause)};}
      return serial(() => {
        refresh();
        if (find(id).revision !== p.revision) throw fail('测试期间供应商配置已变化，未保存过期测试结果', 409, 'settings_conflict');
        const result = {...test, testedAt: new Date().toISOString(), modelId: body.modelId, profileRevision: p.revision};
        const profiles = state.profiles.map(item => item.id === id ? {...item, lastTest: result, lastTests: [...(item.lastTests || []).filter(t => t.modelId !== body.modelId), result]} : item);
        save({...state, revision: revision(), profiles}, {commitGuard});return publicState();
      });
    },
  };
}
