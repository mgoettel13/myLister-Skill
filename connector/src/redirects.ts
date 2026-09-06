export function allowedRedirect(uri: string, exactUris: string[], allowLoopback = false): boolean {
  try {
    const url = new URL(uri);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:' && exactUris.includes(uri)) return true;
    return allowLoopback && url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && Boolean(url.port) &&
      /^\/callback(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname) && !url.search;
  } catch { return false; }
}
