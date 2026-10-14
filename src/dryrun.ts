/**
 * Dry run: apply a repair in memory and re-audit, without writing anything.
 *
 * The gap this closes: every `Fix` until now was a label plus a snippet, and
 * nothing had ever checked that pasting it actually resolves the finding. It
 * might not — the snippet could target the wrong row, or fix one conflict while
 * creating another.
 *
 * Nothing is written to disk. The proposed edit is handed to the scanner as
 * replacement TEXT for one patch file, so the profile on disk is untouched and a
 * dry run cannot corrupt anything even if the snippet is wrong.
 *
 * @module dsh-conflict-doctor/dryrun
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { detect } from './detect.js'
import { applySnippet } from './patch-edit.js'
import { collectStatic } from './static.js'
import type { AuditOptions } from './index.js'
import type { Fix, Finding, StaticSnapshot } from './types.js'

/** What one dry run established. */
export interface DryRunOutcome {
  /** The finding the repair was meant to resolve. */
  readonly code: string
  /** The repair's label, for the report. */
  readonly label: string
  /** False when the snippet is a shape this cannot apply, or was a no-op. */
  readonly applied: boolean
  /** True when the target finding is gone afterwards. */
  readonly resolved: boolean
  /** Codes that appeared afterwards and were not there before. */
  readonly introduced: readonly string[]
  /** Codes present before, for the before/after table. */
  readonly before: readonly string[]
  readonly after: readonly string[]
  /** Why it was not applied, or why it did not resolve. */
  readonly reason?: string
}

/** Count findings by code, which is the level the comparison is meaningful at. */
function codeCounts(findings: readonly Finding[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const finding of findings) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1)
  return counts
}

/**
 * Re-audit a profile with one patch file's text replaced in memory.
 *
 * @param profilePath - the profile directory.
 * @param patchFile - absolute path of the patch file to substitute.
 * @param text - the replacement text.
 * @param options - scope and Node version, mirroring a normal audit.
 * @returns the findings the substituted composition produces.
 */
function auditWithPatch(profilePath: string, patchFile: string, text: string, options: AuditOptions): readonly Finding[] {
  const overrides = new Map<string, string>([[resolve(patchFile), text]])
  const snapshot: StaticSnapshot = collectStatic(profilePath, [], undefined, true, overrides)
  return detect({ profile: snapshot, nodeVersion: options.nodeVersion ?? process.version })
}

/**
 * Dry-run one repair against a profile.
 *
 * @param profilePath - the profile directory.
 * @param baseline - the findings from the unmodified profile.
 * @param finding - the finding the repair belongs to.
 * @param fix - the repair to try.
 * @param options - audit options; `profilePath` is taken from the argument.
 * @returns what the dry run established.
 */
export function dryRunFix(
  profilePath: string,
  baseline: readonly Finding[],
  finding: Finding,
  fix: Fix,
  options: AuditOptions = {},
): DryRunOutcome {
  const before = [...new Set(baseline.map((entry) => entry.code))].sort()
  const patchFile = join(profilePath, 'cordis.patch.yml')

  const base: DryRunOutcome = {
    code: finding.code,
    label: fix.label,
    applied: false,
    resolved: false,
    introduced: [],
    before,
    after: before,
  }

  if (fix.snippet === undefined) {
    return { ...base, reason: '该修复没有可应用的 patch 片段（属于人工决定或命令）' }
  }
  if (!existsSync(patchFile)) {
    return { ...base, reason: `profile 里没有 ${patchFile}，无法套用` }
  }

  const original = readFileSync(patchFile, 'utf8')
  const edited = applySnippet(original, fix.snippet)
  if (edited === undefined) {
    return { ...base, reason: '片段不是本工具能安全套用的形状（仅支持停用与改 config）' }
  }
  if (!edited.changed) {
    // Already applied. Not an error, but there is nothing to verify.
    return { ...base, reason: '该片段套用后文件没有变化（可能已经应用过）' }
  }

  let after: readonly Finding[]
  try {
    after = auditWithPatch(profilePath, patchFile, edited.text, options)
  } catch (error) {
    return { ...base, reason: `套用后重新审计失败：${error instanceof Error ? error.message : String(error)}` }
  }

  const beforeCounts = codeCounts(baseline)
  const afterCounts = codeCounts(after)

  // Resolved means this code got rarer. Requiring it to vanish entirely would be
  // wrong when several findings share a code: fixing one of three legitimate
  // `row-config-replaced` entries should count as progress.
  const wasCount = beforeCounts.get(finding.code) ?? 0
  const nowCount = afterCounts.get(finding.code) ?? 0
  const resolved = nowCount < wasCount

  // Introduced means a code got MORE common, or appeared where it was absent.
  const introduced = [...afterCounts.entries()]
    .filter(([code, count]) => count > (beforeCounts.get(code) ?? 0) && code !== finding.code)
    .map(([code]) => code)
    .sort()

  return {
    code: finding.code,
    label: fix.label,
    applied: true,
    resolved,
    introduced,
    before,
    after: [...new Set(after.map((entry) => entry.code))].sort(),
    ...(resolved ? {} : { reason: `套用后“${finding.code}”的数量没有减少（${wasCount} → ${nowCount}）` }),
  }
}

/**
 * Dry-run every auto-applicable repair in an audit.
 *
 * Only `patch` fixes with a snippet are attempted: a manual decision has nothing
 * to apply, and a command's effect cannot be simulated.
 *
 * @param profilePath - the profile directory.
 * @param findings - the baseline findings.
 * @param options - audit options.
 * @returns one outcome per attempted repair.
 */
export function dryRunAll(profilePath: string, findings: readonly Finding[], options: AuditOptions = {}): DryRunOutcome[] {
  const outcomes: DryRunOutcome[] = []
  for (const finding of findings) {
    for (const fix of finding.fixes) {
      if (fix.kind !== 'patch' || fix.snippet === undefined) continue
      outcomes.push(dryRunFix(profilePath, findings, finding, fix, options))
    }
  }
  return outcomes
}

/**
 * Render dry-run outcomes as a before/after table.
 *
 * @param outcomes - results from {@link dryRunAll}.
 * @returns markdown lines, or a single line saying nothing was attempted.
 */
export function renderDryRun(outcomes: readonly DryRunOutcome[]): string {
  if (outcomes.length === 0) return '没有可试跑的修复（全部为人工决定或命令）。'
  const lines: string[] = ['| 目标结论 | 是否解决 | 是否引入新结论 | 说明 |', '|---|---|---|---|']
  for (const outcome of outcomes) {
    lines.push(
      `| \`${outcome.code}\` | ${outcome.resolved ? '✅ 已解决' : '❌ 未解决'} | ` +
        `${outcome.introduced.length === 0 ? '无' : `⚠️ ${outcome.introduced.join(', ')}`} | ` +
        `${outcome.reason ?? (outcome.resolved ? '目标结论数量减少' : '')} |`,
    )
  }
  return lines.join('\n')
}
