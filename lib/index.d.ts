import type { Context } from '@deepseek-ai/cordis';
import type { AuditReport, AuditScope } from './types.js';
export declare const name = "conflict-doctor";
/**
 * Only `tools` is hard-required. Everything else — the Loader tree, the
 * command registry, the profile path — is read through `ctx.get` at use time,
 * because a diagnostics plugin that parks itself in PENDING on a missing
 * service would be the joke that tells itself.
 */
export declare const inject: string[];
export type { AuditReport, AuditScope, Finding, Fix, Severity } from './types.js';
export { detect } from './detect.js';
export { collectLive } from './live.js';
export { collectStatic, resolveVersionAuthority, scanDeclaredToolIds, satisfiesRange } from './static.js';
export { renderHeadline, renderMarkdown } from './render.js';
/** Where the audit reads the profile from when the caller names nothing. */
export interface AuditOptions {
    /** `live` = running process only, `profile` = disk only, `all` = both. */
    readonly scope?: AuditScope;
    /** Profile directory to read; defaults to the running profile. */
    readonly profilePath?: string;
    /** Node version to judge `engines.node` against; defaults to `process.version`. */
    readonly nodeVersion?: string;
}
/** Resolve the running profile directory from the environment DSH sets. */
export declare function defaultProfilePath(env?: NodeJS.ProcessEnv): string | undefined;
/**
 * Run one audit (asynchronous so the live host can be consulted first).
 *
 * @param ctx - the live context (used for the live half).
 * @param options - scope, profile path, and Node version overrides.
 * @returns the complete report, never throwing for a missing input: gaps land in `notes`.
 */
export declare function runAudit(ctx: Context, options?: AuditOptions): Promise<AuditReport>;
/**
 * Register the audit tool, the `/conflict-doctor` command, and the proactive
 * critical-conflict alert.
 *
 * @param ctx - the host context; `tools` must be available.
 */
export declare function apply(ctx: Context): void;
