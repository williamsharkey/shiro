package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "ls" {
		ents, err := os.ReadDir(os.Args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, "readdir:", err)
			os.Exit(1)
		}
		names := []string{}
		for _, e := range ents {
			names = append(names, e.Name())
		}
		sort.Strings(names)
		fmt.Println(strings.Join(names, ","))
		wd, _ := os.Getwd()
		fmt.Println("wd:", wd)
		data, err := os.ReadFile("rel.txt")
		fmt.Printf("rel: %q %v\n", string(data), err)
		if err := os.WriteFile(os.Args[2]+"/made-by-go.txt", []byte("hi from go\n"), 0644); err != nil {
			fmt.Println("write:", err)
		}
		if err := os.Symlink("made-by-go.txt", "link.txt"); err != nil {
			fmt.Println("symlink:", err)
		}
		target, err := os.Readlink("link.txt")
		fmt.Printf("readlink: %s %v\n", target, err)
		if err := os.Rename("rel.txt", "renamed.txt"); err != nil {
			fmt.Println("rename:", err)
		}
		if err := os.Mkdir("sub", 0755); err != nil {
			fmt.Println("mkdir:", err)
		}
		st, err := os.Stat("sub")
		fmt.Printf("sub dir: %v %v\n", err == nil && st.IsDir(), err)
		return
	}
	sc := bufio.NewScanner(os.Stdin)
	n := 0
	for sc.Scan() {
		n++
		fmt.Printf("%d: %s\n", n, strings.ToUpper(sc.Text()))
	}
	fmt.Println("done", n)
	os.Exit(n)
}
