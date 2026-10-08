// Benchmark: tight LCG loop; arg = iterations, prints elapsed ms.
package main

import ("fmt"; "os"; "strconv"; "time")

func main() {
	n := 50000000
	if len(os.Args) > 1 { n, _ = strconv.Atoi(os.Args[1]) }
	t := time.Now()
	var x uint64 = 1
	for i := 0; i < n; i++ { x = x*6364136223846793005 + 1442695040888963407; x ^= x >> 13 }
	fmt.Printf("loop %d x=%d %dms\n", n, x, time.Since(t).Milliseconds())
}
