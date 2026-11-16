// Package payments charges cards.
package payments

import (
	"net/http"

	"example.com/shop/internal/model"
	"example.com/shop/internal/store"
)

func Run() {
	_ = model.Order{}
	store.Query()
	_, _ = http.Get("https://api.stripe.com/v1/charges")
}
