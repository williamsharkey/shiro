// Benchmark: TLS 1.3 handshake + 3 HTTPS requests over loopback, self-signed cert.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"time"
)

func main() {
	t0 := time.Now()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), DNSNames: []string{"localhost"},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil { fmt.Println("listen:", err); return }
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"path": r.URL.Path, "proto": r.Proto})
	}))
	pool := x509.NewCertPool()
	c, _ := x509.ParseCertificate(der)
	pool.AddCert(c)
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}, ForceAttemptHTTP2: true}}
	t1 := time.Now()
	for i := 0; i < 3; i++ {
		r, err := client.Get(fmt.Sprintf("https://%s/req%d", ln.Addr(), i))
		if err != nil { fmt.Println("get:", err); return }
		b, _ := io.ReadAll(r.Body); r.Body.Close()
		fmt.Printf("%s %s", r.Proto, b)
	}
	fmt.Printf("setup %dms, 3 https requests %dms\n", t1.Sub(t0).Milliseconds(), time.Since(t1).Milliseconds())
}
