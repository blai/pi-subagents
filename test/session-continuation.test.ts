/**
 * Tests for sessionFile parameter — persistent writer session across loop iterations.
 *
 * When `sessionFile` is provided to a SINGLE subagent call, the subprocess is
 * launched with `--session <path>`, which causes pi to load the existing session
 * (full conversation history) rather than starting fresh. This lets a writer
 * accumulate file context across multiple outer loop iterations without re-reading.
 *
 * Reviewers always omit `sessionFile` to remain isolated (fresh context).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "./helpers.ts";
import { createMockPi, createTempDir, removeTempDir, tryImport } from "./helpers.ts";

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<{
			isError?: boolean;
			content: Array<{ text?: string }>;
			details?: {
				results?: Array<{ sessionFile?: string }>;
			};
		}>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./subagent-executor.ts");
const available = !!executorMod;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function makeSessionManagerStub(sessionFile?: string) {
	return {
		getSessionFile: () => sessionFile,
		getLeafId: () => "leaf-current",
		createBranchedSession: (leafId: string) => `/tmp/fork-${leafId}.jsonl`,
	};
}

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

describe(
	"sessionFile parameter — persistent writer session",
	{ skip: !available ? "subagent executor not importable" : undefined },
	() => {
		let tempDir: string;
		let mockPi: MockPi;

		before(() => {
			mockPi = createMockPi();
			mockPi.install();
		});

		after(() => {
			mockPi.uninstall();
		});

		beforeEach(() => {
			tempDir = createTempDir("pi-subagent-session-cont-test-");
			mockPi.reset();
			mockPi.onCall({ output: "task complete" });
		});

		afterEach(() => {
			removeTempDir(tempDir);
		});

		function makeExecutor() {
			return createSubagentExecutor!({
				pi: { events: { emit: () => {} } },
				state: makeState(tempDir),
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => tempDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({
					agents: [
						{ name: "writer", description: "Implementation writer" },
						{ name: "reviewer", description: "Code reviewer" },
					],
				}),
			});
		}

		function makeCtx(sessionFile?: string) {
			return {
				cwd: tempDir,
				hasUI: false,
				ui: {},
				modelRegistry: { getAvailable: () => [] },
				sessionManager: makeSessionManagerStub(sessionFile),
			};
		}

		// ── Schema ──────────────────────────────────────────────────────────

		it("SubagentParams schema includes sessionFile field", async () => {
			const mod = await tryImport<{ SubagentParams?: { properties?: Record<string, unknown> } }>(
				"./schemas.ts",
			);
			const schema = mod?.SubagentParams;
			assert.ok(schema, "schemas.ts should be importable");
			assert.ok(
				schema.properties?.sessionFile,
				"SubagentParams should have a sessionFile property",
			);
		});

		// ── Core: result surfaces sessionFile for the next iteration ────────

		it("result.details.results[0].sessionFile is populated so caller can resume next iteration", async () => {
			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{ agent: "writer", task: "implement step 1", sessionDir: tempDir },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, undefined);
			const sessionFile = result.details?.results?.[0]?.sessionFile;
			assert.ok(
				sessionFile,
				"sessionFile should be populated in result so caller can pass it to next iteration",
			);
			assert.ok(sessionFile.endsWith(".jsonl"), "sessionFile should be a .jsonl path");
		});

		// ── Explicit sessionFile is threaded to the subprocess ───────────────
		// We verify this by checking that:
		//   (a) the call succeeds (mock pi ran once)
		//   (b) the provided session file is echoed back in result.sessionFile
		//       (confirming it was used rather than a new file being created)

		it("uses the provided sessionFile — it is echoed back in result, not a newly created path", async () => {
			const existingSession = path.join(tempDir, "writer-iter-1.jsonl");
			fs.writeFileSync(existingSession, '{"type":"session"}\n');

			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{ agent: "writer", task: "implement step 2", sessionFile: existingSession },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, undefined);
			assert.equal(mockPi.callCount(), 1, "mock pi should have been called once");

			const returnedSessionFile = result.details?.results?.[0]?.sessionFile;
			assert.equal(
				returnedSessionFile,
				existingSession,
				"result.sessionFile should be the explicitly provided path, not a newly created one",
			);
		});

		it("without sessionFile, a new session file is created each call (normal fresh behavior)", async () => {
			const executor = makeExecutor();

			const result1 = await executor.execute(
				"id1",
				{ agent: "writer", task: "iteration 1", sessionDir: tempDir },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);
			mockPi.reset();
			mockPi.onCall({ output: "second call" });

			const result2 = await executor.execute(
				"id2",
				{ agent: "writer", task: "iteration 2", sessionDir: tempDir },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			const file1 = result1.details?.results?.[0]?.sessionFile;
			const file2 = result2.details?.results?.[0]?.sessionFile;
			assert.ok(file1, "first call should produce a session file");
			assert.ok(file2, "second call should produce a session file");
			assert.notEqual(
				file1,
				file2,
				"without sessionFile param, each call creates a distinct session file",
			);
		});

		// ── sessionFile takes precedence over sessionDir ─────────────────────

		it("sessionFile takes precedence over sessionDir — result echoes the explicit path", async () => {
			const existingSession = path.join(tempDir, "writer-persistent.jsonl");
			fs.writeFileSync(existingSession, '{"type":"session"}\n');

			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{
					agent: "writer",
					task: "implement step 2",
					sessionFile: existingSession,
					sessionDir: path.join(tempDir, "other-session-dir"),
				},
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, undefined);
			assert.equal(
				result.details?.results?.[0]?.sessionFile,
				existingSession,
				"should use the explicit sessionFile, not a path derived from sessionDir",
			);
		});

		// ── Non-SINGLE modes: sessionFile is rejected ─────────────────────────

		it("sessionFile in PARALLEL mode returns an error — silent ignore would break history resumption", async () => {
			const existingSession = path.join(tempDir, "writer.jsonl");
			fs.writeFileSync(existingSession, "{}\n");

			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{
					tasks: [
						{ agent: "reviewer", task: "review A" },
						{ agent: "reviewer", task: "review B" },
					],
					sessionFile: existingSession,
				},
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, true, "sessionFile in parallel mode should be an error");
			assert.match(result.content[0]?.text ?? "", /SINGLE mode/i);
			assert.equal(mockPi.callCount(), 0, "no subprocess should be spawned");
		});

		it("sessionFile + context: \'fork\' returns an error — contradictory semantics", async () => {
			const existingSession = path.join(tempDir, "writer.jsonl");
			fs.writeFileSync(existingSession, "{}\n");

			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{ agent: "writer", task: "implement", sessionFile: existingSession, context: "fork" },
				new AbortController().signal,
				undefined,
				makeCtx("/tmp/some-parent.jsonl"),
			);

			assert.equal(result.isError, true, "fork + sessionFile should be an error");
			assert.match(result.content[0]?.text ?? "", /fork/i);
			assert.equal(mockPi.callCount(), 0);
		});

		// ── Error cases ──────────────────────────────────────────────────────

		it("returns an error when sessionFile path does not exist", async () => {
			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{
					agent: "writer",
					task: "implement step 2",
					sessionFile: "/nonexistent/path/to/session.jsonl",
				},
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, true, "should return error when sessionFile does not exist");
			assert.match(
				result.content[0]?.text ?? "",
				/sessionFile.*not found|not found.*sessionFile|does not exist/i,
			);
		});

		it("does not spawn the subprocess when sessionFile is missing — callCount stays 0", async () => {
			const executor = makeExecutor();
			await executor.execute(
				"id",
				{
					agent: "writer",
					task: "implement step 2",
					sessionFile: "/nonexistent/path/to/session.jsonl",
				},
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(mockPi.callCount(), 0, "subprocess should not be spawned when sessionFile is missing");
		});

		it("empty sessionFile returns an error — file from crashed run", async () => {
			const emptySession = path.join(tempDir, "empty.jsonl");
			fs.writeFileSync(emptySession, "");  // zero bytes

			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{ agent: "writer", task: "implement", sessionFile: emptySession },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, true, "empty sessionFile should be an error");
			assert.match(result.content[0]?.text ?? "", /empty|crashed/i);
			assert.equal(mockPi.callCount(), 0);
		});
	},
);
