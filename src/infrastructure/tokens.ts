/**
 * @file tokens.ts
 * @author Pablo Reis Rebonato
 * @description Dependency-injection tokens for infrastructure singletons.
 */

export const TOKENS = {
  Orm: Symbol('MikroORM'),
  Sqs: Symbol('SQSClient'),
  Queues: Symbol('QueueRegistry'),
  Metrics: Symbol('PrometheusMetrics'),
  RootLogger: Symbol('RootLogger'),
} as const;
