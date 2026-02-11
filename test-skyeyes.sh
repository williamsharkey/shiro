#!/bin/bash
# test-skyeyes.sh - End-to-end tests for skyeyes bridge functionality
# Usage: ./test-skyeyes.sh [base_url]
# Default base_url: http://localhost:7777

set -e

BASE_URL="${1:-http://localhost:7777}"
PASS=0
FAIL=0
TOTAL=0

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================="
echo "Skyeyes Bridge End-to-End Tests"
echo "Base URL: $BASE_URL"
echo "========================================="
echo ""

# Test helper functions
test_start() {
    TOTAL=$((TOTAL + 1))
    echo -n "Test $TOTAL: $1... "
}

test_pass() {
    PASS=$((PASS + 1))
    echo -e "${GREEN}PASS${NC}"
    if [ -n "$1" ]; then
        echo "  Result: $1"
    fi
}

test_fail() {
    FAIL=$((FAIL + 1))
    echo -e "${RED}FAIL${NC}"
    echo "  Error: $1"
}

# Test 1: Check server is running
test_start "Server health check"
if curl -s -f "$BASE_URL/api/skyeyes/status" > /dev/null 2>&1; then
    test_pass
else
    test_fail "Server not responding at $BASE_URL"
    echo ""
    echo "Ensure Nimbus server is running with skyeyes bridges connected."
    exit 1
fi

# Test 2: Check connection status
test_start "Connection status check"
STATUS=$(curl -s "$BASE_URL/api/skyeyes/status")
if echo "$STATUS" | grep -q "shiro-skyeyes"; then
    test_pass "Found shiro-skyeyes in status"
else
    test_fail "shiro-skyeyes not connected"
fi

# Test 3: Simple GET eval
test_start "Simple GET eval (document.title)"
RESULT=$(curl -s "$BASE_URL/api/skyeyes/shiro-skyeyes/eval?code=return%20document.title")
if [ -n "$RESULT" ]; then
    test_pass "Got: $RESULT"
else
    test_fail "Empty response"
fi

# Test 4: POST eval with JSON
test_start "POST eval with JSON"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return 1 + 1"}')
if echo "$RESULT" | grep -q '"result":"2"'; then
    test_pass "Calculation correct: 1+1=2"
else
    test_fail "Unexpected result: $RESULT"
fi

# Test 5: Async promise handling
test_start "Async promise handling"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return new Promise(resolve => setTimeout(() => resolve(\"async-ok\"), 100))"}')
if echo "$RESULT" | grep -q '"result":"async-ok"'; then
    test_pass "Promise resolved correctly"
else
    test_fail "Promise not handled: $RESULT"
fi

# Test 6: Timeout handling (should complete before timeout)
test_start "Timeout handling (within limit)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return new Promise(resolve => setTimeout(() => resolve(\"timeout-ok\"), 500))", "timeout": 2000}')
if echo "$RESULT" | grep -q '"result":"timeout-ok"'; then
    test_pass "Completed within timeout"
else
    test_fail "Timeout test failed: $RESULT"
fi

# Test 7: Error handling
test_start "Error handling (syntax error)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return invalid syntax here"}')
if echo "$RESULT" | grep -q '"error"'; then
    test_pass "Error properly caught"
else
    test_fail "Error not reported: $RESULT"
fi

# Test 8: DOM manipulation
test_start "DOM manipulation (querySelector)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return document.querySelector(\"title\") ? \"found\" : \"not-found\""}')
if echo "$RESULT" | grep -q '"result":"found"'; then
    test_pass "DOM query successful"
else
    test_fail "DOM query failed: $RESULT"
fi

# Test 9: JSON serialization
test_start "JSON serialization (object)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {foo: \"bar\", num: 42}"}')
if echo "$RESULT" | grep -q 'foo' && echo "$RESULT" | grep -q 'bar' && echo "$RESULT" | grep -q '42'; then
    test_pass "Object serialized correctly"
else
    test_fail "Object not serialized: $RESULT"
fi

# Test 10: Array handling
test_start "Array handling"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return [1, 2, 3, 4, 5]"}')
if echo "$RESULT" | grep -q '"result"' && echo "$RESULT" | grep -q '1' && echo "$RESULT" | grep -q '5'; then
    test_pass "Array serialized correctly"
else
    test_fail "Array not serialized: $RESULT"
fi

# Test 11: Multiple bridges (foam-skyeyes)
test_start "Multiple bridge support (foam-skyeyes)"
if echo "$STATUS" | grep -q '"foam-skyeyes":true'; then
    RESULT=$(curl -s "$BASE_URL/api/skyeyes/foam-skyeyes/eval?code=return%20%22foam-test%22")
    if [ -n "$RESULT" ]; then
        test_pass "Foam bridge responding: $RESULT"
    else
        test_fail "Foam bridge not responding"
    fi
else
    test_fail "foam-skyeyes not connected"
fi

# Test 12: Undefined handling
test_start "Undefined value handling"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return undefined"}')
if echo "$RESULT" | grep -q '"result":"undefined"'; then
    test_pass "Undefined handled correctly"
else
    test_fail "Undefined not handled: $RESULT"
fi

# Test 13: Null handling
test_start "Null value handling"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return null"}')
if echo "$RESULT" | grep -q '"result":"null"'; then
    test_pass "Null handled correctly"
else
    test_fail "Null not handled: $RESULT"
fi

# Test 14: Boolean values
test_start "Boolean value handling"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return true"}')
if echo "$RESULT" | grep -q '"result":"true"'; then
    test_pass "Boolean handled correctly"
else
    test_fail "Boolean not handled: $RESULT"
fi

# Test 15: Window object access
test_start "Window object access"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return typeof window"}')
if echo "$RESULT" | grep -q '"result":"object"'; then
    test_pass "Window object accessible"
else
    test_fail "Window object not accessible: $RESULT"
fi

# Summary
echo ""
echo "========================================="
echo "Test Summary"
echo "========================================="
echo -e "Total:  $TOTAL"
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo "========================================="

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
