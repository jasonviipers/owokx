import {
  type ExecuteOrderResult,
  type ExecutionSource,
  executeOrder,
  isAcceptedSubmissionState,
} from "../../execution/execute-order";
import type { OrderPreview } from "../../mcp/types";
import type { BrokerProviders } from "../../providers/broker-factory";
import { createD1Client, type D1Client } from "../../storage/d1/client";
import type { HarnessContext } from "./types";

export interface SubmitExecutionOrderParams {
  broker: BrokerProviders;
  idempotency_key: string;
  order: OrderPreview;
  source?: ExecutionSource;
  approval_id?: string | null;
}

export interface SubmitExecutionOrderResult extends ExecuteOrderResult {
  accepted: boolean;
}

export interface ExecutionService {
  submitOrder: (params: SubmitExecutionOrderParams) => Promise<SubmitExecutionOrderResult>;
}

export interface ExecutionServiceDeps {
  createDb?: () => D1Client;
  executeOrderImpl?: typeof executeOrder;
}

class DefaultExecutionService implements ExecutionService {
  constructor(
    private readonly context: HarnessContext,
    private readonly deps: ExecutionServiceDeps
  ) {}

  async submitOrder(params: SubmitExecutionOrderParams): Promise<SubmitExecutionOrderResult> {
    const db = this.deps.createDb?.() ?? createD1Client(this.context.env.DB);
    const runExecuteOrder = this.deps.executeOrderImpl ?? executeOrder;
    const result = await runExecuteOrder({
      env: this.context.env,
      db,
      broker: params.broker,
      source: params.source ?? "harness",
      idempotency_key: params.idempotency_key,
      order: params.order,
      approval_id: params.approval_id ?? null,
    });

    return {
      ...result,
      accepted: isAcceptedSubmissionState(result.submission.state),
    };
  }
}

export function createExecutionService(context: HarnessContext, deps: ExecutionServiceDeps = {}): ExecutionService {
  return new DefaultExecutionService(context, deps);
}
