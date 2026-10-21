/**
 * The live widgets of cloud jobs, handed to omp's own job tiles.
 *
 * Every surface that draws a job's widget (the `wait` card, the dock pill and its hover card, `/jobs`, Tern's Background
 * jobs panel) asks the manager's `widgets` registry for `view(job)`. Omp's registry (a `JobWidgetRegistry` in the manager's
 * `widgets` slot, not an extension API) writes a widget from a job's text with a cheap `widget`-role model, so a job's
 * `widgetInputs` feed only that author, and it has no hook for a view a job already knows. A cloud job's own view is
 * therefore put in front of it: a wrapper registry answers for the ids it holds views of and gives every other job,
 * `subscribe`, `forget` and `dispose` to the registry omp installed. The wrapper stands in `manager.widgets` itself, because
 * omp sets the slot to `undefined` when it shuts the manager down and may replace the registry: the new one is wrapped too.
 * Without a registry (`async.widgets` off, a host without jobs) nothing is installed and nothing changes.
 */

import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { JobWidgetRegistry } from "@oh-my-pi/pi-coding-agent/job-widgets/types";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";

/** What of omp's job manager the wrapper reaches: the registry slot. */
export interface WidgetHost {
	widgets: JobWidgetRegistry | undefined;
}

/** The views of the cloud jobs of one manager, by job id, and the surfaces that repaint when one changes. */
export class CloudJobViews {
	readonly #views = new Map<string, JobWidgetView>();
	readonly #listeners = new Set<() => void>();

	get(id: string): JobWidgetView | undefined {
		return this.#views.get(id);
	}

	/** Keeps `view` as the job's widget and tells the subscribers; a view that reads as the held one (its stamp aside) changes nothing. */
	set(id: string, view: JobWidgetView): void {
		const held = this.#views.get(id);
		if (held && JSON.stringify({ ...held, updatedAt: 0 }) === JSON.stringify({ ...view, updatedAt: 0 })) return;
		this.#views.set(id, view);
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch {
				// A surface that fails to repaint must not stop the others, or the job.
			}
		}
	}

	/** Drops a job's view, once omp evicted its row. */
	forget(id: string): void {
		this.#views.delete(id);
	}

	clear(): void {
		this.#views.clear();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => void this.#listeners.delete(listener);
	}
}

/** The registry omp sees: cloud jobs' views first, omp's own registry for everything else. */
class CloudWidgetRegistry implements JobWidgetRegistry {
	readonly views: CloudJobViews;
	readonly #inner: JobWidgetRegistry;

	constructor(inner: JobWidgetRegistry, views: CloudJobViews) {
		this.#inner = inner;
		this.views = views;
	}

	view(job: AsyncJob): JobWidgetView | undefined {
		return this.views.get(job.id) ?? this.#inner.view(job);
	}

	subscribe(listener: () => void): () => void {
		const own = this.views.subscribe(listener);
		const inner = this.#inner.subscribe(listener);
		return () => {
			own();
			inner();
		};
	}

	forget(jobId: string): void {
		this.views.forget(jobId);
		this.#inner.forget(jobId);
	}

	dispose(): void {
		this.views.clear();
		this.#inner.dispose();
	}
}

const installed = new WeakMap<object, CloudJobViews>();

/**
 * The views of `host`'s cloud jobs, with the wrapper registry in place; undefined while the host has no registry (nothing is
 * installed then: call again later). The first call wraps the registry omp installed; from then on the slot itself holds the
 * wrapper, and a registry omp sets later is wrapped as it arrives (omp sets `undefined` when it shuts the manager down).
 */
export function cloudJobViews(host: WidgetHost): CloudJobViews | undefined {
	const held = installed.get(host);
	if (held) return held;
	if (host.widgets === undefined) return undefined;
	const views = new CloudJobViews();
	let current: JobWidgetRegistry | undefined = new CloudWidgetRegistry(host.widgets, views);
	try {
		Object.defineProperty(host, "widgets", {
			configurable: true,
			enumerable: true,
			get: () => current,
			set: (next: JobWidgetRegistry | undefined) => {
				current = next === undefined || (next instanceof CloudWidgetRegistry && next.views === views) ? next : new CloudWidgetRegistry(next, views);
			},
		});
	} catch {
		// A host whose slot cannot be taken keeps omp's own registry and its own widgets.
		return undefined;
	}
	installed.set(host, views);
	return views;
}
