import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { chmod, rm } from "node:fs/promises"
import type { Plugin } from "@opencode-ai/plugin"

type SessionInfo = {
	id: string
	parentID?: string | null
}

type PendingTask = {
	agent: string
	createdAt: number
	tmuxWindowID?: string
}

type PaneLocation = {
	paneID: string
	windowID: string
	panePID?: number
}

type TmuxPaneGeometry = {
	paneID: string
	left: number
	top: number
}

type SharedSpawnState =
	| {
		kind: "pending"
		createdAt: number
	  }
	| ({
		kind: "live"
	} & PaneLocation)

const TASK_TTL_MS = 15_000
const CLEANUP_DELAY_MS = 4_000
const PROCESS_TERMINATION_GRACE_MS = 1_000
const TMUX_OPTION_PREFIX = "@opencode_subagent_"
const spawnedSessions = new Set<string>()
const pendingByParent = new Map<string, PendingTask[]>()
const paneBySession = new Map<string, PaneLocation>()
const cleanupTimers = new Map<string, Timer>()
const cleanupGenerations = new Map<string, number>()
const localLockTails = new Map<string, { tail: Promise<void>; token: symbol }>()

type Timer = ReturnType<typeof setTimeout>
type TaskToolArgs = Record<string, unknown> & {
	subagent_type?: string
	task_id?: string
}

function isInsideTmux(): boolean {
	return Boolean(process.env.TMUX)
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`
}

function sanitizeLabel(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24) || "subagent"
}

function prunePending(queue: PendingTask[]): PendingTask[] {
	const cutoff = Date.now() - TASK_TTL_MS
	return queue.filter((item) => item.createdAt >= cutoff)
}

function toNonEmptyString(value?: string | null): string | undefined {
	const trimmedValue = value?.trim()
	if (!trimmedValue) return
	return trimmedValue
}

function toPositiveInteger(value?: string | null): number | undefined {
	const trimmedValue = toNonEmptyString(value)
	if (!trimmedValue) return

	const parsedValue = Number.parseInt(trimmedValue, 10)
	if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) return
	return parsedValue
}

function toNonNegativeInteger(value?: string | null): number | undefined {
	const trimmedValue = toNonEmptyString(value)
	if (!trimmedValue) return

	const parsedValue = Number.parseInt(trimmedValue, 10)
	if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) return
	return parsedValue
}

function toSessionOptionKey(sessionID: string): string {
	const sessionHash = createHash("sha256").update(sessionID).digest("hex")
	return `${TMUX_OPTION_PREFIX}${sessionHash}`
}

function toCleanupOptionKey(sessionID: string): string {
	return `${toSessionOptionKey(sessionID)}_cleanup`
}

function toSpawnLockName(sessionID: string): string {
	return `${TMUX_OPTION_PREFIX}lock_${toSessionOptionKey(sessionID).slice(TMUX_OPTION_PREFIX.length)}`
}

function readSharedSpawnState(sessionID: string): SharedSpawnState | undefined {
	const optionKey = toSessionOptionKey(sessionID)
	const optionResult = Bun.spawnSync(["tmux", "show-options", "-gqv", optionKey])
	if (optionResult.exitCode !== 0) return

	const rawValue = toNonEmptyString(optionResult.stdout.toString())
	if (!rawValue) return

	const [kind, ...parts] = rawValue.split("\t")
	if (kind === "pending") {
		const createdAt = toPositiveInteger(parts[0])
		if (!createdAt) {
			clearSharedSpawnState(sessionID)
			return
		}

		if (createdAt < Date.now() - TASK_TTL_MS) {
			clearSharedSpawnState(sessionID)
			return
		}

		return { kind, createdAt }
	}

	if (kind !== "live") {
		clearSharedSpawnState(sessionID)
		return
	}

	const [paneID, windowID, panePIDValue] = parts
	if (!paneID || !windowID) {
		clearSharedSpawnState(sessionID)
		return
	}

	const paneLocation: PaneLocation = {
		paneID,
		windowID,
		panePID: toPositiveInteger(panePIDValue),
	}
	if (!isPaneLive(paneLocation)) {
		clearSharedSpawnState(sessionID)
		return
	}

	return { kind, ...paneLocation }
}

function writeSharedSpawnState(sessionID: string, state: SharedSpawnState): void {
	const optionKey = toSessionOptionKey(sessionID)
	const optionValue =
		state.kind === "pending"
			? `${state.kind}\t${state.createdAt}`
			: `${state.kind}\t${state.paneID}\t${state.windowID}\t${state.panePID ?? ""}`

	Bun.spawnSync(["tmux", "set-option", "-gq", optionKey, optionValue])
}

function clearSharedSpawnState(sessionID: string): void {
	const optionKey = toSessionOptionKey(sessionID)
	Bun.spawnSync(["tmux", "set-option", "-gu", optionKey])
}

function readSharedCleanupGeneration(sessionID: string): number {
	const optionKey = toCleanupOptionKey(sessionID)
	const optionResult = Bun.spawnSync(["tmux", "show-options", "-gqv", optionKey])
	if (optionResult.exitCode !== 0) return 0

	return toPositiveInteger(optionResult.stdout.toString()) ?? 0
}

function bumpSharedCleanupGeneration(sessionID: string): number {
	const optionKey = toCleanupOptionKey(sessionID)
	const nextGeneration = readSharedCleanupGeneration(sessionID) + 1
	Bun.spawnSync(["tmux", "set-option", "-gq", optionKey, String(nextGeneration)])
	return nextGeneration
}

function clearSharedCleanupGeneration(sessionID: string): void {
	const optionKey = toCleanupOptionKey(sessionID)
	Bun.spawnSync(["tmux", "set-option", "-gu", optionKey])
}

async function withSpawnLock<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
	const previousTail = localLockTails.get(sessionID)?.tail ?? Promise.resolve()
	let releaseLocalLock = () => {}
	const nextTail = new Promise<void>((resolve) => {
		releaseLocalLock = resolve
	})
	const lockToken = Symbol(sessionID)
	localLockTails.set(sessionID, { tail: previousTail.then(() => nextTail), token: lockToken })

	await previousTail
	const lockName = toSpawnLockName(sessionID)
	Bun.spawnSync(["tmux", "wait-for", "-L", lockName])
	try {
		return await action()
	} finally {
		Bun.spawnSync(["tmux", "wait-for", "-U", lockName])
		releaseLocalLock()
		if (localLockTails.get(sessionID)?.token === lockToken) {
			localLockTails.delete(sessionID)
		}
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isMissingPaneError(message: string): boolean {
	return message.includes("can't find pane")
}

function resolvePanePID(paneLocation: PaneLocation): number | undefined {
	const panePIDResult = Bun.spawnSync([
		"tmux",
		"display-message",
		"-p",
		"-t",
		paneLocation.paneID,
		"#{pane_pid}",
	])
	if (panePIDResult.exitCode !== 0) return

	return toPositiveInteger(panePIDResult.stdout.toString()) ?? paneLocation.panePID
}

function isPaneLive(paneLocation: PaneLocation): boolean {
	const paneResult = Bun.spawnSync([
		"tmux",
		"display-message",
		"-p",
		"-t",
		paneLocation.paneID,
		"#{pane_id}",
	])
	if (paneResult.exitCode !== 0) return false

	return toNonEmptyString(paneResult.stdout.toString()) === paneLocation.paneID
}

function getLiveTrackedPane(sessionID: string): PaneLocation | undefined {
	const paneLocation = paneBySession.get(sessionID)
	if (!paneLocation) return
	if (isPaneLive(paneLocation)) return paneLocation

	paneBySession.delete(sessionID)
	spawnedSessions.delete(sessionID)
	return
}

function bumpCleanupGeneration(sessionID: string): number {
	const generation = (cleanupGenerations.get(sessionID) ?? 0) + 1
	cleanupGenerations.set(sessionID, generation)
	return generation
}

function isCurrentCleanupGeneration(sessionID: string, generation: number): boolean {
	return cleanupGenerations.get(sessionID) === generation
}

function resolveServerUrl(runtimeServerUrl?: URL | string | null): string {
	const explicitServerUrl =
		runtimeServerUrl instanceof URL ? runtimeServerUrl.toString() : runtimeServerUrl

	return (
		toNonEmptyString(explicitServerUrl) ??
		toNonEmptyString(process.env.OPENCODE_SERVER_URL) ??
		"http://localhost:4096"
	)
}

function resolveCurrentTmuxWindowID(): string | undefined {
	const paneID = toNonEmptyString(process.env.TMUX_PANE)
	if (!paneID) return

	const windowResult = Bun.spawnSync([
		"tmux",
		"display-message",
		"-p",
		"-t",
		paneID,
		"#{window_id}",
	])
	if (windowResult.exitCode !== 0) return

	return toNonEmptyString(windowResult.stdout.toString())
}

function resolveTmuxWindowPanes(windowID: string): TmuxPaneGeometry[] {
	const listPanesResult = Bun.spawnSync([
		"tmux",
		"list-panes",
		"-t",
		windowID,
		"-F",
		"#{pane_id} #{pane_left} #{pane_top}",
	])
	if (listPanesResult.exitCode !== 0) return []

	const panes: TmuxPaneGeometry[] = []
	for (const line of listPanesResult.stdout.toString().split("\n")) {
		const trimmedLine = line.trim()
		if (!trimmedLine) continue

		const [paneID, paneLeftValue, paneTopValue] = trimmedLine.split(/\s+/, 3)
		const left = toNonNegativeInteger(paneLeftValue)
		const top = toNonNegativeInteger(paneTopValue)
		if (!paneID || left === undefined || top === undefined) continue

		panes.push({ paneID, left, top })
	}

	return panes
}

function resolveSplitTarget(tmuxTargetWindowID?: string): {
	target?: string
	direction: "-h" | "-v"
} {
	if (!tmuxTargetWindowID) {
		return { direction: "-h" }
	}

	const livePanes = resolveTmuxWindowPanes(tmuxTargetWindowID)
	const managedPaneIDs = new Set(
		Array.from(paneBySession.values())
			.filter((pane) => pane.windowID === tmuxTargetWindowID)
			.map((pane) => pane.paneID),
	)
	const existingSubagentPanes = livePanes.filter((pane) => managedPaneIDs.has(pane.paneID))

	if (existingSubagentPanes.length === 0) {
		return { target: tmuxTargetWindowID, direction: "-h" }
	}

	const bottomMostPane = existingSubagentPanes.sort((leftPane, rightPane) => {
		if (leftPane.left !== rightPane.left) return rightPane.left - leftPane.left
		return rightPane.top - leftPane.top
	})[0]

	return { target: bottomMostPane?.paneID ?? tmuxTargetWindowID, direction: "-v" }
}

function queueTask(parentSessionID: string, task: Omit<PendingTask, "createdAt">): void {
	const queue = prunePending(pendingByParent.get(parentSessionID) ?? [])
	queue.push({
		...task,
		createdAt: Date.now(),
		tmuxWindowID: task.tmuxWindowID ?? resolveCurrentTmuxWindowID(),
	})
	pendingByParent.set(parentSessionID, queue)
}

function takeQueuedTask(parentSessionID: string): PendingTask | undefined {
	const queue = prunePending(pendingByParent.get(parentSessionID) ?? [])
	const next = queue.shift()
	if (queue.length > 0) {
		pendingByParent.set(parentSessionID, queue)
	} else {
		pendingByParent.delete(parentSessionID)
	}
	return next
}

async function spawnTmuxPane(options: {
	cwd: string
	sessionID: string
	paneLabel: string
	tmuxTargetWindowID?: string
	opencodeBin: string
	serverUrl: string
	log: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
}): Promise<PaneLocation> {
	const { cwd, sessionID, paneLabel, tmuxTargetWindowID, opencodeBin, serverUrl, log } = options
	const splitTarget = resolveSplitTarget(tmuxTargetWindowID)
	const scriptPath = path.join(os.tmpdir(), `opencode-subagent-${sessionID}.sh`)
	const envVars = {
		OPENCODE_BIN: process.env.OPENCODE_BIN,
		OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
		OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
		OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
		OPENCODE_DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
		OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL,
		OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
		OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
	}

	const envLines = Object.entries(envVars)
		.filter((entry): entry is [string, string] => Boolean(entry[1]))
		.map(([key, value]) => `export ${key}=${shellQuote(value)}`)

	const command = [
		shellQuote(opencodeBin),
		"attach",
		shellQuote(serverUrl),
		"--dir",
		shellQuote(cwd),
		"--session",
		shellQuote(sessionID),
	]

	const script = [
		"#!/bin/bash",
		"trap 'rm -f \"$0\"' EXIT INT TERM",
		...envLines,
		`cd ${shellQuote(cwd)} || exit 1`,
		`exec ${command.join(" ")}`,
	].join("\n")

	await Bun.write(scriptPath, script)
	await chmod(scriptPath, 0o755)

	const splitResult = Bun.spawnSync([
		"tmux",
		"split-window",
		"-d",
		splitTarget.direction,
		...(splitTarget.target ? ["-t", splitTarget.target] : []),
		"-c",
		cwd,
		"-P",
		"-F",
		"#{pane_id} #{window_id} #{pane_pid}",
		"--",
		"bash",
		scriptPath,
	])

	if (splitResult.exitCode !== 0) {
		await rm(scriptPath, { force: true }).catch(() => {})
		throw new Error(splitResult.stderr.toString().trim() || "tmux split-window failed")
	}

	const [paneID, windowID, panePIDValue] = splitResult.stdout.toString().trim().split(/\s+/, 3)
	if (!paneID || !windowID) {
		throw new Error("tmux split-window did not return pane and window ids")
	}

	const panePID = toPositiveInteger(panePIDValue)

	Bun.spawnSync(["tmux", "select-pane", "-t", paneID, "-T", paneLabel])
	Bun.spawnSync(["tmux", "set-option", "-w", "-t", windowID, "main-pane-width", "50%"])
	Bun.spawnSync(["tmux", "select-layout", "-t", windowID, "main-vertical"])
	await log("info", `Spawned tmux pane for ${paneLabel} (${sessionID})`)
	return { paneID, windowID, panePID }
}

async function openPaneForSession(options: {
	sessionID: string
	agentName: string
	directory: string
	tmuxTargetWindowID?: string
	serverUrl: string
	log: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
}): Promise<void> {
	const { sessionID, agentName, directory, tmuxTargetWindowID, serverUrl, log } = options
	const paneLabel = sanitizeLabel(agentName)
	const opencodeBin = process.env.OPENCODE_BIN || Bun.which("opencode") || "opencode"
	const paneLocation = await spawnTmuxPane({
		cwd: directory,
		sessionID,
		paneLabel,
		tmuxTargetWindowID,
		opencodeBin,
		serverUrl,
		log,
	})
	paneBySession.set(sessionID, paneLocation)
	writeSharedSpawnState(sessionID, { kind: "live", ...paneLocation })
}

async function ensureSessionPane(options: {
	sessionID: string
	agentName: string
	directory: string
	tmuxTargetWindowID?: string
	serverUrl: string
	log: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
}): Promise<void> {
	const { sessionID, agentName, directory, tmuxTargetWindowID, serverUrl, log } = options

	const shouldSpawn = await withSpawnLock(sessionID, async () => {
		cancelPaneCleanupTimer(sessionID)
		bumpSharedCleanupGeneration(sessionID)

		const liveTrackedPane = getLiveTrackedPane(sessionID)
		if (liveTrackedPane) {
			writeSharedSpawnState(sessionID, { kind: "live", ...liveTrackedPane })
			return false
		}

		const sharedState = readSharedSpawnState(sessionID)
		if (sharedState?.kind === "live") {
			paneBySession.set(sessionID, sharedState)
			spawnedSessions.add(sessionID)
			return false
		}

		if (sharedState?.kind === "pending") {
			spawnedSessions.add(sessionID)
			return false
		}

		spawnedSessions.add(sessionID)
		writeSharedSpawnState(sessionID, { kind: "pending", createdAt: Date.now() })
		return true
	})

	if (!shouldSpawn) return

	try {
		await openPaneForSession({
			sessionID,
			agentName,
			directory,
			tmuxTargetWindowID,
			serverUrl,
			log,
		})
	} catch (error) {
		await withSpawnLock(sessionID, async () => {
			spawnedSessions.delete(sessionID)
			clearSharedSpawnState(sessionID)
		})
		throw error
	}
}

function cancelPaneCleanupTimer(sessionID: string): number {
	const generation = bumpCleanupGeneration(sessionID)
	const timer = cleanupTimers.get(sessionID)
	if (timer) {
		clearTimeout(timer)
	}
	cleanupTimers.delete(sessionID)
	return generation
}

async function killPane(options: {
	sessionID: string
	paneLocation: PaneLocation
	log: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
	failurePrefix: string
	shouldAbort?: () => boolean
}): Promise<boolean> {
	const { sessionID, paneLocation, log, failurePrefix, shouldAbort } = options
	if (shouldAbort?.()) return false

	const panePID = resolvePanePID(paneLocation)
	if (panePID) {
		try {
			process.kill(panePID, "SIGTERM")
			await log(
				"debug",
				`Sent SIGTERM to pane process ${panePID} for ${sessionID} before tmux cleanup`,
			)
			await delay(PROCESS_TERMINATION_GRACE_MS)
		} catch (error) {
			const errorCode = error && typeof error === "object" && "code" in error ? error.code : undefined
			if (errorCode !== "ESRCH") {
				await log(
					"warn",
					`Failed to gracefully terminate pane process ${panePID} for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	if (shouldAbort?.()) return false

	const killResult = Bun.spawnSync(["tmux", "kill-pane", "-t", paneLocation.paneID])
	const killError = killResult.stderr.toString().trim()
	if (killResult.exitCode !== 0) {
		if (isMissingPaneError(killError)) {
			Bun.spawnSync(["tmux", "select-layout", "-t", paneLocation.windowID, "main-vertical"])
			return true
		}

		await log(
			"warn",
			`${failurePrefix} ${paneLocation.paneID} for ${sessionID}: ${killError || "tmux kill-pane failed"}`,
		)
		return false
	}

	Bun.spawnSync(["tmux", "select-layout", "-t", paneLocation.windowID, "main-vertical"])
	return true
}

function readAndClearTmuxOption(optionKey: string): string | undefined {
	const optionResult = Bun.spawnSync(["tmux", "show-options", "-gqv", optionKey])
	const optionValue = optionResult.exitCode === 0 ? toNonEmptyString(optionResult.stdout.toString()) : undefined
	Bun.spawnSync(["tmux", "set-option", "-gu", optionKey])
	return optionValue
}

async function autoCleanupKillPane(options: {
	sessionID: string
	paneLocation: PaneLocation
	sharedGeneration: number
	log: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
}): Promise<boolean> {
	const { sessionID, paneLocation, sharedGeneration, log } = options
	const resultOptionKey = `${toCleanupOptionKey(sessionID)}_result_${process.pid}_${Date.now()}`
	const script = [
		`generation=$(tmux show-options -gqv ${shellQuote(toCleanupOptionKey(sessionID))})`,
		`if [ "$generation" != ${shellQuote(String(sharedGeneration))} ]; then`,
		`  tmux set-option -gq ${shellQuote(resultOptionKey)} stale`,
		`elif ! tmux display-message -p -t ${shellQuote(paneLocation.paneID)} '#{pane_id}' >/dev/null 2>&1; then`,
		`  tmux set-option -gq ${shellQuote(resultOptionKey)} missing`,
		`elif kill_output=$(tmux kill-pane -t ${shellQuote(paneLocation.paneID)} 2>&1); then`,
		`  tmux select-layout -t ${shellQuote(paneLocation.windowID)} main-vertical >/dev/null 2>&1 || true`,
		`  tmux set-option -gq ${shellQuote(resultOptionKey)} killed`,
		`elif printf '%s' "$kill_output" | grep -F "can't find pane" >/dev/null 2>&1; then`,
		`  tmux select-layout -t ${shellQuote(paneLocation.windowID)} main-vertical >/dev/null 2>&1 || true`,
		`  tmux set-option -gq ${shellQuote(resultOptionKey)} missing`,
		`else`,
		`  tmux set-option -gq ${shellQuote(resultOptionKey)} failed`,
		`fi`,
	].join(" ")

	const cleanupResult = Bun.spawnSync([
		"tmux",
		"wait-for",
		"-L",
		toSpawnLockName(sessionID),
		";",
		"run-shell",
		script,
		";",
		"wait-for",
		"-U",
		toSpawnLockName(sessionID),
	])
	if (cleanupResult.exitCode !== 0) {
		await log(
			"warn",
			`Failed to run locked auto-cleanup for ${sessionID}: ${cleanupResult.stderr.toString().trim() || "tmux command failed"}`,
		)
		readAndClearTmuxOption(resultOptionKey)
		return false
	}

	const result = readAndClearTmuxOption(resultOptionKey)
	if (result === "killed" || result === "missing") {
		return true
	}

	if (result && result !== "stale") {
		await log("warn", `Failed to auto-clean tmux pane ${paneLocation.paneID} for ${sessionID}`)
	} else if (!result) {
		await log("warn", `Locked auto-cleanup returned no result for ${sessionID}`)
	}

	return false
}

async function schedulePaneCleanup(options: {
	sessionID: string
	log: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
}): Promise<void> {
	const { sessionID, log } = options
	const paneLocation = paneBySession.get(sessionID)
	if (!paneLocation) return

	const { localGeneration, sharedGeneration } = await withSpawnLock(sessionID, async () => ({
		localGeneration: cancelPaneCleanupTimer(sessionID),
		sharedGeneration: bumpSharedCleanupGeneration(sessionID),
	}))

	const timer = setTimeout(async () => {
		cleanupTimers.delete(sessionID)
		await delay(0)
		const shouldAbortCleanup = (): boolean =>
			!isCurrentCleanupGeneration(sessionID, localGeneration) ||
			readSharedCleanupGeneration(sessionID) !== sharedGeneration

		if (shouldAbortCleanup()) {
			return
		}

		const didKillPane = await autoCleanupKillPane({
			sessionID,
			paneLocation,
			sharedGeneration,
			log,
		})
		if (!didKillPane) {
			return
		}

		const didFinalize = await withSpawnLock(sessionID, async () => {
			if (shouldAbortCleanup()) return false

			paneBySession.delete(sessionID)
			spawnedSessions.delete(sessionID)
			clearSharedSpawnState(sessionID)
			clearSharedCleanupGeneration(sessionID)
			cleanupGenerations.delete(sessionID)
			return true
		})
		if (!didFinalize) return

		await log("info", `Auto-closed tmux pane ${paneLocation.paneID} for completed session ${sessionID}`)
	}, CLEANUP_DELAY_MS)

	timer.unref?.()
	cleanupTimers.set(sessionID, timer)
}

export const TmuxSubagentsPlugin: Plugin = async ({ client, directory, serverUrl: pluginServerUrl }) => {
	const resolvedServerUrl = resolveServerUrl(pluginServerUrl)
	const log = async (level: "debug" | "info" | "warn" | "error", message: string): Promise<void> => {
		await client.app.log({ body: { service: "tmux-subagents", level, message } }).catch(() => {})
	}

	return {
		"tool.execute.before": async (
			input: { tool: string; sessionID?: string },
			output: { args?: TaskToolArgs },
		) => {
			if (!isInsideTmux()) return
			if (input.tool !== "task") return
			if (!input.sessionID) return

			const agentName = output.args?.subagent_type
			if (!agentName) return

			const resumedSessionID = toNonEmptyString(output.args?.task_id)
			if (resumedSessionID && resumedSessionID !== input.sessionID) {
				try {
					await ensureSessionPane({
						sessionID: resumedSessionID,
						agentName,
						directory,
						tmuxTargetWindowID: resolveCurrentTmuxWindowID(),
						serverUrl: resolvedServerUrl,
						log,
					})
				} catch (error) {
					await log(
						"warn",
						`Failed to spawn tmux pane for resumed session ${resumedSessionID}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
				return
			}

			queueTask(input.sessionID, {
				agent: agentName,
			})
		},

		event: async ({ event }) => {
			if (!isInsideTmux()) return

			if (event.type === "session.idle") {
				const sessionID = (event.properties as { sessionID?: string }).sessionID
				if (sessionID) {
					await schedulePaneCleanup({ sessionID, log })
				}
				return
			}

			if (event.type === "session.deleted") {
				const sessionID = (event.properties as { info?: SessionInfo }).info?.id
				if (sessionID) {
					await withSpawnLock(sessionID, async () => {
						cancelPaneCleanupTimer(sessionID)
						clearSharedCleanupGeneration(sessionID)
					})
					const paneLocation = paneBySession.get(sessionID)
					if (paneLocation) {
						await killPane({
							sessionID,
							paneLocation,
							log,
							failurePrefix: "Failed to close tmux pane",
						})
					}
					paneBySession.delete(sessionID)
					spawnedSessions.delete(sessionID)
					clearSharedSpawnState(sessionID)
					clearSharedCleanupGeneration(sessionID)
					cleanupGenerations.delete(sessionID)
				}
				return
			}

			if (event.type !== "session.created") return

			const info = (event.properties as { info?: SessionInfo }).info
			if (!info?.id || !info.parentID) return

			const queuedTask = takeQueuedTask(info.parentID)
			if (!queuedTask) return

			try {
				await ensureSessionPane({
					sessionID: info.id,
					agentName: queuedTask.agent,
					directory,
					tmuxTargetWindowID: queuedTask?.tmuxWindowID,
					serverUrl: resolvedServerUrl,
					log,
				})
			} catch (error) {
				await log(
					"warn",
					`Failed to spawn tmux pane for child session ${info.id}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		},
	}
}

export default TmuxSubagentsPlugin
