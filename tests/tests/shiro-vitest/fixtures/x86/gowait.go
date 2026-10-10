// Fixture for x86-engine.test.ts: cmd/go's build loop in miniature. Rounds
// of parallel children (this binary again) that exit close together, each
// waited for by os/exec in its own goroutine (waitid WNOWAIT, then wait4).
// Build: CGO_ENABLED=0 go build -ldflags=-s -o gowait gowait.go
package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

func main() {
	if len(os.Args) > 2 && os.Args[1] == "child" {
		ms, _ := strconv.Atoi(os.Args[2])
		time.Sleep(time.Duration(ms) * time.Millisecond)
		os.Exit(ms % 3)
	}
	rounds, par := 10, 4
	if len(os.Args) > 2 {
		rounds, _ = strconv.Atoi(os.Args[1])
		par, _ = strconv.Atoi(os.Args[2])
	}
	self, _ := os.Executable()
	for r := 0; r < rounds; r++ {
		var wg sync.WaitGroup
		codes := make([]int, par)
		for i := 0; i < par; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				cmd := exec.Command(self, "child", strconv.Itoa((r*7+i*5)%10))
				cmd.Stdout = os.Stdout
				err := cmd.Run()
				codes[i] = cmd.ProcessState.ExitCode()
				if err != nil && codes[i] <= 0 {
					codes[i] = -100
				}
			}(i)
		}
		wg.Wait()
		for i, c := range codes {
			if c != ((r*7+i*5)%10)%3 {
				fmt.Println("round", r, "child", i, "code", c)
			}
		}
	}
	fmt.Println("done", rounds, par)
}
