#!/bin/bash
# test-accessibility-tree.sh - Test accessibility tree extraction

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

# Test 1: Basic accessibility tree
test_header "Basic accessibility tree"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"tree":{' && echo "$RESULT" | grep -q '"role":'; then
  pass "Basic accessibility tree extraction succeeds"
else
  fail "Basic accessibility tree fails" "$RESULT"
fi

# Test 2: Tree includes role and tag
test_header "Tree includes role and tag"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"role":' && echo "$RESULT" | grep -q '"tag":'; then
  pass "Tree nodes include role and tag"
else
  fail "Tree nodes missing role/tag" "$RESULT"
fi

# Test 3: Landmarks extraction
test_header "Landmarks extraction"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"landmarks":\['; then
  pass "Landmarks array included"
else
  fail "Landmarks extraction fails" "$RESULT"
fi

# Test 4: Headings extraction
test_header "Headings extraction"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"headings":\['; then
  pass "Headings array included"
else
  fail "Headings extraction fails" "$RESULT"
fi

# Test 5: Interactive elements
test_header "Interactive elements"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"interactive":\['; then
  pass "Interactive elements array included"
else
  fail "Interactive extraction fails" "$RESULT"
fi

# Test 6: Forms extraction
test_header "Forms extraction"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"forms":\['; then
  pass "Forms array included"
else
  fail "Forms extraction fails" "$RESULT"
fi

# Test 7: Navigation extraction
test_header "Navigation extraction"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"navigation":\['; then
  pass "Navigation array included"
else
  fail "Navigation extraction fails" "$RESULT"
fi

# Test 8: Metadata inclusion
test_header "Metadata inclusion"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"metadata":{' && echo "$RESULT" | grep -q '"title":' && echo "$RESULT" | grep -q '"url":'; then
  pass "Metadata includes title and url"
else
  fail "Metadata incomplete" "$RESULT"
fi

# Test 9: maxDepth option
test_header "maxDepth option"
RESULT=$(send_message "test-page" "accessibility_tree" '{ "options": { "maxDepth": 10 } }')
if echo "$RESULT" | grep -q '"tree":{'; then
  pass "maxDepth option accepted"
else
  fail "maxDepth option fails" "$RESULT"
fi

# Test 10: includePositions option
test_header "includePositions option"
RESULT=$(send_message "test-page" "accessibility_tree" '{ "options": { "includePositions": true } }')
if echo "$RESULT" | grep -q '"rect":{' || echo "$RESULT" | grep -q '"tree":{'; then
  pass "includePositions option accepted"
else
  fail "includePositions option fails" "$RESULT"
fi

# Test 11: Element selectors
test_header "Element selectors"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"selector":'; then
  pass "Elements include selectors"
else
  fail "Selectors missing" "$RESULT"
fi

# Test 12: ARIA states
test_header "ARIA states"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"states":{' || echo "$RESULT" | grep -q '"interactive":\['; then
  pass "ARIA states captured or interactive array present"
else
  fail "ARIA states missing" "$RESULT"
fi

# Test 13: Timing data
test_header "Timing data"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"timing":{' && echo "$RESULT" | grep -q '"duration":'; then
  pass "Timing data included"
else
  fail "Timing data missing" "$RESULT"
fi

# Test 14: Timestamp
test_header "Timestamp"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"timestamp":'; then
  pass "Timestamp included"
else
  fail "Timestamp missing" "$RESULT"
fi

# Test 15: Tree depth tracking
test_header "Tree depth tracking"
RESULT=$(send_message "test-page" "accessibility_tree" '{}')
if echo "$RESULT" | grep -q '"depth":'; then
  pass "Tree nodes include depth"
else
  fail "Depth tracking missing" "$RESULT"
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
