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
    for (const finding of report.findings) {
      lines.push(renderFinding(finding))
      lines.push('')
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
