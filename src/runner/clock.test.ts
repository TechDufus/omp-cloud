import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { TurnClock } from "./clock";

beforeEach(() => {
	jest.useFakeTimers();
});
afterEach(() => {
	jest.useRealTimers();
});

describe("TurnClock", () => {
	test("pauses nest, resume re-arms with the time the pauses did not use, and it fires once", () => {
		let fired = 0;
		const clock = new TurnClock(300, () => fired++);
		clock.pause();
		clock.pause();
		jest.advanceTimersByTime(500);
		clock.resume();
		jest.advanceTimersByTime(100);
		expect(fired).toBe(0);
		expect(clock.deadline() - Date.now()).toBe(300);

		clock.resume();
		jest.advanceTimersByTime(299);
		expect(fired).toBe(0);
		jest.advanceTimersByTime(1);
		expect(fired).toBe(1);
		expect(clock.deadline()).toBeLessThan(Date.now());
		jest.advanceTimersByTime(1000);
		expect(fired).toBe(1);
	});

	test("time spent running before a pause is not given back", () => {
		let fired = 0;
		const clock = new TurnClock(300, () => fired++);
		jest.advanceTimersByTime(200);
		clock.pause();
		jest.advanceTimersByTime(300);
		expect(fired).toBe(0);
		expect(clock.deadline() - Date.now()).toBe(100);
		clock.resume();
		jest.advanceTimersByTime(99);
		expect(fired).toBe(0);
		jest.advanceTimersByTime(1);
		expect(fired).toBe(1);
	});

	test("a stopped clock never fires, and an extra resume is harmless", () => {
		let fired = 0;
		const clock = new TurnClock(50, () => fired++);
		clock.resume();
		clock.stop();
		jest.advanceTimersByTime(150);
		expect(fired).toBe(0);
		clock.pause();
		clock.resume();
		jest.advanceTimersByTime(100);
		expect(fired).toBe(0);
	});

	test("the deadline of a running clock stays put while time passes", () => {
		const clock = new TurnClock(10_000, () => {});
		const first = clock.deadline();
		jest.advanceTimersByTime(4000);
		expect(clock.deadline()).toBe(first);
		clock.stop();
	});
});
