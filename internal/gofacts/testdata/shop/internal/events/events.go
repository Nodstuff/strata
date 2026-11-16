package events

import (
	"github.com/nats-io/nats.go"

	"example.com/shop/internal/model"
)

const (
	streamName = "ORDERS"
	subjectNew = "orders.new"
)

func Setup(js nats.JetStreamContext) {
	_, _ = js.AddStream(&nats.StreamConfig{Name: streamName, Subjects: []string{subjectNew, "orders.paid.*"}})
	_, _ = js.CreateKeyValue(&nats.KeyValueConfig{Bucket: "carts"})
}

func Run() {
	var nc *nats.Conn
	_ = model.Order{}
	_ = nc.Publish(subjectNew, nil)
	_, _ = nc.Subscribe("orders.paid.eu", nil)
}
