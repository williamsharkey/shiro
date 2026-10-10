// Fixture for x86-engine.test.ts: what `go run` does once the binary is built.
// It starts it as a child with the terminal inherited and forwards signals
// (cmd/go's base.RunStdin + StartSigHandlers).
// Build: CGO_ENABLED=0 go build -ldflags=-s -o gorun gorun.go
package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

func main() {
	if os.Getenv("GORUN_NONBLOCK") != "" {
		// a program before it left the terminal's description non-blocking
		syscall.SetNonblock(1, true)
	}
	cmd := exec.Command(os.Args[1], os.Args[2:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGQUIT)
	if err := cmd.Start(); err != nil {
		os.Stderr.WriteString("start: " + err.Error() + "\n")
		os.Exit(2)
	}
	go func() {
		for s := range sig {
			cmd.Process.Signal(s)
		}
	}()
	if err := cmd.Wait(); err != nil {
		os.Stderr.WriteString("wait: " + err.Error() + "\n")
		os.Exit(1)
	}
}
