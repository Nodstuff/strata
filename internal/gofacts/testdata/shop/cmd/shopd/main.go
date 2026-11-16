// Command shopd serves the shop's HTTP API.
package main

import (
	"net/http"

	"example.com/shop/internal/orders"
	"example.com/shop/internal/web"
)

func main() {
	mux := http.NewServeMux()
	web.Register(mux)
	orders.Register(mux)
	_ = http.ListenAndServe(":8080", mux)
}
