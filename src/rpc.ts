/**
 * pi-subagents in-process RPC client (SPEC.md §7).
 * Protocol version 1 over pi.events:
 *   request: "subagents:rpc:v1:request"  { version: 1, requestId, method, params, source }
 *   reply:   "subagents:rpc:v1:reply:<requestId>"  { version, requestId, success, data | error }
 * Verified against pi-subagents src/extension/rpc.ts.
 */

export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export interface EventBusLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

export class RpcError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "RpcError";
		this.code = code;
	}
}

export interface SpawnResult {
	text: string;
	asyncId: string;
	asyncDir: string | null;
}

export interface PingData {
	version?: number;
	methods?: string[];
	events?: { asyncComplete?: string };
}

let counter = 0;

export function createRpcClient(events: EventBusLike) {
	function request<T = unknown>(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const requestId = `panel-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
			const replyChannel = RPC_REPLY_PREFIX + requestId;
			let settled = false;

			let unsubscribe: () => void = () => {};

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				unsubscribe();
				reject(new RpcError("timeout", `pi-subagents RPC ${method} timed out after ${timeoutMs}ms.`));
			}, timeoutMs);

			const unsub = events.on(replyChannel, (raw: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				const reply = raw as { success?: boolean; data?: T; error?: { code?: string; message?: string } };
				if (reply && reply.success === true) {
					resolve(reply.data as T);
				} else {
					reject(new RpcError(reply?.error?.code ?? "unknown", reply?.error?.message ?? `RPC ${method} failed without details.`));
				}
			});
			if (typeof unsub === "function") unsubscribe = unsub;

			events.emit(RPC_REQUEST_EVENT, {
				version: 1,
				requestId,
				method,
				...(params !== undefined ? { params } : {}),
				source: { extension: "pi-panel" },
			});
		});
	}

	return {
		/** 5s default — absence means pi-subagents is not installed/loaded. */
		ping(timeoutMs = 5000): Promise<PingData> {
			return request<PingData>("ping", undefined, timeoutMs);
		},
		/** Spawn returns after launch. Long timeout: launch itself is quick, but be lenient. */
		async spawn(workflowScript: string, description: string): Promise<SpawnResult> {
			const data = await request<{ text?: string; details?: { asyncId?: string; runId?: string; asyncDir?: string } }>(
				"spawn",
				{ workflowScript, async: true, context: "fresh", mission: false, description },
				30_000,
			);
			const details = data?.details ?? {};
			const asyncId = details.asyncId ?? details.runId;
			if (!asyncId) {
				throw new RpcError("invalid_state", `RPC spawn reply did not include an async id. Reply text: ${(data?.text ?? "").slice(0, 300)}`);
			}
			return { text: data?.text ?? "", asyncId, asyncDir: details.asyncDir ?? null };
		},
		status(id: string): Promise<unknown> {
			return request("status", { id }, 30_000);
		},
		stop(id: string): Promise<unknown> {
			return request("stop", { id }, 15_000);
		},
	};
}

export type RpcClient = ReturnType<typeof createRpcClient>;

/** Extract the async id from a subagent:async-complete payload. */
export function asyncCompleteId(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	const id = p.id ?? p.runId;
	return typeof id === "string" && id ? id : null;
}
