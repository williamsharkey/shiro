// Fixture for x86-engine.test.ts. Build: CGO_ENABLED=0 go build -ldflags=-s -o hello-go hello.go
package main

import (
	"fmt"
	"math"
	"os"
	"sync"
)

func main() {
	fmt.Println("hello from go")
	fmt.Println("args:", os.Args[1:])
	if b, err := os.ReadFile("input.txt"); err == nil {
		fmt.Printf("read=%s", b)
	}
	if err := os.WriteFile("out-go.txt", []byte("written by go\n"), 0644); err != nil {
		fmt.Println("write error:", err)
	}
	var wg sync.WaitGroup
	sums := make([]float64, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 1; j <= 1000; j++ {
				sums[i] += math.Sqrt(float64(j * (i + 1)))
			}
		}(i)
	}
	wg.Wait()
	t := 0.0
	for _, s := range sums {
		t += s
	}
	fmt.Printf("goroutines=%.3f\n", t)
	if len(os.Args) > 1 && os.Args[1] == "fail" {
		os.Exit(5)
	}
}
