/**
 * dsh-upstream-watch — client half.
 *
 * Registers a persistent status badge beside Settings in the sidebar footer
 * (`sidebar.footer.action`). It polls the host's `GET /api/upstream-watch/status`
 * and renders:
 * - strong → red badge (new upstream version)
 * - info   → grey badge (master ahead)
 * - error  → amber badge (check failed)
 * - ok     → muted grey badge (already up to date)
 * - pending → faint grey badge (check still running)
 *
 * Hover shows the full detail; clicking opens the compare URL.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the sidebar slot declarations into this program.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Cordis plugin name used by client loader diagnostics. */
export const name = 'upstream-watch'

/** Client services required by this plugin. */
export const inject = ['slots']

/** Mirrors the host's UpstreamState (only the badge-relevant fields). */
interface StatusPayload {
  status?: 'pending' | 'ok' | 'info' | 'strong' | 'error'
  checkedAt?: string
  localVersion?: string | null
  upstreamLatestTag?: string | null
  aheadCount?: number | null
  recentCommits?: Array<{ sha: string; title: string }>
  compareUrl?: string | null
  error?: string | null
}

const BADGE_COLORS: Record<string, string> = {
  strong: '#EE0000', // 有新版本：红
  info: '#FFD700',   // 仅 master 有新提交：黄
  error: '#A855F7',  // 检查失败：紫
  ok: '#66CCFF',     // 已是最新：蓝
  pending: '#9ca3af', // 检查中：淡灰（用户未指定，保留）
}

/** Bell / badge icon (16px, currentColor). */
function BellIcon(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

function buildTitle(status: StatusPayload): string {
  const lines: string[] = []
  if (status.status === 'strong') {
    lines.push(`上游有新版本：${status.upstreamLatestTag ?? '?'}${status.localVersion ? `（当前 ${status.localVersion}）` : ''}`)
    lines.push(`领先本地 ${status.aheadCount ?? '?'} 个提交`)
  } else if (status.status === 'info') {
    lines.push(`上游 master 领先本地 ${status.aheadCount ?? '?'} 个提交`)
  } else if (status.status === 'error') {
    lines.push('上游更新检查失败')
    if (status.error) lines.push(status.error)
  } else if (status.status === 'ok') {
    lines.push(`已是最新：${status.upstreamLatestTag ?? '?'}`)
    if (status.checkedAt) lines.push(`检查于 ${new Date(status.checkedAt).toLocaleString()}`)
  } else {
    lines.push('正在检查上游更新…')
  }
  if (status.recentCommits?.length) {
    lines.push('最近提交：')
    for (const c of status.recentCommits) lines.push(`  ${c.sha.slice(0, 7)} ${c.title}`)
  }
  if (status.compareUrl) lines.push('点击打开对比页')
  return lines.join('\n')
}

/** Sidebar footer badge that reflects the upstream update check. */
function UpstreamBadge(_props: SidebarFooterActionOwnerProps): ReactElement | null {
  const [status, setStatus] = useState<StatusPayload>({ status: 'pending' })

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch('/api/upstream-watch/status', { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = (await response.json()) as StatusPayload
        if (cancelled) return
        setStatus(data)
        // Keep polling while the startup check is still running.
        if (data.status === 'pending') {
          timer = window.setTimeout(poll, 3000)
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 10000)
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  // Persistent badge: render in every state (muted when ok/pending).
  const color = BADGE_COLORS[status.status ?? 'pending'] ?? 'inherit'
  const badge = (
    <BellIcon />
  )

  return (
    <a
      href={status.compareUrl ?? '#'}
      target="_blank"
      rel="noreferrer"
      title={buildTitle(status)}
      aria-label="上游更新提醒"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: '1px solid transparent',
        borderRadius: 8,
        background: 'transparent',
        color,
        cursor: 'pointer',
        textDecoration: 'none',
        transition: 'color .2s ease, background-color .2s ease',
      }}
    >
      {badge}
    </a>
  )
}

/** Register the sidebar footer action. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'upstream-watch',
    order: 0,
  }, UpstreamBadge))
}
