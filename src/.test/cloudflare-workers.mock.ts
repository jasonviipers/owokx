export interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectState {
  id: DurableObjectId;
  storage: DurableObjectStorage;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStorage {
  get(key: string): Promise<any>;
  put(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: any): Promise<Map<string, any>>;
}

export class DurableObject<TEnv = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}
