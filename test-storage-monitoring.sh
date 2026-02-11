#!/bin/bash
# test-storage-monitoring.sh - Test localStorage and sessionStorage monitoring

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

# Helper function to send typed message
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

echo ""
echo "========================================"
echo "  Storage Monitoring Tests"
echo "========================================"

# Test 1: Get storage usage
test_header "Get storage usage"
RESULT=$(send_message "test-page" "storage_usage" '{}')
if echo "$RESULT" | grep -q '"localStorage":{' && echo "$RESULT" | grep -q '"sessionStorage":{'; then
  pass "Storage usage retrieved successfully"
else
  fail "Failed to get storage usage" "$RESULT"
fi

# Test 2: Storage usage includes item count
test_header "Storage usage includes item count"
RESULT=$(send_message "test-page" "storage_usage" '{}')
if echo "$RESULT" | grep -q '"itemCount":[0-9]' && echo "$RESULT" | grep -q '"sizeBytes":[0-9]'; then
  pass "Item count and size included"
else
  fail "Storage info missing" "$RESULT"
fi

# Test 3: Set localStorage item
test_header "Set localStorage item"
RESULT=$(send_message "test-page" "storage_set" '{"storageType":"localStorage","key":"test-key","value":"test-value"}')
if echo "$RESULT" | grep -q '"success":true' && echo "$RESULT" | grep -q '"key":"test-key"'; then
  pass "localStorage item set successfully"
else
  fail "Failed to set localStorage item" "$RESULT"
fi

# Test 4: Get localStorage item
test_header "Get localStorage item"
RESULT=$(send_message "test-page" "storage_get" '{"storageType":"localStorage","key":"test-key"}')
if echo "$RESULT" | grep -q '"value":"test-value"' && echo "$RESULT" | grep -q '"exists":true'; then
  pass "localStorage item retrieved"
else
  fail "Failed to get localStorage item" "$RESULT"
fi

# Test 5: Set sessionStorage item
test_header "Set sessionStorage item"
RESULT=$(send_message "test-page" "storage_set" '{"storageType":"sessionStorage","key":"session-key","value":"session-value"}')
if echo "$RESULT" | grep -q '"success":true' && echo "$RESULT" | grep -q '"storageType":"sessionStorage"'; then
  pass "sessionStorage item set successfully"
else
  fail "Failed to set sessionStorage item" "$RESULT"
fi

# Test 6: Get sessionStorage item
test_header "Get sessionStorage item"
RESULT=$(send_message "test-page" "storage_get" '{"storageType":"sessionStorage","key":"session-key"}')
if echo "$RESULT" | grep -q '"value":"session-value"' && echo "$RESULT" | grep -q '"exists":true'; then
  pass "sessionStorage item retrieved"
else
  fail "Failed to get sessionStorage item" "$RESULT"
fi

# Test 7: Start storage monitoring
test_header "Start storage monitoring"
RESULT=$(send_message "test-page" "storage_start" '{"options":{"interval":500}}')
if echo "$RESULT" | grep -q '"started":true' && echo "$RESULT" | grep -q '"interval":500'; then
  pass "Storage monitoring started"
else
  fail "Failed to start monitoring" "$RESULT"
fi

# Test 8: Detect storage changes
test_header "Detect storage changes"
sleep 1
send_message "test-page" "storage_set" '{"storageType":"localStorage","key":"change-test","value":"initial"}' > /dev/null 2>&1
sleep 1
RESULT=$(send_message "test-page" "storage_log" '{}')
if echo "$RESULT" | grep -q '"changes":\[' && echo "$RESULT" | grep -q '"monitoringActive":true'; then
  pass "Storage changes detected"
else
  fail "Failed to detect changes" "$RESULT"
fi

# Test 9: Filter by storage type
test_header "Filter by storage type"
RESULT=$(send_message "test-page" "storage_log" '{"options":{"storageType":"localStorage"}}')
if echo "$RESULT" | grep -q '"changes":\['; then
  pass "Filters by storage type"
else
  fail "Failed to filter" "$RESULT"
fi

# Test 10: Filter by change type
test_header "Filter by change type"
RESULT=$(send_message "test-page" "storage_log" '{"options":{"changeType":"set"}}')
if echo "$RESULT" | grep -q '"changes":\['; then
  pass "Filters by change type"
else
  fail "Failed to filter by change type" "$RESULT"
fi

# Test 11: Remove storage item
test_header "Remove storage item"
RESULT=$(send_message "test-page" "storage_remove" '{"storageType":"localStorage","key":"test-key"}')
if echo "$RESULT" | grep -q '"success":true' && echo "$RESULT" | grep -q '"existed":true'; then
  pass "Storage item removed"
else
  fail "Failed to remove item" "$RESULT"
fi

# Test 12: Clear storage log
test_header "Clear storage log"
RESULT=$(send_message "test-page" "storage_clear_log" '{}')
if echo "$RESULT" | grep -q '"cleared":[0-9]' && echo "$RESULT" | grep -q '"remaining":0'; then
  pass "Storage log cleared"
else
  fail "Failed to clear log" "$RESULT"
fi

# Test 13: Clear localStorage
test_header "Clear localStorage"
RESULT=$(send_message "test-page" "storage_clear" '{"storageType":"localStorage"}')
if echo "$RESULT" | grep -q '"success":true' && echo "$RESULT" | grep -q '"newSize":0'; then
  pass "localStorage cleared"
else
  fail "Failed to clear localStorage" "$RESULT"
fi

# Test 14: Clear sessionStorage
test_header "Clear sessionStorage"
RESULT=$(send_message "test-page" "storage_clear" '{"storageType":"sessionStorage"}')
if echo "$RESULT" | grep -q '"success":true' && echo "$RESULT" | grep -q '"storageType":"sessionStorage"'; then
  pass "sessionStorage cleared"
else
  fail "Failed to clear sessionStorage" "$RESULT"
fi

# Test 15: Stop storage monitoring
test_header "Stop storage monitoring"
RESULT=$(send_message "test-page" "storage_stop" '{}')
if echo "$RESULT" | grep -q '"stopped":true'; then
  pass "Storage monitoring stopped"
else
  fail "Failed to stop monitoring" "$RESULT"
fi

# Test 16: Monitoring inactive after stop
test_header "Monitoring inactive after stop"
RESULT=$(send_message "test-page" "storage_log" '{}')
if echo "$RESULT" | grep -q '"monitoringActive":false'; then
  pass "Monitoring correctly inactive"
else
  fail "Still active after stop" "$RESULT"
fi

# Test 17: Storage size calculation
test_header "Storage size calculation"
send_message "test-page" "storage_set" '{"storageType":"localStorage","key":"size-test","value":"x"}' > /dev/null 2>&1
RESULT=$(send_message "test-page" "storage_usage" '{}')
if echo "$RESULT" | grep -q '"sizeKB":[0-9]' && echo "$RESULT" | grep -q '"percentUsed":[0-9]'; then
  pass "Storage size calculated"
else
  fail "Size calculation missing" "$RESULT"
fi

# Test 18: Storage items list
test_header "Storage items list in usage"
RESULT=$(send_message "test-page" "storage_usage" '{}')
if echo "$RESULT" | grep -q '"items":\['; then
  pass "Storage items list included"
else
  fail "Items list missing" "$RESULT"
fi

# Final summary
echo ""
echo "========================================"
echo "  Test Summary"
echo "========================================"
echo -e "Total:  $TOTAL"
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed.${NC}"
  exit 1
fi
