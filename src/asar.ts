/**
 * Read files out of an Electron `.asar` archive, with no external dependency.
 *
 * Why this exists: a packaged desktop app serves its profile bundles from its
 * OWN archive, while `profiles/node_modules` can hold a completely different
 * generation. Comparing a plugin's imports against the stale disk copies is how
 * this project once invented seven conflicts that did not exist. To compare
 * against what actually runs, the bytes have to come from the archive.
 *
 * The format is deliberately small: an 8-byte header, then a JSON tree mapping
 * each name to a `{ size, offset }` for files and `{ files: {...} }` for
 * directories. Everything after the tree is raw content addressed by absolute
 * offsets. See Electron's `asar.ts` if this ever stops matching.
 *
 * @module dsh-conflict-doctor/asar
 */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

/**
 * Pickled-header layout, verified against a real 121 MB Electron app.asar:
 *
 *   u32 @0  = 4          (pickle payload size field, always 4 here)
 *   u32 @4  = headerSize size of the pickled tree INCLUDING this prefix
 *   u32 @8  = headerSize - 4
 *   u32 @12 = headerSize - 8
 *   @16     = first byte of the JSON tree
 *
 * Only the u32 at byte 4 is needed; the rest is here so nobody re-derives it.
 * Getting this wrong produces a JSON error one character in, which looks like
 * corruption rather than an off-by-eight.
 */
const HEADER_PREFIX_BYTES = 16

/** Refuse absurd archives rather than allocating whatever they ask for. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024

/** One node of the decoded tree. */
export interface AsarNode {
  /** Present on file nodes. May exceed Number.MAX_SAFE_INTEGER as a string. */
  readonly size?: number | string
  /**
   * Byte offset of the content from the start of the ARCHIVE.
   *
   * Older Electron wrote a JSON number; modern builds write a STRING to carry
   * offsets past 2^53 exactly. Both forms occur in the wild, so both are read.
   */
  readonly offset?: number | string
  /** Present on directory nodes. */
  readonly files?: Readonly<Record<string, AsarNode>>
  /** Present on some modern builds; informational only. */
  readonly integrity?: Readonly<{ algorithm?: string; hash?: string }>
}

/** An opened archive handle. Close it with {@link closeAsar}. */
export interface AsarArchive {
  /** Absolute path that was opened. */
  readonly path: string
  /** Decoded root; its own `files` map is the archive root. */
  readonly root: AsarNode
  /** File descriptor held open for reads. */
  readonly fd: number
  /**
   * Additive base for every content offset.
   *
   * Content offsets in the tree are relative to the END of the effective header
   * (the 16-byte pickle prefix plus the whole JSON tree), NOT to the start of
   * the file. Verified empirically against a real 121 MB Electron archive by
   * SHA-256: for `package.json` the tree said 117911453 while the bytes actually
   * begin at 121303517, a difference of exactly `16 + treeLen`.
   *
   * Note that `16 + treeLen` is NOT the u32 `headerSize` field, which reports
   * 3392056 against a true value of 3392064 — eight bytes off, enough to land
   * every read inside a neighbouring file's bytes.
   */
  readonly contentBase: number
}

/**
 * Locate the end of the JSON tree by brace matching.
 *
 * The u32 header field is NOT reliable for locating the tree in modern
 * Electron archives. On a real 121 MB `app.asar` it reports 3392056 while the
 * tree JSON actually continues well past that point — the tree ends with keys
 * the size field does not account for, so slicing at `headerSize` produces a
 * truncated parse ("Unterminated string") that looks like corruption.
 *
 * Brace matching is exact for well-formed JSON and costs one linear scan over
 * the header region only. It tracks string state so braces and escapes inside
 * string literals cannot desynchronise it, and it stops at the first `}` that
 * returns depth to zero, which is by definition the end of the root object.
 *
 * @param text - decoded text starting at the beginning of the JSON tree.
 * @returns the index just past the root object, or -1 when unbalanced.
 */
function endOfJsonTree(text: string): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** Bytes to read past `headerSize` looking for the true end of the tree. */
const TREE_SCAN_SLACK_BYTES = 64 * 1024 * 1024

/**
 * Decode the pickled header of an asar file.
 *
 * @param path - archive to open.
 * @returns the decoded root node and an open descriptor.
 * @throws when the file is too small, malformed, or not JSON at all — the
 *   caller turns this into a coverage note rather than propagating it.
 */
export function openAsar(path: string): AsarArchive {
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    const prefix = Buffer.alloc(HEADER_PREFIX_BYTES)
    readSync(fd, prefix, 0, HEADER_PREFIX_BYTES, 0)

    // The u32 at byte 4 is the header size FIELD. It bounds how much we read,
    // but not where the tree ends — see {@link endOfJsonTree}.
    const headerSize = prefix.readUInt32LE(4)
    if (headerSize <= 0 || headerSize > MAX_HEADER_BYTES) {
      throw new Error(`implausible asar header size ${headerSize} for ${stat.size} bytes`)
    }

    const budget = Math.min(headerSize + TREE_SCAN_SLACK_BYTES, stat.size) - HEADER_PREFIX_BYTES
    if (budget <= 0) throw new Error(`asar too small to contain a tree: ${stat.size} bytes`)

    const raw = Buffer.alloc(budget)
    readSync(fd, raw, 0, budget, HEADER_PREFIX_BYTES)
    const text = raw.toString('utf8')

    const end = endOfJsonTree(text)
    if (end < 0) throw new Error('asar tree JSON is unbalanced beyond the scan budget')
    const root = JSON.parse(text.slice(0, end)) as AsarNode
    const contentBase = HEADER_PREFIX_BYTES + end
    return { path, root, fd, contentBase }
  } catch (error) {
    closeSync(fd)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** Release the descriptor. Safe to call twice. */
export function closeAsar(archive: AsarArchive): void {
  try {
    closeSync(archive.fd)
  } catch {
    // Already closed; there is nothing to undo.
  }
}

/**
 * Resolve one path inside the archive.
 *
 * The input is normalised before lookup, so both `../node_modules/evil` inside
 * the archive and a leading `./` behave like any other walk. Nothing here can
 * escape the archive root: the result is a node from the decoded tree, never a
 * filesystem path.
 *
 * @param archive - an open archive.
 * @param target - slash-separated path inside the archive.
 * @returns the node, or undefined when absent.
 */
export function findNode(archive: AsarArchive, target: string): AsarNode | undefined {
  const parts = target.split(/[\\/]+/).filter((part) => part.length > 0 && part !== '.' && part !== '..')
  let node: AsarNode | undefined = archive.root
  for (const part of parts) {
    if (node === undefined) return undefined
    node = node.files?.[part]
  }
  return node
}

/**
 * Read one file's bytes.
 *
 * @param archive - an open archive.
 * @param target - path inside the archive.
 * @returns the content, or undefined when the path is missing or not a file.
 */
export function readAsarFile(archive: AsarArchive, target: string): Buffer | undefined {
  const node = findNode(archive, target)
  if (node === undefined) return undefined
  // String or number, and never a directory (which has `files`, not `size`).
  if (node.size === undefined || node.offset === undefined || node.files !== undefined) return undefined
  const size = Number(node.size)
  const offset = Number(node.offset)
  if (!Number.isFinite(size) || !Number.isFinite(offset) || size < 0 || offset < 0) return undefined
  if (size === 0) return Buffer.alloc(0)
  const out = Buffer.alloc(size)
  readSync(archive.fd, out, 0, size, archive.contentBase + offset)
  return out
}

/** Read one file as UTF-8 text. */
export function readAsarText(archive: AsarArchive, target: string): string | undefined {
  const buf = readAsarFile(archive, target)
  return buf === undefined ? undefined : buf.toString('utf8')
}

/** Whether a path exists in the archive. */
export function hasAsarPath(archive: AsarArchive, target: string): boolean {
  return findNode(archive, target) !== undefined
}

/**
 * List immediate children of one directory.
 *
 * @param archive - an open archive.
 * @param target - directory path; pass `''` for the root.
 * @returns `[name, node]` pairs in insertion order.
 */
export function listAsarDir(archive: AsarArchive, target: string): Array<[string, AsarNode]> {
  const node = target.length === 0 ? archive.root : findNode(archive, target)
  return node?.files === undefined ? [] : Object.entries(node.files)
}

/** Whether a node is a directory. */
export function isAsarDir(node: AsarNode | undefined): boolean {
  return node !== undefined && node.files !== undefined
}
