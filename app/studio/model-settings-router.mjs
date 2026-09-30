const send = (res, status, value) => {res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});res.end(JSON.stringify(value));};
const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const loopback = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '[::1]'].includes(value);
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail('模型设置写入仅接受 application/json', 415);
  let bytes = 0;const chunks = [];
  for await (const chunk of req) {bytes += chunk.length;if (bytes > 65536) throw fail('模型设置请求过大', 413);chunks.push(chunk);}
  try {const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();return body;} catch {throw fail('请求体不是有效 JSON 对象');}
}
export function guardLocalStudioRequest(req) {
  let host;
  try {host = new URL(`http://${req.headers.host}`);} catch {throw fail('无效的本机服务 Host', 403);}
  // Vite's same-origin /api proxy preserves its browser-facing Host and Origin,
  // whose port intentionally differs from the backend socket's local port.
  if (!loopback(host.hostname) || host.username || host.password || host.pathname !== '/' || host.search || !loopback(req.socket.remoteAddress)) throw fail('工作台写入只允许通过本机服务访问', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('模型设置不允许跨站访问', 403);
  if (req.headers.origin) {
    let origin;
    try {origin = new URL(req.headers.origin);} catch {throw fail('模型设置请求来源无效', 403);}
    if (origin.protocol !== 'http:' || origin.host !== host.host || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw fail('模型设置不允许跨源访问', 403);
  }
}

export function createModelSettingsRouter(settings, {beforeMutation} = {}) {
  return async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const base = '/api/studio/model-settings';
    if (pathname !== base && !pathname.startsWith(base + '/')) return false;
    try {
      guardLocalStudioRequest(req);
      if (req.method === 'GET' && pathname === base) {send(res, 200, settings.publicState());return true;}
      const profile = /^\/api\/studio\/model-settings\/profiles\/([^/]+)(\/test)?$/.exec(pathname);
      let operation;
      if (req.method === 'POST' && pathname === base + '/profiles') operation = 'add';
      else if (req.method === 'POST' && pathname === base + '/select') operation = 'select';
      else if (profile && !profile[2] && req.method === 'PATCH') operation = 'update';
      else if (profile && !profile[2] && req.method === 'DELETE') operation = 'delete';
      else if (profile?.[2] && req.method === 'POST') operation = 'test';
      else throw fail('模型设置接口不存在', 404);
      const body = await readBody(req), profileId = profile ? decodeURIComponent(profile[1]) : null;
      if (beforeMutation) await beforeMutation({operation, profileId, body});
      const commitGuard = beforeMutation ? () => beforeMutation({operation, profileId, body}) : undefined;
      const result = operation === 'add' ? await settings.addProfile(body, commitGuard)
        : operation === 'update' ? await settings.updateProfile(profileId, body, commitGuard)
        : operation === 'delete' ? await settings.deleteProfile(profileId, body, commitGuard)
        : operation === 'select' ? await settings.select(body, commitGuard)
        : await settings.testProfile(profileId, body, commitGuard);
      send(res, 200, result);
    } catch (cause) {send(res, cause.status || 500, {error: cause.status ? cause.message : '模型设置处理失败', ...(cause.code ? {code: cause.code} : {})});}
    return true;
  };
}
