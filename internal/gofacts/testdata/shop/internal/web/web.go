package web

import (
	"net/http"

	"example.com/shop/internal/catalog"
	"example.com/shop/internal/model"
)

func Register(mux *http.ServeMux) {
	_ = model.Order{}
	_ = catalog.X
	mux.Handle("/static/", http.NotFoundHandler())
	mux.HandleFunc("/healthz", nil)
	mux.HandleFunc("/api/catalog/items", nil)
	mux.HandleFunc("/api/catalog/items/{id}", nil)
}
