/**
 * Attribution: how confidently this tool can say WHO owns a name.
 *
 * The README has always admitted the limit — "tool-id ownership cannot be
 * attributed with certainty", because the tool registry does not record who
 * registered a name. That admission is honest but not actionable: a reader
 * cannot tell a certain answer from a guess.
 *
 * This module replaces the admission with a graded answer. Every attribution
 * carries the evidence that produced it and the confidence that evidence
 * supports, so the report can say "certain", "probable" or "unknown" instead of
 * either overstating or staying silent.
 *
 * Nothing here invents a signal. Each grade corresponds to a real observation:
 *
 *   certain   — exactly one package's compiled sources declare the name as a
 *               literal, and it was actually scanned. There is no competing
 *               declaration to weigh.
 *   probable  — several packages declare it, but they sit in DIFFERENT realms,
 *               which cannot collide; or one declaration is a literal while
 *               others are absent from the scan.
 *   ambiguous — several packages in the SAME realm declare it. This is the case
 *               that genuinely needs a human, and saying so is the point.
 *   unknown   — no scanned package declares it, so the name came from somewhere
 *               the static scan cannot see (a dynamic name, or a live registry).
 *
 * @module dsh-conflict-doctor/attribution
 */
import type { StaticSnapshot } from './types.js'

/**
 * How well supported an ownership claim is.
 *
 * Ordered from strongest to weakest; `ambiguous` and `unknown` both mean "do not
 * act on this without checking".
 */
export type Confidence = 'certain' | 'probable' | 'ambiguous' | 'unknown'

/** One attribution result with the facts behind it. */
export interface Attribution {
  /** The name being attributed (a tool id or a service name). */
  readonly name: string
  /** Whether this is a tool id or a service name. */
  readonly kind: 'tool' | 'service'
  readonly confidence: Confidence
  /** Candidate owners in declaration order, each with the realm it sits in. */
  readonly candidates: ReadonlyArray<{ readonly owner: string; readonly realm: 'host' | 'client' }>
  /** Why this grade was reached, in the reader's terms. */
  readonly reason: string
}

/** Human label for a confidence grade, used by the renderer. */
export const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>> = {
  certain: '确定',
  probable: '较可能',
  ambiguous: '有歧义（需人工确认）',
  unknown: '无法归因',
}

/**
 * Which realm a package sits in, according to its own declaration.
 *
 * @param snapshot - the profile scan.
 * @param name - package name.
 * @returns `client` when the package declares a browser half, else `host`.
 */
function realmOfPackage(snapshot: StaticSnapshot, name: string): 'host' | 'client' {
  const pkg = snapshot.packages.find((entry) => entry.name === name)
  return pkg?.client === undefined ? 'host' : 'client'
}

/**
 * Attribute one name to an owner, with a confidence grade.
 *
 * @param snapshot - the profile scan, which carries the declarations.
 * @param kind - whether the name is a tool id or a service name.
 * @param name - the name to attribute.
 * @returns the attribution, including why the grade was chosen.
 */
export function attribute(snapshot: StaticSnapshot, kind: 'tool' | 'service', name: string): Attribution {
  const declared = kind === 'tool' ? snapshot.declaredTools : snapshot.declaredServices
  const owners = declared?.[name] ?? []
  const candidates = owners.map((owner) => ({ owner, realm: realmOfPackage(snapshot, owner) }))

  if (candidates.length === 0) {
    return {
      name,
      kind,
      confidence: 'unknown',
      candidates,
      reason:
        '已扫描的包里没有任何一处声明这个名字。它可能来自动态拼接的名字，或只存在于运行期的注册表里——静态扫描看不到这两种来源。',
    }
  }

  if (candidates.length === 1) {
    return {
      name,
      kind,
      confidence: 'certain',
      candidates,
      reason: `只有一个包声明了这个名字，且它的编译产物已被扫描：${candidates[0]?.owner}。`,
    }
  }

  // Several declarers: the realm decides whether they can actually collide.
  const realms = new Set(candidates.map((entry) => entry.realm))
  if (realms.size > 1) {
    return {
      name,
      kind,
      confidence: 'probable',
      candidates,
      reason:
        `有 ${candidates.length} 个包声明了这个名字，但它们分属不同 realm（页面/宿主各有独立注册表），` +
        '因此不构成冲突——这是宿主与页面各自注册同名能力的正常形态。',
    }
  }

  return {
    name,
    kind,
    confidence: 'ambiguous',
    candidates,
    reason:
      `有 ${candidates.length} 个包在同一个 realm 里都声明了这个名字，静态扫描无法判断谁才是实际注册方` +
      '（注册表不记录注册者）。需要人工确认，或改用运行期扫描看实际注册结果。',
  }
}

/**
 * Attribute every declared tool id and service name in one pass.
 *
 * @param snapshot - the profile scan.
 * @returns attributions sorted by weakness first, so the ones needing a human
 *   come before the ones that are settled.
 */
export function attributeAll(snapshot: StaticSnapshot): Attribution[] {
  const rank: Record<Confidence, number> = { ambiguous: 0, unknown: 1, probable: 2, certain: 3 }
  const out: Attribution[] = []
  for (const name of Object.keys(snapshot.declaredTools ?? {})) out.push(attribute(snapshot, 'tool', name))
  for (const name of Object.keys(snapshot.declaredServices ?? {})) out.push(attribute(snapshot, 'service', name))
  return out.sort((left, right) => {
    const byRank = rank[left.confidence] - rank[right.confidence]
    if (byRank !== 0) return byRank
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })
}

/**
 * Summary counts per grade, for the report's coverage section.
 *
 * @param attributions - results from {@link attributeAll}.
 * @returns counts keyed by grade.
 */
export function confidenceCounts(attributions: readonly Attribution[]): Record<Confidence, number> {
  const counts: Record<Confidence, number> = { certain: 0, probable: 0, ambiguous: 0, unknown: 0 }
  for (const entry of attributions) counts[entry.confidence] += 1
  return counts
}

/**
 * The coverage note describing attribution quality for one profile.
 *
 * Lives here rather than in each entry point so `runAudit`, the CLI, and the
 * report generator all say the same thing. Duplicating it is how one of them
 * silently stops mentioning that a finding could not be attributed.
 *
 * @param snapshot - the profile scan.
 * @returns one coverage sentence, or undefined when nothing was declared.
 */
export function attributionNote(snapshot: StaticSnapshot): string | undefined {
  const attributed = attributeAll(snapshot)
  if (attributed.length === 0) return undefined

  const counts = confidenceCounts(attributed)
  const unsettled = attributed.filter((entry) => entry.confidence === 'ambiguous' || entry.confidence === 'unknown')
  if (unsettled.length === 0) {
    return (
      `归属覆盖：${attributed.length} 个名字全部可归因（${counts.certain} 确定、${counts.probable} 较可能）；` +
      '没有需要人工确认的归属。判定依据见 docs/realms.md 与 attribution.ts 的分级规则。'
    )
  }
  const shown = unsettled
    .slice(0, 5)
    .map((entry) => `${entry.name}（${CONFIDENCE_LABEL[entry.confidence]}）`)
    .join('、')
  return (
    `归属覆盖：${attributed.length} 个名字中 ${counts.certain} 个确定、${counts.probable} 个较可能，` +
    `${unsettled.length} 个无法可靠归因：${shown}${unsettled.length > 5 ? ' 等' : ''}。` +
    '这些名字在同一个 realm 里有多处声明，静态扫描无法判断实际注册方——需要人工确认。'
  )
}
