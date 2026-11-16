import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { InvalidRequestError } from '../../../application/errors/application-errors';
import { CreateWallet } from '../../../application/use-cases/create-wallet';
import { ReconcileWallet, WalletQueries } from '../../../application/use-cases/queries';
import { SubmitWagerTransaction } from '../../../application/use-cases/submit-wager-transaction';
import { CreateWalletSchema, WagerPayloadSchema, formatZodError } from '../../contracts/wager-contracts';
import { ProviderAuthGuard, type RequestWithIdentity } from '../guards/provider-auth.guard';
import {
  presentLedgerEntry,
  presentSubmission,
  presentTransaction,
  presentWallet,
  statusForSubmission,
} from '../presenters';

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidRequestError('INVALID_PAYLOAD', 'request body is invalid', formatZodError(result.error));
  }
  return result.data;
}

const uuid = z.string().uuid();
function assertUuid(value: string, name: string): string {
  if (!uuid.safeParse(value).success) throw new InvalidRequestError('INVALID_ID', `${name} must be a UUID`);
  return value;
}

function correlationOf(req: RequestWithIdentity): string {
  return typeof req.id === 'string' ? req.id : 'unknown';
}

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: RequestWithIdentity) {
    const input = parse(CreateWalletSchema, body);
    const wallet = await this.createWallet.execute({ ...input, correlationId: correlationOf(req) });
    return presentWallet(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return presentWallet(await this.queries.getWallet(assertUuid(walletId, 'walletId')));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const size = limit === undefined ? 50 : /^\d{1,3}$/.test(limit) ? Number.parseInt(limit, 10) : Number.NaN;
    const page = await this.queries.getLedger(assertUuid(walletId, 'walletId'), cursor || undefined, size);
    return { items: page.entries.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string, @Req() req: RequestWithIdentity) {
    const report = await this.reconcile.execute(assertUuid(walletId, 'walletId'), correlationOf(req));
    const { walletVersion: _v, ...body } = report;
    return body;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: RequestWithIdentity,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new InvalidRequestError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    }
    const payload = parse(WagerPayloadSchema, body);
    if (req.providerIdentity && req.providerIdentity.providerId !== payload.providerId) {
      throw new ForbiddenException('providerId does not match the authenticated provider');
    }
    const result = await this.submit.execute({
      ...payload,
      idempotencyKey,
      correlationId: correlationOf(req),
      source: { channel: 'http' },
    });
    res.status(statusForSubmission(result));
    return presentSubmission(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    return presentTransaction(await this.queries.getTransaction(assertUuid(transactionId, 'transactionId')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return presentTransaction(await this.queries.getTransactionByExternalId(providerId, externalTransactionId));
  }
}
