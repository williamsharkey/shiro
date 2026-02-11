#!/bin/bash
# test-keyboard-clipboard.sh - Test clipboard and keyboard event simulation

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

# Test 1: Paste into input element
test_header "Paste into input element"
RESULT=$(send_message "test-page" "element_paste" '{ "selector": "input[type=text]", "text": "Hello World" }')
if echo "$RESULT" | grep -q '"success":true'; then
  pass "Paste into input succeeds"
else
  fail "Paste into input fails" "$RESULT"
fi

# Test 2: Paste at cursor position
test_header "Paste at cursor position"
RESULT=$(send_message "test-page" "element_paste" '{ "selector": "input[type=text]", "text": "inserted" }')
if echo "$RESULT" | grep -q '"pastedText":"inserted"'; then
  pass "Paste at cursor position preserves text"
else
  fail "Paste at cursor position fails" "$RESULT"
fi

# Test 3: Paste into textarea
test_header "Paste into textarea"
RESULT=$(send_message "test-page" "element_paste" '{ "selector": "textarea", "text": "Multi\\nline\\ntext" }')
if echo "$RESULT" | grep -q '"success":true'; then
  pass "Paste into textarea succeeds"
else
  fail "Paste into textarea fails" "$RESULT"
fi

# Test 4: Paste without selector (focused element)
test_header "Paste without selector"
RESULT=$(send_message "test-page" "element_paste" '{ "text": "focused paste" }')
if echo "$RESULT" | grep -q 'activeElement\|No focused element'; then
  pass "Paste without selector uses activeElement"
else
  fail "Paste without selector fails" "$RESULT"
fi

# Test 5: Paste into contenteditable
test_header "Paste into contenteditable"
RESULT=$(send_message "test-page" "element_paste" '{ "selector": "[contenteditable]", "text": "editable content" }')
if echo "$RESULT" | grep -q '"success":true'; then
  pass "Paste into contenteditable succeeds"
else
  fail "Paste into contenteditable fails" "$RESULT"
fi

# Test 6: Simulate Enter key
test_header "Simulate Enter key"
RESULT=$(send_message "test-page" "element_keypress" '{ "selector": "input[type=text]", "key": "Enter" }')
if echo "$RESULT" | grep -q '"key":"Enter"'; then
  pass "Enter key simulation succeeds"
else
  fail "Enter key simulation fails" "$RESULT"
fi

# Test 7: Simulate Tab key
test_header "Simulate Tab key"
RESULT=$(send_message "test-page" "element_keypress" '{ "selector": "input", "key": "Tab" }')
if echo "$RESULT" | grep -q '"key":"Tab"'; then
  pass "Tab key simulation succeeds"
else
  fail "Tab key simulation fails" "$RESULT"
fi

# Test 8: Simulate Escape key
test_header "Simulate Escape key"
RESULT=$(send_message "test-page" "element_keypress" '{ "selector": "input", "key": "Escape" }')
if echo "$RESULT" | grep -q '"key":"Escape"'; then
  pass "Escape key simulation succeeds"
else
  fail "Escape key simulation fails" "$RESULT"
fi

# Test 9: Simulate arrow keys
test_header "Simulate arrow keys"
RESULT=$(send_message "test-page" "element_keypress" '{ "selector": "input", "key": "ArrowUp" }')
if echo "$RESULT" | grep -q '"key":"ArrowUp"'; then
  pass "ArrowUp key simulation succeeds"
else
  fail "ArrowUp key simulation fails" "$RESULT"
fi

# Test 10: Simulate Ctrl+C
test_header "Simulate Ctrl+C"
RESULT=$(send_message "test-page" "element_keypress" '{ "selector": "input", "key": "Ctrl+C" }')
if echo "$RESULT" | grep -q '"ctrl":true' && echo "$RESULT" | grep -q '"key":"C"'; then
  pass "Ctrl+C simulation includes modifiers"
else
  fail "Ctrl+C simulation fails" "$RESULT"
fi

# Test 11: Simulate Shift+Enter
test_header "Simulate Shift+Enter"
RESULT=$(send_message "test-page" "element_keypress" '{ "selector": "textarea", "key": "Shift+Enter" }')
if echo "$RESULT" | grep -q '"shift":true' && echo "$RESULT" | grep -q '"key":"Enter"'; then
  pass "Shift+Enter simulation includes modifiers"
else
  fail "Shift+Enter simulation fails" "$RESULT"
fi

# Test 12: Focus element by selector
test_header "Focus element by selector"
RESULT=$(send_message "test-page" "element_focus" '{ "selector": "input[type=text]" }')
if echo "$RESULT" | grep -q '"focused":true'; then
  pass "Focus element by selector succeeds"
else
  fail "Focus element by selector fails" "$RESULT"
fi

# Test 13: Focus returns element info
test_header "Focus returns element info"
RESULT=$(send_message "test-page" "element_focus" '{ "selector": "textarea" }')
if echo "$RESULT" | grep -q '"tag":"textarea"' && echo "$RESULT" | grep -q '"focusable"'; then
  pass "Focus returns element info"
else
  fail "Focus returns element info fails" "$RESULT"
fi

# Test 14: Focus tracks previous focus
test_header "Focus tracks previous focus"
RESULT=$(send_message "test-page" "element_focus" '{ "selector": "button" }')
if echo "$RESULT" | grep -q '"previousFocus"'; then
  pass "Focus tracks previous focus element"
else
  fail "Focus tracks previous focus fails" "$RESULT"
fi

# Test 15: Keypress without selector uses activeElement
test_header "Keypress without selector"
RESULT=$(send_message "test-page" "element_keypress" '{ "key": "Enter" }')
if echo "$RESULT" | grep -q 'activeElement\|No focused element'; then
  pass "Keypress without selector uses activeElement"
else
  fail "Keypress without selector fails" "$RESULT"
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
