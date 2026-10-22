import type { Context } from "hono";
import { createBlockFetcher, type RpcBindings } from "../utils/block-fetcher";

const isInteger = (value: string) =>
	/^\d+$/.test(value) && Number.isSafeInteger(Number(value));

export async function handleApiRoute(c: Context<{ Bindings: RpcBindings }>) {
	const chain = c.req.query("chain") ?? "evm";
	const timestamps = c.req.query("timestamps");
	const block = c.req.query("blockNumber");
	if (chain !== "evm" && chain !== "solana") {
		return c.json({ error: "chain must be evm or solana" }, 400);
	}
	if ((timestamps === undefined) === (block === undefined)) {
		return c.json({ error: "Provide either timestamps or blockNumber" }, 400);
	}
	const values = (timestamps ?? block ?? "")
		.split(",")
		.map((value) => value.trim());
	if (
		!values.every(isInteger) ||
		values.length > 5 ||
		(block !== undefined && values.length !== 1)
	) {
		return c.json(
			{
				error:
					"Provide non-negative safe integers; at most 5 timestamps or one block number",
			},
			400,
		);
	}
	const endpoint = chain === "evm" ? c.env.EVM_RPC_URL : c.env.SOLANA_RPC_URL;
	if (!endpoint)
		return c.json({ error: "RPC endpoint is not configured" }, 503);

	const rpc = createBlockFetcher(c.env);
	const results: Record<string, number | null> = {};
	for (const value of values) {
		if (Object.hasOwn(results, value)) continue;
		try {
			results[value] =
				timestamps !== undefined
					? await (chain === "evm"
							? rpc.getEVMBlockByTimestamp
							: rpc.getSolanaBlockByTimestamp)(Number(value))
					: await (chain === "evm"
							? rpc.getTimestampByBlockNumber
							: rpc.getTimestampBySlot)(Number(value));
		} catch {
			// Provider errors may contain credential-bearing URLs.
			if (block !== undefined)
				return c.json({ error: "RPC lookup failed" }, 502);
			results[value] = null;
		}
	}
	return c.json(results);
}
