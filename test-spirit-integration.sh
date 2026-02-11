#!/bin/bash
# test-spirit-integration.sh - Tests for Spirit integration features
# Usage: ./test-spirit-integration.sh [base_url]
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
echo "Skyeyes Spirit Integration Tests"
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

# Test 1: DOM snapshot - viewport info
test_start "DOM snapshot (viewport)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {viewport: {width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY}, title: document.title}"}')
if echo "$RESULT" | grep -q 'viewport' && echo "$RESULT" | grep -q 'width' && echo "$RESULT" | grep -q 'title'; then
    test_pass "Viewport data captured"
else
    test_fail "Viewport data missing: $RESULT"
fi

# Test 2: Element query - querySelector
test_start "Element query (querySelector)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const el = document.querySelector(\"body\"); return el ? {tag: el.tagName, exists: true} : {exists: false}"}')
if echo "$RESULT" | grep -q 'BODY' && echo "$RESULT" | grep -q 'true'; then
    test_pass "Element found successfully"
else
    test_fail "Element query failed: $RESULT"
fi

# Test 3: Element query - querySelectorAll
test_start "Element query (querySelectorAll)"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {count: document.querySelectorAll(\"*\").length}"}')
if echo "$RESULT" | grep -q 'count'; then
    test_pass "Element count retrieved"
else
    test_fail "querySelectorAll failed: $RESULT"
fi

# Test 4: Element visibility check
test_start "Element visibility detection"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const el = document.querySelector(\"body\"); const style = window.getComputedStyle(el); return {display: style.display, visibility: style.visibility}"}')
if echo "$RESULT" | grep -q 'display'; then
    test_pass "Visibility check working"
else
    test_fail "Visibility check failed: $RESULT"
fi

# Test 5: Element bounding box
test_start "Element bounding box"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const rect = document.querySelector(\"body\").getBoundingClientRect(); return {width: rect.width, height: rect.height, top: rect.top, left: rect.left}"}')
if echo "$RESULT" | grep -q 'width' && echo "$RESULT" | grep -q 'height'; then
    test_pass "Bounding box retrieved"
else
    test_fail "Bounding box failed: $RESULT"
fi

# Test 6: Element attributes
test_start "Element attributes"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const el = document.querySelector(\"html\"); const attrs = {}; for (const attr of el.attributes) attrs[attr.name] = attr.value; return {attrCount: Object.keys(attrs).length, hasLang: !!attrs.lang}"}')
if echo "$RESULT" | grep -q 'attrCount'; then
    test_pass "Attributes retrieved"
else
    test_fail "Attributes failed: $RESULT"
fi

# Test 7: Computed styles
test_start "Computed styles"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const style = window.getComputedStyle(document.body); return {color: style.color, bg: style.backgroundColor, fontSize: style.fontSize}"}')
if echo "$RESULT" | grep -q 'color'; then
    test_pass "Computed styles retrieved"
else
    test_fail "Computed styles failed: $RESULT"
fi

# Test 8: Text content extraction
test_start "Text content extraction"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {title: document.querySelector(\"title\")?.textContent, bodyText: document.body?.textContent?.substring(0, 50)}"}')
if echo "$RESULT" | grep -q 'title'; then
    test_pass "Text content extracted"
else
    test_fail "Text extraction failed: $RESULT"
fi

# Test 9: Element class list
test_start "Element class list"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const el = document.querySelector(\"body\"); return {classes: Array.from(el.classList), count: el.classList.length}"}')
if echo "$RESULT" | grep -q 'classes'; then
    test_pass "Class list retrieved"
else
    test_fail "Class list failed: $RESULT"
fi

# Test 10: Document structure
test_start "Document structure"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {doctype: !!document.doctype, head: !!document.head, body: !!document.body, title: document.title}"}')
if echo "$RESULT" | grep -q 'doctype' && echo "$RESULT" | grep -q 'true'; then
    test_pass "Document structure valid"
else
    test_fail "Document structure check failed: $RESULT"
fi

# Test 11: Scroll position
test_start "Scroll position"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {scrollX: window.scrollX, scrollY: window.scrollY, pageYOffset: window.pageYOffset}"}')
if echo "$RESULT" | grep -q 'scrollX'; then
    test_pass "Scroll position retrieved"
else
    test_fail "Scroll position failed: $RESULT"
fi

# Test 12: Window dimensions
test_start "Window dimensions"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight}"}')
if echo "$RESULT" | grep -q 'innerWidth'; then
    test_pass "Window dimensions retrieved"
else
    test_fail "Window dimensions failed: $RESULT"
fi

# Test 13: Document dimensions
test_start "Document dimensions"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight}"}')
if echo "$RESULT" | grep -q 'scrollWidth'; then
    test_pass "Document dimensions retrieved"
else
    test_fail "Document dimensions failed: $RESULT"
fi

# Test 14: Element HTML serialization
test_start "Element HTML serialization"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"return {html: document.querySelector(\"title\")?.outerHTML}"}')
if echo "$RESULT" | grep -q '<title>'; then
    test_pass "HTML serialized correctly"
else
    test_fail "HTML serialization failed: $RESULT"
fi

# Test 15: CSS selector generation
test_start "CSS selector generation"
RESULT=$(curl -s -X POST "$BASE_URL/api/skyeyes/shiro-skyeyes/exec" \
    -H 'Content-Type: application/json' \
    -d '{"code":"const el = document.querySelector(\"body\"); return {selector: el.id ? \"#\" + el.id : el.tagName.toLowerCase()}"}')
if echo "$RESULT" | grep -q 'selector'; then
    test_pass "Selector generated"
else
    test_fail "Selector generation failed: $RESULT"
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
    echo -e "${GREEN}All Spirit integration tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
