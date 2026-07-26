/**
 * todo-footer.ts — observability edition
 *
 * Philosophy: this extension does NOT attempt to control the agent. It makes
 * the agent's activity *legible* to the user. There is no approval gate, no
 * `terminate`, no "step mode". Those are theatre in this architecture — the
 * only enforceable mechanism in Pi is `tool_call` with `block: true`, and a
 * general plan step cannot be mapped to a tool whitelist. So we don't pretend.
 *
 * Two channels, honestly labeled:
 *
 *  1. FACT (hard)   — derived from tool_execution_* / turn_* events. The harness
 *                     knows these regardless of model honesty. Always true.
 *  2. INTENT (soft) — the model *declares* a plan via the update_plan tool.
 *                     Labeled "declared by model". May be stale or wrong.
 *
 * A conservative discrepancy check flags the rare case where the model
 * declared an in_progress step but the FACT channel shows zero tool activity
 * at all. Token-based matching between step text and file paths/commands was
 * deliberately removed — the vocabularies do not overlap in general, so it
 * only produced noise (see README "Known limitations").
 *
 * Three objective anomaly detectors (all from harness facts, no guessing):
 *  - Loop detector: the same tool call (same name + args) repeated ≥3× in a
 *    sliding window. Catches the model re-issuing identical edits/calls.
 *  - Error streak: ≥3 consecutive tool errors. Catches the model stuck in a
 *    failing loop.
 *  - Context pressure: context usage ≥30% — cumulative token cost grows
 *    super-linearly per turn, so the widget surfaces the current percentage.
 *    No action is suggested; the user decides how to proceed.
 *
 * Backup of the previous control-style version: todo-footer.ts.bak
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

type TaskStatus = "pending" | "in_progress" | "done";

interface Task {
	text: string;
	status: TaskStatus;
}

interface FactAction {
	toolName: string;
	summary: string; // short human label of what was done
	isError: boolean;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const TaskSchema = Type.Object({
	text: Type.String({ minLength: 1, description: "Short step description" }),
	status: StringEnum(["pending", "in_progress", "done"] as const),
});

const UpdatePlanParams = Type.Object({
	tasks: Type.Array(TaskSchema, { minItems: 0, maxItems: 12 }),
});

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RECENT_ACTIONS = 8;
const MAX_VISIBLE_TASKS = 7;

// Anomaly detector thresholds.
const MAX_SIGNATURES = 16; // sliding window for the loop detector
const LOOP_THRESHOLD = 3; // ≥3 identical calls in the window ⇒ loop
const ERROR_STREAK_THRESHOLD = 3; // ≥3 consecutive errors ⇒ streak
const CONTEXT_WARN_PCT = 30; // start showing context pressure
const CONTEXT_CRITICAL_PCT = 60; // escalate to red

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countByStatus(tasks: Task[], status: TaskStatus): number {
	return tasks.filter((t) => t.status === status).length;
}

/** Build a short human summary of a tool call's input. */
function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
	const s = (v: unknown): string => (typeof v === "string" ? v : "");

	switch (toolName) {
		case "bash": {
			const cmd = s(input.command).split("\n")[0].trim();
			return cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd;
		}
		case "read":
			return s(input.path);
		case "write":
			return s(input.path);
		case "edit":
			return s(input.path);
		case "grep":
			return s(input.pattern) || s(input.path) || "grep";
		case "find":
			return s(input.path) || s(input.name) || "find";
		case "ls":
			return s(input.path) || ".";
		default: {
			// generic: prefer path, then command, then first string-valued field
			if (s(input.path)) return s(input.path);
			if (s(input.command)) return s(input.command);
			for (const v of Object.values(input)) {
				if (typeof v === "string" && v.length > 0) return v.length > 60 ? v.slice(0, 57) + "…" : v;
			}
			return "";
		}
	}
}

/** Cheap string hash (djb2) for call signatures. Not cryptographic. */
function hashString(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(33, h) + s.charCodeAt(i)) | 0;
	}
	return h >>> 0;
}

/** Stable signature of a tool call so identical calls hash equally. */
function callSignature(toolName: string, args: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(args ?? {});
	} catch {
		// Fall back to a coarse string if args contain cycles (shouldn't happen
		// for LLM tool inputs, but be safe).
		json = String(args);
	}
	return `${toolName}:${hashString(json)}`;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function todoFooterExtension(pi: ExtensionAPI) {
	// ── INTENT channel (soft): declared by the model ──
	let declaredTasks: Task[] = [];

	// ── FACT channel (hard): derived from harness events ──
	let currentAction: { toolName: string; summary: string; signature: string } | null = null;
	let recentActions: FactAction[] = [];
	let turnCount = 0;
	let errorsThisSession = 0;

	// ── Anomaly detector state (FACT-derived) ──
	let recentSignatures: string[] = [];
	let loopAlert: { toolName: string; count: number } | null = null;
	let consecutiveErrors = 0;
	let lastContextPercent: number | null = null;
	// Previous-state flags so we notify only on the norm→anomaly transition,
	// not on every turn while the anomaly persists.
	let wasLooping = false;
	let wasStreaking = false;
	let wasContextHigh = false;

	// ── UI state ──
	let widgetVisible = true;

	// ── Validation (light: schema already enforces shape; we only normalize) ──

	function normalizeTasks(raw: unknown): Task[] | null {
		if (!Array.isArray(raw)) return null;
		const out: Task[] = [];
		for (const t of raw) {
			if (typeof t !== "object" || t === null) return null;
			const o = t as { text?: unknown; status?: unknown };
			if (typeof o.text !== "string" || o.text.trim().length === 0) return null;
			if (o.status !== "pending" && o.status !== "in_progress" && o.status !== "done") return null;
			out.push({ text: o.text.trim(), status: o.status });
		}
		return out;
	}

	// ── State restoration (INTENT only; FACT is ephemeral) ──

	function restoreIntent(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type !== "message") continue;
			const msg = e.message;
			if (msg.role !== "toolResult" || msg.toolName !== "update_plan") continue;

			const details = msg.details as { tasks?: unknown } | undefined;
			if (!details || !Array.isArray(details.tasks)) continue;

			const normalized = normalizeTasks(details.tasks);
			if (normalized === null) continue;

			declaredTasks = normalized;
			return;
		}
		declaredTasks = [];
	}

	// ── Rendering ──

	function buildFactLines(theme: Theme, width: number): string[] {
		const lines: string[] = [];
		const header = `${theme.fg("accent", "👁 Fact")} ${theme.fg("dim", `· turn ${turnCount}`)}`;
		lines.push(truncateToWidth(header, width));

		if (currentAction) {
			const label = theme.fg("warning", "now:");
			const body = `${currentAction.toolName} ${theme.fg("muted", currentAction.summary)}`;
			lines.push(truncateToWidth(`  ${label} ${body}`, width));
		} else if (recentActions.length === 0) {
			lines.push(truncateToWidth(`  ${theme.fg("dim", "idle…")}`, width));
		}

		if (recentActions.length > 0) {
			const shown = recentActions.slice(-4);
			const label = theme.fg("dim", "recent:");
			const parts = shown.map((a) => {
				const mark = a.isError ? theme.fg("error", "✗") : theme.fg("muted", "·");
				const body = `${a.toolName}${a.summary ? " " + a.summary : ""}`;
				// Errors render fully red, not just the mark.
				const coloredBody = a.isError ? theme.fg("error", body) : body;
				return `${mark} ${coloredBody}`;
			});
			lines.push(truncateToWidth(`  ${label} ${parts.join("  ")}`, width));
		}

		if (errorsThisSession > 0) {
			lines.push(
				truncateToWidth(
					`  ${theme.fg("error", `⚠ session errors: ${errorsThisSession}`)}`,
					width,
				),
			);
		}

		// Context pressure (≥30%): cumulative token cost grows super-linearly per
		// turn, so we surface the usage early. The widget only states the fact —
		// the user decides what to do (no action suggestion).
		if (lastContextPercent !== null && lastContextPercent >= CONTEXT_WARN_PCT) {
			const severe = lastContextPercent >= CONTEXT_CRITICAL_PCT;
			const color = severe ? "error" : "warning";
			lines.push(
				truncateToWidth(
					`  ${theme.fg(color, `⚠ context ${lastContextPercent}%`)}`,
					width,
				),
			);
		}

		// Loop detector: identical tool call repeated ≥3× in the recent window.
		if (loopAlert) {
			lines.push(
				truncateToWidth(
					`  ${theme.fg("warning", `⚠ loop: repeated identical calls (×${loopAlert.count}: ${loopAlert.toolName})`)}`,
					width,
				),
			);
		}

		// Error streak: ≥3 consecutive tool errors.
		if (consecutiveErrors >= ERROR_STREAK_THRESHOLD) {
			lines.push(
				truncateToWidth(
					`  ${theme.fg("error", `⚠ error streak: ${consecutiveErrors} in a row`)}`,
					width,
				),
			);
		}

		return lines;
	}

	function buildIntentLines(theme: Theme, width: number): string[] {
		if (declaredTasks.length === 0) return [];

		const lines: string[] = [];
		const done = countByStatus(declaredTasks, "done");
		const total = declaredTasks.length;
		const pct = Math.round((done / total) * 100);

		const header = `${theme.fg("accent", "🗣 Plan")} ${theme.fg("dim", "(declared by model)")} ${theme.fg("muted", `[${done}/${total}] ${pct}%`)}`;
		lines.push(truncateToWidth(header, width));

		// Discrepancy check (conservative): the model declared an in_progress step
		// but the FACT channel shows no tool activity at all — neither a running
		// action nor any recent ones. We deliberately do NOT try to match step text
		// against file paths/commands: those vocabularies don't overlap in general,
		// so token-matching only produced false positives.
		const inProgressIdx = declaredTasks.findIndex((t) => t.status === "in_progress");
		const discrepancy = inProgressIdx !== -1 && recentActions.length === 0 && currentAction === null;

		const renderTasks = declaredTasks.length <= MAX_VISIBLE_TASKS
			? declaredTasks.map((t, i) => ({ t, i }))
			: (() => {
					// fold: last 2 done + in_progress + pending
					const idxDone = declaredTasks
						.map((t, i) => ({ t, i }))
						.filter(({ t }) => t.status === "done");
					const shownDone = idxDone.slice(-2);
					const hidden = idxDone.length - shownDone.length;
					const result: { t: Task; i: number }[] = [];
					if (hidden > 0) {
						lines.push(truncateToWidth(`  ${theme.fg("dim", `… ${hidden} done hidden`)}`, width));
					}
					result.push(...shownDone);
					const ip = declaredTasks.findIndex((t) => t.status === "in_progress");
					if (ip !== -1 && !result.some((r) => r.i === ip)) result.push({ t: declaredTasks[ip], i: ip });
					for (let i = 0; i < declaredTasks.length; i++) {
						if (declaredTasks[i].status === "pending" && !result.some((r) => r.i === i)) {
							result.push({ t: declaredTasks[i], i });
						}
					}
					return result;
				})();

		for (const { t, i } of renderTasks) {
			const num = theme.fg("accent", `${i + 1}.`);
			let icon: string;
			let body: string;
			switch (t.status) {
				case "done":
					icon = theme.fg("success", "✓");
					body = theme.fg("dim", t.text);
					break;
				case "in_progress":
					icon = theme.fg("warning", "→");
					body = theme.fg("text", t.text);
					break;
				default:
					icon = theme.fg("muted", "○");
					body = theme.fg("muted", t.text);
			}
			lines.push(truncateToWidth(`  ${icon} ${num} ${body}`, width));
		}

		if (discrepancy) {
			lines.push(
				truncateToWidth(
					`  ${theme.fg("warning", "⚠ step declared but no tool activity")}`,
					width,
				),
			);
		}

		return lines;
	}

	function buildWidgetLines(theme: Theme, width: number): string[] {
		const fact = buildFactLines(theme, width);
		const intent = buildIntentLines(theme, width);
		if (intent.length > 0) {
			return [...fact, truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width), ...intent];
		}
		return fact;
	}

	// ── Widget ──

	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!widgetVisible) {
			ctx.ui.setWidget("todo-footer", undefined);
			return;
		}
		// Factory form so we receive `width` and can truncate per the TUI contract.
		ctx.ui.setWidget("todo-footer", (_tui, theme) => ({
			render: (width: number) => buildWidgetLines(theme, Math.max(1, width)),
			invalidate: () => {},
		}));
	}

	// ── Tool: update_plan (declaration only — no control) ──

	pi.registerTool({
		name: "update_plan",
		label: "Update Plan",
		description:
			"Declare your task plan. This is for the USER'S visibility (shown in the widget) — it does NOT pause or control execution. " +
			"Each task: text (short step description) + status (pending | in_progress | done). " +
			"Call this when starting a multi-step task and update statuses as you progress.",

		// promptGuidelines are appended to the system prompt `Guidelines` section on
		// EVERY turn while this tool is active — this is the idiomatic Pi mechanism
		// to keep the tool "top of mind" for the model, replacing the brittle
		// once-per-session before_agent_start injection used in earlier versions.
		promptGuidelines: [
			"When starting a multi-step task (2+ steps), first declare a plan via the update_plan tool, then update task statuses (pending â in_progress â done) as you progress. This keeps the user informed of what you are doing.",
		],

		parameters: UpdatePlanParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const normalized = normalizeTasks(params.tasks);
			if (normalized === null) {
				return {
					content: [{ type: "text" as const, text: "Invalid plan: each task needs non-empty text and status in {pending,in_progress,done}." }],
					isError: true,
					details: {},
				};
			}

			declaredTasks = normalized;
			updateWidget(ctx);

			return {
				content: [{ type: "text" as const, text: "Plan declared (visible to user). Continue freely." }],
				details: { tasks: declaredTasks },
			};
		},
	});

	// ── Command: /todo ──

	pi.registerCommand("todo", {
		description:
			"Manage the todo-footer widget. 'clear' — clear the declared plan; 'toggle' — show/hide the widget; (no args) — show status.",

		handler: async (args: string, ctx: ExtensionContext) => {
			const sub = args.trim().toLowerCase();

			if (sub === "clear") {
				declaredTasks = [];
				updateWidget(ctx);
				ctx.ui.notify("🧹 Plan cleared", "info");
				return;
			}

			if (sub === "toggle") {
				widgetVisible = !widgetVisible;
				updateWidget(ctx);
				ctx.ui.notify(widgetVisible ? "📋 Widget shown" : "📋 Widget hidden", "info");
				return;
			}

			// default: status — include active anomalies for at-a-glance triage.
			const anomalies: string[] = [];
			if (lastContextPercent !== null && lastContextPercent >= CONTEXT_WARN_PCT) {
				anomalies.push(`context ${lastContextPercent}%`);
			}
			if (loopAlert) {
				anomalies.push(`loop ×${loopAlert.count} (${loopAlert.toolName})`);
			}
			if (consecutiveErrors >= ERROR_STREAK_THRESHOLD) {
				anomalies.push(`error streak: ${consecutiveErrors}`);
			}
			ctx.ui.notify(
				`todo-footer: ${declaredTasks.length} task(s), turn ${turnCount}, widget ${widgetVisible ? "on" : "off"}` +
					(anomalies.length > 0 ? `, anomalies: ${anomalies.join(", ")}` : "") +
					`. /todo clear | /todo toggle`,
				"info",
			);
		},
	});

	// ── FACT channel: harness events (ground truth) ──

	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		updateWidget(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Context pressure is read once per turn (after the turn settles) rather
		// than on every render — getContextUsage() is not free, and the value
		// only changes meaningfully between turns.
		const usage = ctx.getContextUsage();
		lastContextPercent = usage?.percent ?? null;
		// Notify only on the transition into context pressure.
		const isContextHigh = lastContextPercent !== null && lastContextPercent >= CONTEXT_WARN_PCT;
		if (isContextHigh && !wasContextHigh && ctx.hasUI) {
			const severe = lastContextPercent! >= CONTEXT_CRITICAL_PCT;
			ctx.ui.notify(`⚠ context ${lastContextPercent}%`, severe ? "error" : "warning");
		}
		wasContextHigh = isContextHigh;
		updateWidget(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		// update_plan is the INTENT channel, not a fact-work action. Ignore it
		// so the FACT channel reflects real work (bash/read/edit/...) only.
		if (event.toolName === "update_plan") return;

		const input = (event.args ?? {}) as Record<string, unknown>;
		currentAction = {
			toolName: event.toolName,
			summary: summarizeToolCall(event.toolName, input),
			signature: callSignature(event.toolName, event.args),
		};
		updateWidget(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		// Mirror the guard in tool_execution_start: keep update_plan out of facts.
		if (event.toolName === "update_plan") {
			// It never set currentAction, so nothing to clear here.
			return;
		}

		if (currentAction) {
			const isError = !!event.isError;
			recentActions.push({
				toolName: currentAction.toolName,
				summary: currentAction.summary,
				isError,
			});
			if (recentActions.length > MAX_RECENT_ACTIONS) {
				recentActions = recentActions.slice(-MAX_RECENT_ACTIONS);
			}
			if (isError) {
				errorsThisSession++;
				consecutiveErrors++;
			} else {
				consecutiveErrors = 0;
			}

			// Loop detection: track a sliding window of call signatures. If the
			// just-completed call's signature appears ≥3× in the window, flag it.
			// The alert clears as soon as a non-repeating call lands.
			const sig = currentAction.signature;
			recentSignatures.push(sig);
			if (recentSignatures.length > MAX_SIGNATURES) {
				recentSignatures = recentSignatures.slice(-MAX_SIGNATURES);
			}
			const count = recentSignatures.filter((s) => s === sig).length;
			loopAlert = count >= LOOP_THRESHOLD ? { toolName: event.toolName, count } : null;

			// Notify only on the transition into a loop (not while it persists).
			const isLooping = loopAlert !== null;
			if (isLooping && !wasLooping && ctx.hasUI) {
				const la = loopAlert!;
				ctx.ui.notify(`⚠ loop: repeated identical calls (×${la.count}: ${la.toolName})`, "warning");
			}
			wasLooping = isLooping;

			// Notify only on the transition into an error streak.
			const isStreaking = consecutiveErrors >= ERROR_STREAK_THRESHOLD;
			if (isStreaking && !wasStreaking && ctx.hasUI) {
				ctx.ui.notify(`⚠ error streak: ${consecutiveErrors} in a row`, "error");
			}
			wasStreaking = isStreaking;

			currentAction = null;
		}
		updateWidget(ctx);
	});

	// ── Per-turn reminder (soft-channel reinforcement) ──
	//
	// promptGuidelines keeps the tool in the `Guidelines` list while it is active,
	// but that list is easy for the model to tune out on later turns. This hook
	// appends a short, explicit reminder to the system prompt on EVERY turn —
	// a stronger nudge to actually call update_plan for multi-step work and to
	// keep statuses current. It is still NOT enforcement; the model can ignore it.
	// There is deliberately no `instructionAdded` flag — the system prompt is
	// rebuilt per turn, so re-injecting each turn is correct and idiomatic.

	pi.on("before_agent_start", async (event) => {
		const reminder =
			"todo-footer: if the user's request is multi-step (2+ steps), declare a plan via the update_plan tool before doing the work, and update task statuses (pending → in_progress → done) as you progress. For single trivial actions (e.g. a one-line bash call) this is optional.";

		return {
			systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${reminder}` : reminder,
		};
	});

	// ── Lifecycle ──

	pi.on("session_start", async (_event, ctx) => {
		// INTENT restored from session; FACT reset (ephemeral).
		declaredTasks = [];
		currentAction = null;
		recentActions = [];
		turnCount = 0;
		errorsThisSession = 0;
		recentSignatures = [];
		loopAlert = null;
		consecutiveErrors = 0;
		lastContextPercent = null;
		wasLooping = false;
		wasStreaking = false;
		wasContextHigh = false;
		restoreIntent(ctx);
		updateWidget(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Compaction may drop entries; re-derive intent from surviving branch.
		restoreIntent(ctx);
		updateWidget(ctx);
	});

		pi.on("session_shutdown", async (_event, ctx) => {
		currentAction = null;
		recentActions = [];
		declaredTasks = [];
		turnCount = 0;
		errorsThisSession = 0;
		recentSignatures = [];
		loopAlert = null;
		consecutiveErrors = 0;
		lastContextPercent = null;
		wasLooping = false;
		wasStreaking = false;
		wasContextHigh = false;
		if (ctx.hasUI) {
			ctx.ui.setWidget("todo-footer", undefined);
		}
	});
}
