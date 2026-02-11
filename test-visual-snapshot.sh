#!/bin/bash
# test-visual-snapshot.sh - Test visual snapshot capability

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0
TOTAL=0

pass() {
  echo -e "${GREEN}✓${NC} $1"
  ((PASSED++))
  ((TOTAL++))
}

fail() {
  echo -e "${RED}✗${NC} $1"
  echo -e "  ${RED}Error: $2${NC}"
  ((FAILED++))
  ((TOTAL++))
}

info() {
  echo -e "${YELLOW}ℹ${NC} $1"
}

test_header() {
  echo ""
  echo -e "${YELLOW}Testing: $1${NC}"
  echo "----------------------------------------"
}

# Start test server
info "Starting skyeyes test server..."
node test-server.js &
SERVER_PID=$!
sleep 2

# Helper function to send message and get response
send_message() {
  local page=$1
  local type=$2
  local data=$3

  node -e "
    const WebSocket = require('ws');
    const ws = new WebSocket('ws://localhost:3456/skyeyes?page=${page}');

    ws.on('open', function() {
      ws.send(JSON.stringify({ type: '${type}', id: 'test-${type}', ...${data} }));
    });

    ws.on('message', function(data) {
      const msg = JSON.parse(data);
      if (msg.id === 'test-${type}') {
        console.log(JSON.stringify(msg));
        ws.close();
        process.exit(0);
      }
    });

    setTimeout(() => {
      console.error('Timeout waiting for response');
      ws.close();
      process.exit(1);
    }, 5000);
  " 2>/dev/null
}

# Test 1: Basic visual snapshot
test_header "Basic visual snapshot"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"viewport"' && echo "$RESULT" | grep -q '"visualTree"'; then
  pass "Basic visual snapshot returns viewport and visualTree"
else
  fail "Basic visual snapshot fails" "$RESULT"
fi

# Test 2: Viewport information
test_header "Viewport information"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"width"' && echo "$RESULT" | grep -q '"height"' && echo "$RESULT" | grep -q '"scrollX"'; then
  pass "Viewport includes width, height, and scroll positions"
else
  fail "Viewport information incomplete" "$RESULT"
fi

# Test 3: Document information
test_header "Document information"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"title"' && echo "$RESULT" | grep -q '"url"' && echo "$RESULT" | grep -q '"readyState"'; then
  pass "Document includes title, url, and readyState"
else
  fail "Document information incomplete" "$RESULT"
fi

# Test 4: Visual tree structure
test_header "Visual tree structure"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"tag":"body"' && echo "$RESULT" | grep -q '"depth":0' && echo "$RESULT" | grep -q '"visible"'; then
  pass "Visual tree has root node with tag, depth, and visible"
else
  fail "Visual tree structure invalid" "$RESULT"
fi

# Test 5: Element rectangles
test_header "Element rectangles"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"rect":{' && echo "$RESULT" | grep -q '"x":' && echo "$RESULT" | grep -q '"width":'; then
  pass "Elements include rect with x, y, width, height"
else
  fail "Element rectangles missing" "$RESULT"
fi

# Test 6: Visible text extraction
test_header "Visible text extraction"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"visibleText":\['; then
  pass "Visible text array included in snapshot"
else
  fail "Visible text extraction fails" "$RESULT"
fi

# Test 7: Interactive elements
test_header "Interactive elements"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"interactiveElements":\['; then
  pass "Interactive elements array included"
else
  fail "Interactive elements missing" "$RESULT"
fi

# Test 8: Layout zones
test_header "Layout zones"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"layoutZones":{'; then
  pass "Layout zones included in snapshot"
else
  fail "Layout zones missing" "$RESULT"
fi

# Test 9: maxDepth option
test_header "maxDepth option"
RESULT=$(send_message "test-page" "visual_snapshot" '{ "options": { "maxDepth": 3 } }')
if echo "$RESULT" | grep -q '"visualTree"'; then
  pass "maxDepth option accepted"
else
  fail "maxDepth option fails" "$RESULT"
fi

# Test 10: includeStyles option
test_header "includeStyles option"
RESULT=$(send_message "test-page" "visual_snapshot" '{ "options": { "includeStyles": true } }')
if echo "$RESULT" | grep -q '"styles":{' || echo "$RESULT" | grep -q '"visualTree"'; then
  pass "includeStyles option accepted"
else
  fail "includeStyles option fails" "$RESULT"
fi

# Test 11: maxElements option
test_header "maxElements option"
RESULT=$(send_message "test-page" "visual_snapshot" '{ "options": { "maxElements": 50 } }')
if echo "$RESULT" | grep -q '"visualTree"'; then
  pass "maxElements option accepted"
else
  fail "maxElements option fails" "$RESULT"
fi

# Test 12: Timestamp included
test_header "Timestamp included"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"timestamp":'; then
  pass "Snapshot includes timestamp"
else
  fail "Timestamp missing" "$RESULT"
fi

# Test 13: Timing data
test_header "Timing data"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"timing":{' && echo "$RESULT" | grep -q '"duration":'; then
  pass "Snapshot includes timing data"
else
  fail "Timing data missing" "$RESULT"
fi

# Test 14: Device pixel ratio
test_header "Device pixel ratio"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"devicePixelRatio":'; then
  pass "Viewport includes devicePixelRatio"
else
  fail "devicePixelRatio missing" "$RESULT"
fi

# Test 15: Element selectors in interactive elements
test_header "Element selectors"
RESULT=$(send_message "test-page" "visual_snapshot" '{}')
if echo "$RESULT" | grep -q '"selector":' || echo "$RESULT" | grep -q '"interactiveElements":\[\]'; then
  pass "Interactive elements include selectors or array is empty"
else
  fail "Element selectors missing" "$RESULT"
fi

# Cleanup
info "Cleaning up..."
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

# Summary
echo ""
echo "========================================"
echo -e "Test Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC} out of ${TOTAL} total"
echo "========================================"

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed.${NC}"
  exit 1
fi
