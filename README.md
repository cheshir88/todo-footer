# todo-footer — observability extension for Pi Agent

> **Pi Agent extension — a transparent todo widget that cross-checks the model's declared plan against actual tool activity.**

A sticky widget above the editor that makes the agent's activity **legible** to the user.
Unlike a classic to-do list, it does **not** try to control or gate the agent — it shows
two honestly-labeled channels: what the agent is *actually doing* (fact) and what it
*claims* to be doing (intent), and flags the case where work is declared but there is
no tool activity at all.

> **TL;DR difference from a classic todo:** a classic todo stores the model's plan and
> trusts it. This extension treats the model's plan as a *claim*, shows it next to the
> harness's own tool-event log, and never pretends to enforce anything it can't.

---

## Concept

### The problem with "control" extensions

A natural design for a plan widget is to *pause* the agent after each step and ask the
user to approve continuation ("Step mode"). This extension used to work that way. It
doesn't anymore, and the reason is structural, not a bug:

- In Pi, the only **enforceable** control mechanism is intercepting a tool call and
  returning `{ block: true }`. Everything else is a request the model is free to ignore.
- A general plan step ("refactor auth", "write tests") cannot be mapped to a whitelist of
  allowed tools, so you cannot *enforce* that the model is doing the step it declared.
- An "approval gate" built on `terminate: true` + a free-text `"continue"` message is
  **theatre**: the model decides whether to call the gate, and interprets the resume
  message itself. "No" can be read as "he disagreed, but I'll continue."

So a control-style plan widget claims oversight it cannot deliver. This extension
chooses the opposite: **deliver what it *can* — visibility — and be honest about what
it can't.**

### Two channels, honestly labeled

| Channel | Source | Trust | Labeled as |
|---|---|---|---|
| **FACT** (hard) | harness events `tool_execution_start` / `tool_execution_end` / `turn_start` / `turn_end` | absolute — the harness knows which tools ran, regardless of model honesty | `👁 Fact` |
| **INTENT** (soft) | the model declares a plan via the `update_plan` tool | the model may be stale or wrong | `🗣 Plan (declared by model)` |

The fact channel is **ground truth**. The intent channel is the model's **claim**.
The widget never blurs the two.

### Discrepancy check

When the model declares an `in_progress` step, the extension checks the FACT channel
for any tool activity at all — either a running action (`tool_execution_start` without a
matching `end`) or any entry in the recent-actions list. If **both are empty**, the widget
shows:

```
⚠ step declared but no tool activity
```

This catches the rare, meaningful case: the model declared work but is doing literally
nothing. It is deliberately conservative — it never tries to match the *content* of the
step against the *content* of the actions (see *Known limitations*).

### Known limitations

- **Token-based matching between step text and real activity is not reliable.** The
  vocabulary of a step's purpose (e.g. "refactor auth") and the vocabulary of file
  paths/commands (e.g. `edit auth.ts`) do not overlap in general. An earlier version
  tokenized both and flagged mismatches; it produced constant false positives and was
  removed. The extension now only flags the trivial case of declared work with **zero**
  tool activity.
- **Soft channel depends on model cooperation.** There is no way in Pi to *force* the
  model to call `update_plan`. `promptGuidelines` + the per-turn `before_agent_start`
  reminder raise the call rate substantially but do not guarantee it. On short tasks the
  model still frequently skips declaring a plan. This is a fundamental limit of the soft
  channel, not a bug.

### Anomaly detectors (objective, from harness facts)

Three detectors surface patterns the user would otherwise miss. All are derived from
harness facts — no guessing about *what* the model is doing, only counting what *happened*.
The widget states the fact; the user decides what to do.

- **Loop detector.** The same tool call (same name + a hash of its args) repeated ≥3×
  within a sliding window of 16 signatures → `⚠ loop: repeated identical calls (×N: tool)`.
  Catches the model re-issuing identical edits/calls. Hashing stores only a number per
  call, so even huge `edit` payloads cost no memory. The alert clears as soon as a
  non-repeating call lands.
- **Error streak.** ≥3 consecutive tool errors → `⚠ error streak: N in a row`. Catches
  the model stuck in a failing loop.
- **Context pressure.** Context usage ≥30% → `⚠ context N%` (yellow 30–60%, red >60%).
  Cumulative token cost grows super-linearly per turn, so the percentage is surfaced
  early. No action is suggested; the user decides (e.g. `/compact` — the plan survives
  via `restoreIntent` — or a fresh session).

Each detector also fires a one-time `ctx.ui.notify` toast **on the transition** into the
anomaly (norm → anomaly), not on every turn while it persists — so you notice even if you
are not looking at the footer.

---

## Differences from a classic todo widget

| | Classic todo | todo-footer (this extension) |
|---|---|---|
| Primary goal | track the model's plan | make the model's activity legible |
| Source of truth | the model's declarations | harness tool events (fact) + model declarations (intent, labeled) |
| Shows what model is doing *right now* | rarely — only if the model updates status | always — from `tool_execution_start` |
| Flags plan vs. reality mismatch | no | yes (conservative: zero activity on a declared step) + loop / error-streak / context-pressure detectors |
| Tries to pause/approve steps | often | **never** — no `terminate`, no approval gate, no step mode |
| Depends on model honesty for its core value | yes | only for the intent channel; the fact channel is independent |
| Risk of deadlock / stuck state | high (approval can hang) | none — nothing is blocked |

---

## Functionality

### `update_plan` tool (model-callable)

Declares a task plan for the user's visibility. **Declaration only — it does not pause or
control execution.** Two complementary mechanisms keep the tool "top of mind" for the
model:

1. **`promptGuidelines`** — a bullet appended to the system prompt's `Guidelines` section
   on every turn while the tool is active.
2. **`before_agent_start` hook** — an explicit per-turn reminder block injected into the
   system prompt every turn (stronger than a single shared bullet; still not enforcement).

Together they raise how often the model actually declares a plan for multi-step work and
keeps statuses current. Neither can *force* a call (see *Known limitations*).

Parameters:
- `tasks` — array (0–12) of `{ text: string, status: "pending" | "in_progress" | "done" }`

State is stored in `toolResult.details.tasks` for branch-correct restoration on resume.

### Fact channel (automatic, from harness events)

The extension subscribes to harness events and derives, with **no model cooperation**:

- **`turn_start`** — increments the turn counter.
- **`turn_end`** — reads `ctx.getContextUsage()` once per turn to drive the context-pressure detector.
- **`tool_execution_start`** — sets "now: <tool> <summary>" (e.g. `bash git diff`, `read auth.ts`).
- **`tool_execution_end`** — records the action into a rolling "recent:" list (last 8, shows 4) and bumps the error counter if `isError`. Also feeds the loop detector and the error-streak counter. Errors render fully red in the "recent:" line (not just the mark).

`update_plan` calls are deliberately excluded from the fact channel — declaring a plan is
intent, not work; including it would pollute "what is the model doing".

Per-tool summaries:
- `bash` → first line of the command (truncated to 60 chars)
- `read` / `write` / `edit` → the path
- `grep` → pattern or path
- `find` / `ls` → path
- other tools → path, else command, else first string argument

### Intent channel (model-declared)

The model's declared plan, restored from `toolResult.details.tasks` on `session_start` and
`session_compact`. Displayed under `🗣 Plan (declared by model)` with a `[done/total] pct%`
header, status icons (`✓` done / `→` in_progress / `○` pending), and overflow folding for
plans longer than 7 items (last 2 done + in_progress + pending, with a "… N done hidden"
summary line).

### `/todo` command (user)

| Command | Action |
|---|---|
| `/todo` | Show status: task count, turn, widget state, and **active anomalies** (context %, loop, error streak) for at-a-glance triage. Does **not** toggle mode. |
| `/todo clear` | Clear the declared plan |
| `/todo toggle` | Show / hide the widget |

There is no `/todo mode` and no `A`/`S`/`C` shortcuts — those belonged to the removed
control layer.

### Widget layout

```
👁 Fact · turn 4
  now: read auth.ts
  recent:  · bash git status   · read config.ts   ✓ edit auth.ts
  ⚠ session errors: 1
  ⚠ context 34%
────────────────────────────────────────
🗣 Plan (declared by model) [2/5] 40%
  ✓ 1. Study the auth module
  → 2. Fix the logout bug
  ○ 3. Add tests
  ⚠ step declared but no tool activity
```

The three anomaly lines (`context`, `loop`, `error streak`) are conditional — they appear
only while the corresponding detector is active. In a calm session the fact block is just
the header + `now:`/`recent:` + the session-errors counter.

- Every line is truncated to the terminal width via `truncateToWidth` (TUI contract).
- The divider and intent section appear only when a plan is declared.
- The discrepancy line appears only when the conservative check fires (a declared
  `in_progress` step with zero tool activity).

---

## Architecture

```
todo-footer.ts
├── Types & Schema          — Task, TaskStatus, FactAction; TypeBox validation
├── Constants               — MAX_RECENT_ACTIONS, MAX_VISIBLE_TASKS, anomaly thresholds
├── Helpers (pure)
│   ├── countByStatus, summarizeToolCall
│   ├── hashString, callSignature — djb2 hash + stable call signature for the loop detector
│   └── (token-matching helpers removed — see Known limitations)
├── Extension (closure)
│   ├── State               — declaredTasks (intent), currentAction/recentActions/turnCount/errorsThisSession (fact),
│   │                         anomaly state (recentSignatures/loopAlert/consecutiveErrors/lastContextPercent + was* transition flags), widgetVisible
│   ├── normalizeTasks      — validate + trim in one pass (schema already enforces shape)
│   ├── restoreIntent       — scan branch for latest update_plan details.tasks (for /resume)
│   ├── Rendering           — buildFactLines (incl. anomaly lines), buildIntentLines, buildWidgetLines (all width-aware)
│   ├── updateWidget        — factory form setWidget(key, (tui,theme) => Component), render(width)
│   ├── update_plan tool    — declaration only; promptGuidelines + before_agent_start keep it top-of-mind; no terminate
│   ├── /todo command       — clear / toggle / status-with-anomaly-summary (no mode toggle)
│   ├── FACT events         — turn_start, turn_end (context read), tool_execution_start/end (update_plan excluded)
│   ├── Anomaly detectors   — loop (sig window), error streak (consecutive), context pressure (getContextUsage); notify on transition
│   ├── before_agent_start hook — per-turn explicit reminder injected into system prompt (soft-channel reinforcement)
│   └── Lifecycle           — session_start (reset facts + anomaly state, restore intent), session_compact (re-derive intent), session_shutdown (cleanup)
```

### Key design decisions

- **No control layer.** No `terminate`, no approval gate, no step mode. The extension
  delivers visibility, not oversight it can't enforce. (See *Concept*.)
- **Fact is ephemeral, intent is persisted.** Fact state is reset on `session_start`
  (it can't be reconstructed truthfully from history); intent is restored from
  `details.tasks` for correct branching.
- **`update_plan` excluded from the fact channel** so "what the model is doing" reflects
  real work (`bash`/`read`/`edit`/…), not plan declarations.
- **`promptGuidelines` + `before_agent_start` per-turn reminder.** The earlier
  control-style version injected a reminder once per session via `before_agent_start`
  with an `instructionAdded` flag, which was forgotten after the first turn. The
  observability edition uses **both** mechanisms, both per-turn: `promptGuidelines`
  keeps a bullet in the `Guidelines` list while the tool is active, and the
  `before_agent_start` hook appends a short explicit reminder block to the system
  prompt every turn — a stronger nudge than a single shared bullet. There is
  deliberately no `instructionAdded` flag: the system prompt is rebuilt per turn, so
  re-injecting each turn is correct. This is still **not** enforcement; the model can
  ignore it (see *Known limitations*).
- **Width-safe rendering.** The widget uses the factory form and truncates every line to
  `width`, satisfying the TUI `render(width)` contract (long paths/commands no longer
  break the layout).
- **No external dependencies** — imports only from the Pi runtime (`pi-coding-agent`,
  `pi-tui`, `pi-ai`, `typebox`).
- **Anomaly detectors are pure observation, not control.** They count harness facts
  (call signatures, consecutive errors, context %) and surface them — plus a one-time
  toast on the norm→anomaly transition. They never abort the model, never auto-compact,
  never take any action on the session. That line (read facts and report vs. act on the
  session) is the boundary of the extension's philosophy.

## Requirements

- Pi Agent (`@earendil-works/pi-coding-agent`)

## Dev workflow scripts

Two shell scripts (in the project repo, not the extension) make the edit-check-deploy
loop a single command:

| Script | Action |
|---|---|
| `./check.sh` | `tsc --strict` against the globally installed Pi package (resolves sub-deps via a temp tsconfig). Non-zero exit on any error. |
| `./deploy.sh` | Runs `check.sh` first (skip with `--no-check`), then copies `todo-footer.ts` into `~/.pi/agent/extensions/` and reminds you to `/reload`. |

These live outside the extension on purpose — a `/todo deploy` command would run from the
*already-installed* copy while you edit the source, a chicken-and-egg trap. A standalone
script has no such dependency.

## Files

| File | Location | Notes |
|---|---|---|
| Extension source | `todo-footer.ts` | observability edition; deploy to `~/.pi/agent/extensions/` via `./deploy.sh` |
| English README | `README_en.md` | this file |
| Russian README | `README_ru.md` | Russian translation |
| Dev scripts | `check.sh`, `deploy.sh` | type-check + deploy loop |
| License | `LICENSE` | MIT |
| Previous version | `~/.pi/agent/extensions/todo-footer.ts.bak` | earlier control-style version (Step mode, approval gate) |
