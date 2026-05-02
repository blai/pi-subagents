import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { formatAsyncRunList, formatAsyncRunProgressLabel, listAsyncRuns } from "./async-status.ts";
import { ASYNC_DIR, RESULTS_DIR, type AsyncStatus, type Details } from "../../shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { resolveAsyncRunLocation } from "./async-resume.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";

interface RunStatusParams {
	action?: "status";
	id?: string;
	runId?: string;
	dir?: string;
}

interface RunStatusDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

function activityText(activityState: unknown, lastActivityAt: unknown): string | undefined {
	if (typeof lastActivityAt !== "number") return undefined;
	const seconds = Math.floor(Math.max(0, Date.now() - lastActivityAt) / 1000);
	return activityState === "needs_attention" ? `no activity for ${seconds}s` : `active ${seconds}s ago`;
}

function canShowRevive(stepCount: number, sessionFile: unknown): sessionFile is string {
	return stepCount === 1 && typeof sessionFile === "string" && fs.existsSync(sessionFile);
}

function stepLineLabel(status: AsyncStatus, index: number): string {
	const steps = status.steps ?? [];
	if (status.mode === "parallel") return `Agent ${index + 1}/${steps.length || 1}`;
	if (status.mode === "chain") {
		const chainStepCount = status.chainStepCount ?? (steps.length || 1);
		const groups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
		const group = groups.find((candidate) => index >= candidate.start && index < candidate.start + candidate.count);
		if (group) return `Step ${group.stepIndex + 1}/${chainStepCount} Agent ${index - group.start + 1}/${group.count}`;
		return `Step ${flatToLogicalStepIndex(index, chainStepCount, groups) + 1}/${chainStepCount}`;
	}
	return `Step ${index + 1}`;
}

export function inspectSubagentStatus(params: RunStatusParams, deps: RunStatusDeps = {}): AgentToolResult<Details> {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	if (!params.id && !params.runId && !params.dir) {
		try {
			const runs = listAsyncRuns(asyncDirRoot, { states: ["queued", "running"], resultsDir, kill: deps.kill, now: deps.now });
			return {
				content: [{ type: "text", text: formatAsyncRunList(runs) }],
				details: { mode: "single", results: [] },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	let location;
	try {
		location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	const { asyncDir, resultPath, resolvedId } = location;

	if (!asyncDir && !resultPath) {
		return {
			content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	if (asyncDir) {
		let reconciliation;
		try {
			reconciliation = reconcileAsyncRun(asyncDir, { resultsDir, kill: deps.kill, now: deps.now });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		const status = reconciliation.status;
		const effectiveRunId = status?.runId ?? resolvedId ?? "unknown";
		const logPath = path.join(asyncDir, `subagent-log-${effectiveRunId}.md`);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		if (status) {
			const progressLabel = formatAsyncRunProgressLabel({
				mode: status.mode,
				state: status.state,
				currentStep: status.currentStep,
				chainStepCount: status.chainStepCount,
				parallelGroups: status.parallelGroups,
				steps: (status.steps ?? []).map((step, index) => ({ index, agent: step.agent, status: step.status })),
			});
			const started = new Date(status.startedAt).toISOString();
			const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";
			const statusActivityText = status.state === "running" ? activityText(status.activityState, status.lastActivityAt) : undefined;

			const lines = [
				`Run: ${status.runId}`,
				`State: ${status.state}`,
				statusActivityText ? `Activity: ${statusActivityText}` : undefined,
				`Mode: ${status.mode}`,
				`Progress: ${progressLabel}`,
				`Started: ${started}`,
				`Updated: ${updated}`,
				`Dir: ${asyncDir}`,
				reconciliation.message ? `Diagnosis: ${reconciliation.message}` : undefined,
				reconciliation.resultPath && fs.existsSync(reconciliation.resultPath) ? `Result: ${reconciliation.resultPath}` : undefined,
			].filter((line): line is string => Boolean(line));
			for (const [index, step] of (status.steps ?? []).entries()) {
				const stepActivityText = step.status === "running" ? activityText(step.activityState, step.lastActivityAt) : undefined;
				const errorText = step.error ? `, error: ${step.error}` : "";
				lines.push(`${stepLineLabel(status, index)}: ${step.agent} ${step.status}${stepActivityText ? `, ${stepActivityText}` : ""}${errorText}`);
				if (step.status === "running") {
					lines.push(`  Intercom target: ${resolveSubagentIntercomTarget(status.runId, step.agent, index)} (if registered)`);
				}
			}
			if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
			if (status.state !== "running") {
				const stepCount = status.steps?.length ?? 0;
				if (canShowRevive(stepCount, status.sessionFile)) {
					lines.push(`Revive: subagent({ action: "resume", id: "${status.runId}", message: "..." })`);
				} else if (stepCount > 1) {
					lines.push("Resume: unsupported for multi-child async runs until per-child session files are persisted.");
				} else {
					lines.push("Resume: unavailable; no single child session file was persisted.");
				}
			}
			if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
			if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
		}
	}

	if (resultPath) {
		try {
			const raw = fs.readFileSync(resultPath, "utf-8");
			const data = JSON.parse(raw) as { id?: string; runId?: string; agent?: string; success?: boolean; summary?: string; exitCode?: number; state?: string; sessionFile?: string; results?: Array<{ agent?: string }> };
			const status = data.success ? "complete" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
			const runId = data.runId ?? data.id ?? resolvedId;
			const lines = [`Run: ${runId}`, `State: ${status}`, `Result: ${resultPath}`];
			const stepCount = Array.isArray(data.results) ? data.results.length : data.agent ? 1 : 0;
			if (runId && canShowRevive(stepCount, data.sessionFile)) {
				lines.push(`Revive: subagent({ action: "resume", id: "${runId}", message: "..." })`);
			} else if (stepCount > 1) {
				lines.push("Resume: unsupported for multi-child async runs until per-child session files are persisted.");
			} else {
				lines.push("Resume: unavailable; no single child session file was persisted.");
			}
			if (data.summary) lines.push("", data.summary);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Failed to read async result file: ${message}` }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	return {
		content: [{ type: "text", text: "Status file not found." }],
		isError: true,
		details: { mode: "single", results: [] },
	};
}
