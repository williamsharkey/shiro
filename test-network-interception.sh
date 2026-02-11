#!/bin/bash
# test-network-interception.sh - Test network interception layer

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

# Test 1: Network log retrieval
test_header "Network log retrieval"
RESULT=$(send_message "test-page" "network_log" '{}')
if echo "$RESULT" | grep -q '"total":' && echo "$RESULT" | grep -q '"entries":\['; then
  pass "Network log retrieval succeeds"
else
  fail "Network log retrieval fails" "$RESULT"
fi

# Test 2: Network log includes summary
test_header "Network log includes summary"
RESULT=$(send_message "test-page" "network_log" '{}')
if echo "$RESULT" | grep -q '"summary":{' && echo "$RESULT" | grep -q '"totalRequests":'; then
  pass "Network log includes summary"
else
  fail "Summary missing" "$RESULT"
fi

# Test 3: Summary by method
test_header "Summary by method"
RESULT=$(send_message "test-page" "network_log" '{}')
if echo "$RESULT" | grep -q '"byMethod":{'; then
  pass "Summary includes byMethod"
else
  fail "byMethod missing" "$RESULT"
fi

# Test 4: Summary by status
test_header "Summary by status"
RESULT=$(send_message "test-page" "network_log" '{}')
if echo "$RESULT" | grep -q '"byStatus":{'; then
  pass "Summary includes byStatus"
else
  fail "byStatus missing" "$RESULT"
fi

# Test 5: Summary by type
test_header "Summary by type"
RESULT=$(send_message "test-page" "network_log" '{}')
if echo "$RESULT" | grep -q '"byType":{'; then
  pass "Summary includes byType"
else
  fail "byType missing" "$RESULT"
fi

# Test 6: Average duration
test_header "Average duration"
RESULT=$(send_message "test-page" "network_log" '{}')
if echo "$RESULT" | grep -q '"avgDuration":'; then
  pass "Summary includes avgDuration"
else
  fail "avgDuration missing" "$RESULT"
fi

# Test 7: Pagination - limit option
test_header "Pagination limit option"
RESULT=$(send_message "test-page" "network_log" '{ "options": { "limit": 10 } }')
if echo "$RESULT" | grep -q '"limit":10'; then
  pass "Limit option works"
else
  fail "Limit option fails" "$RESULT"
fi

# Test 8: Pagination - offset option
test_header "Pagination offset option"
RESULT=$(send_message "test-page" "network_log" '{ "options": { "offset": 5 } }')
if echo "$RESULT" | grep -q '"offset":5'; then
  pass "Offset option works"
else
  fail "Offset option fails" "$RESULT"
fi

# Test 9: Filter by method
test_header "Filter by method"
RESULT=$(send_message "test-page" "network_log" '{ "options": { "filter": { "method": "GET" } } }')
if echo "$RESULT" | grep -q '"filtered":'; then
  pass "Method filter accepted"
else
  fail "Method filter fails" "$RESULT"
fi

# Test 10: Filter by status
test_header "Filter by status"
RESULT=$(send_message "test-page" "network_log" '{ "options": { "filter": { "status": 200 } } }')
if echo "$RESULT" | grep -q '"filtered":'; then
  pass "Status filter accepted"
else
  fail "Status filter fails" "$RESULT"
fi

# Test 11: Filter by URL
test_header "Filter by URL"
RESULT=$(send_message "test-page" "network_log" '{ "options": { "filter": { "url": "/api/" } } }')
if echo "$RESULT" | grep -q '"filtered":'; then
  pass "URL filter accepted"
else
  fail "URL filter fails" "$RESULT"
fi

# Test 12: Filter by type
test_header "Filter by type"
RESULT=$(send_message "test-page" "network_log" '{ "options": { "filter": { "type": "fetch" } } }')
if echo "$RESULT" | grep -q '"filtered":'; then
  pass "Type filter accepted"
else
  fail "Type filter fails" "$RESULT"
fi

# Test 13: Clear network log
test_header "Clear network log"
RESULT=$(send_message "test-page" "network_clear" '{}')
if echo "$RESULT" | grep -q '"cleared":' && echo "$RESULT" | grep -q '"remaining":'; then
  pass "Clear network log succeeds"
else
  fail "Clear network log fails" "$RESULT"
fi

# Test 14: Log entry structure
test_header "Log entry structure"
RESULT=$(send_message "test-page" "network_log" '{}')
if echo "$RESULT" | grep -q '"entries":\['; then
  pass "Entries array present"
else
  fail "Entries array missing" "$RESULT"
fi

# Test 15: Response metadata
test_header "Response metadata"
RESULT=$(send_message "test-page" "network_log" '{}')
if echo "$RESULT" | grep -q '"total":' && echo "$RESULT" | grep -q '"returned":'; then
  pass "Response includes metadata"
else
  fail "Metadata missing" "$RESULT"
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
