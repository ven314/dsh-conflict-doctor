/**
 * Detectors and the repair engine. Every detector is a pure function over a
 * snapshot, so the whole diagnosis is unit-testable with fixtures and cannot
 * take down the harness. Each finding carries evidence and at least one
 * ready-to-paste repair: the tool's job is to answer "who collided, and what do
 * I change", not merely to print a red line.
 * @module dsh-conflict-doctor/detect
 */
import type { Finding, LiveSnapshot, StaticSnapshot } from './types.js';
/** Sort findings deterministically: severity, then code, then first ref. */
export declare function sortFindings(findings: readonly Finding[]): Finding[];
/**
 * Declared dependency ranges the installed tree cannot satisfy.
 *
 * Grouped per package rather than per dependency: a single community plugin
 * commonly pins a whole generation of the host (`^0.2.0-rc.2` across ten
 * packages), and ten separate findings would bury the one fact that matters —
 * "this plugin was built against a newer host than the one running".
 *
 * Severity: `warning` when the installed version is BELOW the range's minimum
 * (host older than the plugin expects — the version that actually breaks), else
 * `info` (host newer than declared, usually fine with a compatible API).
 *
 * `versionsComparable` gates it: only a snapshot whose baseline is trustworthy
 * may drive a comparison. Historically that meant `authoritative` alone, so a
 * packaged desktop install suppressed every version-sensitive check. W1 added
 * `archive-authoritative` — the disk is stale, but the running host's own
 * archive supplies the baseline instead.
 */
/**
 * Whether version-sensitive detectors may run against this snapshot.
 *
 * Exported so the gate itself can be unit-tested.
 */
export declare function versionsComparable(snapshot: StaticSnapshot): boolean;
/**
 * Run every detector that the supplied snapshots support.
 *
 * @param input - live snapshot, static snapshot, and the Node version to judge engines against.
 * @returns findings sorted by severity, deterministically.
 */
export declare function detect(input: {
    live?: LiveSnapshot;
    profile?: StaticSnapshot;
    nodeVersion: string;
}): Finding[];
