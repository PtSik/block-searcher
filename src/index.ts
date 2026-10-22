import { Hono } from "hono";
import { handleApiRoute } from "./routes/api";
import type { RpcBindings } from "./utils/block-fetcher";

const app = new Hono<{ Bindings: RpcBindings }>();
app.get("/", (c) =>
	c.json({
		service: "Block Searcher",
		example: "/api?chain=evm&timestamps=1700000000",
	}),
);
app.get("/api", handleApiRoute);
export default app;
