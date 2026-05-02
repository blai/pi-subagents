import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildWidgetLines, renderWidget, stopResultAnimations, stopWidgetAnimation, syncResultAnimation } = await import("../../src/tui/render.ts") as {
	buildWidgetLines: (jobs: Array<Record<string, unknown>>, theme: { fg(name: string, text: string): string; bold(text: string): string }, width?: number) => string[];
	renderWidget: (ctx: Record<string, unknown>, jobs: Array<Record<string, unknown>>) => void;
	stopResultAnimations: () => void;
	stopWidgetAnimation: () => void;
	syncResultAnimation: (result: Record<string, unknown>, context: { state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> }; invalidate: () => void }) => void;
};

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const STALE_EXTENSION_CONTEXT_MESSAGE = "This extension ctx is stale after session replacement or reload";

function staleExtensionContextError(): Error {
	return new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
}

async function expectNoUncaught(action: () => Promise<void> | void): Promise<void> {
	let uncaught: unknown;
	const handler = (error: unknown) => {
		uncaught = error;
	};
	process.once("uncaughtException", handler);
	try {
		await action();
	} finally {
		process.removeListener("uncaughtException", handler);
	}
	assert.equal(uncaught, undefined, `expected no uncaught exception, got: ${uncaught instanceof Error ? uncaught.message : String(uncaught)}`);
}

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		widgets,
		get renderRequests() {
			return renderRequests;
		},
	};
}

describe("subagent async widget rendering", () => {
	it("orders running jobs before queued summaries and completions", () => {
		const lines = buildWidgetLines([
			{ asyncId: "done-1", asyncDir: "/tmp/done", status: "complete", agents: ["reviewer"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "queued-1", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "run-1", asyncDir: "/tmp/run", status: "running", agents: ["scout"], currentStep: 0, stepsTotal: 2, startedAt: Date.now() - 1000, updatedAt: Date.now(), currentTool: "read", currentToolStartedAt: Date.now() - 500 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /^● Async agents · background · \/subagents-status/);
		assert.ok(text.indexOf("scout") < text.indexOf("queued"), "running row should precede queued summary");
		assert.ok(text.indexOf("queued") < text.indexOf("reviewer"), "queued summary should precede completions");
		assert.match(text, /⎿  read/);
	});

	it("uses parallel running/done wording for async jobs with parallel groups", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", mode: "parallel", agents: ["scout", "reviewer", "worker"], hasParallelGroups: true, activeParallelGroup: true, runningSteps: 3, completedSteps: 0, stepsTotal: 3 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /parallel · scout, reviewer, worker/);
		assert.match(text, /3 agents running · 0\/3 done/);
		assert.doesNotMatch(text, /step 1\/3/);
	});

	it("collapses repeated async parallel agent names", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", mode: "parallel", agents: ["reviewer", "reviewer", "reviewer"], activeParallelGroup: true, runningSteps: 3, completedSteps: 0, stepsTotal: 3 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /parallel · reviewer ×3 · 3 agents running/);
		assert.doesNotMatch(text, /reviewer → reviewer → reviewer/);
	});

	it("shows per-agent detail for active async parallel widget rows", () => {
		const now = Date.now();
		const lines = buildWidgetLines([
			{
				asyncId: "run-1",
				asyncDir: "/tmp/1",
				status: "running",
				mode: "parallel",
				agents: ["reviewer", "reviewer", "reviewer"],
				activeParallelGroup: true,
				runningSteps: 2,
				completedSteps: 1,
				stepsTotal: 3,
				steps: [
					{ agent: "reviewer", status: "running", lastActivityAt: now, toolCount: 2 },
					{ agent: "reviewer", status: "running", currentTool: "read", currentToolStartedAt: now - 2000 },
					{ agent: "reviewer", status: "complete", tokens: { input: 1000, output: 500, cache: 0, total: 1500 } },
				],
			},
		], theme, 160);

		const text = lines.join("\n");
		assert.match(text, /parallel · reviewer ×3 · 2 agents running · 1\/3 done/);
		assert.match(text, /Agent 1\/3: reviewer · running · active now · 2 tools/);
		assert.match(text, /Agent 2\/3: reviewer · running · read 2\.0s/);
		assert.match(text, /Agent 3\/3: reviewer · complete · 1\.5k tok/);
	});

	it("includes logical chain context for active async chain parallel groups", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "run-chain",
				asyncDir: "/tmp/chain",
				status: "running",
				mode: "chain",
				agents: ["reviewer", "auditor"],
				activeParallelGroup: true,
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				runningSteps: 1,
				completedSteps: 1,
				stepsTotal: 2,
			},
		], theme, 160);

		const text = lines.join("\n");
		assert.match(text, /step 2\/3 · parallel group: 1 agent running · 1\/2 done/);
	});

	it("shows explicit overflow counts for hidden work", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["a1"] },
			{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
			{ asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
			{ asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
			{ asyncId: "run-5", asyncDir: "/tmp/5", status: "running", agents: ["a5"] },
		], theme, 120);

		assert.match(lines.join("\n"), /\+1 more \(1 running\)/);
	});

	it("counts hidden queued work even when a visible running agent name contains queued", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["queued-scanner"] },
			{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
			{ asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
			{ asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
			{ asyncId: "queued-1", asyncDir: "/tmp/q", status: "queued", agents: ["planner"] },
		], theme, 120);

		assert.match(lines.join("\n"), /\+1 more \(1 queued\)/);
	});

	it("does not animate queued-only widgets", async () => {
		const ui = createUiContext();
		try {
			renderWidget(ui.ctx as never, [{ asyncId: "queued-only", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"] }]);
			const initialWidgetCount = ui.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(ui.widgets.length, initialWidgetCount, "static queued widget should not refresh at animation cadence");
			assert.equal(ui.renderRequests, 0);
		} finally {
			stopWidgetAnimation();
		}
	});

	it("invalidates running result rows and stops after completion", async () => {
		let invalidations = 0;
		const context = {
			state: {},
			invalidate: () => {
				invalidations += 1;
			},
		};
		try {
			syncResultAnimation({
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "parallel",
					results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "running" } }],
				},
			}, context);
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.ok(invalidations > 0, "running result should request row redraws");
			assert.ok(context.state.subagentResultAnimationTimer, "running result should store its timer handle");
			stopResultAnimations();
			assert.equal(context.state.subagentResultAnimationTimer, undefined, "global cleanup should clear row timer state");

			syncResultAnimation({
				content: [{ type: "text", text: "running again" }],
				details: {
					mode: "parallel",
					results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "running" } }],
				},
			}, context);
			assert.ok(context.state.subagentResultAnimationTimer, "running result should restart after global cleanup");

			syncResultAnimation({
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "parallel",
					results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "completed" } }],
				},
			}, context);
			const afterComplete = invalidations;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(invalidations, afterComplete, "completed result should stop row redraws");
			assert.equal(context.state.subagentResultAnimationTimer, undefined);
		} finally {
			stopResultAnimations();
		}
	});

	it("stops result animation when invalidate throws stale-context errors", async () => {
		let invalidations = 0;
		const context = {
			state: {},
			invalidate: () => {
				invalidations += 1;
				throw staleExtensionContextError();
			},
		};
		try {
			await expectNoUncaught(async () => {
				syncResultAnimation({
					content: [{ type: "text", text: "running" }],
					details: {
						mode: "parallel",
						results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "running" } }],
					},
				}, context);
				await new Promise((resolve) => setTimeout(resolve, 190));
			});
			assert.equal(context.state.subagentResultAnimationTimer, undefined, "stale invalidate should clear timer state");
			const afterStop = invalidations;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(invalidations, afterStop, "stale invalidate should stop future timer ticks");
		} finally {
			stopResultAnimations();
		}
	});

	it("animates while active and stops after the widget is cleared", async () => {
		const ui = createUiContext();
		try {
			renderWidget(ui.ctx as never, [{ asyncId: "run-anim", asyncDir: "/tmp/run", status: "running", agents: ["scout"] }]);
			const initialWidgetCount = ui.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.ok(ui.widgets.length > initialWidgetCount, "animation should refresh widget lines");
			assert.ok(ui.renderRequests > 0, "animation should request UI renders");

			renderWidget(ui.ctx as never, []);
			const afterClearCount = ui.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(ui.widgets.length, afterClearCount, "cleared widget should stop animating");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			stopWidgetAnimation();
		}
	});

	it("stops widget animation when stale-context errors are thrown during refresh", async () => {
		const widgets: unknown[] = [];
		let hasUiReads = 0;
		let setWidgetCalls = 0;
		let renderRequests = 0;
		const ctx = {
			get hasUI() {
				hasUiReads += 1;
				if (hasUiReads > 1) throw staleExtensionContextError();
				return true;
			},
			ui: {
				theme,
				setWidget: (_key: string, value: unknown) => {
					setWidgetCalls += 1;
					widgets.push(value);
				},
				requestRender: () => {
					renderRequests += 1;
				},
			},
		};
		try {
			await expectNoUncaught(async () => {
				renderWidget(ctx as never, [{ asyncId: "run-anim", asyncDir: "/tmp/run", status: "running", agents: ["scout"] }]);
				await new Promise((resolve) => setTimeout(resolve, 190));
			});
			assert.equal(hasUiReads, 2, "widget refresh should stop immediately after stale hasUI throw");
			assert.equal(setWidgetCalls, 1, "stale hasUI throw should stop before refreshing widget lines");
			const requestsAfterStop = renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(renderRequests, requestsAfterStop, "stale-context throw should stop future render requests");
		} finally {
			stopWidgetAnimation();
		}
	});
});
