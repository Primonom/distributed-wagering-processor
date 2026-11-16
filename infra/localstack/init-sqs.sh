#!/bin/sh
# LocalStack "ready" hook: creates the queues used by the service (idempotent).
# The application also creates them on startup when SQS_BOOTSTRAP=true.
set -e
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" \
  --queue-url "http://localhost:4566/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
awslocal sqs create-queue --region "$REGION" --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null
awslocal sqs create-queue --region "$REGION" --queue-name wallet-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
echo "SQS queues ready"
