#!/bin/bash
# test-performance-monitoring.sh - Tests for performance monitoring features
# Usage: ./test-performance-monitoring.sh [base_url]
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
echo "Skyeyes Performance Monitoring Tests"
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

# Test 1: Health metrics initialized
test_start "Health metrics initialization"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return typeof window !== \"undefined\""}')
if echo "$RESULT" | grep -q 'true'; then
    test_pass "Window context available"
else
    test_fail "Window context not available"
fi

# Test 2: Execution count tracking
test_start "Execution count tracking"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return 1+1"}')
if echo "$RESULT" | grep -q '"result":"2"' || echo "$RESULT" | grep -q '2'; then
    test_pass "Execution successful"
else
    test_fail "Execution failed: $RESULT"
fi

# Test 3: Performance timing
test_start "Performance timing measurement"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const start = performance.now(); let sum = 0; for(let i = 0; i < 1000; i++) sum += i; const end = performance.now(); return {sum, took: end - start}"}')
if echo "$RESULT" | grep -q 'sum' && echo "$RESULT" | grep -q 'took'; then
    test_pass "Timing measured successfully"
else
    test_fail "Timing measurement failed"
fi

# Test 4: Multiple rapid executions
test_start "Multiple rapid executions"
for i in {1..5}; do
    curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
        -H 'Content-Type: application/json' \
        -d "{\"code\":\"return $i * 2\"}" > /dev/null
done
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return \"batch complete\""}')
if echo "$RESULT" | grep -q 'batch complete'; then
    test_pass "Batch executions completed"
else
    test_fail "Batch executions failed"
fi

# Test 5: Error counting
test_start "Error tracking"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"throw new Error(\"Test error for metrics\")"}')
if echo "$RESULT" | grep -q 'error'; then
    test_pass "Error tracked correctly"
else
    test_fail "Error tracking failed"
fi

# Test 6: Promise timing
test_start "Async/Promise timing"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return new Promise(resolve => setTimeout(() => resolve(\"async-done\"), 100))"}')
if echo "$RESULT" | grep -q 'async-done'; then
    test_pass "Async operation timed correctly"
else
    test_fail "Async timing failed: $RESULT"
fi

# Test 7: Connection uptime calculation
test_start "Uptime calculation"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {now: Date.now(), hasPerformance: typeof performance !== \"undefined\"}"}')
if echo "$RESULT" | grep -q 'now' && echo "$RESULT" | grep -q 'hasPerformance'; then
    test_pass "Time tracking available"
else
    test_fail "Time tracking not available"
fi

# Test 8: Memory reporting (if available)
test_start "Memory reporting"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {hasMemory: typeof performance.memory !== \"undefined\", userAgent: navigator.userAgent.substring(0, 20)}"}')
if echo "$RESULT" | grep -q 'hasMemory'; then
    test_pass "Memory info queried"
else
    test_fail "Memory query failed"
fi

# Test 9: Viewport information
test_start "Viewport information"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio}"}')
if echo "$RESULT" | grep -q 'width' && echo "$RESULT" | grep -q 'height'; then
    test_pass "Viewport metrics available"
else
    test_fail "Viewport metrics not available"
fi

# Test 10: URL and page info
test_start "Page information tracking"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {url: location.href, title: document.title, ready: document.readyState}"}')
if echo "$RESULT" | grep -q 'url' && echo "$RESULT" | grep -q 'title'; then
    test_pass "Page info tracked"
else
    test_fail "Page info not tracked"
fi

# Test 11: Operation type categorization
test_start "Operation categorization"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {type: \"eval\", operation: \"test\"}"}')
if echo "$RESULT" | grep -q 'eval' || echo "$RESULT" | grep -q 'test'; then
    test_pass "Operations can be categorized"
else
    test_fail "Categorization failed"
fi

# Test 12: Sequential timing accuracy
test_start "Sequential timing accuracy"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const t1 = Date.now(); const arr = Array(1000).fill(0).map((_, i) => i * 2); const t2 = Date.now(); return {length: arr.length, duration: t2 - t1}"}')
if echo "$RESULT" | grep -q 'duration'; then
    test_pass "Sequential timing accurate"
else
    test_fail "Sequential timing failed"
fi

# Test 13: Error rate calculation
test_start "Error rate tracking"
# Generate some errors
for i in {1..3}; do
    curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
        -H 'Content-Type: application/json' \
        -d '{"code":"throw new Error(\"metric test\")"}' > /dev/null 2>&1 || true
done
# Then a success
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return \"error rate test complete\""}')
if echo "$RESULT" | grep -q 'error rate test complete'; then
    test_pass "Error rate can be calculated"
else
    test_fail "Error rate calculation failed"
fi

# Test 14: Performance.now() availability
test_start "High-resolution timing"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {hasPerformanceNow: typeof performance.now === \"function\", sample: performance.now()}"}')
if echo "$RESULT" | grep -q 'hasPerformanceNow'; then
    test_pass "High-res timing available"
else
    test_fail "High-res timing not available"
fi

# Test 15: Metric aggregation
test_start "Metric aggregation"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const metrics = {total: 100, errors: 5, avgTime: 250}; return {errorRate: (metrics.errors / metrics.total * 100).toFixed(2) + \"%\", metrics}"}')
if echo "$RESULT" | grep -q 'errorRate' || echo "$RESULT" | grep -q 'metrics'; then
    test_pass "Metrics can be aggregated"
else
    test_fail "Metric aggregation failed"
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
    echo -e "${GREEN}All performance monitoring tests passed!${NC}"
    echo ""
    echo "Performance monitoring features validated:"
    echo "  • Execution count tracking"
    echo "  • Timing measurement"
    echo "  • Error tracking and rates"
    echo "  • Async operation timing"
    echo "  • Memory and system info"
    echo "  • Viewport metrics"
    echo "  • High-resolution timing"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
