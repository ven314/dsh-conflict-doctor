/**
 * Renderers: a markdown report for humans and the model, plus the JSON shape
 * returned by the tool. Both are pure functions over findings.
 * @module dsh-conflict-doctor/render
 */
import type { AuditReport, Finding, Severity } from './types.js'

/** Severity label, rendered identically in every surface. */
const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  critical: 'CRITICAL',
  warning: 'WARNING',
  info: 'INFO',
}

/** Render one finding as a markdown section. */
function renderFinding(finding: Finding): string {
  const lines: string[] = []
  lines.push(`### [${SEVERITY_LABEL[finding.severity]}] ${finding.title}`)
  lines.push(`- code: \`${finding.code}\``)
  lines.push(`- 涉及: ${finding.refs.map((ref) => `\`${ref}\``).join(', ')}`)
  lines.push(`- 影响: ${finding.impact}`)
  lines.push('- 证据:')
  for (const item of finding.evidence) lines.push(`  - ${item}`)
  lines.push('- 修复:')
  finding.fixes.forEach((fix, index) => {
    lines.push(`  ${index + 1}. ${fix.label} — ${fix.detail}`)
    if (fix.snippet !== undefined) {
      lines.push('    ```yaml')
      for (const snippetLine of fix.snippet.split('\n')) lines.push(`    ${snippetLine}`)
      lines.push('    ```')
    }
  })
  return lines.join('\n')
}

/**
 * The realm a finding belongs to, derived from its code prefix.
 *
 * The prefix is already the realm (`live/`, `profile/`, `client/`, `fix/`), so
 * nothing has to be declared twice. Grouping on it matters because the two
 * realms fail differently and are fixed differently: a host-side row problem is
 * solved in `cordis.patch.yml`, while a browser-half problem usually has no
 * config fix at all.
 *
 * @param code - a finding code such as `client/inject-unprovided`.
 * @returns a human label for the section heading.
 */
export function realmLabelOf(code: string): string {
  const prefix = code.split('/')[0]
  switch (prefix) {
    case 'live':
      return '运行期（Loader / fiber / 服务）'
    case 'profile':
      return '磁盘组合（patch 层 / 包）'
    case 'client':
      return '客户端半区（页面 / 模块）'
    case 'fix':
      return '修复建议自身'
    default:
      // An unknown prefix must not silently vanish from the report.
      return `其他（${prefix}）`
  }
}

/** Section order: the realm a user can act on fastest comes first. */
const REALM_ORDER = ['live', 'profile', 'client', 'fix']

/**
 * Group findings by realm, preserving each group's existing sort.
 *
 * @param findings - already sorted findings.
 * @returns groups in a stable, meaningful order.
 */
function groupByRealm(findings: readonly Finding[]): Array<{ prefix: string; label: string; items: Finding[] }> {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const prefix = finding.code.split('/')[0] ?? 'other'
    const bucket = groups.get(prefix) ?? []
    bucket.push(finding)
    groups.set(prefix, bucket)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const ai = REALM_ORDER.indexOf(a)
      const bi = REALM_ORDER.indexOf(b)
      // Unknown prefixes sort last, deterministically, rather than first.
      return (ai === -1 ? REALM_ORDER.length : ai) - (bi === -1 ? REALM_ORDER.length : bi)
    })
    .map(([prefix, items]) => ({ prefix, label: realmLabelOf(`${prefix}/x`), items }))
}

/**
 * Render the audit as markdown.
 *
 * @param report - the completed audit.
 * @returns a self-contained markdown document.
 */
export function renderMarkdown(report: AuditReport): string {
  const { summary } = report
  const lines: string[] = []
  const verdict =
    summary.critical > 0
      ? `${summary.critical} 个 critical 冲突`
      : summary.warning > 0
        ? `无 critical，${summary.warning} 个 warning`
        : '未发现冲突'

  lines.push('# 插件冲突诊断报告')
  lines.push('')
  lines.push(`**结论：${verdict}**`)
  lines.push('')
  lines.push(`- 生成时间：${report.generatedAt}`)
  lines.push(`- 审计范围：${report.scope}`)
  lines.push(`- 配置目录：${report.profilePath}`)
  lines.push(
    `- 覆盖：live entries ${summary.liveEntries} · patch 层 ${summary.patchLayers} · 扫描包 ${summary.scannedPackages} · 提取 tool id ${summary.declaredTools}`,
  )
  lines.push('')

  if (report.findings.length === 0) {
    lines.push('未发现已知冲突类别的命中项。')
    lines.push('')
    lines.push("这不等于「绝对安全」：静态提取只能看到 `defineTool({ name: '...' })` 形式的字面量，")
    lines.push('动态拼出的 tool 名、以及只在运行期才出现的服务依赖，仍需 live 扫描或实际运行。')
  } else {
    lines.push('## 冲突清单')
    lines.push('')
    // Grouped by realm. A reader who only cares about the page half can stop
    // after its section, and nobody has to work out from the code prefix
    // whether a finding is host-side or browser-side.
    const groups = groupByRealm(report.findings)
    for (const group of groups) {
      const counts = group.items.reduce<Record<string, number>>((acc, item) => {
        acc[item.severity] = (acc[item.severity] ?? 0) + 1
        return acc
      }, {})
      const parts = (['critical', 'warning', 'info'] as const)
        .filter((severity) => (counts[severity] ?? 0) > 0)
        .map((severity) => `${counts[severity]} ${severity}`)
      lines.push(`### ${group.label} — ${group.items.length} 项（${parts.join('、')}）`)
      lines.push('')
      for (const finding of group.items) {
        lines.push(renderFinding(finding))
        lines.push('')
      }
    }
  }

  if (report.notes.length > 0) {
    lines.push('## 覆盖说明')
    lines.push('')
    for (const note of report.notes) lines.push(`- ${note}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

/**
 * One-line summary for a command acknowledgement.
 *
 * @param report - the completed audit.
 * @returns the summary line.
 */
export function renderHeadline(report: AuditReport): string {
  const { summary } = report
  if (summary.critical > 0) return `发现 ${summary.critical} 个 critical、${summary.warning} 个 warning 冲突`
  if (summary.warning > 0) return `未发现 critical，${summary.warning} 个 warning 需要确认`
  return '未发现已知冲突'
}
