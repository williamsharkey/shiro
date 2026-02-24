# C Compiler — write, compile, and run C programs
# Uses xcc to compile C to WebAssembly, executed via WASI

# Hello World
cat > /tmp/hello.c << 'EOF'
#include <stdio.h>

int main() {
    printf("Hello from C compiled to WASM!\n");
    return 0;
}
EOF
cc /tmp/hello.c -o /tmp/hello && /tmp/hello

# Fibonacci
cat > /tmp/fib.c << 'EOF'
#include <stdio.h>

int fib(int n) {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
}

int main() {
    for (int i = 0; i < 10; i++) {
        printf("fib(%d) = %d\n", i, fib(i));
    }
    return 0;
}
EOF
cc /tmp/fib.c -o /tmp/fib && /tmp/fib
