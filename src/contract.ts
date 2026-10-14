/**
 * The JSON contract's version, and the exit-code contract, in one place.
 *
 * `SCHEMA_VERSION` must be bumped whenever an EXISTING field changes meaning.
 * Adding a field does not bump it: consumers are required to tolerate unknown
 * properties, which is what lets new detectors ship without a breaking change.
 *
 * @module dsh-conflict-doctor/contract
 */

/**
 * Current version of `schema/audit-report.schema.json`.
 *
 * History:
 *   1 — initial frozen contract (0.1.0 shape, published as 0.2.0).
 */
export const SCHEMA_VERSION = 1

/** Severity floor at or above which a run is considered failed. */
export type FailOn = 'none' | 'warning' | 'critical'

/**
 * Process exit codes. Stable, because CI depends on them.
 *
 * Chosen so that 0 is success and everything else is distinguishable without
 * reading stdout: a pipeline can gate on `critical` alone while another only
 * wants to know the tool itself broke.
 */
export const EXIT = {
  /** Nothing at or above the `--fail-on` threshold. */
  ok: 0,
  /** At least one warning, with `--fail-on warning`. */
  warning: 1,
  /** At least one critical, with the default `--fail-on critical`. */
  critical: 2,
  /** The audit could not run at all (bad arguments, no profile, internal error). */
  error: 3,
} as const

/**
 * Map a summary to an exit code for the given threshold.
 *
 * Accepts the full summary, or just the two counts: the extra fields are
 * irrelevant here, and demanding them would force callers to construct a whole
 * report to answer "should CI fail".
 *
 * @param summary - counts from one audit.
 * @param failOn - the threshold; `none` never fails on findings.
 * @returns the exit code to use.
 */
export function exitCodeFor(summary: { readonly critical: number; readonly warning: number }, failOn: FailOn): number {
  if (failOn === 'none') return EXIT.ok
  if (summary.critical > 0) return EXIT.critical
  if (failOn === 'warning' && summary.warning > 0) return EXIT.warning
  return EXIT.ok
}

/**
 * Parse a `--fail-on` value.
 *
 * @param raw - the raw argument, or undefined for the default.
 * @returns the threshold, defaulting to `critical`.
 * @throws when the value is not one of the three accepted words — a typo in a
 *   CI gate silently disabling it is worse than refusing to start.
 */
export function parseFailOn(raw: string | undefined): FailOn {
  if (raw === undefined) return 'critical'
  if (raw === 'none' || raw === 'warning' || raw === 'critical') return raw
  throw new Error(`--fail-on must be none, warning, or critical (got "${raw}")`)
}
