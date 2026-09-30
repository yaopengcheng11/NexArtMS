const protocolPaths = Object.freeze({
  'openai-chat-completions': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
});

/** Resolve conventional API base URLs without changing the configured origin. */
export function resolveModelEndpoint(endpoint, protocol) {
  const suffix = Object.hasOwn(protocolPaths, protocol) ? protocolPaths[protocol] : null;
  if (!suffix || typeof endpoint !== 'string') return endpoint;
  let url;
  try { url = new URL(endpoint); } catch { return endpoint; }
  // Validation owns unsafe URLs; never transform them into an apparently safe URL.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || endpoint.includes('?') || endpoint.includes('#')) return endpoint;
  const pathname = url.pathname.replace(/\/$/, '');
  const base = endpoint.trim().replace(/\/$/, '');
  if (!pathname) return `${base}/v1${suffix}`;
  if (/\/v\d+$/.test(pathname)) return `${base}${suffix}`;
  return endpoint;
}

// Cosmetic edits to a Base URL must not discard a saved credential. Compare
// resolved destinations, but keep custom paths and protocol changes distinct.
export function sameModelEndpoint(firstEndpoint, firstProtocol, secondEndpoint, secondProtocol) {
  if (firstProtocol !== secondProtocol) return false;
  try {
    const inputs = [firstEndpoint, secondEndpoint];
    const urls = inputs.map(endpoint => new URL(endpoint));
    if (urls.some((url, index) => !['https:', 'http:'].includes(url.protocol) || url.username || url.password || inputs[index].includes('?') || inputs[index].includes('#'))) return false;
    return new URL(resolveModelEndpoint(firstEndpoint, firstProtocol)).href === new URL(resolveModelEndpoint(secondEndpoint, secondProtocol)).href;
  } catch {return false;}
}
