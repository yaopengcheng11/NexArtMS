/**
 * MiniMax 视觉模型连接诊断。
 * 复用项目内同一份 createVisionChallenge / resolveModelEndpoint，
 * 发出的请求与模型设置里的「测试连接」完全一致，便于对比原始响应。
 *
 * 用法：
 *   MINIMAX_API_KEY=你的key MINIMAX_BASE_URL=https://api.minimaxi.com/v1 \
 *   MINIMAX_MODEL=MiniMax-M3 node diagnose-minimax-vision.mjs
 *
 * 可选：MINIMAX_ENDPOINT 覆盖最终 URL（诊断自定义路径时用）
 */
import {createVisionChallenge} from './studio/model-settings.mjs';
import {resolveModelEndpoint} from './studio/model-endpoint.mjs';

const key = process.env.MINIMAX_API_KEY || '';
const base = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1';
const model = process.env.MINIMAX_MODEL || 'MiniMax-M3';
const protocol = 'openai-chat-completions';
const url = process.env.MINIMAX_ENDPOINT || resolveModelEndpoint(base, protocol);

if (!key) {
  console.error('缺少 MINIMAX_API_KEY。先到 MiniMax 控制台 → 账户管理 → API Key 管理复制。');
  process.exit(2);
}

const challenge = createVisionChallenge();
const prompt = 'Read the attached test image. Return only JSON: {"colorsLeftToRight":[color names in English],"pattern":"vertical-stripes","count":number of stripes}. Use only red, green, blue, yellow, magenta, cyan for color names. Identify the actual image, not this text. Count the equal-width colored stripes from left to right.';

const body = {
  model,
  response_format: {type: 'json_object'},
  messages: [{role: 'user', content: [
    {type: 'text', text: prompt},
    {type: 'image_url', image_url: {url: challenge.payload.evidenceFrames[0].dataUrl, detail: 'high'}},
  ]}],
};
if (model.toLowerCase() === 'minimax') {
  body.reasoning_split = true;
  if (/^MiniMax-M3(?:$|-)/i.test(model)) {
    body.thinking = {type: 'disabled'};
    body.max_completion_tokens = 1024;
  }
}

console.log('端点  :', url);
console.log('模型  :', model);
console.log('期望  :', JSON.stringify(challenge.expected));
console.log('---');

let response;
try {
  response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}`},
    body: JSON.stringify(body),
  });
} catch (cause) {
  console.log('网络失败:', cause.message);
  process.exit(1);
}

const rawText = await response.text();
console.log('HTTP  :', response.status, response.statusText);
if (response.status >= 300 && response.status < 400) console.log('!! 返回重定向，请确认 API 地址填的是 Base URL');
if (!response.ok) {
  console.log('响应体:', rawText.slice(0, 1200));
  const hint = {400: '协议/模型 ID/图片输入不兼容', 401: '密钥无效，或密钥与区域不匹配（国内 minimaxi.com ↔ 国际 minimimax.io 不能混用）', 403: '模型权限或账户限制', 404: '路径或模型 ID 不存在（模型 ID 区分大小写）', 429: '额度或频率限制'}[response.status];
  if (hint) console.log('提示  :', hint);
  process.exit(1);
}

let raw;
try { raw = JSON.parse(rawText); } catch {
  console.log('!! 响应本身不是 JSON，原始内容:', rawText.slice(0, 800));
  process.exit(1);
}

const content = raw.choices?.[0]?.message?.content;
console.log('finish_reason:', raw.choices?.[0]?.finish_reason);
console.log('usage        :', JSON.stringify(raw.usage || {}));
console.log('--- content 原文（这步最关键）---');
console.log(content);
console.log('--- 逐项对照 App 的判分逻辑 ---');

let output = null;
try { output = JSON.parse(content); }
catch {
  const why = /^\s*```/.test(content || '') ? 'content 被 Markdown 围栏包住 → JSON.parse 失败'
    : /<think>/.test(content || '') ? 'content 里混入了 <think> 思考过程 → JSON.parse 失败'
    : 'content 不是合法 JSON';
  console.log('✗ JSON 解析失败：', why);
  console.log('  App 会显示：模型已响应，但未返回所需的 JSON');
  process.exit(1);
}

const got = (output.colorsLeftToRight || []).map(c => typeof c === 'string' ? c.toLowerCase().trim() : c);
const colorKey = `色名与期望完全一致 ${JSON.stringify(challenge.expected)}`;
const checks = {
  'pattern === "vertical-stripes"': output.pattern === 'vertical-stripes',
  'count === 3': output.count === 3,
  'colorsLeftToRight 是数组': Array.isArray(output.colorsLeftToRight),
  [colorKey]: JSON.stringify(got) === JSON.stringify(challenge.expected),
};
for (const [name, ok] of Object.entries(checks)) console.log(ok ? '✓' : '✗', name);
console.log('实际得到:', JSON.stringify(got));
console.log(Object.values(checks).every(Boolean) ? '\n→ 视觉测试应能通过' : '\n→ 视觉测试会判失败（请求成功，但测试图识别不正确）');
