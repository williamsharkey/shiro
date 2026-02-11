#!/bin/bash
# test-page-diff.sh - Test page state diffing system

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

# Test 1: Capture snapshot
test_header "Capture snapshot"
RESULT=$(send_message "test-page" "snapshot_capture" '{ "snapshotId": "test-1" }')
if echo "$RESULT" | grep -q '"snapshotId":"test-1"' && echo "$RESULT" | grep -q '"stored":true'; then
  pass "Snapshot capture succeeds"
else
  fail "Snapshot capture fails" "$RESULT"
fi

# Test 2: Snapshot includes timestamp
test_header "Snapshot includes timestamp"
RESULT=$(send_message "test-page" "snapshot_capture" '{ "snapshotId": "test-2" }')
if echo "$RESULT" | grep -q '"timestamp":'; then
  pass "Snapshot includes timestamp"
else
  fail "Snapshot missing timestamp" "$RESULT"
fi

# Test 3: Snapshot includes element count
test_header "Snapshot includes element count"
RESULT=$(send_message "test-page" "snapshot_capture" '{ "snapshotId": "test-3" }')
if echo "$RESULT" | grep -q '"elementCount":'; then
  pass "Snapshot includes element count"
else
  fail "Snapshot missing element count" "$RESULT"
fi

# Test 4: Auto-generate snapshot ID
test_header "Auto-generate snapshot ID"
RESULT=$(send_message "test-page" "snapshot_capture" '{}')
if echo "$RESULT" | grep -q '"snapshotId":"snapshot-'; then
  pass "Auto-generates snapshot ID"
else
  fail "Auto-generate ID fails" "$RESULT"
fi

# Test 5: Capture options - includeText
test_header "Capture with includeText option"
RESULT=$(send_message "test-page" "snapshot_capture" '{ "snapshotId": "test-text", "options": { "includeText": true } }')
if echo "$RESULT" | grep -q '"stored":true'; then
  pass "includeText option accepted"
else
  fail "includeText option fails" "$RESULT"
fi

# Test 6: Capture options - maxElements
test_header "Capture with maxElements option"
RESULT=$(send_message "test-page" "snapshot_capture" '{ "snapshotId": "test-max", "options": { "maxElements": 100 } }')
if echo "$RESULT" | grep -q '"stored":true'; then
  pass "maxElements option accepted"
else
  fail "maxElements option fails" "$RESULT"
fi

# Test 7: List snapshots
test_header "List snapshots"
RESULT=$(send_message "test-page" "snapshot_list" '{}')
if echo "$RESULT" | grep -q '"count":' && echo "$RESULT" | grep -q '"snapshots":\['; then
  pass "List snapshots returns count and array"
else
  fail "List snapshots fails" "$RESULT"
fi

# Test 8: Snapshot metadata in list
test_header "Snapshot metadata in list"
RESULT=$(send_message "test-page" "snapshot_list" '{}')
if echo "$RESULT" | grep -q '"timestamp":' && echo "$RESULT" | grep -q '"elementCount":'; then
  pass "Snapshot list includes metadata"
else
  fail "Snapshot metadata missing" "$RESULT"
fi

# Test 9: Compute diff between snapshots
test_header "Compute diff"
# First create two snapshots
send_message "test-page" "snapshot_capture" '{ "snapshotId": "before" }' > /dev/null
sleep 1
send_message "test-page" "snapshot_capture" '{ "snapshotId": "after" }' > /dev/null
RESULT=$(send_message "test-page" "snapshot_diff" '{ "beforeId": "before", "afterId": "after" }')
if echo "$RESULT" | grep -q '"beforeId":"before"' && echo "$RESULT" | grep -q '"afterId":"after"'; then
  pass "Diff computation succeeds"
else
  fail "Diff computation fails" "$RESULT"
fi

# Test 10: Diff includes summary
test_header "Diff includes summary"
RESULT=$(send_message "test-page" "snapshot_diff" '{ "beforeId": "before", "afterId": "after" }')
if echo "$RESULT" | grep -q '"summary":{' && echo "$RESULT" | grep -q '"totalChanges":'; then
  pass "Diff includes summary"
else
  fail "Diff summary missing" "$RESULT"
fi

# Test 11: Diff includes change arrays
test_header "Diff includes change arrays"
RESULT=$(send_message "test-page" "snapshot_diff" '{ "beforeId": "before", "afterId": "after" }')
if echo "$RESULT" | grep -q '"added":\[' && echo "$RESULT" | grep -q '"removed":\[' && echo "$RESULT" | grep -q '"modified":\['; then
  pass "Diff includes added, removed, modified arrays"
else
  fail "Diff change arrays missing" "$RESULT"
fi

# Test 12: Diff includes time delta
test_header "Diff includes time delta"
RESULT=$(send_message "test-page" "snapshot_diff" '{ "beforeId": "before", "afterId": "after" }')
if echo "$RESULT" | grep -q '"timeDelta":'; then
  pass "Diff includes time delta"
else
  fail "Diff missing time delta" "$RESULT"
fi

# Test 13: Clear specific snapshot
test_header "Clear specific snapshot"
RESULT=$(send_message "test-page" "snapshot_clear" '{ "snapshotId": "test-1" }')
if echo "$RESULT" | grep -q '"cleared":'; then
  pass "Clear specific snapshot succeeds"
else
  fail "Clear specific snapshot fails" "$RESULT"
fi

# Test 14: Clear all snapshots
test_header "Clear all snapshots"
RESULT=$(send_message "test-page" "snapshot_clear" '{}')
if echo "$RESULT" | grep -q '"cleared":' && echo "$RESULT" | grep -q '"remaining":0'; then
  pass "Clear all snapshots succeeds"
else
  fail "Clear all snapshots fails" "$RESULT"
fi

# Test 15: Error on missing snapshot
test_header "Error on missing snapshot"
RESULT=$(send_message "test-page" "snapshot_diff" '{ "beforeId": "nonexistent", "afterId": "also-nonexistent" }')
if echo "$RESULT" | grep -q '"error"' || echo "$RESULT" | grep -q 'not found'; then
  pass "Returns error for missing snapshot"
else
  fail "Missing snapshot error handling fails" "$RESULT"
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
