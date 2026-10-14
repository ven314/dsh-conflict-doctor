/**
 * Renderers: a markdown report for humans and the model, plus the JSON shape
 * returned by the tool. Both are pure functions over findings.
 * @module dsh-conflict-doctor/render
 */
import type { AuditReport } from './types.js';
/**
 * The realm a finding belongs to, derived from its code prefix.
 *
 * The prefix is already the realm (`live/`, `profile/`, `client/`, `fix/`), so
 * nothing has to be declared twice. Grouping on it matters because the two
 * realms fail differently and are fixed differently: a host-side row problem is
 * solved in `cordis.patch.yml`, while a browser-half problem usually has no
 * config fix at all.
 *
 * @param code - a finding code such as `client/inject-unprovided`.
 * @returns a human label for the section heading.
 */
export declare function realmLabelOf(code: string): string;
/**
 * Render the audit as markdown.
 *
 * @param report - the completed audit.
 * @returns a self-contained markdown document.
 */
export declare function renderMarkdown(report: AuditReport): string;
/**
 * One-line summary for a command acknowledgement.
 *
 * @param report - the completed audit.
 * @returns the summary line.
 */
export declare function renderHeadline(report: AuditReport): string;
