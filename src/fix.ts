/**
 * Repair plans: what a fix will actually DO to a profile, and how dangerous that is.
 *
 * Until now every `Fix` was a label plus a paste-ready snippet, and nothing ever
 * checked the snippet. The README's promise — "it never modifies configuration" —
 * held only because nothing applied anything. That changes the moment a fix can
 * be applied, so the risk has to be derived from the snippet itself rather than
 * from a hand-written label that can drift away from what the YAML says.
 *
 * Risk is therefore COMPUTED, at one choke point in `detect()`, from the fix's
 * own kind and snippet. Annotating ~29 construction sites by hand would drift the
 * first time someone edited a snippet and forgot the label.
 *
 * @module dsh-conflict-doctor/fix
 */

/** How much a repair changes, and whether it can be undone by hand. */
export type RiskLevel =
  /** Adds a row or writes an independent new file. Nothing existing changes. */
  | 'safe'
  /** Replaces an existing row's `config`. The old value is recoverable from the backup. */
  | 'caution'
  /** Disables or removes an existing row, or runs a command. Changes what loads. */
  | 'destructive'

/**
 * Which risks `--apply` may take WITHOUT being asked specifically.
 *
 * Deliberately excludes `destructive`. Disabling a row changes which plugins
 * run, and the audit cannot know whether the disabled row was load-bearing —
 * that is a decision only the user can make. A tool that quietly disables things
 * is exactly the "governance plugin becomes the fault" failure this project
 * exists to avoid.
 */
export const AUTO_APPLICABLE: ReadonlySet<RiskLevel> = new Set<RiskLevel>(['safe', 'caution'])

/**
 * Whether an automated apply may include this fix.
 *
 * Takes the whole fix rather than just its risk, because risk alone cannot
 * answer the question. A `manual` fix is graded `safe` — nothing is applied, so
 * nothing can break — but it is NOT applicable: the decision is the user's, and
 * there is no snippet to write. An earlier version of this function took only
 * the risk level, which classified every manual fix as auto-applicable.
 *
 * `destructive` is excluded deliberately: disabling a row changes which plugins
 * run, and the audit cannot know whether that row was load-bearing. A tool that
 * quietly disables things is the "governance plugin becomes the fault" failure
 * this project exists to prevent.
 *
 * @param fix - the fix to judge, needing at least its kind and risk.
 * @returns true when `--apply` may take it without an explicit opt-in.
 */
export function isAutoApplicable(fix: { kind: 'patch' | 'command' | 'manual'; risk?: RiskLevel }): boolean {
  // Only a patch is a mechanical change. A command's effect is invisible to the
  // audit; a manual decision has nothing to execute.
  if (fix.kind !== 'patch') return false
  const risk = fix.risk ?? classifyRisk(fix.kind, undefined)
  return AUTO_APPLICABLE.has(risk)
}

/** One concrete change to one row, in structured form. */
export interface PatchPlan {
  /** File the change targets, relative to the profile. */
  readonly file: string
  /** The row this addresses, when the change is id-addressed. */
  readonly rowId?: string
  /** What the change does. */
  readonly change: 'insert-row' | 'set-config' | 'disable-row' | 'run-command' | 'manual-decision'
  /** The exact YAML fragment, when there is one. */
  readonly snippet?: string
  /** How to undo it: a backup path, or the instruction a human follows. */
  readonly rollback: string
  readonly risk: RiskLevel
}

/**
 * Classify a fix from its own kind and snippet.
 *
 * The snippet is the authority, not the label: a `patch` whose YAML says
 * `disabled: true` is destructive no matter how it is described, and a patch
 * that only inserts rows cannot break anything that already works.
 *
 * @param kind - the fix kind.
 * @param snippet - the patch fragment, when present.
 * @returns the risk level.
 */
export function classifyRisk(kind: 'patch' | 'command' | 'manual', snippet: string | undefined): RiskLevel {
  // A manual decision applies nothing, so it cannot be dangerous. Treating it as
  // `safe` would be wrong though — it is not auto-applicable at all, which
  // `isAutoApplicable` already excludes by kind.
  if (kind === 'manual') return 'safe'
  // A command runs in the profile; the audit cannot see what it does.
  if (kind === 'command') return 'destructive'

  if (snippet === undefined) return 'caution'

  // `disabled: true` changes which rows load. Checked before config, because a
  // snippet may legitimately contain both.
  if (/^\s*disabled:\s*true\s*$/m.test(snippet)) return 'destructive'
  // A `config:` replacement overwrites whatever an earlier layer wrote. The old
  // value is only recoverable from the backup, so it is not free.
  if (/^\s*config:/m.test(snippet)) return 'caution'
  // An insert list adds rows without touching existing ones.
  if (/^\s*-\s*insert:/m.test(snippet) || /^\s*insert:/m.test(snippet)) return 'safe'
  return 'caution'
}

/**
 * Whether a fix is a manual decision rather than an applicable change.
 *
 * @param kind - the fix kind.
 * @returns true when nothing can be applied.
 */
export function isManual(kind: 'patch' | 'command' | 'manual'): boolean {
  return kind === 'manual'
}

/**
 * Human label for a risk level.
 *
 * Names the consequence rather than the category, because "destructive" alone
 * does not tell a reader whether their tools will stop loading.
 */
export const RISK_LABEL: Readonly<Record<RiskLevel, string>> = {
  safe: '安全（只新增，不改既有行）',
  caution: '需谨慎（覆盖既有行的 config，可从备份恢复）',
  destructive: '有破坏性（停用/删除行或执行命令，会改变实际加载的内容）',
}
