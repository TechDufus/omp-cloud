import type { Server } from "bun";

/** The part of Bun's server the API handlers use: the caller's address and the idle timeout of one request. */
export type ApiServer = Pick<Server<undefined>, "requestIP" | "timeout">;
