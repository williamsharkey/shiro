/**
 * Wildcard subdomain proxy for shiro.computer
 *
 * Routes *.shiro.computer to the Pages deployment.
 * Each subdomain gets isolated IndexedDB/localStorage automatically
 * because the browser sees the original subdomain in window.location.
 */

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Rewrite hostname to Pages deployment
    url.hostname = 'shiro-3m3.pages.dev';

    // Create new request with rewritten URL
    // Preserve all other request properties (method, headers, body)
    const proxyRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    });

    // Fetch from Pages
    const response = await fetch(proxyRequest);

    // Return response with CORS headers for cross-origin iframe usage
    const headers = new Headers(response.headers);

    // Allow the response to be used in iframes on other domains
    headers.delete('X-Frame-Options');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
