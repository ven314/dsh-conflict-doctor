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
 * Find the end of the root JSON object by scanning BYTES, not characters.
 *
 * The u32 header field is NOT reliable for locating the tree in modern Electron
 * archives. On a real 121 MB `app.asar` it reports 3392056 while the tree JSON
 * actually continues past that point — the tree ends with keys the size field
 * does not account for, so slicing at `headerSize` yields a truncated parse
 * ("Unterminated string") that looks like corruption.
 *
 * Scanning bytes is safe here: every structural character (`"`, `{`, `}`, `[`,
 * `]`, `\`) is ASCII, and UTF-8 guarantees no byte of a multi-byte sequence can
 * equal an ASCII value. So a byte scan cannot be desynchronised by CJK content,
 * and it avoids materialising a many-megabyte string just to measure it.
 *
 * @param buf - buffer whose first byte is the `{` of the tree.
 * @param limit - number of valid bytes in `buf`.
 * @returns the index just past the root object, or -1 when still unbalanced.
 */
function endOfJsonTreeBytes(buf: Buffer, limit: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < limit; i += 1) {
    const ch = buf[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === 0x5c) escaped = true
      else if (ch === 0x22) inString = false
      continue
    }
    if (ch === 0x22) inString = true
    else if (ch === 0x7b || ch === 0x5b) depth += 1
    else if (ch === 0x7d || ch === 0x5d) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** Extra bytes to assume beyond `headerSize` on the first read attempt. */
const INITIAL_SCAN_SLACK_BYTES = 256 * 1024

/** Hard ceiling on how far past `headerSize` the tree may extend. */
const MAX_SCAN_SLACK_BYTES = 64 * 1024 * 1024

/**
 * Decode the pickled header of an asar file.
 *
 * Reads in a growing window rather than one huge slurp. The first attempt covers
 * `headerSize` plus a small slack, which on the real 121 MB archive is a single
 * ~3.6 MB read; the window only doubles if the JSON is still unbalanced. An
 * earlier version always read `headerSize + 64 MB`, which made a cold audit
 * spend seconds copying bytes it then threw away.
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

    // The u32 at byte 4 is the header size FIELD. It bounds the first read, but
    // not where the tree ends — see {@link endOfJsonTreeBytes}.
    const headerSize = prefix.readUInt32LE(4)
    if (headerSize <= 0 || headerSize > MAX_HEADER_BYTES) {
      throw new Error(`implausible asar header size ${headerSize} for ${stat.size} bytes`)
    }

    const available = stat.size - HEADER_PREFIX_BYTES
    if (available <= 0) throw new Error(`asar too small to contain a tree: ${stat.size} bytes`)

    let window = Math.min(headerSize + INITIAL_SCAN_SLACK_BYTES, available)
    let buf = Buffer.alloc(window)
    let end = -1

    for (;;) {
      readSync(fd, buf, 0, window, HEADER_PREFIX_BYTES)
      end = endOfJsonTreeBytes(buf, window)
      if (end >= 0) break
      if (window >= available) throw new Error('asar tree JSON is unbalanced through the end of the file')
      const ceiling = Math.min(headerSize + MAX_SCAN_SLACK_BYTES, available)
      if (window >= ceiling) throw new Error('asar tree JSON is unbalanced beyond the scan budget')
      window = Math.min(window * 2, ceiling)
      buf = Buffer.alloc(window)
    }

    const root = JSON.parse(buf.subarray(0, end).toString('utf8')) as AsarNode
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
