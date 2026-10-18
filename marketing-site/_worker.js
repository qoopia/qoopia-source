/** Pages serves a directly requested 404.html as an ordinary 200 page. Fetch the
 * existing custom not-found document through a missing asset instead, preserving its 404.
 * Only /404 and /404.html invoke this worker (_routes.json); other assets stay static.
 */
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname !== '/404' && pathname !== '/404.html') return env.ASSETS.fetch(request);
    const url = new URL('/__qoopia_missing_page__', request.url);
    const headers = new Headers(request.headers);
    headers.delete('if-none-match');
    headers.delete('if-modified-since');
    const response = await env.ASSETS.fetch(new Request(url, { method: request.method, headers }));
    if (response.status >= 500) return response;
    return new Response(response.body, { status: 404, headers: response.headers });
  },
};
