import { existsSync, mkdtempSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEBOUNCE_MS = 200;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: "string", default: "4321" }, base: { type: "string", default: "/" } },
  strict: true,
  allowPositionals: false,
});

const port = Number(values.port);
const base = values.base ?? "/";
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`site: --port must be an integer from 1 to 65535, got ${values.port}`);
  process.exit(1);
}
if (!base.startsWith("/") || !base.endsWith("/")) {
  console.error(`site: --base must start and end with "/", got ${base}`);
  process.exit(1);
}

const root = resolve(import.meta.dir, "..");
const buildScript = join(root, "site/build.ts");
const siteUrl = `http://127.0.0.1:${port}${base.slice(0, -1)}`;
const temp = mkdtempSync(join(tmpdir(), "omp-cloud-site-"));

// Every build goes to a fresh directory: build.ts cleans its output first, so a failed build would otherwise empty what is served.
let current: string | undefined;
let builds = 0;
let building = false;
let queued = false;
let child: Bun.Subprocess | undefined;

async function build(): Promise<void> {
  const dir = join(temp, String(++builds));
  child = Bun.spawn([process.execPath, "run", buildScript, "--out", dir, "--site-url", siteUrl], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  child = undefined;
  if (code !== 0) {
    console.error("site: build failed; still serving the last good build");
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const previous = current;
  current = dir;
  if (previous) rmSync(previous, { recursive: true, force: true });
}

async function rebuild(): Promise<void> {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  try {
    do {
      queued = false;
      await build();
    } while (queued);
  } finally {
    building = false;
  }
}

function respond(request: Request): Response {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(base)) return new Response("Not found", { status: 404 });
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.slice(base.length));
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const segments = relative.split("/");
  if (segments.some(segment => segment === ".." || segment.includes("\0") || segment.includes("\\"))) {
    return new Response("Bad request", { status: 400 });
  }
  if (!current) return new Response("site: the first build has not succeeded yet; see the terminal", { status: 503 });

  const headers = { "cache-control": "no-store" };
  const last = segments[segments.length - 1] ?? "";
  if (last !== "" && !last.includes(".")) {
    return new Response(null, { status: 301, headers: { ...headers, location: `${url.pathname}/${url.search}` } });
  }
  const file = join(current, last === "" ? `${relative}index.html` : relative);
  if (existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file), { headers });
  const missing = join(current, "404.html");
  return existsSync(missing)
    ? new Response(Bun.file(missing), { status: 404, headers: { ...headers, "content-type": "text/html;charset=utf-8" } })
    : new Response("Not found", { status: 404 });
}

await rebuild();

const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: respond });

let timer: ReturnType<typeof setTimeout> | undefined;
const watchers: FSWatcher[] = [];

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), DEBOUNCE_MS);
}

for (const dir of ["docs", "site", "src/dashboard/client/kit"]) {
  watchers.push(
    watch(join(root, dir), { recursive: true }, (_event, filename) => {
      // site/dist is the build's default output and must not retrigger builds.
      if (dir === "site" && filename !== null && /^dist(\/|$)/.test(filename)) return;
      schedule();
    }),
  );
}
for (const file of ["README.md", "CHANGELOG.md", "package.json", "install.sh"]) {
  watchers.push(watch(join(root, file), schedule));
}

console.log(`site: http://127.0.0.1:${port}${base}`);

function shutdown(): never {
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  child?.kill();
  void server.stop(true);
  rmSync(temp, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
