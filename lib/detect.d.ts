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
