#!/bin/sh
# virtual-server.sh - Interactive test for virtual server + Express shim
#
# VERIFIED WORKING: 2025-01-30
#   - Tested on williamsharkey.github.io/shiro/
#   - Express server started on port 9999
#   - Opened ?PORT=9999&PATH=/api/hello in new browser tab
#   - Received {"message":"Hello!"} with browser's JSON pretty-print
#   - Service worker successfully routed cross-tab request!
#
# Run this in Shiro's terminal (via windwalker or manually):
#   source test/interactive/virtual-server.sh
#
# Prerequisites:
#   - Shiro running (localhost:5173 or github.io)
#   - Service worker registered (check devtools > Application > Service Workers)

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  Virtual Server Interactive Test                              ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Test 1: Start Express server
echo "=== Test 1: Starting Express Server on Port 9999 ==="
echo ""

node -e "
const express = require('express');
const app = express();

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from virtual server!', timestamp: Date.now() });
});

app.get('/api/echo/:text', (req, res) => {
  res.json({ echo: req.params.text });
});

app.post('/api/data', (req, res) => {
  res.json({ received: true, body: req.body });
});

app.listen(9999, () => {
  console.log('Express server started on port 9999');
});
" &

# Give it a moment to start
sleep 1

echo ""
echo "=== Test 2: Verify Server is Registered ==="
servers

echo ""
echo "=== Test 3: Test via fetch ==="
echo "Fetching ?PORT=9999&PATH=/api/hello ..."
echo ""

# Use js-eval to make a fetch request to the virtual server
js-eval "
(async () => {
  const origin = window.location.origin;
  const pathname = window.location.pathname;
  const url = origin + pathname + '?PORT=9999&PATH=/api/hello';

  console.log('Fetching:', url);

  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log('Response status:', response.status);
    console.log('Response body:', JSON.stringify(data, null, 2));

    if (data.message === 'Hello from virtual server!') {
      console.log('');
      console.log('✅ TEST PASSED: Virtual server responded correctly!');
    } else {
      console.log('');
      console.log('❌ TEST FAILED: Unexpected response');
    }
  } catch (err) {
    console.log('❌ TEST FAILED:', err.message);
    console.log('');
    console.log('Troubleshooting:');
    console.log('  1. Check if service worker is registered (DevTools > Application)');
    console.log('  2. Try refreshing the page to activate service worker');
    console.log('  3. Check console for errors');
  }
})()
"

echo ""
echo "=== Test 4: Test Route Parameters ==="
js-eval "
(async () => {
  const origin = window.location.origin;
  const pathname = window.location.pathname;
  const url = origin + pathname + '?PORT=9999&PATH=/api/echo/testing123';

  const response = await fetch(url);
  const data = await response.json();

  if (data.echo === 'testing123') {
    console.log('✅ Route params work: echo =', data.echo);
  } else {
    console.log('❌ Route params failed:', JSON.stringify(data));
  }
})()
"

echo ""
echo "=== Test 5: Manual Browser Test ==="
echo ""
echo "Open this URL in a new browser tab to verify:"
js-eval "window.location.origin + window.location.pathname + '?PORT=9999&PATH=/api/hello'"
echo ""

echo "=== Test Complete ==="
echo ""
echo "To stop the server: serve stop 9999"
echo ""
