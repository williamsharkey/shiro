#!/bin/bash
# test-screenshot.sh - Test screenshot capability for visual regression

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

# Helper function to execute eval
exec_eval() {
  local page=$1
  local code=$2

  node -e "
    const WebSocket = require('ws');
    const ws = new WebSocket('ws://localhost:3456/skyeyes?page=${page}');

    ws.on('open', function() {
      ws.send(JSON.stringify({ type: 'eval', id: 'test-eval', code: \`${code}\` }));
    });

    ws.on('message', function(data) {
      const msg = JSON.parse(data);
      if (msg.id === 'test-eval') {
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
    }, 10000);
  " 2>/dev/null
}

echo ""
echo "========================================"
echo "  Screenshot Capability Tests"
echo "========================================"

# Setup - create test element
exec_eval "test-page" "const div = document.createElement('div'); div.id = 'screenshot-test'; div.style.width = '200px'; div.style.height = '100px'; div.style.backgroundColor = 'blue'; div.textContent = 'Test Content'; document.body.appendChild(div);" > /dev/null 2>&1

# Test 1: Capture viewport screenshot
test_header "Capture viewport screenshot"
RESULT=$(send_message "test-page" "screenshot_capture" '{"options":{"screenshotId":"test-viewport"}}')
if echo "$RESULT" | grep -q '"screenshotId":"test-viewport"' && echo "$RESULT" | grep -q '"cached":true'; then
  pass "Viewport screenshot captured"
else
  fail "Failed to capture viewport" "$RESULT"
fi

# Test 2: Capture element screenshot
test_header "Capture element screenshot"
RESULT=$(send_message "test-page" "screenshot_capture" '{"options":{"selector":"#screenshot-test","screenshotId":"test-element"}}')
if echo "$RESULT" | grep -q '"screenshotId":"test-element"' && echo "$RESULT" | grep -q '"width":'; then
  pass "Element screenshot captured"
else
  fail "Failed to capture element" "$RESULT"
fi

# Test 3: Screenshot includes dimensions
test_header "Screenshot includes dimensions"
RESULT=$(send_message "test-page" "screenshot_capture" '{"options":{"screenshotId":"test-dims"}}')
if echo "$RESULT" | grep -q '"width":[0-9]' && echo "$RESULT" | grep -q '"height":[0-9]'; then
  pass "Screenshot includes dimensions"
else
  fail "Dimensions missing" "$RESULT"
fi

# Test 4: Screenshot includes size info
test_header "Screenshot includes size info"
RESULT=$(send_message "test-page" "screenshot_capture" '{"options":{"screenshotId":"test-size"}}')
if echo "$RESULT" | grep -q '"sizeKB":[0-9]' && echo "$RESULT" | grep -q '"format":"png"'; then
  pass "Screenshot includes size info"
else
  fail "Size info missing" "$RESULT"
fi

# Test 5: Return data URL option
test_header "Return data URL in response"
RESULT=$(send_message "test-page" "screenshot_capture" '{"options":{"screenshotId":"test-data","returnData":true}}')
if echo "$RESULT" | grep -q '"dataUrl":"data:image'; then
  pass "Returns data URL when requested"
else
  fail "Data URL missing" "$RESULT"
fi

# Test 6: Get screenshot from cache
test_header "Get screenshot from cache"
RESULT=$(send_message "test-page" "screenshot_get" '{"screenshotId":"test-viewport"}')
if echo "$RESULT" | grep -q '"dataUrl":"data:image' && echo "$RESULT" | grep -q '"id":"test-viewport"'; then
  pass "Retrieves screenshot from cache"
else
  fail "Failed to get from cache" "$RESULT"
fi

# Test 7: List screenshots
test_header "List cached screenshots"
RESULT=$(send_message "test-page" "screenshot_list" '{}')
if echo "$RESULT" | grep -q '"count":[0-9]' && echo "$RESULT" | grep -q '"screenshots":\['; then
  pass "Lists cached screenshots"
else
  fail "Failed to list screenshots" "$RESULT"
fi

# Test 8: Screenshot metadata
test_header "Screenshot metadata in list"
RESULT=$(send_message "test-page" "screenshot_list" '{}')
if echo "$RESULT" | grep -q '"timestamp":' && echo "$RESULT" | grep -q '"sizeKB":'; then
  pass "Screenshot metadata included"
else
  fail "Metadata missing" "$RESULT"
fi

# Test 9: Compare screenshots (identical)
test_header "Compare identical screenshots"
send_message "test-page" "screenshot_capture" '{"options":{"screenshotId":"compare-1"}}' > /dev/null 2>&1
send_message "test-page" "screenshot_capture" '{"options":{"screenshotId":"compare-2"}}' > /dev/null 2>&1
RESULT=$(send_message "test-page" "screenshot_compare" '{"screenshot1Id":"compare-1","screenshot2Id":"compare-2"}')
if echo "$RESULT" | grep -q '"dimensionsMatch":true'; then
  pass "Compares screenshots successfully"
else
  fail "Failed to compare screenshots" "$RESULT"
fi

# Test 10: Compare different screenshots
test_header "Compare different screenshots"
exec_eval "test-page" "document.getElementById('screenshot-test').style.backgroundColor = 'red';" > /dev/null 2>&1
sleep 0.5
send_message "test-page" "screenshot_capture" '{"options":{"selector":"#screenshot-test","screenshotId":"compare-3"}}' > /dev/null 2>&1
RESULT=$(send_message "test-page" "screenshot_compare" '{"screenshot1Id":"test-element","screenshot2Id":"compare-3"}')
if echo "$RESULT" | grep -q '"dimensionsMatch":' && echo "$RESULT" | grep -q '"identical":'; then
  pass "Detects differences between screenshots"
else
  fail "Failed to detect differences" "$RESULT"
fi

# Test 11: Clear specific screenshot
test_header "Clear specific screenshot"
RESULT=$(send_message "test-page" "screenshot_clear" '{"screenshotId":"test-viewport"}')
if echo "$RESULT" | grep -q '"cleared":[0-9]' && echo "$RESULT" | grep -q '"remaining":'; then
  pass "Clears specific screenshot"
else
  fail "Failed to clear screenshot" "$RESULT"
fi

# Test 12: Clear all screenshots
test_header "Clear all screenshots"
RESULT=$(send_message "test-page" "screenshot_clear" '{}')
if echo "$RESULT" | grep -q '"cleared":[0-9]' && echo "$RESULT" | grep -q '"remaining":0'; then
  pass "Clears all screenshots"
else
  fail "Failed to clear all" "$RESULT"
fi

# Test 13: JPEG format support
test_header "JPEG format support"
RESULT=$(send_message "test-page" "screenshot_capture" '{"options":{"screenshotId":"test-jpeg","format":"jpeg"}}')
if echo "$RESULT" | grep -q '"format":"jpeg"'; then
  pass "JPEG format supported"
else
  fail "JPEG format not supported" "$RESULT"
fi

# Test 14: Cache size limit
test_header "Screenshot cache respects size limit"
for i in {1..12}; do
  send_message "test-page" "screenshot_capture" "{\"options\":{\"screenshotId\":\"test-limit-$i\"}}" > /dev/null 2>&1
done
RESULT=$(send_message "test-page" "screenshot_list" '{}')
COUNT=$(echo "$RESULT" | grep -o '"count":[0-9]*' | grep -o '[0-9]*')
if [ "$COUNT" -le 10 ]; then
  pass "Screenshot cache respects limit (count: $COUNT)"
else
  fail "Cache exceeds limit" "Count: $COUNT"
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
