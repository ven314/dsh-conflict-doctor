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
import type { StaticSnapshot } from './types.js';
/**
 * How well supported an ownership claim is.
 *
 * Ordered from strongest to weakest; `ambiguous` and `unknown` both mean "do not
 * act on this without checking".
 */
export type Confidence = 'certain' | 'probable' | 'ambiguous' | 'unknown';
/** One attribution result with the facts behind it. */
export interface Attribution {
    /** The name being attributed (a tool id or a service name). */
    readonly name: string;
    /** Whether this is a tool id or a service name. */
    readonly kind: 'tool' | 'service';
    readonly confidence: Confidence;
    /** Candidate owners in declaration order, each with the realm it sits in. */
    readonly candidates: ReadonlyArray<{
        readonly owner: string;
        readonly realm: 'host' | 'client';
    }>;
    /** Why this grade was reached, in the reader's terms. */
    readonly reason: string;
}
/** Human label for a confidence grade, used by the renderer. */
export declare const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>>;
/**
 * Attribute one name to an owner, with a confidence grade.
 *
 * @param snapshot - the profile scan, which carries the declarations.
 * @param kind - whether the name is a tool id or a service name.
 * @param name - the name to attribute.
 * @returns the attribution, including why the grade was chosen.
 */
export declare function attribute(snapshot: StaticSnapshot, kind: 'tool' | 'service', name: string): Attribution;
/**
 * Attribute every declared tool id and service name in one pass.
 *
 * @param snapshot - the profile scan.
 * @returns attributions sorted by weakness first, so the ones needing a human
 *   come before the ones that are settled.
 */
export declare function attributeAll(snapshot: StaticSnapshot): Attribution[];
/**
 * Summary counts per grade, for the report's coverage section.
 *
 * @param attributions - results from {@link attributeAll}.
 * @returns counts keyed by grade.
 */
export declare function confidenceCounts(attributions: readonly Attribution[]): Record<Confidence, number>;
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
export declare function attributionNote(snapshot: StaticSnapshot): string | undefined;
