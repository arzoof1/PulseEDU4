// Shape a failed Anthropic (or network) error for API responses + logs.
// Never includes secrets (API keys, full request bodies).
export type AiRequestErrorDetail = {
  message: string;
  status?: number;
  type?: string;
  code?: string;
  cause?: string;
  model?: string;
  anthropicBaseURL?: string;
};

function readNestedMessage(err: Record<string, unknown>): string | undefined {
  const error = err.error;
  if (!error || typeof error !== "object") return undefined;
  const body = error as Record<string, unknown>;
  return typeof body.message === "string" ? body.message : undefined;
}

function readNestedType(err: Record<string, unknown>): string | undefined {
  const error = err.error;
  if (!error || typeof error !== "object") return undefined;
  const body = error as Record<string, unknown>;
  return typeof body.type === "string" ? body.type : undefined;
}

export function describeAiRequestError(
  err: unknown,
  context?: { model?: string },
): AiRequestErrorDetail {
  const anthropicBaseURL =
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL?.trim() || undefined;

  if (err instanceof Error) {
    const nested = err as Error & {
      status?: number;
      code?: string;
      error?: unknown;
      cause?: unknown;
    };
    const fromBody = readNestedMessage(nested as unknown as Record<string, unknown>);
    const fromType = readNestedType(nested as unknown as Record<string, unknown>);
    let cause: string | undefined;
    if (nested.cause instanceof Error) cause = nested.cause.message;
    else if (typeof nested.cause === "string") cause = nested.cause;

    return {
      message: fromBody ?? nested.message,
      status: typeof nested.status === "number" ? nested.status : undefined,
      type: fromType,
      code: typeof nested.code === "string" ? nested.code : undefined,
      cause,
      model: context?.model,
      anthropicBaseURL,
    };
  }

  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const message =
      readNestedMessage(e) ??
      (typeof e.message === "string" ? e.message : "AI request failed");
    return {
      message,
      status: typeof e.status === "number" ? e.status : undefined,
      type: readNestedType(e),
      code: typeof e.code === "string" ? e.code : undefined,
      model: context?.model,
      anthropicBaseURL,
    };
  }

  return {
    message: typeof err === "string" ? err : "AI request failed",
    model: context?.model,
    anthropicBaseURL,
  };
}
