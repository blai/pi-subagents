/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_FIELDS } from "./agent-serializer.js";
import { parseChain } from "./chain-serializer.js";
import { mergeAgentsForScope } from "./agent-selection.js";
import { parseFrontmatter } from "./frontmatter.js";

export type AgentScope = "user" | "project" | "both";

/**
 * Agent source priority (lowest → highest):
 *   builtin  — shipped inside pi-subagents itself
 *   package  — registered at runtime by external pi packages via EventBus
 *   user     — ~/.pi/agent/agents/
 *   project  — .pi/agents/ in the nearest ancestor directory
 */
export type AgentSource = "builtin" | "package" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
	extensions?: string[];
	// Chain behavior fields
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	extraFields?: Record<string, string>;
}

export interface ChainStepConfig {
	agent: string;
	task: string;
	output?: string | false;
	reads?: string[] | false;
	model?: string;
	skills?: string[] | false;
	progress?: boolean;
}

export interface ChainConfig {
	name: string;
	description: string;
	source: AgentSource;
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const rawTools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const mcpDirectTools: string[] = [];
		const tools: string[] = [];
		if (rawTools) {
			for (const tool of rawTools) {
				if (tool.startsWith("mcp:")) {
					mcpDirectTools.push(tool.slice(4));
				} else {
					tools.push(tool);
				}
			}
		}

		// Parse defaultReads as comma-separated list (like tools)
		const defaultReads = frontmatter.defaultReads
			?.split(",")
			.map((f) => f.trim())
			.filter(Boolean);

		const skillStr = frontmatter.skill || frontmatter.skills;
		const skills = skillStr
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		let extensions: string[] | undefined;
		if (frontmatter.extensions !== undefined) {
			extensions = frontmatter.extensions
				.split(",")
				.map((e) => e.trim())
				.filter(Boolean);
		}

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!KNOWN_FIELDS.has(key)) extraFields[key] = value;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools.length > 0 ? tools : undefined,
			mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			systemPrompt: body,
			source,
			filePath,
			skills: skills && skills.length > 0 ? skills : undefined,
			extensions,
			// Chain behavior fields
			output: frontmatter.output,
			defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
			defaultProgress: frontmatter.defaultProgress === "true",
			interactive: frontmatter.interactive === "true",
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		});
	}

	return agents;
}

function loadChainsFromDir(dir: string, source: AgentSource): ChainConfig[] {
	const chains: ChainConfig[] = [];

	if (!fs.existsSync(dir)) {
		return chains;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return chains;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			chains.push(parseChain(content, source, filePath));
		} catch {
			continue;
		}
	}

	return chains;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

const BUILTIN_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

/**
 * Extra agent directories registered at runtime via EventBus.
 * Entries are treated as builtins — user/project agents override them.
 * Packages register dirs during `session_start` by emitting:
 *   pi.events.emit("subagents:register-agent-dir", { dir: "/abs/path", source: "builtin" })
 */
const extraAgentDirs: Map<string, AgentSource> = new Map();

/** Register an extra agent directory. Safe to call multiple times with the same dir. */
export function registerExtraAgentDir(dir: string, source: AgentSource = "package"): void {
	extraAgentDirs.set(dir, source);
}

/** Unregister a previously added extra agent directory. */
export function unregisterExtraAgentDir(dir: string): void {
	extraAgentDirs.delete(dir);
}

/** Clear all extra agent directories (e.g. on session reset). */
export function clearExtraAgentDirs(): void {
	extraAgentDirs.clear();
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const builtinAgents = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
	const packageAgents = Array.from(extraAgentDirs.entries()).flatMap(([dir, source]) =>
		loadAgentsFromDir(dir, source),
	);
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const agents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents, packageAgents);

	return { agents, projectAgentsDir };
}

export function discoverAgentsAll(cwd: string): {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	userDir: string;
	projectDir: string | null;
} {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectDir = findNearestProjectAgentsDir(cwd);

	const builtin = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
	const pkg = Array.from(extraAgentDirs.entries()).flatMap(([dir, source]) =>
		loadAgentsFromDir(dir, source),
	);
	const user = loadAgentsFromDir(userDir, "user");
	const project = projectDir ? loadAgentsFromDir(projectDir, "project") : [];
	const chains = [
		...loadChainsFromDir(userDir, "user"),
		...(projectDir ? loadChainsFromDir(projectDir, "project") : []),
	];

	return { builtin, package: pkg, user, project, chains, userDir, projectDir };
}
