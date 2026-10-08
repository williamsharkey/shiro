// Fixture for x86-engine.test.ts: a TCP client through the kernel's relay.
// Build: CGO_ENABLED=0 go build -ldflags=-s -o tcpecho tcpecho.go
package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"time"
)

func main() {
	c, err := net.DialTimeout("tcp", os.Args[1], 10*time.Second)
	if err != nil {
		fmt.Println("dial:", err)
		os.Exit(1)
	}
	defer c.Close()
	fmt.Fprintf(c, "ping from go\n")
	line, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		fmt.Println("read:", err)
		os.Exit(1)
	}
	fmt.Printf("echo: %s", line)
	fmt.Println("local", c.LocalAddr().Network(), "remote", c.RemoteAddr())
}
