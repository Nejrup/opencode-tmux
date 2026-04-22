import { createHash } from "node:crypto"
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
const PENDING_SPAWN_GRACE_MS = 5_000
const CLEANUP_DELAY_MS = 4_000
const FRESH_PANE_IDLE_GUARD_MS = 5_000
const PROCESS_TERMINATION_GRACE_MS = 1_000
const SPAWN_LOCK_TIMEOUT_MS = 5_000
const TMUX_OPTION_PREFIX = "@opencode_subagent_"
const spawnedSessions = new Set<string>()
const pendingByParent = new Map<string, PendingTask[]>()
const paneBySession = new Map<string, PaneLocation>()
const paneActivatedAtBySession = new Map<string, number>()
const cleanupTimers = new Map<string, Timer>()
const cleanupGenerations = new Map<string, number>()
const localLockTails = new Map<string, { tail: Promise<void>; token: symbol }>()
const sessionLockTails = new Map<string, { tail: Promise<void>; token: symbol }>()

type Timer = ReturnType<typeof setTimeout>
type TaskToolArgs = Record<string, unknown> & {
	subagent_type?: string
	task_id?: string
}

function isInsideTmux(): boolean {
	return Boolean(process.env.TMUX)
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

function toSessionOptionKey(sessionID: string, windowID?: string): string {
	const sessionHash = createHash("sha256")
		.update(sessionID)
		.update("\0")
		.update(windowID ?? "")
		.digest("hex")
	return `${TMUX_OPTION_PREFIX}${sessionHash}`
}

function toCleanupOptionKey(sessionID: string, windowID?: string): string {
	return `${toSessionOptionKey(sessionID, windowID)}_cleanup`
}

function toOwnerWindowOptionKey(sessionID: string): string {
	const sessionHash = createHash("sha256").update(sessionID).digest("hex")
	return `${TMUX_OPTION_PREFIX}owner_${sessionHash}`
}

function toWindowRegistryOptionKey(sessionID: string): string {
	const sessionHash = createHash("sha256").update(sessionID).digest("hex")
	return `${TMUX_OPTION_PREFIX}windows_${sessionHash}`
}

function toDeletedSessionOptionKey(sessionID: string): string {
	const sessionHash = createHash("sha256").update(sessionID).digest("hex")
	return `${TMUX_OPTION_PREFIX}deleted_${sessionHash}`
}

function toSpawnLockName(sessionID: string, windowID?: string): string {
	return `${TMUX_OPTION_PREFIX}lock_${toSessionOptionKey(sessionID, windowID).slice(TMUX_OPTION_PREFIX.length)}`
}

function toSessionLockName(sessionID: string): string {
	return `${TMUX_OPTION_PREFIX}session_${createHash("sha256").update(sessionID).digest("hex")}`
}

function readSessionOwnerWindowID(sessionID: string): string | undefined {
	const optionResult = Bun.spawnSync(["tmux", "show-options", "-gqv", toOwnerWindowOptionKey(sessionID)])
	if (optionResult.exitCode !== 0) return

	return toNonEmptyString(optionResult.stdout.toString())
}

function writeSessionOwnerWindowID(sessionID: string, windowID?: string): void {
	const optionKey = toOwnerWindowOptionKey(sessionID)
	if (!windowID) {
		Bun.spawnSync(["tmux", "set-option", "-gu", optionKey])
		return
	}

	Bun.spawnSync(["tmux", "set-option", "-gq", optionKey, windowID])
}

function clearSessionOwnerWindowID(sessionID: string): void {
	Bun.spawnSync(["tmux", "set-option", "-gu", toOwnerWindowOptionKey(sessionID)])
}

function readSessionDeleted(sessionID: string): boolean {
	const optionResult = Bun.spawnSync(["tmux", "show-options", "-gqv", toDeletedSessionOptionKey(sessionID)])
	if (optionResult.exitCode !== 0) return false
	return Boolean(toNonEmptyString(optionResult.stdout.toString()))
}

function writeSessionDeleted(sessionID: string, deleted: boolean): void {
	const optionKey = toDeletedSessionOptionKey(sessionID)
	if (!deleted) {
		Bun.spawnSync(["tmux", "set-option", "-gu", optionKey])
		return
	}

	Bun.spawnSync(["tmux", "set-option", "-gq", optionKey, "1"])
}

function readSessionWindowIDs(sessionID: string): string[] {
	const optionResult = Bun.spawnSync(["tmux", "show-options", "-gqv", toWindowRegistryOptionKey(sessionID)])
	if (optionResult.exitCode !== 0) return []

	const rawValue = toNonEmptyString(optionResult.stdout.toString())
	if (!rawValue) return []

	return Array.from(new Set(rawValue.split("\t").map((value) => value.trim()).filter(Boolean)))
}

function writeSessionWindowIDs(sessionID: string, windowIDs: string[]): void {
	const optionKey = toWindowRegistryOptionKey(sessionID)
	if (windowIDs.length === 0) {
		Bun.spawnSync(["tmux", "set-option", "-gu", optionKey])
		return
	}

	Bun.spawnSync(["tmux", "set-option", "-gq", optionKey, windowIDs.join("\t")])
}

function addSessionWindowID(sessionID: string, windowID?: string): void {
	if (!windowID) return
	const windowIDs = readSessionWindowIDs(sessionID)
	if (windowIDs.includes(windowID)) return
	windowIDs.push(windowID)
	writeSessionWindowIDs(sessionID, windowIDs)
}

function removeSessionWindowID(sessionID: string, windowID?: string): void {
	if (!windowID) return
	const windowIDs = readSessionWindowIDs(sessionID).filter((value) => value !== windowID)
	writeSessionWindowIDs(sessionID, windowIDs)
	if (readSessionOwnerWindowID(sessionID) === windowID) {
		writeSessionOwnerWindowID(sessionID, windowIDs[0])
	}
}

function readSharedSpawnState(sessionID: string, windowID?: string): SharedSpawnState | undefined {
	const optionKey = toSessionOptionKey(sessionID, windowID)
	const optionResult = Bun.spawnSync(["tmux", "show-options", "-gqv", optionKey])
	if (optionResult.exitCode !== 0) return

	const rawValue = toNonEmptyString(optionResult.stdout.toString())
	if (!rawValue) return

	const [kind, ...parts] = rawValue.split("\t")
	if (kind === "pending") {
		const createdAt = toPositiveInteger(parts[0])
		if (!createdAt) {
			clearSharedSpawnState(sessionID, windowID)
			return
		}

		if (createdAt < Date.now() - TASK_TTL_MS) {
			clearSharedSpawnState(sessionID, windowID)
			return
		}

		return { kind, createdAt }
	}

	if (kind !== "live") {
		clearSharedSpawnState(sessionID, windowID)
		return
	}

	const [paneID, paneWindowID, panePIDValue] = parts
	if (!paneID || !paneWindowID) {
		clearSharedSpawnState(sessionID, windowID)
		return
	}

	const paneLocation: PaneLocation = {
		paneID,
		windowID: paneWindowID,
		panePID: toPositiveInteger(panePIDValue),
	}
	if (!isPaneLive(paneLocation)) {
		clearSharedSpawnState(sessionID, windowID)
		return
	}

	return { kind, ...paneLocation }
}

function writeSharedSpawnState(sessionID: string, state: SharedSpawnState, windowID?: string): void {
	const optionKey = toSessionOptionKey(sessionID, windowID)
	const optionValue =
		state.kind === "pending"
			? `${state.kind}\t${state.createdAt}`
			: `${state.kind}\t${state.paneID}\t${state.windowID}\t${state.panePID ?? ""}`

	Bun.spawnSync(["tmux", "set-option", "-gq", optionKey, optionValue])
	if (state.kind === "live") {
		writeSessionOwnerWindowID(sessionID, windowID)
	}
}

function clearSharedSpawnState(sessionID: string, windowID?: string): void {
	const optionKey = toSessionOptionKey(sessionID, windowID)
	Bun.spawnSync(["tmux", "set-option", "-gu", optionKey])
}

function readSharedCleanupGeneration(sessionID: string, windowID?: string): number {
	const optionKey = toCleanupOptionKey(sessionID, windowID)
	const optionResult = Bun.spawnSync(["tmux", "show-options", "-gqv", optionKey])
	if (optionResult.exitCode !== 0) return 0

	return toPositiveInteger(optionResult.stdout.toString()) ?? 0
}

function bumpSharedCleanupGeneration(sessionID: string, windowID?: string): number {
	const optionKey = toCleanupOptionKey(sessionID, windowID)
	const nextGeneration = readSharedCleanupGeneration(sessionID, windowID) + 1
	Bun.spawnSync(["tmux", "set-option", "-gq", optionKey, String(nextGeneration)])
	return nextGeneration
}

function clearSharedCleanupGeneration(sessionID: string, windowID?: string): void {
	const optionKey = toCleanupOptionKey(sessionID, windowID)
	Bun.spawnSync(["tmux", "set-option", "-gu", optionKey])
}

async function acquireTmuxLock(lockName: string, timeoutMilliseconds: number): Promise<boolean> {
	const waitProcess = Bun.spawn(["tmux", "wait-for", "-L", lockName], {
		stdout: "ignore",
		stderr: "ignore",
	})

	const timeout = setTimeout(() => {
		waitProcess.kill()
	}, timeoutMilliseconds)

	try {
		return (await waitProcess.exited) === 0
	} finally {
		clearTimeout(timeout)
	}
}

async function withSessionLock<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
	const previousTail = sessionLockTails.get(sessionID)?.tail ?? Promise.resolve()
	let releaseLocalLock = () => {}
	const nextTail = new Promise<void>((resolve) => {
		releaseLocalLock = resolve
	})
	const lockToken = Symbol(sessionID)
	sessionLockTails.set(sessionID, { tail: previousTail.then(() => nextTail), token: lockToken })

	await previousTail
	const lockName = toSessionLockName(sessionID)
	const didAcquireLock = await acquireTmuxLock(lockName, SPAWN_LOCK_TIMEOUT_MS)
	if (!didAcquireLock) {
		releaseLocalLock()
		if (sessionLockTails.get(sessionID)?.token === lockToken) {
			sessionLockTails.delete(sessionID)
		}
		throw new Error(`Timed out waiting for tmux session lock for session ${sessionID}`)
	}

	try {
		return await action()
	} finally {
		Bun.spawnSync(["tmux", "wait-for", "-U", lockName])
		releaseLocalLock()
		if (sessionLockTails.get(sessionID)?.token === lockToken) {
			sessionLockTails.delete(sessionID)
		}
	}
}

async function registerSessionWindowID(sessionID: string, windowID?: string): Promise<void> {
	if (!windowID) return
	await withSessionLock(sessionID, async () => {
		addSessionWindowID(sessionID, windowID)
	})
}

async function unregisterSessionWindowID(sessionID: string, windowID?: string): Promise<void> {
	if (!windowID) return
	await withSessionLock(sessionID, async () => {
		removeSessionWindowID(sessionID, windowID)
	})
}

async function withSpawnLock<T>(sessionID: string, windowID: string | undefined, action: () => Promise<T>): Promise<T> {
	const previousTail = localLockTails.get(sessionID)?.tail ?? Promise.resolve()
	let releaseLocalLock = () => {}
	const nextTail = new Promise<void>((resolve) => {
		releaseLocalLock = resolve
	})
	const lockToken = Symbol(sessionID)
	localLockTails.set(sessionID, { tail: previousTail.then(() => nextTail), token: lockToken })

	await previousTail
	const lockName = toSpawnLockName(sessionID, windowID)
	const didAcquireLock = await acquireTmuxLock(lockName, SPAWN_LOCK_TIMEOUT_MS)
	if (!didAcquireLock) {
		releaseLocalLock()
		if (localLockTails.get(sessionID)?.token === lockToken) {
			localLockTails.delete(sessionID)
		}
		throw new Error(`Timed out waiting for tmux pane lock for session ${sessionID}`)
	}

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

function getLiveTrackedPane(sessionID: string, windowID?: string): PaneLocation | undefined {
	const paneLocation = paneBySession.get(sessionID)
	if (!paneLocation) return
	if (windowID && paneLocation.windowID !== windowID) return
	if (isPaneLive(paneLocation)) return paneLocation

	paneBySession.delete(sessionID)
	paneActivatedAtBySession.delete(sessionID)
	spawnedSessions.delete(sessionID)
	return
}

function getFreshPaneIdleGuardRemainingMilliseconds(sessionID: string): number {
	const activatedAt = paneActivatedAtBySession.get(sessionID)
	if (!activatedAt) return 0
	return Math.max(0, activatedAt + FRESH_PANE_IDLE_GUARD_MS - Date.now())
}

function getManagedPane(sessionID: string, windowID?: string): PaneLocation | undefined {
	const liveTrackedPane = getLiveTrackedPane(sessionID, windowID)
	if (liveTrackedPane) return liveTrackedPane

	const sharedState = readSharedSpawnState(sessionID, windowID)
	if (sharedState?.kind !== "live") return

	paneBySession.set(sessionID, sharedState)
	spawnedSessions.add(sessionID)
	return sharedState
}

function resolveCleanupWindowID(sessionID: string, fallbackWindowID?: string): string | undefined {
	return readSessionOwnerWindowID(sessionID) ?? fallbackWindowID
}

function resolveCleanupWindowIDs(sessionID: string, fallbackWindowID?: string): string[] {
	const windowIDs = readSessionWindowIDs(sessionID)
	const ownerWindowID = readSessionOwnerWindowID(sessionID)
	if (ownerWindowID && !windowIDs.includes(ownerWindowID)) {
		windowIDs.unshift(ownerWindowID)
	}
	if (windowIDs.length > 0) {
		return Array.from(new Set(windowIDs))
	}

	return fallbackWindowID ? [fallbackWindowID] : []
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
	const tmuxEnvArgs = Object.entries(envVars)
		.filter((entry): entry is [string, string] => Boolean(entry[1]))
		.flatMap(([key, value]) => ["-e", `${key}=${value}`])

	const command = [
		opencodeBin,
		"attach",
		serverUrl,
		"--dir",
		cwd,
		"--session",
		sessionID,
	]

	const splitResult = Bun.spawnSync([
		"tmux",
		"split-window",
		"-d",
		splitTarget.direction,
		...(splitTarget.target ? ["-t", splitTarget.target] : []),
		...tmuxEnvArgs,
		"-c",
		cwd,
		"-P",
		"-F",
		"#{pane_id} #{window_id} #{pane_pid}",
		"--",
		...command,
	])

	if (splitResult.exitCode !== 0) {
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
}): Promise<PaneLocation> {
	const { sessionID, agentName, directory, tmuxTargetWindowID, serverUrl, log } = options
	const paneLabel = sanitizeLabel(agentName)
	const opencodeBin = process.env.OPENCODE_BIN || Bun.which("opencode") || "opencode"
	return spawnTmuxPane({
		cwd: directory,
		sessionID,
		paneLabel,
		tmuxTargetWindowID,
		opencodeBin,
		serverUrl,
		log,
	})
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
	const windowID = tmuxTargetWindowID ?? resolveCurrentTmuxWindowID()
	type PaneDecision =
		| { kind: "done" }
		| { kind: "retry"; delayMilliseconds: number }
		| { kind: "spawn"; cleanupGeneration: number }

	let paneDecision: PaneDecision
	while (true) {
		paneDecision = await withSpawnLock(sessionID, windowID, async () => {
			if (readSessionDeleted(sessionID)) {
				return { kind: "done" }
			}

			cancelPaneCleanupTimer(sessionID)
			const cleanupGeneration = bumpSharedCleanupGeneration(sessionID, windowID)

			const liveTrackedPane = getLiveTrackedPane(sessionID, windowID)
			if (liveTrackedPane) {
				writeSharedSpawnState(sessionID, { kind: "live", ...liveTrackedPane }, windowID)
				return { kind: "done" }
			}

			const sharedState = readSharedSpawnState(sessionID, windowID)
			if (sharedState?.kind === "live") {
				paneBySession.set(sessionID, sharedState)
				spawnedSessions.add(sessionID)
				return { kind: "done" }
			}

			if (sharedState?.kind === "pending") {
				const delayMilliseconds = sharedState.createdAt + PENDING_SPAWN_GRACE_MS - Date.now()
				if (delayMilliseconds > 0) {
					spawnedSessions.add(sessionID)
					return { kind: "retry", delayMilliseconds }
				}

				spawnedSessions.delete(sessionID)
				clearSharedSpawnState(sessionID, windowID)
				await unregisterSessionWindowID(sessionID, windowID)
			}

			spawnedSessions.add(sessionID)
			await registerSessionWindowID(sessionID, windowID)
			writeSharedSpawnState(sessionID, { kind: "pending", createdAt: Date.now() }, windowID)
			return { kind: "spawn", cleanupGeneration }
		})

		if (paneDecision.kind !== "retry") break
		await delay(paneDecision.delayMilliseconds)
	}

	if (paneDecision.kind === "done") return

	try {
		const paneLocation = await openPaneForSession({
			sessionID,
			agentName,
			directory,
			tmuxTargetWindowID,
			serverUrl,
			log,
		})

		let shouldKeepPane = false
		await withSpawnLock(sessionID, windowID, async () => {
			if (readSessionDeleted(sessionID)) {
				spawnedSessions.delete(sessionID)
				clearSharedSpawnState(sessionID, windowID)
				await unregisterSessionWindowID(sessionID, windowID)
				return
			}

			const cleanupGeneration = readSharedCleanupGeneration(sessionID, windowID)
			const sharedState = readSharedSpawnState(sessionID, windowID)

			if (
				cleanupGeneration !== paneDecision.cleanupGeneration ||
				(sharedState?.kind === "live" && sharedState.paneID !== paneLocation.paneID)
			) {
				spawnedSessions.delete(sessionID)
				if (sharedState?.kind === "pending") {
					clearSharedSpawnState(sessionID, windowID)
					await unregisterSessionWindowID(sessionID, windowID)
				}
				return
			}

			paneBySession.set(sessionID, paneLocation)
			paneActivatedAtBySession.set(sessionID, Date.now())
			await registerSessionWindowID(sessionID, windowID)
			writeSharedSpawnState(sessionID, { kind: "live", ...paneLocation }, windowID)
			shouldKeepPane = true
		})

		if (!shouldKeepPane) {
			await killPane({
				sessionID,
				paneLocation,
				log,
				failurePrefix: "Failed to close canceled tmux pane",
			})
		}
	} catch (error) {
		await withSpawnLock(sessionID, windowID, async () => {
			spawnedSessions.delete(sessionID)
			clearSharedSpawnState(sessionID, windowID)
			await unregisterSessionWindowID(sessionID, windowID)
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
	gracefulTerminate?: boolean
}): Promise<boolean> {
	const {
		sessionID,
		paneLocation,
		log,
		failurePrefix,
		shouldAbort,
		gracefulTerminate = true,
	} = options
	if (shouldAbort?.()) return false
	if (!isPaneLive(paneLocation)) return true

	const panePID = gracefulTerminate ? resolvePanePID(paneLocation) : undefined
	if (panePID) {
		if (shouldAbort?.()) return false
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

async function autoCleanupKillPane(options: {
	sessionID: string
	paneLocation: PaneLocation
	sharedGeneration: number
	windowID?: string
	log: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
}): Promise<boolean> {
	const { sessionID, paneLocation, sharedGeneration, windowID, log } = options
	const shouldAbort = (): boolean => readSharedCleanupGeneration(sessionID, windowID) !== sharedGeneration

	return killPane({
		sessionID,
		paneLocation,
		log,
		failurePrefix: "Failed to auto-clean tmux pane",
		shouldAbort,
		gracefulTerminate: false,
	})
}

async function schedulePaneCleanup(options: {
	sessionID: string
	log: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
}): Promise<void> {
	const { sessionID, log } = options
	const windowIDs = resolveCleanupWindowIDs(sessionID, resolveCurrentTmuxWindowID())
	if (windowIDs.length === 0) return

	const localGeneration = cancelPaneCleanupTimer(sessionID)
	const panesByWindow = new Map<string, PaneLocation>()
	const generationsByWindow = new Map<string, number>()
	for (const windowID of windowIDs) {
		const paneLocation = getManagedPane(sessionID, windowID)
		if (!paneLocation) continue

		panesByWindow.set(windowID, paneLocation)

		const sharedGeneration = await withSpawnLock(sessionID, windowID, async () =>
			bumpSharedCleanupGeneration(sessionID, windowID),
		)
		generationsByWindow.set(windowID, sharedGeneration)
	}
	if (panesByWindow.size === 0) return

	const timer = setTimeout(async () => {
		cleanupTimers.delete(sessionID)
		await delay(0)
		const shouldAbortCleanup = (windowID: string): boolean =>
			!isCurrentCleanupGeneration(sessionID, localGeneration) ||
			readSharedCleanupGeneration(sessionID, windowID) !== generationsByWindow.get(windowID)

		if (!isCurrentCleanupGeneration(sessionID, localGeneration)) {
			return
		}

		const cleanedPaneIDs: string[] = []
		for (const [windowID, paneLocation] of panesByWindow) {
			if (shouldAbortCleanup(windowID)) continue

			const didKillPane = await autoCleanupKillPane({
				sessionID,
				paneLocation,
				sharedGeneration: generationsByWindow.get(windowID) ?? 0,
				windowID,
				log,
			})
			if (!didKillPane) {
				continue
			}

			const didFinalize = await withSpawnLock(sessionID, windowID, async () => {
				if (shouldAbortCleanup(windowID)) return false

				clearSharedSpawnState(sessionID, windowID)
				await unregisterSessionWindowID(sessionID, windowID)
				clearSharedCleanupGeneration(sessionID, windowID)
				return true
			})
			if (didFinalize) {
				cleanedPaneIDs.push(paneLocation.paneID)
			}
		}

		if (cleanedPaneIDs.length === 0) return

		paneBySession.delete(sessionID)
		paneActivatedAtBySession.delete(sessionID)
		spawnedSessions.delete(sessionID)
		clearSessionOwnerWindowID(sessionID)
		cleanupGenerations.delete(sessionID)
		await log("info", `Auto-closed tmux pane(s) ${cleanedPaneIDs.join(", ")} for completed session ${sessionID}`)
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
				const freshPaneIdleGuardRemainingMilliseconds = getFreshPaneIdleGuardRemainingMilliseconds(sessionID)
				if (freshPaneIdleGuardRemainingMilliseconds > 0) {
					cancelPaneCleanupTimer(sessionID)
					const timer = setTimeout(() => {
						cleanupTimers.delete(sessionID)
						void schedulePaneCleanup({ sessionID, log }).catch(async (error) => {
							await log(
								"warn",
								`Failed to schedule deferred tmux pane cleanup for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
							)
						})
					}, freshPaneIdleGuardRemainingMilliseconds)

					timer.unref?.()
					cleanupTimers.set(sessionID, timer)
					await log(
						"debug",
						`Deferred idle cleanup for freshly opened pane in session ${sessionID} by ${freshPaneIdleGuardRemainingMilliseconds}ms`,
					)
					return
				}

				try {
					await schedulePaneCleanup({ sessionID, log })
				} catch (error) {
					await log(
						"warn",
						`Failed to schedule tmux pane cleanup for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}
			return
		}

		if (event.type === "session.deleted") {
			const sessionID = (event.properties as { info?: SessionInfo }).info?.id
			if (sessionID) {
				try {
					const windowIDs = await withSessionLock(sessionID, async () => {
						writeSessionDeleted(sessionID, true)
						return resolveCleanupWindowIDs(sessionID, resolveCurrentTmuxWindowID())
					})
					cancelPaneCleanupTimer(sessionID)
					for (const windowID of windowIDs) {
						await withSpawnLock(sessionID, windowID, async () => {
							clearSharedCleanupGeneration(sessionID, windowID)
						})
						const paneLocation = getManagedPane(sessionID, windowID)
						if (paneLocation) {
							const didKillPane = await killPane({
								sessionID,
								paneLocation,
								log,
								failurePrefix: "Failed to close tmux pane",
							})
							if (!didKillPane) {
								return
							}
						}
						clearSharedSpawnState(sessionID, windowID)
						await unregisterSessionWindowID(sessionID, windowID)
						clearSharedCleanupGeneration(sessionID, windowID)
					}
					paneBySession.delete(sessionID)
					paneActivatedAtBySession.delete(sessionID)
					spawnedSessions.delete(sessionID)
					clearSessionOwnerWindowID(sessionID)
					cleanupGenerations.delete(sessionID)
				} catch (error) {
					await log(
						"warn",
						`Failed to close tmux pane for deleted session ${sessionID}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
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
