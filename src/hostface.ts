/**
 * Read the running host's bundled packages straight out of its Electron
 * archive, so symbol comparisons can be made against what ACTUALLY executes.
 *
 * A packaged desktop app serves its profile bundles from its own archive while
 * `profiles/node_modules` can hold an entirely different generation. Comparing
 * a plugin's imports against the disk copies is how this project once invented
 * seven conflicts that did not exist, so every read here resolves inside the
 * archive instead.
 *
 * The result is always optional: when no archive exists (a plain npm install,
 * CI, or an unpacked layout) these functions return undefined and the caller
 * falls back, rather than pretending to have evidence.
 *
 * @module dsh-conflict-doctor/hostface
 */
import { closeAsar, hasAsarPath, listAsarDir, openAsar, readAsarText, type AsarArchive } from './asar.js'
import { findHostRoot, resolveModulesRoot, type HostRoot } from './hostroot.js'
import { collectSurface, type ExportSurface, type SurfaceSource } from './surface.js'

/** One bundle as the RUNNING host has it. */
export interface HostBundle {
  readonly name: string
  readonly version: string
  /** Directory inside the archive, slash-separated. */
  readonly dir: string
  /** Free-text reason when the version could not be read. */
  readonly note?: string
}

/** Everything learned about the running host in one read. */
export interface HostFacts {
  /** Where the host was found, for the report's coverage note. */
  readonly origin: string
  /** Bundle name → version for every bundle the archive contains. */
  readonly bundles: ReadonlyMap<string, string>
  /** True when every contributing read completed within budget. */
  readonly complete: boolean
  /** Notes about anything skipped or unreadable. */
  readonly notes: readonly string[]
}

/** Adapter exposing one archive through the surface walker's reader contract. */
function archiveSource(archive: AsarArchive): SurfaceSource {
  return {
    readText: (path) => {
      try {
        return readAsarText(archive, path)
      } catch {
        return undefined
      }
    },
    hasFile: (path) => {
      try {
        return hasAsarPath(archive, path)
      } catch {
        return false
      }
    },
    hasDir: (path) => {
      try {
        return listAsarDir(archive, path).length > 0 || hasAsarPath(archive, path)
      } catch {
        return false
      }
    },
    listDir: (path) => listAsarDir(archive, path).map(([name]) => name),
  }
}

/** Normalise `@scope/name` → the archive path for its directory. */
function packageDir(root: string, modulesRoot: string, name: string): string {
  return `${root}/${modulesRoot}/${name}`.replace(/\/{2,}/g, '/')
}

/**
 * Open the running host's archive.
 *
 * @returns the archive and its root, or undefined when there is nothing to open.
 */
export function openHostArchive(): { archive: AsarArchive; root: HostRoot } | undefined {
  const root = findHostRoot()
  if (root === undefined || root.kind !== 'asar' || root.archivePath === undefined) return undefined
  try {
    return { archive: openAsar(root.archivePath), root }
  } catch {
    // A unreadable archive is a coverage gap, never a crash: fall back silently
    // and let the caller say so in the report.
    return undefined
  }
}

/**
 * Read every bundled package version the running host ships.
 *
 * This is the authoritative replacement for reading versions off disk, and it
 * is what lets version-sensitive detectors stop abstaining.
 *
 * @returns the facts, or undefined when no host archive is available.
 */
export function collectHostFacts(): HostFacts | undefined {
  const opened = openHostArchive()
  if (opened === undefined) return undefined
  const { archive, root } = opened
  const notes: string[] = []
  const bundles = new Map<string, string>()
  let complete = true

  try {
    const rootDir = `${root.modulesRoot}`.replace(/\/{2,}/g, '/')
    // Scoped namespaces (@scope) hold a second level of package directories.
    for (const [name] of listAsarDir(archive, rootDir)) {
      const child = `${rootDir}/${name}`
      if (name.startsWith('@')) {
        for (const [scoped] of listAsarDir(archive, child)) {
          const version = readVersion(archive, `${child}/${scoped}`)
          if (version !== undefined) bundles.set(`${name}/${scoped}`, version)
        }
        continue
      }
      const version = readVersion(archive, child)
      if (version !== undefined) bundles.set(name, version)
    }
  } catch (error) {
    complete = false
    notes.push(`the running host's bundle versions could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }

  closeAsar(archive)
  return { origin: root.note ?? root.path, bundles, complete, notes }
}

/** Read one package's version from its manifest inside the archive. */
function readVersion(archive: AsarArchive, dir: string): string | undefined {
  const text = readAsarText(archive, `${dir}/package.json`)
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Read one package's export surface FROM THE RUNNING HOST.
 *
 * @param name - package name, e.g. `@deepseek-ai/dsh-tools`.
 * @returns the surface, or undefined when the package is not in this host.
 */
export function readHostSurface(name: string): ExportSurface | undefined {
  const opened = openHostArchive()
  if (opened === undefined) return undefined
  const { archive, root } = opened
  try {
    const dir = packageDir('', root.modulesRoot, name).replace(/^\//, '')
    const manifestText = readAsarText(archive, `${dir}/package.json`)
    if (manifestText === undefined) return undefined
    let manifest: Record<string, unknown> = {}
    try {
      manifest = JSON.parse(manifestText) as Record<string, unknown>
    } catch {
      // A broken manifest still allows the directory-union fallback.
    }
    return collectSurface(archiveSource(archive), dir, manifest)
  } finally {
    closeAsar(archive)
  }
}

/** Whether a bundle exists in the running host at all. */
export function hostHasBundle(name: string): boolean {
  const opened = openHostArchive()
  if (opened === undefined) return false
  const { archive, root } = opened
  try {
    return hasAsarPath(archive, packageDir('', root.modulesRoot, name).replace(/^\//, ''))
  } finally {
    closeAsar(archive)
  }
}

export { findHostRoot, resolveModulesRoot }
