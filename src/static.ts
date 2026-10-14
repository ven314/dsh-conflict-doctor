/**
 * Static profile scanner: reads a PROFILE DIRECTORY on disk and reconstructs the
 * layered composition DSH will build, without booting anything. This is the
 * half that can answer questions no live scan can — a row silently replaced by
 * a later bundle layer, a disable that targets nothing, two installed packages
 * that declare the same tool id, or a peer range the installed package cannot
 * satisfy.
 * @module dsh-conflict-doctor/static
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { satisfies, valid, validRange } from 'semver'
import { parse as parseYaml } from 'yaml'
import { collectHostFacts, readHostSurface } from './hostface.js'
import { evaluateCondition, evaluateExpression } from './expr.js'
import { readClientHalf, type ClientHalfDeclaration } from './realm.js'
import { collectExportSurface, scanPackageSources, type PackageSources } from './source.js'
import type { ExportSurface } from './surface.js'
import type {
  ImportedSymbol,
  PackageSourceFacts,
  PatchInsert,
  PatchLayer,
  PatchOverride,
  ResolvedPackage,
  StaticSnapshot,
  VersionAuthority,
} from './types.js'

/** Caps that keep a pathological package tree from turning an audit into a hang. */
const MAX_FILES_SCANNED = 400
const MAX_FILE_BYTES = 3 * 1024 * 1024
const DEFINE_TOOL_WINDOW = 1200

/** Marker prefix for a `!!js` expression kept verbatim instead of evaluated. */
const JS_EXPRESSION = '!!js '

/**
 * DSH patch files carry `!!js` expressions (host paths, platform predicates,
 * lazily-read env). Static analysis must NOT evaluate them — that would run
 * profile-supplied code inside the audit — so they are captured verbatim as a
 * tagged string. Two expressions that differ stay distinct, which is all the
 * config-comparison detectors need, and the yaml parser stops emitting
 * "unresolved tag" warnings into whatever log the harness is writing.
 */
const jsExpressionTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve(value: string): string {
    return `${JS_EXPRESSION}${value}`
  },
}

/**
 * Record the realm facts a package declares: whether it ships a browser half,
 * and what that half requires.
 *
 * Superseded a version that only recorded a boolean-ish `'client'`. The browser
 * half's `inject` list is what makes the silent-failure check possible on the
 * client side, so the declaration is now carried in full.
 *
 * @param manifest - the package's parsed manifest.
 * @returns the client declaration when `dsh.client` is present, else undefined.
 */
function halvesOf(manifest: Record<string, unknown> | undefined): ClientHalfDeclaration | undefined {
  return readClientHalf(manifest)
}

/**
 * Normalise a patch row's `inject` declaration to a name list.
 *
 * Real patch files write `inject: [webStartup]`. Cordis also accepts an object
 * form, so both are read. Returns undefined when the row declares none, which is
 * distinct from declaring an empty list.
 *
 * @param raw - the raw value from the parsed row.
 * @returns the declared names, or undefined when absent.
 */
function injectNamesOf(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string' && value.length > 0)
  }
  if (raw !== null && typeof raw === 'object') return Object.keys(raw as Record<string, unknown>)
  return undefined
}

/**
 * Resolve a patch row's `disabled` value.
 *
 * Three outcomes, and the difference between them matters:
 *
 * - `true` / `false` literal → decided, and it is what the layer says.
 * - `!!js <expression>` inside the whitelist → decided by real evaluation
 *   (`process.platform === 'win32'` is a plain string comparison).
 * - anything else, including `!!js` we refuse to evaluate → NOT decidable. The
 *   row is treated as enabled, exactly as before, but the caller records that
 *   this was a default rather than a fact. Guessing `false` silently is what
 *   produced the wrong baseline; guessing is fine, hiding that we guessed is not.
 *
 * @param raw - the raw `disabled` value from the parsed layer.
 * @returns the effective boolean, plus whether it was actually decided.
 */
function resolveDisabled(raw: unknown): { value: boolean; decidable: boolean } {
  if (raw === true) return { value: true, decidable: true }
  if (raw === false || raw === undefined) return { value: false, decidable: true }
  if (typeof raw !== 'string') return { value: false, decidable: false }

  const expression = raw.startsWith(JS_EXPRESSION) ? raw.slice(JS_EXPRESSION.length) : raw
  const decided = evaluateCondition(expression)
  if (decided === undefined) return { value: false, decidable: false }
  return { value: decided, decidable: true }
}

/** Read and parse JSON, returning undefined instead of throwing. */
function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

/** Read a text file, returning undefined instead of throwing. */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Resolve an installed package directory across the layouts DSH uses. */
function packageDir(profilePath: string, name: string, extraRoots: readonly string[]): string | undefined {
  const roots = [join(profilePath, 'node_modules'), resolve(profilePath, '..', 'node_modules'), ...extraRoots]
  for (const root of roots) {
    const dir = join(root, ...name.split('/'))
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return undefined
}

/** One patch node as parsed from YAML: either an `insert:` list or an id-addressed row. */
function asRows(document: unknown): {
  inserts: Omit<PatchInsert, 'layerIndex'>[]
  overrides: Omit<PatchOverride, 'layerIndex'>[]
} {
  const inserts: Omit<PatchInsert, 'layerIndex'>[] = []
  const overrides: Omit<PatchOverride, 'layerIndex'>[] = []
  if (!Array.isArray(document)) return { inserts, overrides }

  for (const node of document) {
    if (node === null || typeof node !== 'object') continue
    const record = node as Record<string, unknown>
    const insertList = record.insert
    if (Array.isArray(insertList)) {
      for (const row of insertList) {
        if (row === null || typeof row !== 'object') continue
        const item = row as Record<string, unknown>
        if (typeof item.id !== 'string') continue
        const inject = injectNamesOf(item.inject)
        inserts.push({
          rowId: item.id,
          moduleName: typeof item.name === 'string' ? item.name : '(inherited)',
          hasConfig: item.config !== undefined,
          configJson: JSON.stringify(item.config ?? null),
          ...(inject === undefined ? {} : { inject }),
        })
      }
      continue
    }
    if (typeof record.id === 'string') {
      // `disabled` may be a literal boolean, or a `!!js` expression string.
      //
      // Reading it as `record.disabled === true` was WRONG for the expression
      // case: a string is never `=== true`, so every conditional disable was
      // silently read as "enabled". On this Windows machine that meant
      // `disabled: !!js process.platform === 'win32'` on `bash-sandbox` and
      // `tool-bash` was ignored, and the audit believed rows existed that do
      // not. A wrong baseline corrupts every downstream existence check.
      const disabled = resolveDisabled(record.disabled)
      overrides.push({
        rowId: record.id,
        ...(typeof record.name === 'string' ? { moduleName: record.name } : {}),
        disabled: disabled.value,
        ...(disabled.decidable ? {} : { disabledUndecided: true }),
        hasConfig: record.config !== undefined,
        configJson: JSON.stringify(record.config ?? null),
      })
    }
  }
  return { inserts, overrides }
}

/** Recursively list `.js` files under `dir`, bounded by the scan caps. */
/**
 * Extract the tool ids a package declares in its compiled sources.
 *
 * Delegates to the shared source scanner so the same single pass also yields
 * imports and service names. Best-effort by construction: a tool built from a
 * non-literal name is invisible, which is why findings from this scan say
 * "declared in compiled sources" rather than "registered at runtime".
 *
 * @param dir - the package directory.
 * @returns distinct tool ids declared by that package.
 */
export function scanDeclaredToolIds(dir: string): string[] {
  return [...scanPackageSources(dir).tools]
}

/**
 * Read a profile directory and project its composition.
 *
 * @param profilePath - the profile directory (the one holding `package.json`
 *   with `dsh.profile.bundles` and `cordis.patch.yml`).
 * @param extraRoots - additional `node_modules` roots to search for packages.
 * @param liveBundleVersions - versions reported by the live plugin-manager,
 *   which take precedence over anything read from disk.
 * @param allowArchive - read the running host's OWN archive when no live
 *   versions were supplied. Set false for hermetic tests; default true.
 * @returns the static snapshot; missing files are reported as notes, never thrown.
 */
export function collectStatic(
  profilePath: string,
  extraRoots: readonly string[] = [],
  liveBundleVersions?: Readonly<Record<string, string>>,
  allowArchive = true,
): StaticSnapshot {
  const notes: string[] = []
  const layers: PatchLayer[] = []
  const inserts: PatchInsert[] = []
  const overrides: PatchOverride[] = []
  const missingPatchFiles: string[] = []
  const unresolvedBundles: string[] = []
  const jsExpressionLayers: string[] = []
  /** `!!js` occurrences the whitelist interpreter could decide. */
  let decidedExpressions = 0
  /** `!!js` occurrences outside the whitelist, still recorded verbatim. */
  let undecidedExpressions = 0
  const packages: ResolvedPackage[] = []
  const declaredTools: Record<string, string[]> = {}
  const declaredServices: Record<string, string[]> = {}
  const declaredImports: Record<string, Record<string, string[]>> = {}
  const sourceFacts: Record<string, PackageSourceFacts> = {}

  const profileJson = readJson(join(profilePath, 'package.json'))
  if (profileJson === undefined) {
    notes.push(`no readable package.json at ${join(profilePath, 'package.json')}`)
  }

  const bundleNames = (() => {
    const dsh = profileJson?.dsh as Record<string, unknown> | undefined
    const profile = dsh?.profile as Record<string, unknown> | undefined
    const list = profile?.bundles
    return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []
  })()

  const resolvedDirs = new Map<string, string>()

  /** Apply one patch file as the next layer. */
  const applyLayer = (label: string, kind: 'bundle' | 'user', file: string, packageName?: string, version?: string): void => {
    const text = readText(file)
    const index = layers.length
    if (text === undefined) {
      missingPatchFiles.push(packageName === undefined ? file : `${packageName} → ${file}`)
      return
    }
    layers.push({
      index,
      label,
      kind,
      file,
      ...(packageName === undefined ? {} : { packageName }),
      ...(version === undefined ? {} : { version }),
    })
    let document: unknown
    try {
      document = parseYaml(text, { customTags: [jsExpressionTag] })
    } catch (error) {
      notes.push(`patch file could not be parsed: ${file} (${error instanceof Error ? error.message : 'unknown error'})`)
      return
    }
    const parsed = asRows(document)
    for (const row of parsed.inserts) inserts.push({ ...row, layerIndex: index })
    for (const row of parsed.overrides) overrides.push({ ...row, layerIndex: index })
    if (text.includes('!!js')) jsExpressionLayers.push(label)
    // Count each `!!js` occurrence by whether the whitelist interpreter could
    // decide it, so the coverage note reports facts instead of a blanket claim.
    for (const match of text.matchAll(/!!js\s+(\S[^\n]*)/g)) {
      const expression = (match[1] ?? '').trim()
      if (expression.length === 0) continue
      const value = evaluateExpression(expression)
      if (value === undefined) undecidedExpressions += 1
      else decidedExpressions += 1
    }
  }

  for (const name of bundleNames) {
    const dir = packageDir(profilePath, name, extraRoots)
    if (dir === undefined) {
      // Not necessarily broken: the desktop app resolves its own experimental
      // bundles out of the packaged app archive, which no node_modules root
      // holds. Report it as a finding so the user can confirm which it is.
      unresolvedBundles.push(name)
      continue
    }
    resolvedDirs.set(name, dir)
    const manifest = readJson(join(dir, 'package.json'))
    const version = typeof manifest?.version === 'string' ? manifest.version : undefined
    if (manifest !== undefined) {
      const ranges: Record<string, string> = {}
      for (const field of ['dependencies', 'peerDependencies'] as const) {
        const group = manifest[field]
        if (group === null || typeof group !== 'object') continue
        for (const [dep, range] of Object.entries(group as Record<string, unknown>)) {
          if (typeof range === 'string') ranges[dep] = range
        }
      }
      const engines = manifest.engines as Record<string, unknown> | undefined
      const client = halvesOf(manifest)
      packages.push({
        name,
        version: version ?? '0.0.0',
        dir,
        ranges,
        ...(typeof engines?.node === 'string' ? { enginesNode: engines.node } : {}),
        ...(client === undefined ? {} : { halves: 'client' as const, client }),
      })
    }
    const dsh = manifest?.dsh as Record<string, unknown> | undefined
    const bundle = dsh?.bundle as Record<string, unknown> | undefined
    const patchRel = typeof bundle?.patch === 'string' ? bundle.patch : undefined
    if (patchRel === undefined) {
      notes.push(`bundle "${name}" declares no dsh.bundle.patch; it contributes no rows`)
      continue
    }
    applyLayer(`bundle ${name}${version === undefined ? '' : `@${version}`}`, 'bundle', resolve(dir, patchRel), name, version)
  }

  applyLayer('user patch', 'user', join(profilePath, 'cordis.patch.yml'))

  // One source pass per loaded package yields three facts at once: the tool ids
  // it declares, the service names it registers, and the host symbols it
  // imports. Only packages the composition actually loads are scanned, so the
  // report stays about this profile rather than about everything in the store.
  const scanned = new Set<string>()
  const knownPackages = new Set(packages.map((entry) => entry.name))
  const scannedFacts = new Map<string, PackageSources>()
  for (const row of inserts) {
    const moduleName = row.moduleName
    if (moduleName === '(inherited)' || scanned.has(moduleName)) continue
    scanned.add(moduleName)
    const dir = resolvedDirs.get(moduleName) ?? packageDir(profilePath, moduleName, extraRoots)
    if (dir === undefined) continue
    resolvedDirs.set(moduleName, dir)
    if (!knownPackages.has(moduleName)) {
      knownPackages.add(moduleName)
      const manifest = readJson(join(dir, 'package.json'))
      if (manifest !== undefined) {
        const ranges: Record<string, string> = {}
        for (const field of ['dependencies', 'peerDependencies'] as const) {
          const group = manifest[field]
          if (group === null || typeof group !== 'object') continue
          for (const [dep, range] of Object.entries(group as Record<string, unknown>)) {
            if (typeof range === 'string') ranges[dep] = range
          }
        }
        const engines = manifest.engines as Record<string, unknown> | undefined
        const client = halvesOf(manifest)
        packages.push({
          name: moduleName,
          version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
          dir,
          ranges,
          ...(typeof engines?.node === 'string' ? { enginesNode: engines.node } : {}),
          ...(client === undefined ? {} : { halves: 'client' as const, client }),
        })
      }
    }

    const facts = scanPackageSources(dir)
    scannedFacts.set(moduleName, facts)
    for (const tool of facts.tools) {
      const owners = declaredTools[tool] ?? (declaredTools[tool] = [])
      if (!owners.includes(moduleName)) owners.push(moduleName)
    }
    for (const service of facts.services) {
      const owners = declaredServices[service] ?? (declaredServices[service] = [])
      if (!owners.includes(moduleName)) owners.push(moduleName)
    }
    const importsCopy: Record<string, string[]> = {}
    for (const [module, symbols] of Object.entries(facts.imports)) importsCopy[module] = [...symbols]
    declaredImports[moduleName] = importsCopy
  }

  // Verify every declared import against the installed package's real export
  // surface. This is the difference between "the version string matches" and
  // "the symbol the plugin imports actually exists here".
  //
  // Surfaces from the running host are cached per module: each uncached read
  // opens the 121 MB archive, and a profile importing the same host package
  // from dozens of plugins would otherwise pay that cost every time.
  const hostSurfaceCache = new Map<string, ExportSurface | undefined>()
  const readHostSurfaceCached = (name: string): ExportSurface | undefined => {
    if (hostSurfaceCache.has(name)) return hostSurfaceCache.get(name)
    let surface: ExportSurface | undefined
    try {
      surface = readHostSurface(name)
    } catch {
      surface = undefined
    }
    hostSurfaceCache.set(name, surface)
    return surface
  }
  // Consult the running host when the disk is not authoritative, or when there
  // is nothing to compare against at all.
  const preferHostSurface = allowArchive !== false

  for (const [moduleName, imports] of Object.entries(declaredImports)) {
    const unchecked: ImportedSymbol[] = []
    const unverifiable: ImportedSymbol[] = []
    let verified = 0
    const importFiles: Array<[string, readonly string[]]> = []
    for (const [module, symbols] of Object.entries(imports)) importFiles.push([module, symbols])

    for (const [module, symbols] of importFiles) {
      const depDir = resolvedDirs.get(module) ?? packageDir(profilePath, module, extraRoots)
      if (depDir === undefined) {
        for (const symbol of symbols) unverifiable.push({ module, symbol, file: '(package not resolvable)' })
        continue
      }
      resolvedDirs.set(module, depDir)

      // Prefer the RUNNING host's export surface over the disk copy. A packaged
      // app serves bundles from its own archive, so the copy in this profile
      // tree can be a whole generation behind: resolving imports against it is
      // exactly how this tool once reported seven missing symbols that were
      // present in the host actually running.
      const hostSurface = preferHostSurface ? (hostSurfaceCache.get(module) ?? readHostSurfaceCached(module)) : undefined
      if (hostSurface !== undefined) hostSurfaceCache.set(module, hostSurface)
      const fromDisk = collectExportSurface(depDir)
      const surface = hostSurface ?? fromDisk
      const origin = hostSurface !== undefined ? 'running host' : 'profile node_modules'

      for (const symbol of symbols) {
        if (surface.names.has(symbol)) verified += 1
        // Only ever called absent from a COMPLETE surface. An incomplete one may
        // be missing names through truncation, so it can never prove absence.
        else if (surface.complete) unchecked.push({ module, symbol, file: `${moduleName} → ${module} (${origin})` })
        else unverifiable.push({ module, symbol, file: `${moduleName} → ${module} (${origin})` })
      }
    }
    sourceFacts[moduleName] = {
      name: moduleName,
      uncheckedImports: unchecked,
      unverifiable,
      verified,
      filesScanned: scannedFacts.get(moduleName)?.filesScanned ?? 0,
    }
  }

  for (const name of ['yaml', 'semver']) {
    if (packageDir(profilePath, name, extraRoots) === undefined) {
      notes.push(`optional dependency "${name}" is not installed in this profile tree`)
    }
  }

  if (jsExpressionLayers.length > 0) {
    // The note used to claim every `!!js` was unevaluated. That is no longer
    // true: a whitelist interpreter now decides the pure ones (platform
    // comparisons, literal defaults), which is how the wrong `disabled`
    // baseline was found. What remains undecided still needs disclosing, so the
    // count of each is reported rather than a blanket statement.
    notes.push(
      `${jsExpressionLayers.length} 个 patch 层含 !!js 表达式（${jsExpressionLayers.join(', ')}）：` +
        `其中 ${decidedExpressions} 个已由白名单解释器判定（仅限字面量与 process.platform/arch 比较，不求值任意代码），` +
        `另有 ${undecidedExpressions} 个超出白名单、仍按原样记录。` +
        '超出白名单的情况（属性链、函数调用、模板字符串）仍无法判定真假，相关行按「未停用」处理。',
    )
  }

  const hostVersion = (() => {
    const base = layers.find((entry) => entry.packageName === '@deepseek-ai/dsh-base')
    return base?.version
  })()

  // Decide whether these on-disk versions describe the RUNNING host. A packaged
  // desktop app serves its bundles from its own archive while this directory
  // may hold an older generation; reporting peer/import conflicts against the
  // stale copy invents failures that do not exist.
  //
  // When no live plugin-manager versions were supplied, consult the running
  // host's archive directly. That is what turns "abstain" into "compare against
  // what actually runs" — the point of W1. It is skipped when `allowArchive` is
  // false so unit tests stay hermetic and predictable.
  let archiveVersions: Record<string, string> | undefined
  let archiveOrigin: string | undefined
  if (liveBundleVersions === undefined && allowArchive !== false) {
    try {
      const facts = collectHostFacts()
      if (facts !== undefined) {
        archiveVersions = Object.fromEntries(facts.bundles)
        archiveOrigin = facts.origin
        notes.push(...facts.notes)
      } else {
        // W1-16: no archive is a COVERAGE GAP, not a silent no-op. Saying
        // nothing here would leave the reader believing version-sensitive
        // checks ran and found nothing, when in fact they never ran.
        notes.push(
          '运行宿主的 archive 没有找到（非打包安装，或安装在未知位置）：peer 范围与导入符号这两类「必须与运行宿主逐条比对」的检查不可判定，' +
            '只输出不依赖版本的结构类结论。设置 DSH_INSTALL_ROOT 或 DSH_APP_ASAR 可指定安装位置。',
        )
      }
    } catch (error) {
      notes.push(
        `运行宿主的 archive 读取失败，因此版本敏感的结论不可判定：` + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const authority = resolveVersionAuthority(hostVersion, liveBundleVersions, archiveVersions)

  return {
    profilePath,
    layers,
    inserts,
    overrides,
    missingPatchFiles,
    unresolvedBundles,
    packages,
    declaredTools,
    declaredServices,
    declaredImports,
    sourceFacts,
    ...(hostVersion === undefined ? {} : { hostVersion }),
    versionAuthority: authority.verdict,
    ...(authority.reason === undefined ? {} : { versionAuthorityReason: authority.reason }),
    ...(archiveVersions === undefined ? {} : { hostBundleVersions: archiveVersions }),
    ...(archiveOrigin === undefined ? {} : { hostOrigin: archiveOrigin }),
    notes,
  }
}

/**
 * Compare the profile's on-disk core version against the running host's.
 *
 * Exported so the verdict can be unit-tested directly, and so callers can
 * explain it without re-deriving the rule.
 *
 * Four verdicts, and the fourth is why W1 exists. Historically there were three
 * and `stale-disk` meant "abstain": on a packaged desktop install the disk holds
 * one generation while the app runs another, so every version comparison was
 * suppressed — including the import check that catches a plugin calling an API
 * the host does not export. `archive-authoritative` replaces that abstention by
 * reading the running host's own archive and comparing against IT.
 *
 * @param diskHostVersion - `@deepseek-ai/dsh-base` version found on disk.
 * @param liveBundleVersions - versions reported by the live plugin-manager.
 * @param archiveVersions - versions read from the running host's archive.
 * @returns the verdict plus its explanation.
 */
export function resolveVersionAuthority(
  diskHostVersion: string | undefined,
  liveBundleVersions?: Readonly<Record<string, string>>,
  archiveVersions?: Readonly<Record<string, string>>,
): { verdict: VersionAuthority; reason?: string } {
  const liveHost = liveBundleVersions?.['@deepseek-ai/dsh-base']
  const archiveHost = archiveVersions?.['@deepseek-ai/dsh-base']

  // A live plugin-manager reading equal to disk is the strongest evidence.
  if (liveHost !== undefined && diskHostVersion !== undefined && liveHost === diskHostVersion) {
    return { verdict: 'authoritative' }
  }

  // The disk disagrees with the running host, but the running host's own archive
  // was read: version-sensitive detectors may run against THAT baseline.
  if (archiveHost !== undefined && diskHostVersion !== undefined && archiveHost !== diskHostVersion) {
    return {
      verdict: 'archive-authoritative',
      reason:
        `${profileVersionSource()} 里的 @deepseek-ai/dsh-base 是 ${diskHostVersion}，而运行中的宿主是 ${archiveHost}（打包应用自带 ` +
        `archive，已直接读取）：磁盘副本不是同一代，因此版本敏感的结论以运行宿主为准，而不是像过去那样整体跳过。`,
    }
  }
  if (archiveHost !== undefined && diskHostVersion === undefined) {
    return {
      verdict: 'archive-authoritative',
      reason:
        `磁盘上没有解析到 @deepseek-ai/dsh-base，但读到了运行宿主自带的 ${archiveHost}：` + `版本敏感的结论以运行宿主为准。`,
    }
  }

  if (liveHost !== undefined && diskHostVersion !== undefined && liveHost !== diskHostVersion) {
    return {
      verdict: 'stale-disk',
      reason:
        `运行中的宿主是 ${liveHost}（打包应用自带），而 ${profileVersionSource()} 里的 @deepseek-ai/dsh-base 是 ${diskHostVersion}：` +
        `两者不是同一代。版本敏感的结论（peer 范围、导入符号）已按「不可判定」跳过，避免用旧副本比对出并不存在的冲突。`,
    }
  }

  return {
    verdict: 'unknown',
    reason:
      liveBundleVersions === undefined
        ? 'live bundle versions were unavailable, so on-disk versions could not be confirmed against the running host'
        : 'the host version could not be read from both the disk and the live host',
  }
}

/** Human label for where the on-disk versions came from. */
function profileVersionSource(): string {
  return 'profiles/node_modules'
}

/**
 * Check whether an installed version satisfies a declared range.
 *
 * @param installed - the version installed in the profile tree.
 * @param range - the declared range; non-registry ranges are skipped.
 * @returns `undefined` when the range cannot be judged, else the verdict.
 */
export function satisfiesRange(installed: string | undefined, range: string): boolean | undefined {
  if (installed === undefined || valid(installed) === null) return undefined
  if (range.trim().length === 0) return undefined
  if (/^(workspace|catalog|file|link|portal|npm):/.test(range)) return undefined
  if (range === '*' || range === 'latest') return undefined
  if (validRange(range) === null) return undefined
  return satisfies(installed, range, { includePrerelease: true })
}
