#!/bin/bash
# test-mutation-observer.sh - Test DOM mutation observer integration

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

# Helper function to execute eval and get response
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

# Helper function to send typed message and get response
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
echo "  Skyeyes Mutation Observer Tests"
echo "========================================"

# Test 1: Start mutation observer
test_header "Start mutation observer"
RESULT=$(send_message "test-page" "mutation_start" '{}')
if echo "$RESULT" | grep -q '"started":true' && echo "$RESULT" | grep -q '"target":'; then
  pass "Mutation observer starts successfully"
else
  fail "Failed to start mutation observer" "$RESULT"
fi

# Test 2: Capture childList mutations
test_header "Capture childList mutations (add element)"
send_message "test-page" "mutation_clear" '{}' > /dev/null 2>&1
send_message "test-page" "mutation_start" '{}' > /dev/null 2>&1
sleep 0.5
exec_eval "test-page" "const div = document.createElement('div'); div.id = 'test-mutation'; document.body.appendChild(div);" > /dev/null 2>&1
sleep 0.5
RESULT=$(send_message "test-page" "mutation_log" '{}')
if echo "$RESULT" | grep -q '"type":"childList"' && echo "$RESULT" | grep -q '"addedNodes":\['; then
  pass "Captures childList mutation (element added)"
else
  fail "Failed to capture childList mutation" "$RESULT"
fi

# Test 3: Capture attribute mutations
test_header "Capture attribute mutations"
send_message "test-page" "mutation_clear" '{}' > /dev/null 2>&1
send_message "test-page" "mutation_start" '{"options":{"attributes":true,"attributeOldValue":true}}' > /dev/null 2>&1
sleep 0.5
exec_eval "test-page" "const el = document.getElementById('test-mutation'); if(el) el.setAttribute('data-test', 'value123');" > /dev/null 2>&1
sleep 0.5
RESULT=$(send_message "test-page" "mutation_log" '{}')
if echo "$RESULT" | grep -q '"type":"attributes"' && echo "$RESULT" | grep -q '"attributeName":"data-test"'; then
  pass "Captures attribute mutation"
else
  fail "Failed to capture attribute mutation" "$RESULT"
fi

# Test 4: Capture characterData mutations
test_header "Capture characterData mutations"
send_message "test-page" "mutation_clear" '{}' > /dev/null 2>&1
send_message "test-page" "mutation_start" '{"options":{"characterData":true}}' > /dev/null 2>&1
sleep 0.5
exec_eval "test-page" "const el = document.getElementById('test-mutation'); if(el) { el.textContent = 'initial'; setTimeout(() => el.textContent = 'updated', 100); }" > /dev/null 2>&1
sleep 0.5
RESULT=$(send_message "test-page" "mutation_log" '{}')
if echo "$RESULT" | grep -q '"type":"characterData"' || echo "$RESULT" | grep -q '"mutations":\['; then
  pass "Captures characterData mutation"
else
  fail "Failed to capture characterData mutation" "$RESULT"
fi

# Test 5: Stop mutation observer
test_header "Stop mutation observer"
RESULT=$(send_message "test-page" "mutation_stop" '{}')
if echo "$RESULT" | grep -q '"stopped":true'; then
  pass "Mutation observer stops successfully"
else
  fail "Failed to stop mutation observer" "$RESULT"
fi

# Test 6: Observer doesn't capture after stop
test_header "Observer inactive after stop"
send_message "test-page" "mutation_clear" '{}' > /dev/null 2>&1
send_message "test-page" "mutation_stop" '{}' > /dev/null 2>&1
sleep 0.5
exec_eval "test-page" "const div2 = document.createElement('div'); div2.id = 'test-after-stop'; document.body.appendChild(div2);" > /dev/null 2>&1
sleep 0.5
RESULT=$(send_message "test-page" "mutation_log" '{}')
# Should have no mutations or very few (from before)
if echo "$RESULT" | grep -q '"observerActive":false'; then
  pass "Observer correctly inactive after stop"
else
  fail "Observer still active after stop" "$RESULT"
fi

# Test 7: Get mutation log with filters
test_header "Get mutation log with type filter"
send_message "test-page" "mutation_clear" '{}' > /dev/null 2>&1
send_message "test-page" "mutation_start" '{}' > /dev/null 2>&1
sleep 0.5
exec_eval "test-page" "const el = document.createElement('span'); el.id = 'filter-test'; document.body.appendChild(el); el.setAttribute('class', 'test-class');" > /dev/null 2>&1
sleep 0.5
RESULT=$(send_message "test-page" "mutation_log" '{"options":{"type":"attributes"}}')
if echo "$RESULT" | grep -q '"filters":{' && echo "$RESULT" | grep -q '"type":"attributes"'; then
  pass "Filters mutation log by type"
else
  fail "Failed to filter mutation log" "$RESULT"
fi

# Test 8: Clear mutation log
test_header "Clear mutation log"
RESULT=$(send_message "test-page" "mutation_clear" '{}')
if echo "$RESULT" | grep -q '"cleared":' && echo "$RESULT" | grep -q '"remaining":0'; then
  pass "Clears mutation log successfully"
else
  fail "Failed to clear mutation log" "$RESULT"
fi

# Test 9: Log size limit (MAX_MUTATION_LOG_SIZE = 200)
test_header "Mutation log respects size limit"
send_message "test-page" "mutation_clear" '{}' > /dev/null 2>&1
send_message "test-page" "mutation_start" '{}' > /dev/null 2>&1
sleep 0.5
# Create many mutations
exec_eval "test-page" "for(let i=0; i<250; i++) { const el = document.createElement('span'); el.id = 'spam-' + i; document.body.appendChild(el); }" > /dev/null 2>&1
sleep 1
RESULT=$(send_message "test-page" "mutation_log" '{}')
# Should have at most 200 mutations
TOTAL=$(echo "$RESULT" | grep -o '"total":[0-9]*' | grep -o '[0-9]*')
if [ "$TOTAL" -le 200 ]; then
  pass "Mutation log respects size limit (total: $TOTAL)"
else
  fail "Mutation log exceeds size limit" "Total: $TOTAL"
fi

# Test 10: Observer with custom target
test_header "Observer with custom target element"
exec_eval "test-page" "const container = document.createElement('div'); container.id = 'custom-target'; document.body.appendChild(container);" > /dev/null 2>&1
sleep 0.5
send_message "test-page" "mutation_clear" '{}' > /dev/null 2>&1
RESULT=$(send_message "test-page" "mutation_start" '{"options":{"target":"#custom-target"}}')
if echo "$RESULT" | grep -q '"started":true' && echo "$RESULT" | grep -q '"target":"#custom-target"'; then
  pass "Observer starts with custom target"
else
  fail "Failed to start observer with custom target" "$RESULT"
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
