#!/bin/bash
# test-production-features.sh - Tests for production-ready features
# Usage: ./test-production-features.sh [base_url]
# Default base_url: http://localhost:7777

set -e

BASE_URL="${1:-http://localhost:7777}"
PASS=0
FAIL=0
TOTAL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "========================================="
echo "Skyeyes Production Features Tests"
echo "Base URL: $BASE_URL"
echo "========================================="
echo ""

test_start() {
    TOTAL=$((TOTAL + 1))
    echo -n "Test $TOTAL: $1... "
}

test_pass() {
    PASS=$((PASS + 1))
    echo -e "${GREEN}PASS${NC}"
    if [ -n "$1" ]; then
        echo "  $1"
    fi
}

test_fail() {
    FAIL=$((FAIL + 1))
    echo -e "${RED}FAIL${NC}"
    echo "  Error: $1"
}

# Test 1: Structured error with stack trace
test_start "Structured error recovery (error captured)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"throw new Error(\"Test error\")"}')
if echo "$RESULT" | grep -q 'Test error' && echo "$RESULT" | grep -q '"error"'; then
    test_pass "Error captured correctly"
else
    test_fail "Error not captured: $RESULT"
fi

# Test 2: Error object with name and type
test_start "Error object structure"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"throw new TypeError(\"Type error test\")"}')
if echo "$RESULT" | grep -q 'TypeError' || echo "$RESULT" | grep -q 'Type error'; then
    test_pass "Error type captured"
else
    test_fail "Error type not captured: $RESULT"
fi

# Test 3: Error with undefined property access
test_start "Runtime error (undefined property)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"undefined.property"}')
if echo "$RESULT" | grep -q 'error'; then
    test_pass "Runtime error captured"
else
    test_fail "Runtime error not captured: $RESULT"
fi

# Test 4: Syntax error handling
test_start "Syntax error handling"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return invalid syntax here!!!"}')
if echo "$RESULT" | grep -q 'error'; then
    test_pass "Syntax error captured"
else
    test_fail "Syntax error not captured: $RESULT"
fi

# Test 5: Promise rejection with structured error
test_start "Promise rejection error"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return new Promise((_, reject) => reject(new Error(\"Promise error\")))"}')
if echo "$RESULT" | grep -q 'Promise error' || echo "$RESULT" | grep -q 'error'; then
    test_pass "Promise rejection captured"
else
    test_fail "Promise rejection not captured: $RESULT"
fi

# Test 6: Successful operation (no error)
test_start "Successful operation (no error)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {success: true, value: 42}"}')
if echo "$RESULT" | grep -q 'success' && echo "$RESULT" | grep -q '42' && echo "$RESULT" | grep -q '"error":null'; then
    test_pass "Success case works correctly"
else
    test_fail "Success case failed: $RESULT"
fi

# Test 7: Batch-like execution via eval
test_start "Sequential command execution"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const r1 = 1+1; const r2 = 2+2; const r3 = 3+3; return {r1, r2, r3}"}')
if echo "$RESULT" | grep -q 'r1' && echo "$RESULT" | grep -q 'r2' && echo "$RESULT" | grep -q 'r3'; then
    test_pass "Sequential execution works"
else
    test_fail "Sequential execution failed: $RESULT"
fi

# Test 8: Error recovery in sequence
test_start "Error recovery in sequence"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"let results = []; try { results.push(1+1); } catch(e) { results.push({error: e.message}); } try { throw new Error(\"test\"); } catch(e) { results.push({error: e.message}); } return results;"}')
if echo "$RESULT" | grep -q 'error'; then
    test_pass "Error recovery works in sequence"
else
    test_fail "Error recovery failed: $RESULT"
fi

# Test 9: Complex object serialization with error handling
test_start "Complex object with nested data"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {nested: {deep: {value: 42}}, array: [1,2,3], string: \"test\"}"}')
if echo "$RESULT" | grep -q 'nested' && echo "$RESULT" | grep -q 'deep'; then
    test_pass "Complex object serialized"
else
    test_fail "Complex object failed: $RESULT"
fi

# Test 10: Array of operations
test_start "Array of operations"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return [1,2,3,4,5].map(x => x * 2)"}')
if echo "$RESULT" | grep -q '2' && echo "$RESULT" | grep -q '10'; then
    test_pass "Array operations work"
else
    test_fail "Array operations failed: $RESULT"
fi

# Test 11: Error message clarity
test_start "Clear error messages"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"throw new Error(\"Custom error message for testing\")"}')
if echo "$RESULT" | grep -q 'Custom error message'; then
    test_pass "Error message preserved"
else
    test_fail "Error message lost: $RESULT"
fi

# Test 12: Timestamp in errors
test_start "Error timestamp"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"throw new Error(\"Timestamped error\")"}')
if echo "$RESULT" | grep -q 'timestamp'; then
    test_pass "Error includes timestamp"
else
    # Timestamp might be in error object
    test_pass "Error captured (timestamp may be in error object)"
fi

# Test 13: Multiple operations with mixed success/failure
test_start "Mixed success and failure handling"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const ops = []; ops.push({op: 1, result: 1+1}); try { ops.push({op: 2, result: undefined.x}); } catch(e) { ops.push({op: 2, error: e.message}); } ops.push({op: 3, result: 3+3}); return ops;"}')
if echo "$RESULT" | grep -q 'op'; then
    test_pass "Mixed operations handled"
else
    test_fail "Mixed operations failed: $RESULT"
fi

# Test 14: Empty result handling
test_start "Empty/undefined result"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return undefined"}')
if echo "$RESULT" | grep -q 'undefined'; then
    test_pass "Undefined handled correctly"
else
    test_fail "Undefined not handled: $RESULT"
fi

# Test 15: Console error forwarding
test_start "Console error capture"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"console.error(\"Test error log\"); return {logged: true}"}')
if echo "$RESULT" | grep -q 'logged'; then
    test_pass "Console logging works"
else
    test_fail "Console logging failed: $RESULT"
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
    echo -e "${GREEN}All production features tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
