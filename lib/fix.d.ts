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
'safe'
/** Replaces an existing row's `config`. The old value is recoverable from the backup. */
 | 'caution'
/** Disables or removes an existing row, or runs a command. Changes what loads. */
 | 'destructive';
/** Import the canonical PatchPlan definition from types.js to avoid duplication. */
import type { PatchPlan } from './types.js';
/**
 * Which risks `--apply` may take WITHOUT being asked specifically.
 *
 * Deliberately excludes `destructive`. Disabling a row changes which plugins
 * run, and the audit cannot know whether the disabled row was load-bearing —
 * that is a decision only the user can make. A tool that quietly disables things
 * is exactly the "governance plugin becomes the fault" failure this project
 * exists to avoid.
 */
export declare const AUTO_APPLICABLE: ReadonlySet<RiskLevel>;
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
export declare function isAutoApplicable(fix: {
    kind: 'patch' | 'command' | 'manual';
    risk?: RiskLevel;
}): boolean;
/** One concrete change to one row, in structured form (canonical definition in `types.js`). */
export type { PatchPlan } from './types.js';
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
export declare function classifyRisk(kind: 'patch' | 'command' | 'manual', snippet: string | undefined): RiskLevel;
/**
 * Build a structured repair plan from a snippet.
 *
 * The snippet is the authority: the row id and the change kind are read back out
 * of it, so a plan cannot disagree with the paste-ready fragment a human reads.
 * A snippet that addresses no row (an `insert:` list, for instance) has no plan,
 * because there is no single row to target.
 *
 * @param snippet - the patch fragment.
 * @param risk - the risk already computed for this fix.
 * @returns the plan, or undefined when the snippet does not address one row.
 */
export declare function buildPatchPlan(snippet: string | undefined, risk: RiskLevel): PatchPlan | undefined;
/**
 * Whether a fix is a manual decision rather than an applicable change.
 *
 * @param kind - the fix kind.
 * @returns true when nothing can be applied.
 */
export declare function isManual(kind: 'patch' | 'command' | 'manual'): boolean;
/**
 * Human label for a risk level.
 *
 * Names the consequence rather than the category, because "destructive" alone
 * does not tell a reader whether their tools will stop loading.
 */
export declare const RISK_LABEL: Readonly<Record<RiskLevel, string>>;
/**
 * Whether a repair is advice rather than something expected to clear its finding.
 *
 * @param code - the finding code.
 * @returns true when a dry run should not read as a failure if nothing changed.
 */
export declare function isAdvisory(code: string): boolean;
/**
 * Why a repair is advisory, for the report.
 *
 * @param code - the finding code.
 * @returns the explanation, or undefined when the code is not advisory.
 */
export declare function advisoryReason(code: string): string | undefined;
/** One row that two or more fixes would change in incompatible ways. */
export interface FixConflict {
    /** The row both fixes address. */
    readonly rowId: string;
    /** The fixes involved, as `code` plus what each would do. */
    readonly fixes: ReadonlyArray<{
        readonly code: string;
        readonly change: PatchChange;
        readonly risk: RiskLevel;
    }>;
}
/** What a fix does to a row, derived from its snippet. */
export type PatchChange = 'insert-row' | 'set-config' | 'disable-row' | 'unknown';
/**
 * Read the row a patch snippet addresses.
 *
 * The snippet is YAML text, so this reads the `- id:` line rather than parsing
 * the whole document: the audit never evaluates or rewrites user YAML outside an
 * explicit apply, and an approximate read is enough to detect that two fixes
 * point at the same row.
 *
 * @param snippet - a paste-ready patch fragment.
 * @returns the row id it addresses, or undefined when it addresses none.
 */
export declare function snippetRowId(snippet: string | undefined): string | undefined;
/**
 * What one fix does, from its kind and snippet.
 *
 * @param fix - the fix to classify.
 * @returns the change it makes.
 */
export declare function classifyChange(fix: {
    kind: 'patch' | 'command' | 'manual';
    snippet?: string;
}): PatchChange;
/**
 * Find rows that two or more fixes would change incompatibly.
 *
 * Two fixes touching one row is not automatically a conflict: two findings may
 * legitimately both add rows to the same `insert` list. It becomes a conflict
 * when their effects disagree — one disabling a row while another reconfigures
 * it, for instance. Applying both silently loses one of them, and which one is
 * lost depends on ordering, so the audit says so instead of guessing.
 *
 * @param findings - findings whose fixes have already been grouped.
 * @returns one entry per conflicting row, sorted by row id.
 */
export declare function findFixConflicts(findings: ReadonlyArray<{
    code: string;
    fixes: ReadonlyArray<{
        kind: 'patch' | 'command' | 'manual';
        snippet?: string;
        risk?: RiskLevel;
    }>;
}>): FixConflict[];
