# Stand-in for busybox's testsuite/testing.sh (host GNU baseline): every
# optional feature is on; each `testing` case prints PASS:/FAIL: NAME.
# testing "name" "command" "expected stdout" "file input" "stdin"
ECHO=${ECHO:-echo}
optional() { :; }
testing() {
  NAME="$1"
  [ -n "$1" ] || NAME="$2"
  $ECHO -ne "$3" > expected
  $ECHO -ne "$4" > input
  $ECHO -ne "$5" | eval "$2" > actual
  if cmp expected actual >/dev/null 2>&1; then echo "PASS: $NAME"; else echo "FAIL: $NAME"; fi
  rm -f input expected actual
}
