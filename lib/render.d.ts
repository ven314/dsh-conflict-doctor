/**
 * Renderers: a markdown report for humans and the model, plus the JSON shape
 * returned by the tool. Both are pure functions over findings.
 * @module dsh-conflict-doctor/render
 */
import type { AuditReport } from './types.js';
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
