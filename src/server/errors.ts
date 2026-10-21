/** A failure the API reports as `status` with the body `{"error": message}` and, when given, these response headers. */
export class ApiError extends Error {
	readonly status: number;
	readonly headers: Record<string, string>;

	constructor(status: number, message: string, headers: Record<string, string> = {}) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.headers = headers;
	}
}
