package orders

import (
	"net/http"

	"example.com/shop/internal/model"
	"example.com/shop/internal/store"
)

const prefix = "/api/orders"

func Register(mux *http.ServeMux) {
	mux.HandleFunc("GET "+prefix, list)
	mux.HandleFunc("POST "+prefix, create)
	mux.HandleFunc("GET "+prefix+"/{id}", get)
	mux.HandleFunc("DELETE /api/orders/{id}", remove)
}

func list(w http.ResponseWriter, r *http.Request)   { _ = model.Order{}; store.Query() }
func create(w http.ResponseWriter, r *http.Request) {}
func get(w http.ResponseWriter, r *http.Request)    {}
func remove(w http.ResponseWriter, r *http.Request) {}
