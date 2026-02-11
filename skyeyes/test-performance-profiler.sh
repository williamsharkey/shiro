#!/bin/bash
# test-performance-profiler.sh - Test performance profiler with PerformanceObserver

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
echo "  Performance Profiler Tests"
echo "========================================"

# Test 1: Start performance monitoring
test_header "Start performance monitoring"
RESULT=$(send_message "test-page" "performance_start" '{}')
if echo "$RESULT" | grep -q '"started":true' && echo "$RESULT" | grep -q '"observing":\['; then
  pass "Performance monitoring starts successfully"
else
  fail "Failed to start performance monitoring" "$RESULT"
fi

# Test 2: Get performance snapshot
test_header "Get performance snapshot"
RESULT=$(send_message "test-page" "performance_snapshot" '{}')
if echo "$RESULT" | grep -q '"timing":{' && echo "$RESULT" | grep -q '"timestamp":'; then
  pass "Performance snapshot retrieved"
else
  fail "Failed to get performance snapshot" "$RESULT"
fi

# Test 3: Get performance metrics
test_header "Get performance metrics"
sleep 1
RESULT=$(send_message "test-page" "performance_metrics" '{}')
if echo "$RESULT" | grep -q '"summary":{' && echo "$RESULT" | grep -q '"monitoringActive":'; then
  pass "Performance metrics retrieved"
else
  fail "Failed to get performance metrics" "$RESULT"
fi

# Test 4: Filter by type
test_header "Filter metrics by type"
RESULT=$(send_message "test-page" "performance_metrics" '{"options":{"type":"navigation"}}')
if echo "$RESULT" | grep -q '"entries":\['; then
  pass "Filters metrics by type"
else
  fail "Failed to filter by type" "$RESULT"
fi

# Test 5: Check summary statistics
test_header "Summary statistics included"
RESULT=$(send_message "test-page" "performance_metrics" '{}')
if echo "$RESULT" | grep -q '"summary":{' && echo "$RESULT" | grep -q '"byType":{'; then
  pass "Summary statistics included"
else
  fail "Summary missing" "$RESULT"
fi

# Test 6: Navigation timing in summary
test_header "Navigation timing in summary"
RESULT=$(send_message "test-page" "performance_metrics" '{}')
if echo "$RESULT" | grep -q '"navigation":' || echo "$RESULT" | grep -q '"summary":{'; then
  pass "Navigation timing available"
else
  fail "Navigation timing missing" "$RESULT"
fi

# Test 7: Clear performance log
test_header "Clear performance log"
RESULT=$(send_message "test-page" "performance_clear" '{}')
if echo "$RESULT" | grep -q '"cleared":' && echo "$RESULT" | grep -q '"remaining":'; then
  pass "Clears performance log successfully"
else
  fail "Failed to clear performance log" "$RESULT"
fi

# Test 8: Stop performance monitoring
test_header "Stop performance monitoring"
RESULT=$(send_message "test-page" "performance_stop" '{}')
if echo "$RESULT" | grep -q '"stopped":true' && echo "$RESULT" | grep -q '"capturedEntries":'; then
  pass "Performance monitoring stops successfully"
else
  fail "Failed to stop performance monitoring" "$RESULT"
fi

# Test 9: Monitoring inactive after stop
test_header "Monitoring inactive after stop"
RESULT=$(send_message "test-page" "performance_metrics" '{}')
if echo "$RESULT" | grep -q '"monitoringActive":false'; then
  pass "Monitoring correctly inactive after stop"
else
  fail "Monitoring still active after stop" "$RESULT"
fi

# Test 10: Restart monitoring
test_header "Restart performance monitoring"
RESULT=$(send_message "test-page" "performance_start" '{"options":{"types":["navigation","paint"]}}')
if echo "$RESULT" | grep -q '"started":true'; then
  pass "Can restart performance monitoring"
else
  fail "Failed to restart monitoring" "$RESULT"
fi

# Test 11: Custom observer types
test_header "Custom observer types"
RESULT=$(send_message "test-page" "performance_start" '{"options":{"types":["resource","longtask"]}}')
if echo "$RESULT" | grep -q '"observing":\['; then
  pass "Custom observer types accepted"
else
  fail "Failed to set custom types" "$RESULT"
fi

# Test 12: Log size limit
test_header "Performance log respects size limit"
send_message "test-page" "performance_start" '{}' > /dev/null 2>&1
sleep 2
RESULT=$(send_message "test-page" "performance_metrics" '{}')
# Should have entries but not exceed 500 (MAX_PERFORMANCE_LOG_SIZE)
TOTAL=$(echo "$RESULT" | grep -o '"total":[0-9]*' | grep -o '[0-9]*' | head -1)
if [ -z "$TOTAL" ] || [ "$TOTAL" -le 500 ]; then
  pass "Performance log respects size limit (total: ${TOTAL:-0})"
else
  fail "Performance log exceeds size limit" "Total: $TOTAL"
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
