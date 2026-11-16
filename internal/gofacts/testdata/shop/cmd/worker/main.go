// Command worker turns order events into payments and notices.
package main

import (
	"example.com/shop/internal/events"
	"example.com/shop/internal/notify"
	"example.com/shop/internal/payments"
)

func main() {
	events.Run()
	payments.Run()
	notify.Run()
}
