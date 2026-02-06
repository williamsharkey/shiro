/**
 * Cloudflare Pages Function - OAuth Callback Handler
 *
 * Receives OAuth redirects from identity providers (e.g., platform.claude.com).
 * Sends the authorization code back to the Shiro window via postMessage,
 * which forwards it to the CLI's local HTTP server handler.
 *
 * Flow:
 * 1. CLI opens OAuth URL with redirect_uri=https://shiro.computer/oauth/callback?port=PORT
 * 2. User authenticates, provider redirects here with ?code=...&state=...&port=PORT
 * 3. This page postMessages {type:'oauth-callback', code, state, port} to window.opener
 * 4. Shiro's message listener dispatches the callback to the HTTP server on that port
 */

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const params = Object.fromEntries(url.searchParams.entries());

  // Build a minimal HTML page that sends the callback data back to the opener
  const html = `<!DOCTYPE html>
<html>
<head><title>OAuth Callback - Shiro</title></head>
<body>
<p>Authenticating...</p>
<script>
(function() {
  var params = ${JSON.stringify(params)};
  if (window.opener) {
    window.opener.postMessage({
      type: 'shiro-oauth-callback',
      code: params.code || '',
      state: params.state || '',
      port: params.port || '',
      params: params
    }, '${url.origin}');
    document.body.innerHTML = '<p>Authentication complete. You can close this window.</p>';
    setTimeout(function() { window.close(); }, 1000);
  } else {
    document.body.innerHTML = '<p>Error: Could not communicate with Shiro. Please close this window and try again.</p>';
  }
})();
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};
