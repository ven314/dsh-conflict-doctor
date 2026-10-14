import type { AuditOptions } from './index.js';
import type { Fix, Finding } from './types.js';
/** What one dry run established. */
export interface DryRunOutcome {
    /** The finding the repair was meant to resolve. */
    readonly code: string;
    /** The repair's label, for the report. */
    readonly label: string;
    /** False when the snippet is a shape this cannot apply, or was a no-op. */
    readonly applied: boolean;
    /** True when the target finding is gone afterwards. */
    readonly resolved: boolean;
    /** Codes that appeared afterwards and were not there before. */
    readonly introduced: readonly string[];
    /** Codes present before, for the before/after table. */
    readonly before: readonly string[];
    readonly after: readonly string[];
    /** Why it was not applied, or why it did not resolve. */
    readonly reason?: string;
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
export declare function dryRunFix(profilePath: string, baseline: readonly Finding[], finding: Finding, fix: Fix, options?: AuditOptions): DryRunOutcome;
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
export declare function dryRunAll(profilePath: string, findings: readonly Finding[], options?: AuditOptions): DryRunOutcome[];
/**
 * Render dry-run outcomes as a before/after table.
 *
 * An advisory repair that changes nothing is reported as `ℹ️ 仅建议（不消除结论）`
 * rather than as a failure. Saying ❌ would be accurate and misleading at once:
 * a reader would go hunting for a broken snippet that is working as intended.
 *
 * @param outcomes - results from {@link dryRunAll}.
 * @returns markdown lines, or a single line saying nothing was attempted.
 */
export declare function renderDryRun(outcomes: readonly DryRunOutcome[]): string;
/**
 * Whether an unresolved outcome should read as a failure.
 *
 * False for an advisory repair, whose finding exists by design and is not meant
 * to be silenced.
 *
 * @param outcome - the dry-run result.
 * @returns true when the reader should treat the repair as not working.
 */
export declare function isFailure(outcome: DryRunOutcome): boolean;
