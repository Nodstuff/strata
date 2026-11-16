package store

import (
	_ "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	_ "github.com/aws/aws-sdk-go-v2/service/sqs"
	_ "github.com/jackc/pgx/v5"

	"example.com/shop/internal/model"
)

func Query() { _ = model.Order{} }
