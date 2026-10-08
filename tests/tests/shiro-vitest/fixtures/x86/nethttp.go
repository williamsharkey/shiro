// Fixture for x86-engine.test.ts: goroutines + net/http over loopback.
// Build: CGO_ENABLED=0 go build -ldflags=-s -o nethttp nethttp.go
package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
)

func main() {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Println("listen:", err)
		return
	}
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "pong %s", r.URL.Path)
	}))
	var wg sync.WaitGroup
	res := make([]string, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := http.Get(fmt.Sprintf("http://%s/%d", ln.Addr(), i))
			if err != nil {
				res[i] = "err " + err.Error()
				return
			}
			b, _ := io.ReadAll(r.Body)
			r.Body.Close()
			res[i] = string(b)
		}(i)
	}
	wg.Wait()
	for _, s := range res {
		fmt.Println(s)
	}
}
