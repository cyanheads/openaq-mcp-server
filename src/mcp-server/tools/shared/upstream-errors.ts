/**
 * @fileoverview Routes OpenAqService transport failures through the calling
 * tool's error contract. The service throws framework-coded errors (Timeout,
 * RateLimited, ServiceUnavailable, Unauthorized) carrying no `reason`, and the framework only
 * mirrors `data.recovery.hint` into `content[]` when the throw site supplies it —
 * so without this mapping the upstream entries every OpenAQ-hitting tool declares
 * are unreachable. Each tool still declares its own `errors[]` inline; this maps
 * a caught error onto one of the three reasons those contracts share.
 * @module mcp-server/tools/shared/upstream-errors
 */

import type { TypedFail, TypedRecoveryFor } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** The upstream failure classes every OpenAQ-hitting tool declares. */
export type UpstreamReason =
  | 'invalid_api_key'
  | 'rate_limited'
  | 'upstream_error'
  | 'upstream_timeout';

/**
 * The slice of a handler `ctx` this mapping needs. Any tool whose contract
 * declares the three upstream reasons satisfies it — the wider reason union of
 * the real ctx is assignable here.
 */
export interface UpstreamFailContext {
  fail: TypedFail<UpstreamReason>;
  recoveryFor: TypedRecoveryFor<UpstreamReason>;
}

/** Service error code → contract reason. Absent codes are not upstream failures. */
const REASON_BY_CODE: Partial<Record<JsonRpcErrorCode, UpstreamReason>> = {
  [JsonRpcErrorCode.RateLimited]: 'rate_limited',
  [JsonRpcErrorCode.ServiceUnavailable]: 'upstream_error',
  [JsonRpcErrorCode.Timeout]: 'upstream_timeout',
  [JsonRpcErrorCode.Unauthorized]: 'invalid_api_key',
};

/**
 * The re-throwable form of `err`: a contract-typed failure when it is an upstream
 * transport error, otherwise `err` untouched so NotFound/ValidationError keep
 * their own per-tool handling. Use at call sites that already catch —
 * `throw upstreamFailure(ctx, err)`.
 */
export function upstreamFailure(ctx: UpstreamFailContext, err: unknown): unknown {
  if (!(err instanceof McpError)) return err;
  const reason = REASON_BY_CODE[err.code];
  if (!reason) return err;
  return ctx.fail(reason, err.message, { ...err.data, ...ctx.recoveryFor(reason) }, { cause: err });
}

/**
 * Run an OpenAQ service call, re-throwing upstream transport failures through the
 * tool's contract. For call sites with no other error handling of their own.
 */
export async function withUpstream<T>(
  ctx: UpstreamFailContext,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw upstreamFailure(ctx, err);
  }
}
