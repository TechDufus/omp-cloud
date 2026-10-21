import { describe, expect, test } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { JobWidgetRegistry } from "@oh-my-pi/pi-coding-agent/job-widgets/types";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { cloudJobViews, type WidgetHost } from "../src/job-widgets";

const job = (id: string): AsyncJob => ({ id, type: "task", status: "running", startTime: 0, label: id, abortController: new AbortController(), promise: Promise.resolve() });

const view = (title: string, updatedAt = 1, stage = "working"): JobWidgetView => ({ title, stage, blocks: [{ kind: "text", text: title }], state: "live", updatedAt });

/** What omp's own registry does for the plugin's tests: a view per job id, and a record of every call. */
class FakeRegistry implements JobWidgetRegistry {
	readonly seen: string[] = [];
	readonly forgotten: string[] = [];
	readonly listeners = new Set<() => void>();
	disposed = 0;

	constructor(readonly own: Record<string, JobWidgetView> = {}) {}

	view(j: AsyncJob): JobWidgetView | undefined {
		this.seen.push(j.id);
		return this.own[j.id];
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	forget(id: string): void {
		this.forgotten.push(id);
	}

	dispose(): void {
		this.disposed++;
	}
}

/** The manager's registry slot, as a class field like omp's. */
class Host implements WidgetHost {
	widgets: JobWidgetRegistry | undefined;
	constructor(widgets?: JobWidgetRegistry) {
		this.widgets = widgets;
	}
}

describe("the wrapper registry", () => {
	test("a cloud job gets its own view, every other job omp's registry's", () => {
		const omp = new FakeRegistry({ bg_1: view("omp's bash widget") });
		const host = new Host(omp);
		const views = cloudJobViews(host);
		views?.set("FixGreeting", view("cloud"));
		expect(host.widgets?.view(job("FixGreeting"))?.title).toBe("cloud");
		expect(host.widgets?.view(job("bg_1"))?.title).toBe("omp's bash widget");
		expect(host.widgets?.view(job("bg_2"))).toBeUndefined();
		// A cloud job never reaches omp's registry, which would start a cheap model writing it a spec.
		expect(omp.seen).toEqual(["bg_1", "bg_2"]);
	});

	test("it stands in the manager's slot, once, and answers with the same registry each time", () => {
		const host = new Host(new FakeRegistry());
		const first = cloudJobViews(host);
		const wrapper = host.widgets;
		expect(cloudJobViews(host)).toBe(first);
		expect(host.widgets).toBe(wrapper);
		expect(host.widgets).not.toBeUndefined();
	});

	test("a registry omp sets later is wrapped as it arrives, with the cloud views kept", () => {
		const first = new FakeRegistry({ bg_1: view("first") });
		const host = new Host(first);
		cloudJobViews(host)?.set("FixGreeting", view("cloud"));
		const before = host.widgets;

		const second = new FakeRegistry({ bg_1: view("second") });
		host.widgets = second;
		expect(host.widgets).not.toBe(before);
		expect(host.widgets?.view(job("FixGreeting"))?.title).toBe("cloud");
		expect(host.widgets?.view(job("bg_1"))?.title).toBe("second");
		expect(first.seen).toEqual([]);

		// omp shuts its manager down: no registry, then a new one.
		host.widgets = undefined;
		expect(host.widgets).toBeUndefined();
		host.widgets = new FakeRegistry({ bg_9: view("third") });
		expect(host.widgets.view(job("FixGreeting"))?.title).toBe("cloud");
		expect(host.widgets.view(job("bg_9"))?.title).toBe("third");
	});

	test("putting the wrapper back is not wrapping it twice", () => {
		const omp = new FakeRegistry({ bg_1: view("bash") });
		const host = new Host(omp);
		cloudJobViews(host);
		const wrapper = host.widgets;
		host.widgets = undefined;
		host.widgets = wrapper;
		expect(host.widgets).toBe(wrapper);
		expect(host.widgets?.view(job("bg_1"))?.title).toBe("bash");
		expect(omp.seen).toEqual(["bg_1"]);
	});

	test("without a registry nothing is installed and nothing changes, until there is one", () => {
		const host = new Host();
		expect(cloudJobViews(host)).toBeUndefined();
		expect(host.widgets).toBeUndefined();
		expect(Object.getOwnPropertyDescriptor(host, "widgets")).toMatchObject({ value: undefined, writable: true });

		host.widgets = new FakeRegistry({ bg_1: view("bash") });
		const views = cloudJobViews(host);
		expect(views).toBeDefined();
		views?.set("FixGreeting", view("cloud"));
		expect(host.widgets.view(job("FixGreeting"))?.title).toBe("cloud");
	});

	test("a slot that cannot be taken keeps omp's registry", () => {
		const omp = new FakeRegistry();
		const host = new Host(omp);
		Object.defineProperty(host, "widgets", { value: omp, writable: true, configurable: false });
		expect(cloudJobViews(host)).toBeUndefined();
		expect(host.widgets).toBe(omp);
	});
});

describe("subscribers", () => {
	test("subscribe goes to omp's registry and to the cloud views, and unsubscribing leaves both", () => {
		const omp = new FakeRegistry();
		const host = new Host(omp);
		const views = cloudJobViews(host);
		let repaints = 0;
		const stop = host.widgets?.subscribe(() => void repaints++);
		expect(omp.listeners.size).toBe(1);

		// The HUD repaints when omp's own widgets change...
		for (const listener of omp.listeners) listener();
		expect(repaints).toBe(1);
		// ...and when a cloud view does.
		views?.set("FixGreeting", view("cloud", 1, "working"));
		expect(repaints).toBe(2);
		views?.set("FixGreeting", view("cloud", 2, "reading the router"));
		expect(repaints).toBe(3);

		stop?.();
		expect(omp.listeners.size).toBe(0);
		views?.set("FixGreeting", view("cloud", 3, "editing"));
		expect(repaints).toBe(3);
	});

	test("a view that reads as the held one, its stamp aside, changes nothing and tells nobody", () => {
		const host = new Host(new FakeRegistry());
		const views = cloudJobViews(host);
		let repaints = 0;
		host.widgets?.subscribe(() => void repaints++);
		views?.set("FixGreeting", view("cloud", 1));
		views?.set("FixGreeting", view("cloud", 99));
		expect(repaints).toBe(1);
		expect(views?.get("FixGreeting")?.updatedAt).toBe(1);
	});

	test("a surface that throws does not stop the others", () => {
		const host = new Host(new FakeRegistry());
		const views = cloudJobViews(host);
		let repaints = 0;
		host.widgets?.subscribe(() => {
			throw new Error("terminal gone");
		});
		host.widgets?.subscribe(() => void repaints++);
		expect(() => views?.set("FixGreeting", view("cloud"))).not.toThrow();
		expect(repaints).toBe(1);
	});
});

describe("forget and dispose", () => {
	test("forget drops the cloud view and tells omp's registry, so an evicted row's id can be reused", () => {
		const omp = new FakeRegistry({ FixGreeting: view("bash that took the id later") });
		const host = new Host(omp);
		cloudJobViews(host)?.set("FixGreeting", view("cloud"));
		host.widgets?.forget("FixGreeting");
		expect(omp.forgotten).toEqual(["FixGreeting"]);
		expect(host.widgets?.view(job("FixGreeting"))?.title).toBe("bash that took the id later");
	});

	test("dispose drops every cloud view and disposes omp's registry", () => {
		const omp = new FakeRegistry();
		const host = new Host(omp);
		const views = cloudJobViews(host);
		views?.set("FixGreeting", view("cloud"));
		host.widgets?.dispose();
		expect(omp.disposed).toBe(1);
		expect(views?.get("FixGreeting")).toBeUndefined();
	});
});
