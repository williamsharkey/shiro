#!/bin/bash

# Integration Test Suite for Windwalker Browser Terminals
# Tests full dev workflows in foam and shiro via Skyeyes API
#
# Usage: ./tests/integration-tests.sh [foam|shiro|all]

set -e

SKYEYES_API="http://localhost:7777/api/skyeyes"
FOAM_PAGE="foam-windwalker"
SHIRO_PAGE="shiro-windwalker"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PASSED=0
FAILED=0
TEST_RESULTS=()

# Helper: Execute command via eval with promise handling
exec_terminal_cmd() {
    local page=$1
    local cmd=$2
    local timeout=${3:-15000}

    local shell_obj="__foam"
    [[ "$page" == *"shiro"* ]] && shell_obj="__shiro"

    # Escape command for JavaScript
    local escaped_cmd=$(echo "$cmd" | sed 's/\\/\\\\/g' | sed 's/`/\\`/g' | sed 's/\$/\\$/g')

    # Create unique result variable
    local result_var="test_result_$(date +%s)_$$"

    # JavaScript to execute command and store result
    local js_code="
(function() {
    var resultVar = '${result_var}';
    var timeout = ${timeout};

    window.${shell_obj}.shell.execute(\`${escaped_cmd}\`)
        .then(function(result) {
            window[resultVar] = {
                success: true,
                output: result,
                timestamp: Date.now()
            };
        })
        .catch(function(error) {
            window[resultVar] = {
                success: false,
                error: error.message || String(error),
                timestamp: Date.now()
            };
        });

    return 'initiated';
})()
"

    # URL encode
    local encoded=$(node -e "console.log(encodeURIComponent(${js_code@Q}))")

    # Initiate execution
    curl -s "${SKYEYES_API}/${page}/eval?code=${encoded}" > /dev/null

    # Poll for result
    local elapsed=0
    local poll_interval=500

    while [ $elapsed -lt $timeout ]; do
        sleep 0.5
        elapsed=$((elapsed + poll_interval))

        # Check for result
        local check_code="return window.${result_var} ? JSON.stringify(window.${result_var}) : null"
        local check_encoded=$(node -e "console.log(encodeURIComponent(${check_code@Q}))")
        local result=$(curl -s "${SKYEYES_API}/${page}/eval?code=${check_encoded}")

        if [ "$result" != "null" ] && [ -n "$result" ]; then
            # Clean up
            local cleanup_code="delete window.${result_var}; return 'cleaned'"
            local cleanup_encoded=$(node -e "console.log(encodeURIComponent(${cleanup_code@Q}))")
            curl -s "${SKYEYES_API}/${page}/eval?code=${cleanup_encoded}" > /dev/null

            echo "$result"
            return 0
        fi
    done

    # Timeout
    echo '{"success":false,"error":"Timeout waiting for command result"}'
    return 1
}

# Test runner
run_test() {
    local page=$1
    local name=$2
    local cmd=$3
    local expected=$4
    local timeout=${5:-15000}

    local page_name=$([ "$page" = "$FOAM_PAGE" ] && echo "FOAM" || echo "SHIRO")

    echo -ne "  ${CYAN}→${NC} Testing: ${name}... "

    local result=$(exec_terminal_cmd "$page" "$cmd" "$timeout")

    # Parse result
    if echo "$result" | grep -q '"success":true'; then
        local output=$(echo "$result" | node -e "
            const data = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
            console.log(data.output || '');
        " 2>/dev/null || echo "$result")

        if echo "$output" | grep -qi "$expected"; then
            echo -e "${GREEN}✓ PASS${NC}"
            ((PASSED++))
            TEST_RESULTS+=("${GREEN}✓${NC} $page_name: $name")
            return 0
        else
            echo -e "${RED}✗ FAIL${NC} (expected: $expected, got: ${output:0:50}...)"
            ((FAILED++))
            TEST_RESULTS+=("${RED}✗${NC} $page_name: $name - Output mismatch")
            return 1
        fi
    else
        local error=$(echo "$result" | node -e "
            try {
                const data = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
                console.log(data.error || 'Unknown error');
            } catch(e) {
                console.log('$result');
            }
        " 2>/dev/null || echo "Failed to execute")

        echo -e "${RED}✗ FAIL${NC} ($error)"
        ((FAILED++))
        TEST_RESULTS+=("${RED}✗${NC} $page_name: $name - $error")
        return 1
    fi
}

# Print section header
print_section() {
    echo ""
    echo -e "${BLUE}${'='*70}${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}${'='*70}${NC}"
}

# Test suite for a specific page
run_integration_tests() {
    local page=$1
    local page_name=$([ "$page" = "$FOAM_PAGE" ] && echo "FOAM" || echo "SHIRO")

    print_section "Integration Tests - $page_name ($page)"

    # Test 1: Basic echo
    echo -e "\n${YELLOW}Basic Commands:${NC}"
    run_test "$page" "Echo command" "echo 'Hello World'" "Hello World"
    run_test "$page" "PWD command" "pwd" "/"

    # Test 2: File operations
    echo -e "\n${YELLOW}File Operations:${NC}"
    run_test "$page" "Create file" "echo 'test content' > /tmp/test_${page}.txt && echo 'created'" "created"
    run_test "$page" "Read file" "cat /tmp/test_${page}.txt" "test content"
    run_test "$page" "Append to file" "echo 'line 2' >> /tmp/test_${page}.txt && echo 'appended'" "appended"
    run_test "$page" "Verify multiline" "cat /tmp/test_${page}.txt" "line 2"
    run_test "$page" "File redirection" "echo 'redirect test' > /tmp/redirect_${page}.txt && cat /tmp/redirect_${page}.txt" "redirect test"

    # Test 3: Pipes
    echo -e "\n${YELLOW}Pipe Operations:${NC}"
    run_test "$page" "Simple pipe" "echo 'hello' | grep hello" "hello"
    run_test "$page" "Pipe with grep" "echo -e 'line1\nline2\nline3' | grep line2" "line2"
    run_test "$page" "Pipe with wc" "echo -e 'a\nb\nc' | wc -l" "3"
    run_test "$page" "Multi-stage pipe" "echo -e 'apple\nbanana\napricot' | grep '^a' | wc -l" "2"

    # Test 4: Git operations
    echo -e "\n${YELLOW}Git Workflows:${NC}"
    run_test "$page" "Git version" "git --version" "git version" 5000
    run_test "$page" "Git init" "cd /tmp && rm -rf git_test_${page} && mkdir git_test_${page} && cd git_test_${page} && git init 2>&1" "Initialized" 10000
    run_test "$page" "Git config" "cd /tmp/git_test_${page} && git config user.name 'Test' && git config user.email 'test@example.com' && git config user.name" "Test" 5000
    run_test "$page" "Git add/commit" "cd /tmp/git_test_${page} && echo '# Test' > README.md && git add . && git commit -m 'Init' 2>&1" "Init" 10000

    # Test 5: Git clone (small repo)
    echo -e "\n${YELLOW}Git Clone:${NC}"
    run_test "$page" "Clone small repo" \
        "cd /tmp && rm -rf hello_${page} && git clone --depth 1 https://github.com/octocat/Hello-World.git hello_${page} 2>&1" \
        "Cloning into" \
        30000

    # Test 6: npm operations
    echo -e "\n${YELLOW}npm Workflows:${NC}"
    run_test "$page" "npm version" "npm --version" "10" 5000
    run_test "$page" "npm init" "cd /tmp && rm -rf npm_test_${page} && mkdir npm_test_${page} && cd npm_test_${page} && npm init -y 2>&1" "package.json" 10000
    run_test "$page" "npm install" \
        "cd /tmp/npm_test_${page} && npm install --silent is-odd && echo 'installed'" \
        "installed" \
        45000
    run_test "$page" "Verify node_modules" "ls /tmp/npm_test_${page}/node_modules" "is-odd" 5000

    # Test 7: Node execution
    echo -e "\n${YELLOW}Node.js Execution:${NC}"
    run_test "$page" "Node version" "node --version" "v" 5000
    run_test "$page" "Node eval" "node -e 'console.log(2+2)'" "4" 5000
    run_test "$page" "Node script" \
        "echo 'console.log(\"Hello Node\")' > /tmp/test_${page}.js && node /tmp/test_${page}.js" \
        "Hello Node" \
        10000
    run_test "$page" "Node require" \
        "cd /tmp/npm_test_${page} && node -e 'const isOdd = require(\"is-odd\"); console.log(isOdd(5))'" \
        "true" \
        10000

    # Cleanup
    echo -e "\n${YELLOW}Cleanup:${NC}"
    run_test "$page" "Cleanup files" \
        "rm -rf /tmp/test_${page}.txt /tmp/redirect_${page}.txt /tmp/test_${page}.js /tmp/git_test_${page} /tmp/npm_test_${page} /tmp/hello_${page} && echo 'cleaned'" \
        "cleaned" \
        10000
}

# Main
main() {
    local target=${1:-all}

    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║                                                               ║"
    echo "║      WINDWALKER INTEGRATION TEST SUITE                        ║"
    echo "║      Full Dev Workflow Testing via Skyeyes API                ║"
    echo "║                                                               ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}\n"

    # Check API availability
    echo -e "${YELLOW}Checking Skyeyes API...${NC}"
    if ! curl -s "${SKYEYES_API}/status" | grep -q "\"${FOAM_PAGE}\":true"; then
        echo -e "${RED}✗ Skyeyes API not available or ${FOAM_PAGE} not active${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Skyeyes API available${NC}\n"

    # Run tests
    case $target in
        foam)
            run_integration_tests "$FOAM_PAGE"
            ;;
        shiro)
            run_integration_tests "$SHIRO_PAGE"
            ;;
        all)
            run_integration_tests "$FOAM_PAGE"
            run_integration_tests "$SHIRO_PAGE"
            ;;
        *)
            echo -e "${RED}Invalid target: $target${NC}"
            echo "Usage: $0 [foam|shiro|all]"
            exit 1
            ;;
    esac

    # Summary
    print_section "Test Summary"
    echo ""

    local total=$((PASSED + FAILED))
    local pass_rate=0
    [ $total -gt 0 ] && pass_rate=$(( (PASSED * 100) / total ))

    echo -e "  ${GREEN}✓ PASSED:${NC}  $PASSED/$total ($pass_rate%)"
    echo -e "  ${RED}✗ FAILED:${NC}  $FAILED/$total"
    echo ""

    if [ $FAILED -gt 0 ]; then
        echo -e "${YELLOW}Failed Tests:${NC}"
        for result in "${TEST_RESULTS[@]}"; do
            if [[ $result == *"✗"* ]]; then
                echo "  $result"
            fi
        done
        echo ""
    fi

    echo -e "${BLUE}${'='*70}${NC}\n"

    if [ $FAILED -eq 0 ]; then
        echo -e "${GREEN}✓✓✓ ALL INTEGRATION TESTS PASSED! ✓✓✓${NC}\n"
        exit 0
    else
        echo -e "${YELLOW}⚠ Some tests failed${NC}\n"
        exit 1
    fi
}

main "$@"
