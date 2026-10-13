/**
 * Collect a package's EXPORT SURFACE — the names a plugin is allowed to import
 * — reading from whichever medium actually holds the running host.
 *
 * This is what makes version-sensitive checks trustworthy on a packaged
 * desktop install. Reading `profiles/node_modules` compares a plugin against a
 * host that is not running, which is how this project once reported seven
 * missing symbols that were present after all.
 *
 * Sources, in order of trust:
 *
 *   1. a `.d.ts` entry — declares intent exactly, no ESM/CJS ambiguity;
 *   2. the `.js` entry listed by `exports`/`main` — for packages shipping no types;
 *   3. the directory union — last resort, flagged incomplete.
 *
 * The result is always an OVER-approximation: a name exported from ANY file in
 * the package counts. That bias is deliberate. A false "missing symbol" makes
 * the user chase a conflict that does not exist, while a missed detection only
 * costs coverage; for a diagnostics tool those errors are not symmetric.
 *
 * @module dsh-conflict-doctor/surface
 */

/** Whether every file contributing to the surface was read. */
export interface ExportSurface {
  /** Exported names found anywhere in the package. */
  readonly names: ReadonlySet<string>
  /**
   * False when a budget cap truncated the walk. An incomplete surface may be
   * missing names, so it must never be used to claim a symbol is absent.
   */
  readonly complete: boolean
  /** Files actually read — coverage evidence for the report. */
  readonly filesScanned: number
  /** How the surface was obtained, for the report's coverage note. */
  readonly source: 'types' | 'js-entry' | 'directory-union'
  /** Entry file used, when one was resolved. */
  readonly entry?: string
}

/** Caps that keep one pathological package from turning an audit into a hang. */
const DEFAULT_BUDGET = {
  /** Maximum files to read while following the import closure. */
  maxFiles: 200,
  /** Maximum bytes per file; larger files are skipped, not truncated. */
  maxFileBytes: 4 * 1024 * 1024,
  /** Maximum depth for following relative re-exports. */
  maxDepth: 12,
}

export type SurfaceBudget = typeof DEFAULT_BUDGET

/**
 * A readable slice of whichever store the host lives in.
 *
 * Both implementations resolve slash-separated relative paths within one
 * package directory, so the surface walker needs no knowledge of archives.
 */
export interface SurfaceSource {
  /** Read a file as UTF-8, or undefined when absent/unreadable. */
  readText(path: string): string | undefined
  /** Whether a path exists as a file. */
  hasFile(path: string): boolean
  /** Whether a path exists as a directory. */
  hasDir(path: string): boolean
  /** Files immediately inside `dir` (names only). Optional. */
  listDir?(dir: string): readonly string[]
  /** Resolve a module specifier for this store, if supported. */
  resolveEntry?(pkgRoot: string, subpath: string): string | undefined
}

/* ------------------------------------------------------------------ parsing */

/** `export { a, b as c, d }` — capture plain AND aliased names independently. */
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g
/** `export const|let|var|function|class|async function NAME` */
const EXPORT_DECLARATION = /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g
/** `export default` contributes the literal name `default`. */
const EXPORT_DEFAULT = /\bexport\s+default\b/g
/** `import { x, y } from './rel'` — follow relative re-export chains. */
const IMPORT_FROM = /\bimport\s*(?:[^'"]*?)\s*from\s*['"](\.[^'"]*)['"]/g
/** `export * from './rel'` */
const EXPORT_STAR_FROM = /\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g
/** `export { x } from './rel'`. */
const EXPORT_NAMED_FROM = /\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
/** CJS: `exports.foo =` */
const CJS_ASSIGN = /\bexports\.([A-Za-z_$][\w$]*)\s*=/g
/** CJS: `module.exports = { foo, bar }` */
const CJS_OBJECT = /\bmodule\.exports\s*=\s*\{([^}]*)\}/g
/** CJS: `Object.defineProperty(exports, 'foo', ...)`. */
const CJS_DEFINE_PROPERTY = /\bObject\.defineProperty\(\s*exports\s*,\s*['"]([^'"]+)['"]/g
/** TypeScript/ESM `declare const x` style `.d.ts` declarations. */
const DECLARATION = /\bdeclare\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g

/**
 * Collect exported names from one file's text.
 *
 * @param text - source text.
 * @param out - set to accumulate into.
 */
function collectFromFileText(text: string, out: Set<string>): void {
  let match: RegExpExecArray | null

  // Named export lists. Each comma-separated entry is parsed INDEPENDENTLY: a
  // list mixing plain and aliased names (`export { A, B as default, C }`) must
  // contribute all three — treating the whole list as aliases silently drops
  // A and C, which this project has actually done once.
  EXPORT_LIST.lastIndex = 0
  while ((match = EXPORT_LIST.exec(text)) !== null) {
    for (const part of (match[1] ?? '').split(',')) {
      const segments = part.trim().split(/\s+as\s+/)
      const exported = (segments.length > 1 ? segments[1] : segments[0])?.trim()
      if (exported !== undefined && /^[A-Za-z_$][\w$]*$/.test(exported)) out.add(exported)
    }
  }

  EXPORT_DECLARATION.lastIndex = 0
  while ((match = EXPORT_DECLARATION.exec(text)) !== null) {
    if (match[1] !== undefined) out.add(match[1])
  }

  if (EXPORT_DEFAULT.test(text)) out.add('default')

  // CJS product shapes. A bundled package is often CJS even when the manifest
  // says `type: module`, or vice versa; read both rather than trusting the field.
  CJS_ASSIGN.lastIndex = 0
  while ((match = CJS_ASSIGN.exec(text)) !== null) {
    if (match[1] !== undefined) out.add(match[1])
  }

  CJS_OBJECT.lastIndex = 0
  while ((match = CJS_OBJECT.exec(text)) !== null) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .split(/\s*:\s*/)[0]
        ?.trim()
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }

  CJS_DEFINE_PROPERTY.lastIndex = 0
  while ((match = CJS_DEFINE_PROPERTY.exec(text)) !== null) {
    if (match[1] !== undefined) out.add(match[1])
  }

  // .d.ts declarations declare exports even when they never write `export`.
  DECLARATION.lastIndex = 0
  while ((match = DECLARATION.exec(text)) !== null) {
    if (match[1] !== undefined) out.add(match[1])
  }
}

/** Append the JS extension candidates that may satisfy a relative specifier. */
function resolveRelative(baseDir: string, specifier: string, source: SurfaceSource): string | undefined {
  const joined = normalizePath(`${baseDir}/${specifier}`)
  const candidates = [joined, `${joined}.js`, `${joined}.mjs`, `${joined}.cjs`, `${joined}/index.js`, `${joined}/index.mjs`]
  for (const candidate of candidates) {
    if (source.hasFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Walk one entry file and its relative re-export closure.
 *
 * @param source - the readable store.
 * @param entry - slash-separated path of the entry file.
 * @param budget - caps.
 * @param seen - visit set, shared with the caller for cycle detection.
 * @param out - name accumulator.
 * @returns how many files were read.
 */
function walkClosure(
  source: SurfaceSource,
  entry: string,
  budget: SurfaceBudget,
  seen: Set<string>,
  files: { count: number },
  out: Set<string>,
): void {
  const stack: Array<{ path: string; depth: number }> = [{ path: entry, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    if (files.count >= budget.maxFiles) return
    // `seen` is the cycle guard: `a` re-exporting `b` re-exporting `a` must not
    // spin, and it must not read one file twice.
    if (seen.has(current.path)) continue
    if (current.depth > budget.maxDepth) continue
    seen.add(current.path)

    const text = source.readText(current.path)
    if (text === undefined) continue
    if (text.length > budget.maxFileBytes) continue
    files.count += 1

    collectFromFileText(text, out)

    const baseDir = current.path.slice(0, current.path.lastIndexOf('/'))

    // `export * from './x'` must be followed: the re-exported names really are
    // part of this package's surface.
    EXPORT_STAR_FROM.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = EXPORT_STAR_FROM.exec(text)) !== null) {
      const specifier = match[1]
      if (specifier === undefined) continue
      const target = resolveRelative(baseDir, specifier, source)
      if (target !== undefined) stack.push({ path: target, depth: current.depth + 1 })
    }

    EXPORT_NAMED_FROM.lastIndex = 0
    while ((match = EXPORT_NAMED_FROM.exec(text)) !== null) {
      const specifier = match[2]
      if (specifier === undefined) continue
      const target = resolveRelative(baseDir, specifier, source)
      if (target !== undefined) stack.push({ path: target, depth: current.depth + 1 })
    }

    IMPORT_FROM.lastIndex = 0
    while ((match = IMPORT_FROM.exec(text)) !== null) {
      const specifier = match[1]
      if (specifier === undefined) continue
      const target = resolveRelative(baseDir, specifier, source)
      if (target !== undefined) stack.push({ path: target, depth: current.depth + 1 })
    }
  }
}

/* ------------------------------------------------------------------- where  */

/**
 * Join a package root with relative manifest paths.
 *
 * Manifest entries are written as `./lib/index.js`, and naive concatenation
 * produces `pkg/./lib/index.js` — a path that resolves on some stores and
 * silently fails on others, which is how this walker once read package.json as
 * its entry and reported every host symbol as missing. Every `.` and `..`
 * segment is therefore collapsed here.
 */
function normalizePath(path: string): string {
  const parts = path.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/**
 * Pick the best entry file for a package, honouring the manifest.
 *
 * @param manifest - parsed package.json.
 * @param source - readable store.
 * @param pkgRoot - root of the package inside the store.
 * @returns the entry path and how it was chosen.
 */
function pickEntry(
  manifest: Record<string, unknown>,
  source: SurfaceSource,
  pkgRoot: string,
): { entry?: string; source: ExportSurface['source'] } {
  const joinPath = (...parts: string[]) => normalizePath(`${pkgRoot}/${parts.join('/')}`)
  // Manifest fields are typed `unknown`, and every caller passes one straight
  // through; narrowing happens inside, where an absent or non-string value is
  // simply "no such entry".
  const exists = (relative: unknown): string | undefined => {
    if (typeof relative !== 'string' || relative.length === 0) return undefined
    const candidate = joinPath(relative)
    return source.hasFile(candidate) ? candidate : undefined
  }

  // `exports` first: a subpath map is authoritative about what is importable,
  // and notably about what is NOT (a symbol reachable internally but absent
  // from `exports` raises ERR_PACKAGE_PATH_NOT_EXPORTED at runtime).
  const exportsField = manifest.exports
  if (exportsField !== null && typeof exportsField === 'object') {
    // Types beat JS within a subpath map: they declare intent without any
    // CJS/ESM ambiguity, and `types` is listed first in well-formed manifests.
    for (const value of Object.values(exportsField as Record<string, unknown>)) {
      if (typeof value === 'string') {
        const candidate = exists(value)
        if (candidate !== undefined) return { entry: candidate, source: candidate.endsWith('.d.ts') ? 'types' : 'js-entry' }
        continue
      }
      if (typeof value !== 'object' || value === null) continue
      const record = value as Record<string, unknown>
      for (const key of ['types', 'import', 'default', 'require']) {
        const candidate = exists(record[key])
        if (candidate !== undefined) {
          return { entry: candidate, source: candidate.endsWith('.d.ts') ? 'types' : 'js-entry' }
        }
      }
    }
  } else if (typeof exportsField === 'string') {
    const candidate = exists(exportsField)
    if (candidate !== undefined) return { entry: candidate, source: 'js-entry' }
  }

  // Types first for the same reason, then `main`.
  for (const key of ['types', 'typings'] as const) {
    const candidate = exists(manifest[key])
    if (candidate !== undefined) return { entry: candidate, source: 'types' }
  }
  const mainEntry = exists(manifest.main)
  if (mainEntry !== undefined) return { entry: mainEntry, source: 'js-entry' }
  if (typeof manifest.main === 'string' && manifest.main.length > 0) {
    const indexEntry = exists(`${manifest.main}/index.js`)
    if (indexEntry !== undefined) return { entry: indexEntry, source: 'js-entry' }
  }

  return { source: 'directory-union' }
}

/* -------------------------------------------------------------------- API   */

/**
 * Collect one package's export surface.
 *
 * @param source - readable store for whichever medium holds the package.
 * @param pkgRoot - slash-separated root of the package.
 * @param manifest - parsed package.json (may be `{}` when unreadable).
 * @param overrides - optional budget caps.
 * @returns the surface plus how it was obtained.
 */
export function collectSurface(
  source: SurfaceSource,
  pkgRoot: string,
  manifest: Record<string, unknown> = {},
  overrides: Partial<SurfaceBudget> = {},
): ExportSurface {
  const budget = { ...DEFAULT_BUDGET, ...overrides }
  const names = new Set<string>()
  const seen = new Set<string>()
  const files = { count: 0 }

  const chosen = pickEntry(manifest, source, pkgRoot)
  if (chosen.entry !== undefined) {
    walkClosure(source, chosen.entry, budget, seen, files, names)
    // A named entry whose closure yielded nothing (e.g. pure re-exports the
    // resolver could not follow) must fall back rather than report an empty
    // surface — an empty surface would claim every symbol is missing.
    if (names.size > 0) {
      return {
        names,
        complete: files.count < budget.maxFiles,
        filesScanned: files.count,
        source: chosen.source,
        entry: chosen.entry,
      }
    }
  }

  // Last resort: union every JS/TS file the listing exposes. Always flagged
  // incomplete — it is a guess about reachability, not a proof.
  unionDirectory(source, pkgRoot, budget, files, names)
  return {
    names,
    complete: false,
    filesScanned: files.count,
    source: 'directory-union',
    ...(chosen.entry === undefined ? {} : { entry: chosen.entry }),
  }
}

/** Accumulate exported names across a directory tree, bounded by the budget. */
function unionDirectory(
  source: SurfaceSource,
  dir: string,
  budget: SurfaceBudget,
  files: { count: number },
  out: Set<string>,
): void {
  if (!source.listDir) return
  // Its own visited sets rather than sharing `seen` with the entry walk: that
  // set tracks FILES while this walk visits DIRECTORIES, so a directory whose
  // name was never recorded as a file got re-pushed forever — an unbounded loop
  // on any flat package of many files.
  const visitedDirs = new Set<string>()
  const visitedFiles = new Set<string>()
  const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    if (files.count >= budget.maxFiles) return
    if (visitedDirs.has(current.path)) continue
    if (current.depth > budget.maxDepth) continue
    visitedDirs.add(current.path)

    for (const name of source.listDir(current.path)) {
      if (files.count >= budget.maxFiles) return
      const child = normalizePath(`${current.path}/${name}`)
      if (source.hasDir(child)) {
        stack.push({ path: child, depth: current.depth + 1 })
        continue
      }
      if (!/\.(js|mjs|cjs|ts)$/.test(name)) continue
      if (visitedFiles.has(child)) continue
      visitedFiles.add(child)
      const text = source.readText(child)
      if (text === undefined || text.length > budget.maxFileBytes) continue
      files.count += 1
      collectFromFileText(text, out)
    }
  }
}

export { DEFAULT_BUDGET }
