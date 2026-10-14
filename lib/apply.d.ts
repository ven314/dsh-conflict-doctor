import type { Finding } from './types.js';
/** Why a write was refused. */
export interface ApplyRefusal {
    readonly ok: false;
    /** Machine-readable reason, stable enough to test against. */
    readonly code: 'outside-profile' | 'inside-node-modules' | 'not-a-file' | 'missing-target' | 'not-a-regular-file';
    /** The same thing in a sentence, for the report. */
    readonly reason: string;
}
/** A completed write. */
export interface ApplySuccess {
    readonly ok: true;
    /** Absolute path that was replaced. */
    readonly targetPath: string;
    /** Absolute path of the backup taken before the write. */
    readonly backupPath: string;
    /** Bytes written. */
    readonly bytes: number;
}
export type ApplyOutcome = ApplyRefusal | ApplySuccess;
/**
 * Decide whether a path may be written.
 *
 * Exported so the rule can be unit-tested directly, and so a caller can explain
 * a refusal without re-deriving it.
 *
 * @param profilePath - the profile root that bounds every permitted write.
 * @param targetPath - the file the caller wants to write.
 * @returns a refusal, or `undefined` when the write is permitted.
 */
export declare function guardTarget(profilePath: string, targetPath: string): ApplyRefusal | undefined;
/**
 * Replace a file's contents, keeping a backup and never leaving it truncated.
 *
 * The order is deliberate: back up the ORIGINAL first, then write a temporary
 * file beside the target, flush it, and rename it over the target. A rename is
 * atomic on the same filesystem, so a reader sees the old file or the new one,
 * and a crash mid-write leaves the temporary file behind rather than a half
 * written configuration.
 *
 * @param profilePath - the profile root, used for the containment guard.
 * @param targetPath - the file to replace.
 * @param text - the new contents.
 * @param options - injectable clock, so backup names are testable.
 * @returns the write outcome, or a refusal.
 */
export declare function writeWithBackup(profilePath: string, targetPath: string, text: string, options?: {
    now?: Date;
}): ApplyOutcome;
/**
 * Restore a target from one of its backups.
 *
 * Also guarded, so a rollback cannot write outside the profile either.
 *
 * @param profilePath - the profile root.
 * @param backupPath - the backup to restore from.
 * @param targetPath - the file to restore. Defaults to stripping the backup suffix.
 * @returns the write outcome, or a refusal.
 */
export declare function rollbackFromBackup(profilePath: string, backupPath: string, targetPath?: string): ApplyOutcome;
/** One repair written out for a human to review and paste. */
export interface FixFile {
    /** Absolute path written. */
    readonly path: string;
    /** The finding it addresses. */
    readonly code: string;
    /** The risk level, so the manifest can warn before anyone pastes it. */
    readonly risk: string;
    readonly label: string;
}
/**
 * Write each applicable repair as its own patch fragment.
 *
 * The middle ground between "here is prose" and "let me edit your config": the
 * user gets real, paste-ready files they can read, pick from, and apply when they
 * choose. Nothing in the profile is touched — a `.patch.yml` sitting beside
 * `cordis.patch.yml` is inert, so a wrong pick cannot break anything.
 *
 * Filenames are derived from the finding CODE, never from a row id or package
 * name, so nothing originating in user data can influence a path.
 *
 * @param outDir - directory to write into; created when absent.
 * @param findings - the audit's findings.
 * @returns the files written, in report order.
 */
export declare function writeFixFiles(outDir: string, findings: readonly Finding[]): FixFile[];
