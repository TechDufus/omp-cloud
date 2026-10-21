/**
 * A git smart-HTTP server for tests and scenarios: `git http-backend` behind `Bun.serve` on 127.0.0.1, with Basic
 * authentication. Every bare repository under `root` is served (`<origin>/<name>.git`) and accepts pushes
 * (`http.receivepack`), so later tests can push through the service.
 */
export interface GitHttpOptions {
	/** The directory holding the bare repositories. */
	root: string;
	/** The Basic-auth user name the server accepts. */
	username?: string;
	/** The Basic-auth password (the token) the server accepts. */
	password: string;
}

/** One request the server answered. */
export interface GitHttpRequest {
	method: string;
	/** Path and query, e.g. `/app.git/info/refs?service=git-upload-pack`. */
	target: string;
	/** Whether the request carried the right credentials: the server answers `401` to every other. */
	authorized: boolean;
}

export interface GitHttpServer {
	/** `127.0.0.1:<port>`: the key of a `git.hosts` entry for this server. */
	host: string;
	/** `http://127.0.0.1:<port>` */
	origin: string;
	/** Every request so far, in order. */
	requests: GitHttpRequest[];
	/** The URL of the bare repository `<root>/<name>.git`. */
	url(name: string): string;
	stop(): Promise<void>;
}

const CRLF = Buffer.from("\r\n\r\n");
const LF = Buffer.from("\n\n");

/** Splits a CGI response into its header block and body. */
function splitCgi(output: Buffer): { head: string; body: Buffer } {
	const crlf = output.indexOf(CRLF);
	const lf = output.indexOf(LF);
	if (crlf >= 0 && (lf < 0 || crlf < lf)) return { head: output.subarray(0, crlf).toString("latin1"), body: output.subarray(crlf + CRLF.length) };
	if (lf >= 0) return { head: output.subarray(0, lf).toString("latin1"), body: output.subarray(lf + LF.length) };
	return { head: "", body: output };
}

/** Starts the server on a free port. */
export function serveGitHttp(options: GitHttpOptions): GitHttpServer {
	const username = options.username ?? "x-access-token";
	const expected = `Basic ${Buffer.from(`${username}:${options.password}`).toString("base64")}`;
	const requests: GitHttpRequest[] = [];

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const authorized = req.headers.get("authorization") === expected;
			requests.push({ method: req.method, target: url.pathname + url.search, authorized });
			if (!authorized) {
				return new Response("authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="git"' } });
			}
			const env: Record<string, string> = {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				GIT_PROJECT_ROOT: options.root,
				GIT_HTTP_EXPORT_ALL: "1",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "http.receivepack",
				GIT_CONFIG_VALUE_0: "true",
				REQUEST_METHOD: req.method,
				PATH_INFO: decodeURIComponent(url.pathname),
				QUERY_STRING: url.search.slice(1),
				REMOTE_USER: username,
				REMOTE_ADDR: "127.0.0.1",
			};
			const contentType = req.headers.get("content-type");
			if (contentType !== null) env.CONTENT_TYPE = contentType;
			const encoding = req.headers.get("content-encoding");
			if (encoding !== null) env.HTTP_CONTENT_ENCODING = encoding;
			const protocol = req.headers.get("git-protocol");
			if (protocol !== null) env.HTTP_GIT_PROTOCOL = protocol;
			const body = Buffer.from(await req.arrayBuffer());
			env.CONTENT_LENGTH = String(body.length);

			const proc = Bun.spawn(["git", "http-backend"], { env, stdin: body, stdout: "pipe", stderr: "pipe" });
			const [out, , code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.stderr.text(), proc.exited]);
			if (code !== 0 && out.byteLength === 0) return new Response("git http-backend failed", { status: 500 });

			const { head, body: payload } = splitCgi(Buffer.from(out));
			const headers = new Headers();
			let status = 200;
			for (const line of head.split(/\r?\n/)) {
				const colon = line.indexOf(":");
				if (colon < 0) continue;
				const name = line.slice(0, colon).trim();
				const value = line.slice(colon + 1).trim();
				if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
				else headers.append(name, value);
			}
			return new Response(payload, { status, headers });
		},
	});

	return {
		host: `127.0.0.1:${server.port}`,
		origin: `http://127.0.0.1:${server.port}`,
		requests,
		url: name => `http://127.0.0.1:${server.port}/${name}.git`,
		stop: () => server.stop(true),
	};
}
