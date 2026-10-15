#!/usr/bin/env node
/** Parsed command-line options. */
interface CliOptions {
    scope: 'live' | 'profile' | 'all';
    format: 'markdown' | 'json';
    failOn: string | undefined;
    profile: string | undefined;
    out: string | undefined;
    /** Try every applicable repair in memory and report which ones actually work. */
    dryRun?: boolean;
    /** Write each applicable repair as its own patch fragment into this directory. */
    fixOut?: string;
    /** Restore a profile from a backup file created by --apply (not yet implemented). */
    rollback?: string;
    /** Skip the interactive confirmation for --apply (required when not a TTY). */
    yes?: boolean;
    help?: boolean;
}
/**
 * Whether stdin is an interactive terminal.
 *
 * `--apply` asks for confirmation, and a confirmation prompt has nowhere to
 * go in a CI pipeline. The rule is therefore: an apply is only permitted
 * interactively, and a non-TTY caller must pass `--yes` to opt in. Detecting
 * this here, at the boundary, means the rule is one check rather than one
 * check per write site.
 */
export declare function isInteractive(): boolean;
/**
 * Whether a write operation may proceed.
 *
 * @param options - the parsed CLI options.
 * @returns a refusal message, or undefined when the write may proceed.
 */
export declare function confirmWrite(options: CliOptions): string | undefined;
export {};
