/**
 * Live capability-graph collector: projects the RUNNING Cordis process into a
 * plain snapshot. Reads only public service lookups plus two documented Loader
 * and Fiber fields; every unreadable fact becomes a note instead of a throw, so
 * an audit never takes the harness down.
 * @module dsh-conflict-doctor/live
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FiberPhase, LiveEntry, LiveProvided, LiveService, LiveSnapshot } from './types.js'

/** Runtime mirror of the Cordis `FiberState` const enum (const enums have no runtime object). */
const PHASE: Readonly<Record<number, FiberPhase>> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/** Minimal structural views of the cordis internals we are allowed to read. */
interface FiberLike {
  state?: number
  inject?: Record<string, unknown>
  runtime?: { name?: string; provide?: unknown }
  entry?: { id?: string }
  name?: string
  _error?: unknown
}

interface EntryLike {
  id?: string
  disabled?: boolean
  options?: { name?: string; group?: unknown; inject?: unknown }
  fiber?: FiberLike
}

interface ServiceImplLike {
  name?: string
  fiber?: FiberLike
}

/** Read a property without trusting the shape (the audit must never throw). */
function read(target: unknown, key: string): unknown {
  if (target === null || typeof target !== 'object') return undefined
  return (target as Record<string, unknown>)[key]
}

/** Normalize cordis's array-or-map `inject` declaration to a name list. */
function injectNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((name): name is string => typeof name === 'string')
  if (value !== null && typeof value === 'object') return Object.keys(value as Record<string, unknown>)
  return []
}

/** Normalize cordis's `provide` declaration (string | string[]) to a name list. */
function provideNames(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value]
  if (Array.isArray(value)) return value.filter((name): name is string => typeof name === 'string')
  return []
}

/** Turn a possibly-hostile thrown value into one readable line. */
function errorText(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined
  try {
    if (error instanceof Error) return error.message
    return String(error)
  } catch {
    return '<unprintable error>'
  }
}

/** Every live service implementation, keyed by the symbol Cordis stores it under. */
function serviceImpls(ctx: Context): ServiceImplLike[] {
  const store = read(read(ctx, 'reflect'), 'store')
  if (store === null || typeof store !== 'object') return []
  return Reflect.ownKeys(store)
    .map((key) => (store as Record<symbol, unknown>)[key as symbol])
    .filter((impl): impl is ServiceImplLike => impl !== null && typeof impl === 'object')
}

/** Entry id owning a fiber, when the loader recorded one. */
function entryIdOf(fiber: FiberLike | undefined): string | undefined {
  const id = read(read(fiber, 'entry'), 'id')
  return typeof id === 'string' ? id : undefined
}

/** Display owner for one implementation: plugin name, else entry id, else `root`. */
function ownerOf(fiber: FiberLike | undefined): string {
  const runtimeName = read(read(fiber, 'runtime'), 'name')
  if (typeof runtimeName === 'string' && runtimeName.length > 0) return runtimeName
  const fiberName = read(fiber, 'name')
  if (typeof fiberName === 'string' && fiberName.length > 0) return fiberName
  return entryIdOf(fiber) ?? 'root'
}

/**
 * Project the running process.
 *
 * @param ctx - the live context (`ctx.tools` is the only hard requirement).
 * @returns the live snapshot, with a note for every fact that could not be read.
 */
export function collectLive(ctx: Context): LiveSnapshot {
  const notes: string[] = []
  const services: LiveService[] = []
  const impls = serviceImpls(ctx)

  for (const impl of impls) {
    if (typeof impl.name !== 'string') continue
    const entryId = entryIdOf(impl.fiber)
    services.push({
      service: impl.name,
      owner: ownerOf(impl.fiber),
      ...(entryId === undefined ? {} : { entryId }),
    })
  }

  const providedNames = new Set(services.map((entry) => entry.service))

  const loader = ctx.get('loader' as never) as unknown as { entries?: () => Iterable<EntryLike> } | undefined
  const entries: LiveEntry[] = []
  const declaredProvides: LiveProvided[] = []

  if (loader === undefined || typeof loader.entries !== 'function') {
    notes.push(
      'service "loader" is unavailable: the live Loader tree could not be read (a non-Loader composition, e.g. headless or SDK, has no entry tree)',
    )
  } else {
    for (const entry of loader.entries()) {
      const fiber = entry.fiber
      const declaredInject = fiber === undefined ? injectNames(read(entry.options, 'inject')) : injectNames(read(fiber, 'inject'))
      const missing = declaredInject.filter((name) => ctx.get(name as never) === undefined)
      const provides =
        fiber === undefined
          ? []
          : impls.filter((impl) => impl.fiber === fiber && typeof impl.name === 'string').map((impl) => impl.name as string)

      const state = read(fiber, 'state')
      const error = errorText(read(fiber, '_error'))
      const entryId = typeof entry.id === 'string' ? entry.id : '(anonymous)'
      const moduleName = typeof read(entry.options, 'name') === 'string' ? (read(entry.options, 'name') as string) : '(unknown)'

      // The plugin's own declaration of what it provides. Reading this
      // distinguishes "nobody provides this service" from "the provider is the
      // very plugin that is stuck" — a self-inflicted PENDING cycle, which is a
      // different diagnosis with a different fix.
      const declaredProvide =
        fiber === undefined
          ? read(entry.options, 'provide')
          : (read(read(fiber, 'runtime'), 'provide') ?? read(entry.options, 'provide'))
      for (const service of provideNames(declaredProvide)) declaredProvides.push({ service, entryId, moduleName })

      entries.push({
        entryId,
        moduleName,
        enabled: entry.disabled !== true,
        group: read(entry.options, 'group') === true,
        fiberPhase: fiber === undefined ? null : (PHASE[typeof state === 'number' ? state : 0] ?? null),
        ...(fiber === undefined ? {} : { pluginName: ownerOf(fiber) }),
        inject: declaredInject,
        missingInject: missing,
        provides,
        ...(error === undefined ? {} : { errorText: error }),
      })
    }
  }

  let tools: string[] = []
  try {
    tools = ctx.tools.schemas().map((schema) => schema.name)
  } catch (error) {
    notes.push(`tool registry could not be read: ${errorText(error) ?? 'unknown error'}`)
  }

  return { entries, services, declaredProvides, tools, notes }
}

/** Re-exported for detectors that need the same membership test. */
export function hasService(snapshot: LiveSnapshot, name: string): boolean {
  return snapshot.services.some((entry) => entry.service === name)
}
