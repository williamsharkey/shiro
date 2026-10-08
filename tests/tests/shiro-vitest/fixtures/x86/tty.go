// Fixture for x86-engine.test.ts: termios, window size and signals on a pty.
// Build: CGO_ENABLED=0 go build -ldflags=-s -o tty tty.go
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"unsafe"
)

type winsize struct{ Row, Col, X, Y uint16 }

func ioctl(fd, req uintptr, p unsafe.Pointer) syscall.Errno {
	_, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, uintptr(p))
	return e
}

func main() {
	var t syscall.Termios
	if e := ioctl(0, syscall.TCGETS, unsafe.Pointer(&t)); e != 0 {
		fmt.Println("not a tty:", e)
		return
	}
	var ws winsize
	ioctl(1, syscall.TIOCGWINSZ, unsafe.Pointer(&ws))
	fmt.Printf("tty rows=%d cols=%d\n", ws.Row, ws.Col)

	c := make(chan os.Signal, 4)
	signal.Notify(c, os.Interrupt, syscall.SIGWINCH)

	raw := t
	raw.Lflag &^= syscall.ICANON | syscall.ECHO
	raw.Cc[syscall.VMIN] = 1
	raw.Cc[syscall.VTIME] = 0
	ioctl(0, syscall.TCSETS, unsafe.Pointer(&raw))
	fmt.Println("raw: press a key")
	b := make([]byte, 1)
	os.Stdin.Read(b)
	ioctl(0, syscall.TCSETS, unsafe.Pointer(&t))
	fmt.Printf("key=%q\n", b[0])

	fmt.Println("waiting for signals")
	for s := range c {
		fmt.Println("got", s)
		if s == os.Interrupt {
			return
		}
	}
}
