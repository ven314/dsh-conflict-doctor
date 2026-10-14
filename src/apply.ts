/**
 * The only place this tool writes to a profile, with every guard around it.
 *
 * Everything else in the audit is read-only, and that promise is what makes it
 * safe to run. This module exists so exactly one function is allowed to break
 * that promise, and so every condition under which writing is refused lives in
 * one reviewable place rather than being spread across call sites.
 *
 * The guards, and why each is needed:
 *
 * 1. **The target must resolve inside the profile.** A row id or a package name
 *    reaches the target path, and either can be attacker-influenced. `..`
 *    segments must not be able to walk out of the profile.
 * 2. **Never inside `node_modules`.** That tree is installed and regenerated;
 *    editing it means the fix disappears on the next install, and it is not the
 *    user's configuration.
 * 3. **The target must already exist.** Creating a patch file where none was is a
 *    different decision with different consequences, and is not attempted.
 * 4. **A backup is written first, and the new content lands by rename.** A crash
 *    mid-write leaves either the old file or the new one, never a truncated one.
 *
 * @module dsh-conflict-doctor/apply
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Why a write was refused. */
export interface ApplyRefusal {
  readonly ok: false
  /** Machine-readable reason, stable enough to test against. */
  readonly code: 'outside-profile' | 'inside-node-modules' | 'not-a-file' | 'missing-target' | 'not-a-regular-file'
  /** The same thing in a sentence, for the report. */
  readonly reason: string
}

/** A completed write. */
export interface ApplySuccess {
  readonly ok: true
  /** Absolute path that was replaced. */
  readonly targetPath: string
  /** Absolute path of the backup taken before the write. */
  readonly backupPath: string
  /** Bytes written. */
  readonly bytes: number
}

export type ApplyOutcome = ApplyRefusal | ApplySuccess

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
export function guardTarget(profilePath: string, targetPath: string): ApplyRefusal | undefined {
  const root = resolve(profilePath)
  const target = resolve(targetPath)

  // `relative` is the reliable containment test: comparing prefixes as strings
  // would accept a sibling directory whose name merely starts with the root's.
  const rel = relative(root, target)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      code: 'outside-profile',
      reason: `目标不在 profile 目录内：${target}（profile 为 ${root}）。本工具只改 profile 自己的配置文件。`,
    }
  }

  const segments = rel.split(sep)
  if (segments.includes('node_modules')) {
    return {
      ok: false,
      code: 'inside-node-modules',
      reason: `目标是 node_modules 里的文件：${target}。那是安装产物、会被重新生成，不属于用户配置。`,
    }
  }

  if (!existsSync(target)) {
    return { ok: false, code: 'missing-target', reason: `目标文件不存在：${target}。本工具只改已存在的文件。` }
  }
  const stat = statSync(target)
  if (!stat.isFile()) {
    return { ok: false, code: 'not-a-regular-file', reason: `目标不是普通文件：${target}。` }
  }
  return undefined
}

/** A filesystem-safe timestamp: no colons, which Windows rejects in names. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

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
export function writeWithBackup(
  profilePath: string,
  targetPath: string,
  text: string,
  options: { now?: Date } = {},
): ApplyOutcome {
  const refusal = guardTarget(profilePath, targetPath)
  if (refusal !== undefined) return refusal

  const target = resolve(targetPath)
  const backupPath = `${target}.bak-${stamp(options.now ?? new Date())}`
  const tempPath = join(dirname(target), `.${Date.now().toString(36)}.tmp-write`)

  // 1. Back up the original before anything changes.
  copyFileSync(target, backupPath)

  try {
    // 2. Write the new content to a sibling temporary file and flush it.
    const fd = openSync(tempPath, 'w')
    try {
      writeSync(fd, text, null, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // 3. Swap it in. On Windows this replaces the destination atomically.
    renameSync(tempPath, target)
  } catch (error) {
    // Leave no partial temp file behind, and leave the target untouched: the
    // rename simply never happened.
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // Nothing more to do; the original error is the useful one.
    }
    throw error
  }

  return { ok: true, targetPath: target, backupPath, bytes: Buffer.byteLength(text, 'utf8') }
}

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
export function rollbackFromBackup(profilePath: string, backupPath: string, targetPath?: string): ApplyOutcome {
  const derived = targetPath ?? backupPath.replace(/\.bak-[^\\/]+$/, '')
  if (!existsSync(backupPath)) {
    return { ok: false, code: 'missing-target', reason: `备份文件不存在：${backupPath}` }
  }
  const text = readFileSync(backupPath, 'utf8')
  // Reuse the same guarded write, so restoring is no less safe than applying.
  return writeWithBackup(profilePath, derived, text)
}
