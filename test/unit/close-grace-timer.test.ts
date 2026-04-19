/**
 * Covers the `exit` -> grace timer -> `close` path used by the runners when a
 * grandchild keeps inherited stdout/stderr open.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

/**
 * Launch a synthetic child that prints once, backgrounds a sleeper that keeps
 * stdout/stderr open, then exits immediately.
 */
function makeLeakyLauncher(sleepSeconds: number): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-close-grace-"));
	const script = path.join(dir, "leaky-subagent.sh");
	fs.writeFileSync(
		script,
		[
			"#!/bin/bash",
			"set -eu",
			'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\'',
			// Background sleeper inherits fd 1 and 2 on purpose.
			`sleep ${sleepSeconds} &`,
			"disown || true",
			"exit 0",
		].join("\n"),
		{ mode: 0o755 },
	);
	return script;
}

interface RunResult {
	resolvedMs: number;
	exitCode: number | null;
	closeFired: boolean;
	exitFired: boolean;
	stdout: string;
}

function runWithGrace(script: string, graceMs: number, maxWaitMs: number): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const child = spawn("bash", [script], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let exitFired = false;
		let closeFired = false;
		let staleStdioGrace: NodeJS.Timeout | undefined;

		const hardStop = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch {}
			reject(new Error(`promise did not resolve within ${maxWaitMs}ms (close hang reproduced)`));
		}, maxWaitMs);
		hardStop.unref?.();

		child.stdout.on("data", (d) => { stdout += d.toString(); });
		// stderr is drained but not captured for this test.
		child.stderr.on("data", () => {});

		child.on("exit", () => {
			exitFired = true;
			if (staleStdioGrace) return;
			staleStdioGrace = setTimeout(() => {
				try { child.stdout?.destroy(); } catch {}
				try { child.stderr?.destroy(); } catch {}
			}, graceMs);
			staleStdioGrace.unref?.();
		});

		child.on("close", (code) => {
			if (staleStdioGrace) {
				clearTimeout(staleStdioGrace);
				staleStdioGrace = undefined;
			}
			clearTimeout(hardStop);
			closeFired = true;
			resolve({
				resolvedMs: Date.now() - start,
				exitCode: code,
				closeFired,
				exitFired,
				stdout,
			});
		});

		child.on("error", reject);
	});
}

describe("grace timer around child.on(\"close\")", () => {
	it("still fast-paths when the child has no grandchildren holding stdio", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-close-grace-clean-"));
		const clean = path.join(dir, "clean-subagent.sh");
		fs.writeFileSync(
			clean,
			[
				"#!/bin/bash",
				"set -eu",
				"echo hello",
				"exit 0",
			].join("\n"),
			{ mode: 0o755 },
		);
		const res = await runWithGrace(clean, 2000, 5_000);
		assert.equal(res.exitCode, 0);
		assert.ok(res.closeFired, "close should fire");
		assert.ok(res.resolvedMs < 500, `fast path should resolve in well under the grace window (got ${res.resolvedMs}ms)`);
		assert.match(res.stdout, /hello/);
	});

	it("resolves promptly even when a grandchild keeps stdio open past exit", async () => {
		// Without the grace timer, `close` would wait for the full 30s sleeper.
		const leaky = makeLeakyLauncher(30);
		const graceMs = 1500;
		const res = await runWithGrace(leaky, graceMs, 10_000);
		assert.equal(res.exitCode, 0, "child exit code should still be 0");
		assert.ok(res.exitFired, "exit should fire before close");
		assert.ok(res.closeFired, "close should fire after grace timer destroys stdio");
		assert.ok(
			res.resolvedMs < graceMs + 2_000,
			`close should resolve shortly after the grace window (got ${res.resolvedMs}ms, grace=${graceMs}ms)`,
		);
		assert.match(res.stdout, /message_end/);
	});
});
