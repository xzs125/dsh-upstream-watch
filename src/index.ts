/**
 * dsh-upstream-watch — host half.
 *
 * On DSH startup, checks the upstream `deepseek-ai/deepseek-harness` repo for
 * updates and reminds the user (startup log + sidebar badge via the client
 * half). Detection is dual-channel: the local git clone first (most accurate:
 * HEAD vs origin/master + tag comparison), the GitHub API as fallback.
 *
 * Reminder semantics:
 * - "存在更新" (has updates) is computed objectively against the local state
 *   (a new tag stronger than the local version → strong; only new master
 *   commits → info). The client badge shows this.
 * - The log reminder is de-duplicated: only a state that was not yet notified
 *   (lastNotified*) triggers a WARN/INFO line.
 * - A failed check reports an ERROR log and an error badge (per requirement).
 * - Everything is persisted to a state file so restarts are silent when the
 *   local checkout is already up to date.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'upstream-watch'

/** The web server seam this plugin registers a route into. */
export const inject = ['webServer']

/** Plugin config. */
export interface Config {
  /** DSH source checkout dir (must contain .git). Auto-detected when omitted. */
  sourceDir?: string
  /** Upstream repo URL used for git remote + GitHub API fallback. */
  repoUrl?: string
  /** Absolute path of the persisted reminder state file. */
  stateFile?: string
  /** Timeout (ms) for each git/API operation. */
  timeoutMs?: number
  /** Optional HTTP(S) proxy for git fetch/ls-remote (e.g. http://127.0.0.1:7897). Empty = no override. */
  gitProxy?: string
  /** Optional GitHub token to raise API rate limits (falls back to GITHUB_TOKEN env). */
  githubToken?: string
  /** Delay (ms) before the very first check; avoids the boot network race. 0 = run immediately. */
  initialDelayMs?: number
  /** Backoff sequence (ms) used while checks keep failing; the last entry repeats. */
  retryBackoffMs?: number[]
  /** Re-check interval (ms) after a successful check. 0 = check once, never again. */
  intervalMs?: number
}

export const Config = z.object({
  sourceDir: z.string(),
  repoUrl: z.string().default('https://github.com/deepseek-ai/deepseek-harness'),
  stateFile: z.string(),
  timeoutMs: z.number().default(20000),
  gitProxy: z.string().default(''),
  githubToken: z.string().default(''),
  initialDelayMs: z.number().default(8000),
  retryBackoffMs: z.array(z.number()).default([15000, 30000, 60000, 120000, 300000]),
  intervalMs: z.number().default(21600000),
})

/** Config with defaults resolved (apply-time normalization). */
interface NormalizedConfig {
  sourceDir?: string
  repoUrl: string
  stateFile?: string
  timeoutMs: number
  gitProxy?: string
  githubToken?: string
  initialDelayMs: number
  retryBackoffMs: number[]
  intervalMs: number
}

/** Logging shape consumed from the Cordis context. */
type Logger = { debug: (...a: unknown[]) => void; info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }

type WebRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface WebServer {
  register(route: { kind: 'exact'; path: string; handler: WebRouteHandler }): () => void
}
type WebContext = Context & { webServer: WebServer }

/** Status served to the client badge + persisted. */
export type UpstreamStatus = 'pending' | 'ok' | 'info' | 'strong' | 'error'

export interface RecentCommit {
  sha: string
  title: string
}

export interface UpstreamState {
  status?: UpstreamStatus
  checkedAt?: string
  /** Local git HEAD (null when no git available). */
  localHead?: string | null
  /** Local version tag, e.g. `dsh-v0.1.0-rc.7` (null when unknown). */
  localVersion?: string | null
  /** Upstream master HEAD sha. */
  upstreamMasterSha?: string | null
  /** Newest upstream `dsh-v*` tag. */
  upstreamLatestTag?: string | null
  /** Commits ahead of local HEAD (null when not computable). */
  aheadCount?: number | null
  recentCommits?: RecentCommit[]
  compareUrl?: string | null
  error?: string | null
  /** De-dup bookmarks: the last upstream state that already triggered a reminder. */
  lastNotifiedTag?: string | null
  lastNotifiedMasterSha?: string | null
  /** true = the last check failed and an automatic retry is scheduled. */
  retrying?: boolean
  /** Consecutive failed checks (0 = the last check succeeded). */
  consecutiveFailures?: number
  /** When the next automatic check is planned (ISO), null when none is scheduled. */
  nextCheckAt?: string | null
}

interface CheckResult {
  localHead?: string | null
  localVersion?: string | null
  upstreamMasterSha?: string | null
  upstreamLatestTag?: string | null
  aheadCount?: number | null
  recentCommits?: RecentCommit[]
  compareUrl?: string | null
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

const execFileAsync = promisify(execFile)

async function gitRun(sourceDir: string, args: string[], timeoutMs: number, gitProxy?: string): Promise<string> {
  // Override the (possibly stale global) proxy for network git commands without
  // touching ~/.gitconfig: `git -c http.proxy=... -c https.proxy=... <cmd>`.
  const proxyArgs = gitProxy
    ? ['-c', `http.proxy=${gitProxy}`, '-c', `https.proxy=${gitProxy}`]
    : []
  const { stdout } = await execFileAsync('git', [...proxyArgs, ...args], {
    cwd: sourceDir,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  })
  return String(stdout).trim()
}

/** Parse `dsh-v0.1.5-alpha.1` → [0,1,5,0,1]; `dsh-v0.1.2-rc.1` → [0,1,2,1,1]; `dsh-v0.1.0` → [0,1,0,2,Infinity]. kind: 0=alpha, 1=rc, 2=release. */
function parseVersion(tag: string): number[] | null {
  const m = tag.match(/^dsh-v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|rc)\.(\d+))?$/i)
  if (!m) return null
  const kind = m[4] ? (m[4].toLowerCase() === 'alpha' ? 0 : 1) : 2
  const num = m[5] != null ? Number(m[5]) : Infinity
  return [Number(m[1]), Number(m[2]), Number(m[3]), kind, num]
}

/** Compare parsed versions (fixed 5-element arrays: major/minor/patch/kind/num). */
function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 5; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av > bv ? 1 : -1
  }
  return 0
}

/** Newest `dsh-v*` tag among raw tag refs/names. */
function maxDshTag(tags: string[]): string | null {
  let best: string | null = null
  let bestVer: number[] | null = null
  for (const raw of tags) {
    const name = raw.replace(/^refs\/tags\//, '')
    const ver = parseVersion(name)
    if (!ver) continue
    if (!bestVer || compareVersion(ver, bestVer) > 0) {
      best = name
      bestVer = ver
    }
  }
  return best
}

function resolveSourceDir(config: Config): string | null {
  if (config.sourceDir && existsSync(join(config.sourceDir, '.git'))) return config.sourceDir
  if (process.env.DSH_CHECKOUT && existsSync(join(process.env.DSH_CHECKOUT, '.git'))) {
    return process.env.DSH_CHECKOUT
  }
  const candidates = process.platform === 'win32'
    ? ['E:\\Deepseek Harness', 'C:\\Deepseek Harness']
    : ['/root/.local/share/dsh-source-3082/current', '/root/deepseek-harness', '/root/.dsh/dsh-harness']
  for (const c of candidates) {
    if (existsSync(join(c, '.git'))) return c
  }
  return null
}

function resolveStateFile(config: Config): string {
  if (config.stateFile) return config.stateFile
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'upstream-watch.json')
  return join(homedir(), '.dsh', 'upstream-watch.json')
}

function loadState(path: string): UpstreamState {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as UpstreamState
  } catch {
    return {}
  }
}

function saveState(path: string, state: UpstreamState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
  } catch (error) {
    console.error('[upstream-watch] failed to persist state:', error)
  }
}

/* ------------------------------------------------------------------ */
/* detection channels                                                  */
/* ------------------------------------------------------------------ */

/** Primary channel: the local git clone (most accurate). */
async function checkViaGit(sourceDir: string, repoUrl: string, timeoutMs: number, gitProxy?: string): Promise<CheckResult> {
  // Fetch remote refs + tags. Only touches .git (FETCH_HEAD / remote-tracking
  // refs / objects); never touches the worktree.
  await gitRun(sourceDir, ['fetch', 'origin', '--tags', '--quiet', '--prune'], timeoutMs, gitProxy)

  const localHead = await gitRun(sourceDir, ['rev-parse', 'HEAD'], timeoutMs, gitProxy)
  const upstreamMasterSha = await gitRun(sourceDir, ['rev-parse', 'origin/master'], timeoutMs, gitProxy)
  const ahead = await gitRun(sourceDir, ['rev-list', '--count', 'HEAD..origin/master'], timeoutMs, gitProxy)
  const aheadCount = Number(ahead)

  // Local version: newest reachable tag.
  const localVersion = await gitRun(sourceDir, ['describe', '--tags', '--abbrev=0'], timeoutMs, gitProxy).catch(() => '')

  // Remote tags (authoritative, read-only).
  const tagsOut = await gitRun(sourceDir, ['ls-remote', '--tags', 'origin'], timeoutMs, gitProxy)
  const tags = tagsOut.split('\n').filter(Boolean).map((line) => line.split('\t')[1] ?? '')

  // Recent upstream commit titles.
  const logOut = await gitRun(sourceDir, ['log', 'origin/master', '--oneline', '-5'], timeoutMs, gitProxy)
  const recentCommits = logOut.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^(\S+)\s+(.*)$/)
    return { sha: m?.[1] ?? line, title: m?.[2] ?? '' }
  })

  return {
    localHead,
    localVersion: localVersion || null,
    upstreamMasterSha,
    upstreamLatestTag: maxDshTag(tags),
    aheadCount,
    recentCommits,
    compareUrl: `https://github.com/deepseek-ai/deepseek-harness/compare/${localHead}...master`,
  }
}

async function githubFetch(url: string, timeoutMs: number, githubToken?: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-upstream-watch',
    }
    if (githubToken) headers.authorization = `Bearer ${githubToken}`
    return await fetch(url, {
      signal: controller.signal,
      headers,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Fallback channel: GitHub API (no local git needed). */
async function checkViaApi(repoUrl: string, timeoutMs: number, githubToken?: string): Promise<CheckResult> {
  const repoPath = repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  const base = `https://api.github.com/repos/${repoPath}`

  const [commitsRes, tagsRes] = await Promise.all([
    githubFetch(`${base}/commits?sha=master&per_page=5`, timeoutMs, githubToken),
    githubFetch(`${base}/tags?per_page=100`, timeoutMs, githubToken),
  ])
  if (!commitsRes.ok || !tagsRes.ok) {
    throw new Error(`GitHub API ${commitsRes.status}/${tagsRes.status}`)
  }
  const commits = await commitsRes.json() as unknown
  const tags = await tagsRes.json() as unknown
  // Defensive: GitHub may return an error object (e.g. rate-limit) instead of
  // the expected arrays; surface a clear error instead of a confusing TypeError.
  if (!Array.isArray(commits) || !Array.isArray(tags)) {
    throw new Error('GitHub API 返回了意外的响应（可能被限流或接口变更）')
  }
  const commitList = commits as Array<{ sha: string; commit: { message: string } }>
  const tagList = tags as Array<{ name: string }>

  const upstreamMasterSha = commitList[0]?.sha ?? null
  const recentCommits = commitList.slice(0, 5).map((c) => ({
    sha: c.sha,
    title: c.commit.message.split('\n')[0],
  }))

  return {
    upstreamMasterSha,
    upstreamLatestTag: maxDshTag(tagList.map((t) => t.name)),
    recentCommits,
    compareUrl: `https://github.com/${repoPath}/compare/master`,
  }
}

/** Compute commits-ahead via the GitHub compare API when we know local HEAD. */
async function apiAheadCount(repoUrl: string, localHead: string, timeoutMs: number, githubToken?: string): Promise<number | null> {
  try {
    const repoPath = repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
    const res = await githubFetch(`https://api.github.com/repos/${repoPath}/compare/${localHead}...master`, timeoutMs, githubToken)
    if (!res.ok) return null
    const data = await res.json() as { ahead_by?: number }
    return typeof data.ahead_by === 'number' ? data.ahead_by : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* main check                                                          */
/* ------------------------------------------------------------------ */

async function runCheck(config: NormalizedConfig, stateFile: string, logger: Logger): Promise<UpstreamState> {
  const prev = loadState(stateFile)
  const checkedAt = new Date().toISOString()
  const sourceDir = resolveSourceDir(config)

  let result: CheckResult = {}
  let error: string | null = null
  let gitErrorText: string | null = null

  // Channel 1: local git clone.
  if (sourceDir) {
    try {
      result = await checkViaGit(sourceDir, config.repoUrl, config.timeoutMs, config.gitProxy)
    } catch (gitError) {
      gitErrorText = String((gitError as Error)?.message ?? gitError)
      logger.debug(`[upstream-watch] git channel failed, falling back to API: ` + gitErrorText)
    }
  }

  // Channel 2: GitHub API (also fills in ahead count when local HEAD known).
  if (!result.upstreamMasterSha) {
    try {
      result = { ...result, ...(await checkViaApi(config.repoUrl, config.timeoutMs, config.githubToken)) }
      if (sourceDir && !result.localHead) {
        try {
          result.localHead = await gitRun(sourceDir, ['rev-parse', 'HEAD'], config.timeoutMs, config.gitProxy)
        } catch { /* read-only best effort */ }
      }
      if (result.localHead && result.upstreamMasterSha) {
        result.aheadCount = await apiAheadCount(config.repoUrl, result.localHead, config.timeoutMs, config.githubToken)
      }
    } catch (apiError) {
      const apiText = String((apiError as Error)?.message ?? apiError)
      // Persist BOTH channel failures: a bare "fetch failed" hid the git-side
      // reason and the previous investigation had to guess at the cause.
      error = gitErrorText ? 'git: ' + gitErrorText + '; api: ' + apiText : apiText
    }
  }

  // ---- Objective "has updates" ----
  let hasNewTag = false
  let hasNewCommits = false

  if (result.upstreamLatestTag) {
    const localVersion = result.localVersion ?? prev.localVersion ?? null
    if (localVersion) {
      const lv = parseVersion(localVersion)
      const uv = parseVersion(result.upstreamLatestTag)
      hasNewTag = !!(lv && uv && compareVersion(uv, lv) > 0)
    } else {
      // No local version known: treat a changed latest tag as new.
      hasNewTag = !!prev.upstreamLatestTag && result.upstreamLatestTag !== prev.upstreamLatestTag
    }
  }

  if (result.aheadCount != null) {
    hasNewCommits = result.aheadCount > 0
  } else if (result.upstreamMasterSha) {
    hasNewCommits = !!prev.upstreamMasterSha && result.upstreamMasterSha !== prev.upstreamMasterSha
  }

  const status: UpstreamStatus = error
    ? 'error'
    : hasNewTag
      ? 'strong'
      : hasNewCommits
        ? 'info'
        : 'ok'

  // ---- Notify (de-duplicated) ----
  const notifyNewTag = hasNewTag && result.upstreamLatestTag !== prev.lastNotifiedTag
  const notifyNewMaster = hasNewCommits && result.upstreamMasterSha !== prev.lastNotifiedMasterSha

  if (status === 'error') {
    logger.error(`[upstream-watch] 上游更新检查失败：${error}`)
  } else if (notifyNewTag) {
    const latest = result.upstreamLatestTag ?? '?'
    const current = result.localVersion ?? prev.localVersion ?? '未知'
    const ahead = result.aheadCount ?? 0
    logger.warn(
      `[upstream-watch] 上游有新版本 ${latest}（当前 ${current}，领先 ${ahead} 个提交）。` +
      `详情：${result.recentCommits?.map((c) => `${c.sha.slice(0, 7)} ${c.title}`).join('；') ?? ''} ` +
      `对比：${result.compareUrl ?? 'https://github.com/deepseek-ai/deepseek-harness'}`,
    )
  } else if (notifyNewMaster) {
    const ahead = result.aheadCount ?? 0
    logger.info(
      `[upstream-watch] 上游 master 领先本地 ${ahead} 个提交。` +
      `最近：${result.recentCommits?.map((c) => `${c.sha.slice(0, 7)} ${c.title}`).join('；') ?? ''} ` +
      `对比：${result.compareUrl ?? 'https://github.com/deepseek-ai/deepseek-harness'}`,
    )
  } else {
    logger.debug('[upstream-watch] 上游已是最新，静默。')
  }

  // ---- Persist ----
  const next: UpstreamState = {
    ...prev,
    status,
    checkedAt,
    localHead: result.localHead ?? prev.localHead ?? null,
    localVersion: result.localVersion ?? prev.localVersion ?? null,
    upstreamMasterSha: result.upstreamMasterSha ?? prev.upstreamMasterSha ?? null,
    upstreamLatestTag: result.upstreamLatestTag ?? prev.upstreamLatestTag ?? null,
    aheadCount: result.aheadCount ?? prev.aheadCount ?? null,
    recentCommits: result.recentCommits ?? prev.recentCommits ?? [],
    compareUrl: result.compareUrl ?? prev.compareUrl ?? null,
    error,
    lastNotifiedTag: notifyNewTag ? result.upstreamLatestTag : prev.lastNotifiedTag ?? null,
    lastNotifiedMasterSha: notifyNewMaster ? result.upstreamMasterSha : prev.lastNotifiedMasterSha ?? null,
  }
  saveState(stateFile, next)
  return next
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* logging + retry schedule                                            */
/* ------------------------------------------------------------------ */

/**
 * Logger that always mirrors info/warn/error to stdout/stderr. The cordis
 * logger this plugin used before swallowed every line - the journal held zero
 * upstream-watch entries, so a failed check left no trace to diagnose.
 */
function createJournalLogger(base?: Logger): Logger {
  return {
    debug: (...args) => { base?.debug?.(...args) },
    info: (...args) => { base?.info?.(...args); console.log(...args) },
    warn: (...args) => { base?.warn?.(...args); console.warn(...args) },
    error: (...args) => { base?.error?.(...args); console.error(...args) },
  }
}

/** Timer seam so the retry loop can be exercised without real time. */
export interface SchedulerTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface SchedulerOptions {
  /** Performs one check and returns the raw state. */
  run: () => Promise<UpstreamState>
  /** Delay before the very first check; avoids the boot network race. */
  initialDelayMs: number
  /** Backoff sequence after failures; the last entry repeats. */
  retryBackoffMs: number[]
  /** Re-check interval after a successful check; 0 disables periodic re-checks. */
  intervalMs: number
  /** Receives every enriched state (retry metadata merged in). */
  onState: (state: UpstreamState) => void
  /** Optional extra persistence of the enriched state. */
  persist?: (state: UpstreamState) => void
  logger: Logger
  /** Injectable timers (tests only). */
  timers?: SchedulerTimers
}

export interface Scheduler {
  /** Schedule the first check (never runs synchronously). */
  start: () => void
  /** Cancel any pending automatic check. */
  stop: () => void
  /** Run a check right now; concurrent callers share one run. */
  triggerNow: () => Promise<UpstreamState>
  /** Whether a check is in flight right now. */
  isRunning: () => boolean
}

const DEFAULT_TIMERS: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Owns the check schedule: one delayed first run, exponential backoff while the
 * check keeps failing, then a slow periodic re-check once it succeeds. Without
 * this the plugin had exactly one shot at startup, so any transient network
 * failure (the 2026-09-11 boot race) left the badge purple until the next
 * DSH restart.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const timers = options.timers ?? DEFAULT_TIMERS
  const backoff = options.retryBackoffMs.length > 0 ? options.retryBackoffMs : [30000]
  let timer: unknown = null
  let stopped = false
  let failures = 0
  let inflight: Promise<UpstreamState> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      timers.clearTimeout(timer)
      timer = null
    }
  }

  const delayForNextRun = (): number => {
    if (failures === 0) return Math.max(0, options.intervalMs)
    const index = Math.min(failures - 1, backoff.length - 1)
    return Math.max(0, backoff[index] ?? 0)
  }

  const scheduleNext = (delay: number): void => {
    clearTimer()
    if (stopped || delay <= 0) return
    timer = timers.setTimeout(() => {
      timer = null
      void runOnce()
    }, delay)
  }

  const finish = async (): Promise<UpstreamState> => {
    let state: UpstreamState
    try {
      state = await options.run()
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      state = { status: 'error', error: message, checkedAt: new Date().toISOString() }
      options.logger.error('[upstream-watch] unexpected failure: ' + message)
    }

    if (state.status === 'error') {
      failures += 1
      const retryDelay = delayForNextRun()
      options.logger.warn(
        '[upstream-watch] 上游更新检查失败（连续 ' + failures + ' 次）：' + (state.error ?? '未知错误') +
        (retryDelay > 0 ? '；' + Math.round(retryDelay / 1000) + 's 后自动重试' : '；已无重试计划'),
      )
    } else if (failures > 0) {
      options.logger.info('[upstream-watch] 上游更新检查已恢复（此前连续失败 ' + failures + ' 次）。')
      failures = 0
    }

    const delay = delayForNextRun()
    const enriched: UpstreamState = {
      ...state,
      retrying: state.status === 'error',
      consecutiveFailures: failures,
      nextCheckAt: delay > 0 ? new Date(Date.now() + delay).toISOString() : null,
    }
    options.onState(enriched)
    options.persist?.(enriched)
    scheduleNext(delay)
    return enriched
  }

  async function runOnce(): Promise<UpstreamState> {
    if (!inflight) {
      inflight = finish().finally(() => {
        inflight = null
      })
    }
    return inflight
  }

  return {
    start: () => {
      stopped = false
      const delay = Math.max(0, options.initialDelayMs)
      if (delay === 0) {
        void runOnce()
        return
      }
      scheduleNext(delay)
    },
    stop: () => {
      stopped = true
      clearTimer()
    },
    triggerNow: () => {
      clearTimer()
      return runOnce()
    },
    isRunning: () => inflight !== null,
  }
}

/** Register the status route and kick off the startup check. */
export function apply(ctx: Context, config: Config): void {
  const webCtx = ctx as WebContext
  const logger: Logger = createJournalLogger((ctx as unknown as { logger?: Logger }).logger)
  const cfg: NormalizedConfig = {
    sourceDir: config.sourceDir,
    repoUrl: config.repoUrl ?? 'https://github.com/deepseek-ai/deepseek-harness',
    stateFile: config.stateFile,
    timeoutMs: config.timeoutMs ?? 20000,
    gitProxy: config.gitProxy,
    githubToken: config.githubToken || process.env.GITHUB_TOKEN,
    initialDelayMs: config.initialDelayMs ?? 8000,
    retryBackoffMs: config.retryBackoffMs ?? [15000, 30000, 60000, 120000, 300000],
    intervalMs: config.intervalMs ?? 21600000,
  }
  const stateFile = resolveStateFile(cfg)

  // Show the previous result immediately, but never boot up already purple: a
  // persisted failure means the check is about to be retried, not that the
  // current run has failed.
  const previous = loadState(stateFile)
  const holder: { current: UpstreamState } = {
    current: previous.status === 'error'
      ? { ...previous, status: 'pending', retrying: true }
      : (previous.status ? previous : { status: 'pending' }),
  }

  const scheduler = createScheduler({
    run: () => runCheck(cfg, stateFile, logger),
    initialDelayMs: cfg.initialDelayMs,
    retryBackoffMs: cfg.retryBackoffMs,
    intervalMs: cfg.intervalMs,
    logger,
    onState: (state) => { holder.current = state },
    persist: (state) => { saveState(stateFile, state) },
  })

  ctx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path: '/api/upstream-watch/status',
    handler: async (_req, res) => {
      sendJson(res, 200, holder.current)
    },
  }), 'upstream-watch: GET /api/upstream-watch/status')

  // On-demand re-check: lets the badge (or curl) recover without a DSH restart.
  ctx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path: '/api/upstream-watch/check',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed; use POST' })
        return
      }
      try {
        sendJson(res, 200, await scheduler.triggerNow())
      } catch (error) {
        sendJson(res, 500, { error: String((error as Error)?.message ?? error) })
      }
    },
  }), 'upstream-watch: POST /api/upstream-watch/check')

  // Delayed first check + backoff retries + periodic re-check, all off the
  // startup path (never blocks DSH boot).
  ctx.effect(() => {
    scheduler.start()
    return () => scheduler.stop()
  }, 'upstream-watch: retry schedule')

  logger.debug('[upstream-watch] 首次检查将在 ' + Math.round(cfg.initialDelayMs / 1000) + 's 后进行（避开启动竞态）。')
}
