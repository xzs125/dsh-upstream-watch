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
}

export const Config = z.object({
  sourceDir: z.string(),
  repoUrl: z.string().default('https://github.com/deepseek-ai/deepseek-harness'),
  stateFile: z.string(),
  timeoutMs: z.number().default(20000),
})

/** Config with defaults resolved (apply-time normalization). */
interface NormalizedConfig {
  sourceDir?: string
  repoUrl: string
  stateFile?: string
  timeoutMs: number
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

async function gitRun(sourceDir: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: sourceDir,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  })
  return String(stdout).trim()
}

/** Parse `dsh-v0.1.0-rc.7` → [0,1,0,7]; `dsh-v0.1.0` → [0,1,0,Infinity]. */
function parseVersion(tag: string): number[] | null {
  const m = tag.match(/^dsh-v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/i)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] != null ? Number(m[4]) : Infinity]
}

function compareVersion(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
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
async function checkViaGit(sourceDir: string, repoUrl: string, timeoutMs: number): Promise<CheckResult> {
  // Fetch remote refs + tags. Only touches .git (FETCH_HEAD / remote-tracking
  // refs / objects); never touches the worktree.
  await gitRun(sourceDir, ['fetch', 'origin', '--tags', '--quiet', '--prune'], timeoutMs)

  const localHead = await gitRun(sourceDir, ['rev-parse', 'HEAD'], timeoutMs)
  const upstreamMasterSha = await gitRun(sourceDir, ['rev-parse', 'origin/master'], timeoutMs)
  const ahead = await gitRun(sourceDir, ['rev-list', '--count', 'HEAD..origin/master'], timeoutMs)
  const aheadCount = Number(ahead)

  // Local version: newest reachable tag.
  const localVersion = await gitRun(sourceDir, ['describe', '--tags', '--abbrev=0'], timeoutMs).catch(() => '')

  // Remote tags (authoritative, read-only).
  const tagsOut = await gitRun(sourceDir, ['ls-remote', '--tags', 'origin'], timeoutMs)
  const tags = tagsOut.split('\n').filter(Boolean).map((line) => line.split('\t')[1] ?? '')

  // Recent upstream commit titles.
  const logOut = await gitRun(sourceDir, ['log', 'origin/master', '--oneline', '-5'], timeoutMs)
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

async function githubFetch(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-upstream-watch' },
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Fallback channel: GitHub API (no local git needed). */
async function checkViaApi(repoUrl: string, timeoutMs: number): Promise<CheckResult> {
  const repoPath = repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  const base = `https://api.github.com/repos/${repoPath}`

  const [commitsRes, tagsRes] = await Promise.all([
    githubFetch(`${base}/commits?sha=master&per_page=5`, timeoutMs),
    githubFetch(`${base}/tags?per_page=100`, timeoutMs),
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
async function apiAheadCount(repoUrl: string, localHead: string, timeoutMs: number): Promise<number | null> {
  try {
    const repoPath = repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
    const res = await githubFetch(`https://api.github.com/repos/${repoPath}/compare/${localHead}...master`, timeoutMs)
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

  // Channel 1: local git clone.
  if (sourceDir) {
    try {
      result = await checkViaGit(sourceDir, config.repoUrl, config.timeoutMs)
    } catch (gitError) {
      logger.debug(`[upstream-watch] git channel failed, falling back to API: ${String(gitError)}`)
    }
  }

  // Channel 2: GitHub API (also fills in ahead count when local HEAD known).
  if (!result.upstreamMasterSha) {
    try {
      result = { ...result, ...(await checkViaApi(config.repoUrl, config.timeoutMs)) }
      if (sourceDir && !result.localHead) {
        try {
          result.localHead = await gitRun(sourceDir, ['rev-parse', 'HEAD'], config.timeoutMs)
        } catch { /* read-only best effort */ }
      }
      if (result.localHead && result.upstreamMasterSha) {
        result.aheadCount = await apiAheadCount(config.repoUrl, result.localHead, config.timeoutMs)
      }
    } catch (apiError) {
      error = String((apiError as Error).message ?? apiError)
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

/** Register the status route and kick off the startup check. */
export function apply(ctx: Context, config: Config): void {
  const webCtx = ctx as WebContext
  const logger: Logger = (ctx as unknown as { logger?: Logger }).logger ?? console
  const cfg: NormalizedConfig = {
    sourceDir: config.sourceDir,
    repoUrl: config.repoUrl ?? 'https://github.com/deepseek-ai/deepseek-harness',
    stateFile: config.stateFile,
    timeoutMs: config.timeoutMs ?? 20000,
  }
  const stateFile = resolveStateFile(cfg)
  const holder: { current: UpstreamState } = { current: { status: 'pending' } }

  ctx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path: '/api/upstream-watch/status',
    handler: async (_req, res) => {
      sendJson(res, 200, holder.current)
    },
  }), 'upstream-watch: GET /api/upstream-watch/status')

  // Fire-and-forget: never block startup on the network check.
  void runCheck(cfg, stateFile, logger).then((state) => {
    holder.current = state
  }).catch((error) => {
    holder.current = { status: 'error', error: String(error), checkedAt: new Date().toISOString() }
    logger.error(`[upstream-watch] unexpected failure: ${String(error)}`)
  })
}
