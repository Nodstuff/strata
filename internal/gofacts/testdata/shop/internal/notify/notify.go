// Package notify tells people about orders, in a doc comment long enough that it has to be cut at one hundred characters somewhere near here.
package notify

import (
	"net/http"

	"example.com/shop/internal/model"
)

func Run() {
	_ = model.Order{}
	_, _ = http.Post("https://hooks.slack.com/services/T0/B0/x", "application/json", nil)
	_, _ = http.Get("https://status.shop-partner.io/health")
	_, _ = http.Get("https://example.com/ignored")
}
