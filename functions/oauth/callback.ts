/**
 * Cloudflare Pages Function - OAuth Callback Handler
 *
 * Handles OAuth callback from Claude Platform, exchanges code for token,
 * and sends the token back to the opener window.
 */

interface Env {
  ALLOWED_ORIGINS?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // Build HTML response that communicates with opener
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Claude Login</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #1a1a2e;
      color: #eee;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .spinner {
      border: 3px solid #333;
      border-top: 3px solid #6366f1;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .error { color: #f87171; }
    .success { color: #4ade80; }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner" id="spinner"></div>
    <p id="status">Completing login...</p>
  </div>
  <script>
    (function() {
      const code = ${JSON.stringify(code)};
      const state = ${JSON.stringify(state)};
      const error = ${JSON.stringify(error)};

      const statusEl = document.getElementById('status');
      const spinnerEl = document.getElementById('spinner');

      function done(success, message) {
        spinnerEl.style.display = 'none';
        statusEl.textContent = message;
        statusEl.className = success ? 'success' : 'error';
        if (success) {
          setTimeout(() => window.close(), 1500);
        }
      }

      if (error) {
        if (window.opener) {
          window.opener.postMessage({ type: 'oauth_error', error }, '*');
        }
        done(false, 'Login failed: ' + error);
        return;
      }

      if (!code) {
        done(false, 'No authorization code received');
        return;
      }

      // Send the code to the opener window
      // The opener will handle the token exchange
      if (window.opener) {
        window.opener.postMessage({
          type: 'oauth_callback',
          code: code,
          state: state
        }, '*');
        done(true, 'Login successful! This window will close.');
      } else {
        done(false, 'Could not communicate with Shiro. Please try again.');
      }
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html',
    },
  });
};
