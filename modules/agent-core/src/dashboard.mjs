import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readMailboard } from './mailboard.mjs';

export const readMailboardHtml = () => readFileSync(new URL('../ui/mailboard.html', import.meta.url), 'utf8');

// This is an explicitly launched, loopback-only read view. It never dispatches agent_act.
export async function startDashboard(core, { port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid dashboard port');
  const html = readMailboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw Error('Dashboard script unavailable');
  const scriptHash = createHash('sha256').update(script).digest('base64');
  const session = randomBytes(32).toString('hex');
  let origin;
  const authenticated = request => {
    const value = request.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith('mailboard='))?.slice(10) ?? '';
    const bytes = Buffer.from(value), expected = Buffer.from(session);
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    const json = (code, value) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    if (request.headers.host !== new URL(origin).host ||
        request.headers.origin && request.headers.origin !== origin ||
        request.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(request.headers['sec-fetch-site']))
      return json(403, { error: 'Local same-origin access only' });
    if (request.method !== 'GET') return json(405, { error: 'Read-only endpoint' });
    if ((request.url?.length ?? 0) > 8192) return json(414, { error: 'Query too large' });
    let url;
    try { url = new URL(request.url, origin); }
    catch { return json(400, { error: 'Invalid URL' }); }
    if (url.pathname === '/' && !url.search) {
      // SameSite plus Origin/Fetch-Site/Host guards prevent cross-site reads; credentials never enter URLs or stdout.
      response.setHeader('Set-Cookie', `mailboard=${session}; HttpOnly; SameSite=Strict; Path=/`);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(html);
    }
    if (url.pathname !== '/api/observe') return json(404, { error: 'Not found' });
    if (!authenticated(request)) return json(401, { error: 'Open the local dashboard first' });
    if ([...url.searchParams.keys()].some(key => key !== 'q') || url.searchParams.getAll('q').length > 1)
      return json(400, { error: 'Invalid query' });
    try {
      const query = JSON.parse(url.searchParams.get('q') || '{}');
      json(200, await readMailboard(core, query));
    } catch { json(400, { error: 'Invalid observation request' }); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${origin}/` };
}
