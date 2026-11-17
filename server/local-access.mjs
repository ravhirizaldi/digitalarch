export function localAccessError(req) {
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(req.headers.host || ''))
    return 'Local access only: unsupported hostname.';
  if (req.headers['sec-fetch-site'] !== 'cross-site') return null;
  // Following a link to the local UI is safe; cross-site API/resource requests are not.
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return 'Invalid local request URL.';
  }
  if (
    req.method === 'GET' &&
    req.headers['sec-fetch-mode'] === 'navigate' &&
    req.headers['sec-fetch-dest'] === 'document' &&
    !pathname.startsWith('/api/')
  )
    return null;
  return 'Cross-site requests are blocked. Open DigitalArch directly in your browser.';
}
