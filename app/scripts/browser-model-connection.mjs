// Real HTTP + browser regression. Uses only temporary project data and a local
// synthetic image service; no saved user provider, key, or video is accessed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {inflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createStudioStore} from '../studio/db.mjs';
import {createJobRunner} from '../studio/jobs.mjs';
import {createStudioRouter} from '../studio/router.mjs';
import {createModelSettings} from '../studio/model-settings.mjs';
import {DEFAULT_LIMITS} from '../studio/media.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(repo); // 仓库根：验证报告写 docs/reports/
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-model-connection-browser-'));
const reportDir = path.join(repoRoot, 'docs', 'reports', 'model-base-url-fix');
fs.mkdirSync(reportDir, {recursive: true});
const store = createStudioStore(root);
const settings = createModelSettings(root, {secretCodec: {
  kind: 'fixture-no-secrets', persistent: false,
  encrypt: async () => {throw new Error('This fixture must not use credentials');},
  decrypt: async () => {throw new Error('This fixture must not use credentials');},
}});
await settings.select({baseRevision: settings.publicState().revision, profileId: null});
const checks = [], errors = [], modelRequests = [];
const check = (name, value) => {checks.push({name, pass: !!value});assert.ok(value, name);};
const deferred = () => {let resolve;const promise = new Promise(done => resolve = done);return {promise, resolve};};
let pending = null, mode = 'success', fixtureFailure;
function readColors(dataUrl) {
  assert.match(dataUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(dataUrl.split(',')[1], 'base64'), chunks = [];let width;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.subarray(offset + 4, offset + 8).toString();
    if (type === 'IHDR') width = png.readUInt32BE(offset + 8);
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  assert.equal(width, 192);
  const pixels = inflateSync(Buffer.concat(chunks));
  const names = {'255,0,0': 'red', '0,255,0': 'green', '0,0,255': 'blue', '255,255,0': 'yellow', '255,0,255': 'magenta', '0,255,255': 'cyan'};
  return [0, 1, 2].map(index => {
    const offset = 1 + Math.floor((index + .5) * width / 3) * 3;
    const name = names[Array.from(pixels.subarray(offset, offset + 3)).join(',')];assert.ok(name);return name;
  });
}
const remote = http.createServer(async (req, res) => {
  try {
    let encoded = '';for await (const chunk of req) encoded += chunk;
    const input = JSON.parse(encoded);
    assert.equal(req.headers.authorization, undefined);assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.url, '/v1/chat/completions');
    const images = input.messages[0].content.filter(item => item.type === 'image_url');
    assert.equal(images.length, 1);
    const colors = readColors(images[0].image_url.url);
    modelRequests.push({model: input.model, mode, frames: 1});
    const current = pending;current?.started.resolve();if (current) await current.release.promise;
    if (mode === 'unauthorized') {res.writeHead(401);res.end('fixture-private-diagnostic-must-not-appear');return;}
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: JSON.stringify({pattern: 'vertical-stripes', count: 3, colorsLeftToRight: colors})}}]}));
  } catch (error) {fixtureFailure = error;res.writeHead(500);res.end('{}');}
});
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${remote.address().port}/v1`;
await settings.addProfile({baseRevision: settings.publicState().revision, name: '已有供应商', provider: 'fixture', protocol: 'json-http', endpoint, models: ['older-fixture']});
const firstProfile = settings.publicState().profiles[0];
const jobs = createJobRunner(store, root, DEFAULT_LIMITS, {modelSettings: settings});
const router = createStudioRouter(store, root, {jobs});
let legacyApiVersion = null, pretendStoredKeyProfileId = null;
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/studio/model-settings' && (legacyApiVersion !== null || pretendStoredKeyProfileId)) {
      // Simulate old public metadata only. The fixture never stores a credential.
      const state = settings.publicState();
      if (legacyApiVersion === 'missing') delete state.capabilities;
      else if (legacyApiVersion !== null) state.capabilities = {modelConnectionTestVersion: legacyApiVersion};
      if (pretendStoredKeyProfileId) state.profiles = state.profiles.map(profile => profile.id === pretendStoredKeyProfileId ? {...profile, hasApiKey: true} : profile);
      res.writeHead(200, {'Content-Type': 'application/json'});res.end(JSON.stringify(state));return;
    }
    if (await router(req, res)) return;
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const dist = path.join(repo, 'dist'), file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404);res.end();return;}
    const type = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html'}[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type});const stream = fs.createReadStream(file);res.on('close', () => stream.destroy());stream.pipe(res);
  } catch (error) {res.writeHead(error.status || 500, {'Content-Type': 'application/json'});res.end(JSON.stringify({error: error.message}));}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1365, height: 1000}});
page.on('pageerror', error => errors.push(String(error)));
const panel = page.locator('.model-settings-test');
const testButton = () => page.getByRole('button', {name: '测试连接', exact: true});
const result = () => panel.locator('[role="status"]');
const modelSelect = () => page.getByLabel('用于拉片的模型', {exact: true});
const startTest = async (responseMode = 'success') => {
  mode = responseMode;pending = {started: deferred(), release: deferred()};
  await testButton().click();await pending.started.promise;
};
const finishTest = async () => {
  pending.release.resolve();pending = null;
  await page.getByRole('button', {name: '测试连接', exact: true}).waitFor();
};
const fullyVisible = locator => locator.evaluate(element => {
  const box = element.getBoundingClientRect(), header = document.querySelector('.model-settings-header').getBoundingClientRect();
  return box.top >= header.bottom && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
});
try {
  await page.goto(`${base}/?settings=models`);
  await testButton().waitFor();
  check('打开设置自动选中首个已保存供应商并显示测试连接', await modelSelect().inputValue() === 'older-fixture' && await fullyVisible(testButton()));
  check('测试按钮位于供应商配置表单上方', await panel.evaluate(element => !!(element.compareDocumentPosition(document.querySelector('.model-settings-form')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  for (const version of ['missing', 1]) {
    legacyApiVersion = version;
    await page.reload();await testButton().waitFor();
    check(`旧后台能力 ${version} 显示重启提示并禁用连接测试`, await testButton().isDisabled() && await page.getByRole('alert').filter({hasText:'后台服务尚未更新，请重启本机服务后再测试'}).isVisible());
    check(`旧后台能力 ${version} 不冒充已使用补全后的地址`, !(await panel.innerText()).includes('实际请求地址') && !(await page.locator('.model-settings-form').innerText()).includes('实际请求地址'));
    await testButton().evaluate(element => element.click());
    const beforeRevision = settings.publicState().revision;
    await page.getByLabel('API 地址', {exact: false}).fill(endpoint + '/');
    check(`旧后台能力 ${version} 禁止保存地址变更以保护密钥`, await page.getByRole('button', {name:'保存供应商', exact:true}).isDisabled());
    await page.locator('.model-settings-form').evaluate(element => element.requestSubmit());
    await page.getByRole('alert').filter({hasText:'旧后台无法安全保存此配置'}).waitFor();
    check(`旧后台能力 ${version} 表单提交也不会写入旧配置`, settings.publicState().revision === beforeRevision);
  }
  check('旧后台禁测不会发送模型请求', modelRequests.length === 0);
  legacyApiVersion = null;
  await page.reload();await testButton().waitFor();
  check('恢复新后台后测试按钮可用并显示实际请求地址', !await testButton().isDisabled() && (await panel.innerText()).includes('实际请求地址') && !await page.getByRole('alert').filter({hasText:'后台服务尚未更新'}).count());
  await page.getByRole('button', {name: '＋ 添加供应商', exact: true}).click();
  await page.getByRole('button', {name: /创建自定义供应商/}).click();
  await page.getByLabel('供应商名称', {exact: true}).fill('连接测试 Fixture');
  await page.getByLabel('接口协议', {exact: true}).selectOption('openai-chat-completions');
  await page.getByLabel('API 地址', {exact: false}).fill(endpoint);
  await page.getByLabel('视觉模型 ID', {exact: false}).fill('vision-a\nvision-b');
  await page.getByRole('button', {name: '保存供应商', exact: true}).click();
  await testButton().waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(element => element.textContent === '测试连接');
    return button && button.getBoundingClientRect().bottom <= innerHeight;
  });
  check('保存供应商后测试按钮自动进入可见区域', await fullyVisible(testButton()));
  check('新模型清楚显示尚未测试', (await result().innerText()).includes('当前模型尚未测试'));
  const savedProfile = settings.publicState().profiles.find(profile => profile.name === '连接测试 Fixture');
  check('浏览器使用真实本机 API 保存供应商且未保存密钥', !!savedProfile && !savedProfile.hasApiKey);
  check('保存 Base URL 保留原值并在测试区显示实际请求地址', savedProfile.endpoint === endpoint && (await panel.innerText()).includes(endpoint + '/chat/completions'));
  await startTest();
  const busyButton = page.getByRole('button', {name: '正在测试连接…', exact: true});
  check('请求期间展示等待且禁用按钮和模型选择', await busyButton.isDisabled() && await modelSelect().isDisabled() && await page.getByRole('button', {name: '关闭模型设置'}).isDisabled());
  await busyButton.evaluate(element => {element.click();element.click();});
  check('忙碌期间重复点击不会重复发送模型请求', modelRequests.length === 1);
  check('测试请求仅包含一张合成图片并且不携带凭据', modelRequests[0].frames === 1 && modelRequests[0].model === 'vision-a');
  await finishTest();
  check('正确识别测试图片显示连接成功及所测模型', (await result().innerText()).includes('连接成功 · 图片输入通过 · vision-a'));
  await modelSelect().selectOption('vision-b');
  check('切换模型不会复用其他模型的成功状态', (await result().innerText()).includes('当前模型尚未测试') && !(await panel.innerText()).includes('连接成功'));
  await startTest('unauthorized');await finishTest();
  check('401 显示测试失败原因并可以重试', (await result().innerText()).includes('测试未通过 · vision-b') && (await result().innerText()).includes('HTTP 401') && !await testButton().isDisabled());
  check('失败详情未泄露服务端原始诊断', !(await page.locator('body').innerText()).includes('fixture-private-diagnostic'));
  await startTest();await finishTest();
  check('失败后重试成功更新当前模型状态', (await result().innerText()).includes('连接成功 · 图片输入通过 · vision-b'));
  await modelSelect().selectOption('vision-a');
  check('切回已测模型显示该模型自己的结果', (await result().innerText()).includes('连接成功 · 图片输入通过 · vision-a'));
  await page.getByLabel('供应商名称', {exact: true}).fill('连接测试 Fixture 更新');
  check('配置存在未保存修改时禁测并隐藏旧成功', await testButton().isDisabled() && !(await panel.innerText()).includes('连接成功') && (await panel.innerText()).includes('有未保存的修改'));
  await page.getByRole('button', {name: '保存供应商', exact: true}).click();
  await page.getByRole('status').filter({hasText: '当前模型尚未测试'}).waitFor();
  check('保存配置新版本后旧测试结果失效', settings.publicState().profiles.find(profile => profile.id === savedProfile.id).revision !== savedProfile.revision && (await result().innerText()).includes('当前模型尚未测试'));
  await startTest();await finishTest();
  await page.getByRole('button', {name: '设为默认视觉模型', exact: true}).click();
  await page.getByRole('button', {name: '当前默认视觉模型', exact: true}).waitFor();
  await page.reload();await testButton().waitFor();
  check('重新打开自动选中默认供应商而非列表第一项', settings.publicState().active.profileId !== firstProfile.id && await page.getByLabel('供应商名称', {exact: true}).inputValue() === '连接测试 Fixture 更新');
  check('刷新后保留当前模型有效的测试结果', (await result().innerText()).includes('连接成功 · 图片输入通过 · vision-a'));
  pretendStoredKeyProfileId = savedProfile.id;
  await page.reload();await testButton().waitFor();
  const endpointInput = page.getByLabel('API 地址', {exact: false});
  await endpointInput.fill(endpoint + '/');
  check('等效 Base URL 尾斜杠不提示清除已保存密钥', !(await page.locator('.model-settings-form').innerText()).includes('留空会清除旧密钥'));
  await endpointInput.fill(endpoint + '/different-handler');
  check('更换不同请求目标仍提醒重新填写密钥', (await page.locator('.model-settings-form').innerText()).includes('留空会清除旧密钥'));
  await page.getByRole('button', {name:'撤回修改',exact:true}).click();
  pretendStoredKeyProfileId = null;
  await page.reload();await testButton().waitFor();
  await page.screenshot({path: path.join(reportDir, 'desktop.png')});
  await page.setViewportSize({width: 390, height: 844});await page.reload();await testButton().waitFor();
  check('手机宽度无横向溢出', await page.locator('.model-settings-dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await testButton().scrollIntoViewIfNeeded();
  check('手机上测试按钮可见可点击', await fullyVisible(testButton()) && !await testButton().isDisabled());
  await page.screenshot({path: path.join(reportDir, 'mobile.png')});
  check('没有页面脚本错误或协议 fixture 异常', errors.length === 0 && !fixtureFailure);
  check('全部连接测试走本机 fixture 且请求次数符合预期', modelRequests.length === 4 && modelRequests.every(request => ['vision-a', 'vision-b'].includes(request.model)));
} finally {
  pending?.release.resolve();
  await browser.close();
  server.closeAllConnections();remote.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => remote.close(resolve))]);
  store.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('studio-model-connection-browser-'));
  fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});
  const report = {scope: 'isolated temporary data, real localhost HTTP, synthetic PNG, no real credentials or external calls', checks, errors, modelRequests, passed: checks.filter(item => item.pass).length};
  fs.writeFileSync(path.join(reportDir, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
