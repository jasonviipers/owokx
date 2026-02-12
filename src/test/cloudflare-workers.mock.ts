export class DurableObject<TEnv = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}
