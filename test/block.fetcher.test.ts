import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createBlockFetcher } from "../src/utils/block-fetcher";
import app from "../src";

const bindings = {
	EVM_RPC_URL: "https://ethereum.example",
	SOLANA_RPC_URL: "https://solana.example",
};
let rpc = createBlockFetcher(bindings);

function mockChain(times = [100, 110, 120, 130, 140]) {
	const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
		const { method, params } = JSON.parse(init.body as string);
		let result: unknown;
		switch (method) {
			case "eth_blockNumber":
				result = `0x${(times.length - 1).toString(16)}`;
				break;
			case "eth_getBlockByNumber": {
				const time = times[parseInt(params[0], 16)];
				result =
					time === undefined ? null : { timestamp: `0x${time.toString(16)}` };
				break;
			}
			case "getSlot":
				result = times.length - 1;
				break;
			case "getBlockTime":
				result = times[params[0]] ?? null;
				break;
			default:
				throw new Error("Unexpected RPC method");
		}
		return Response.json({ jsonrpc: "2.0", id: 1, result });
	});
	vi.stubGlobal("fetch", fetcher);
	return fetcher;
}

beforeEach(() => {
	rpc = createBlockFetcher(bindings);
	mockChain();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("timestamp lookup", () => {
	it("finds exact EVM blocks and the nearest timestamp", async () => {
		expect(await rpc.getEVMBlockByTimestamp(120)).toBe(2);
		expect(await rpc.getEVMBlockByTimestamp(127)).toBe(3);
	});
	it("clamps EVM searches outside the available range", async () => {
		expect(await rpc.getEVMBlockByTimestamp(50)).toBe(0);
		expect(await rpc.getEVMBlockByTimestamp(200)).toBe(4);
	});
	it("returns block timestamps and reuses its request cache", async () => {
		const fetcher = mockChain();
		expect(await rpc.getTimestampByBlockNumber(2)).toBe(120);
		expect(await rpc.getTimestampByBlockNumber(2)).toBe(120);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("does not reuse cached timestamps between clients", async () => {
		expect(await rpc.getBlockTimestamp(0)).toBe(100);
		mockChain([500]);
		expect(await createBlockFetcher(bindings).getBlockTimestamp(0)).toBe(500);
	});
	it("finds Solana slots and stays within the available bounds", async () => {
		expect(await rpc.getSolanaBlockByTimestamp(127)).toBe(3);
		expect(await rpc.getSolanaBlockByTimestamp(0)).toBe(0);
		expect(await rpc.getSolanaBlockByTimestamp(1000)).toBe(4);
		expect(await rpc.getTimestampBySlot(2)).toBe(120);
		await expect(rpc.getTimestampBySlot(5)).rejects.toThrow("out of range");
	});
	it("rejects missing Solana timestamps rather than inventing a match", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ result: null })),
		);
		await expect(rpc.getSlotTime(0)).rejects.toThrow("No timestamp");
	});
	it("rejects HTTP and JSON-RPC failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 429 })),
		);
		await expect(rpc.getLatestBlockNumber()).rejects.toThrow(
			"RPC request failed",
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: { code: -1 } })),
		);
		await expect(rpc.getLatestBlockNumber()).rejects.toThrow("Invalid RPC");
		await expect(rpc.getLatestSlot()).rejects.toThrow("Invalid RPC");
	});
	it("retries transient failures and stops at the attempt limit", async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new Error("temporary"))
			.mockResolvedValue(42);
		expect(await rpc.retry(operation, 3, 0)).toBe(42);
		expect(operation).toHaveBeenCalledTimes(2);
		const failed = vi.fn().mockRejectedValue(new Error("unavailable"));
		await expect(rpc.retry(failed, 3, 0)).rejects.toThrow(
			"Max retries reached",
		);
		expect(failed).toHaveBeenCalledTimes(3);
	});
});

describe("HTTP API", () => {
	it.each([
		"",
		"?chain=other&blockNumber=1",
		"?timestamps=",
		"?blockNumber=-1",
		"?blockNumber=1.5",
		"?blockNumber=Infinity",
		"?blockNumber=9007199254740992",
		"?blockNumber=1&timestamps=100",
		"?timestamps=1,2,3,4,5,6",
		"?blockNumber=1,2",
	])("rejects invalid input before making an RPC call: %s", async (query) => {
		const fetcher = mockChain();
		const response = await app.request(`/api${query}`, {}, bindings);
		expect(response.status).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("returns 503 for missing configuration", async () => {
		expect((await app.request("/api?blockNumber=0", {}, {})).status).toBe(503);
	});
	it("returns timestamp and batch lookup responses, including zero", async () => {
		expect(
			await (await app.request("/api?blockNumber=0", {}, bindings)).json(),
		).toEqual({ "0": 100 });
		expect(
			await (await app.request("/api?timestamps=100,127", {}, bindings)).json(),
		).toEqual({ "100": 0, "127": 3 });
		expect(
			await (
				await app.request("/api?chain=solana&blockNumber=2", {}, bindings)
			).json(),
		).toEqual({ "2": 120 });
	});
	it("does not leak provider credentials in errors", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("https://provider.example/private-key");
			}),
		);
		const pending = app.request("/api?blockNumber=1", {}, bindings);
		await vi.runAllTimersAsync();
		const response = await pending;
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "RPC lookup failed" });
	});
	it("represents a failed batch item as null", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: { code: -1 } })),
		);
		const response = await app.request("/api?timestamps=100", {}, bindings);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ "100": null });
	});
});
