export const TOKENS = {
  Orm: Symbol('MikroORM'),
  Sqs: Symbol('SQSClient'),
  Queues: Symbol('QueueRegistry'),
  Metrics: Symbol('PrometheusMetrics'),
  RootLogger: Symbol('RootLogger'),
} as const;
