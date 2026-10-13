/**
 * dsh-conflict-doctor — plugin conflict governance for DeepSeek Harness.
 *
 * The harness has plenty of ways to tell you a plugin is *installed*. It has no
 * way to tell you a plugin is *not working*: a fiber waiting on a service that
 * nobody provides stays PENDING and logs nothing, a duplicate tool id fails an
 * entire row with an error that never names the other owner, and a later bundle
 * layer silently replaces an earlier layer's `config`. This plugin turns those
 * silent states into a diagnosis with a paste-ready repair.
 *
 * Three layers, one deliverable:
 * 1. capability graph — live Loader entries + fibers + services + tool ids, and
 *    the on-disk patch layers that produced them;
 * 2. conflict detection — ten detectors over that graph, each carrying its own
 *    evidence;
 * 3. repair engine — every finding ships the exact `cordis.patch.yml` fragment
 *    or decision that resolves it.
 *
 * @module dsh-conflict-doctor
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { detect } from './detect.js'
import { collectLive } from './live.js'
import { renderHeadline, renderMarkdown } from './render.js'
import { collectStatic } from './static.js'
import type { AuditReport, AuditScope, Finding } from './types.js'
export const name = 'conflict-doctor'

/**
 * Only `tools` is hard-required. Everything else — the Loader tree, the
 * command registry, the profile path — is read through `ctx.get` at use time,
 * because a diagnostics plugin that parks itself in PENDING on a missing
 * service would be the joke that tells itself.
 */
export const inject = ['tools']

export type { AuditReport, AuditScope, Finding, Fix, Severity } from './types.js'
export { detect } from './detect.js'
export { collectLive } from './live.js'
export { collectStatic, resolveVersionAuthority, scanDeclaredToolIds, satisfiesRange } from './static.js'
export { renderHeadline, renderMarkdown } from './render.js'

/** Where the audit reads the profile from when the caller names nothing. */
export interface AuditOptions {
  /** `live` = running process only, `profile` = disk only, `all` = both. */
  readonly scope?: AuditScope
  /** Profile directory to read; defaults to the running profile. */
  readonly profilePath?: string
  /** Node version to judge `engines.node` against; defaults to `process.version`. */
  readonly nodeVersion?: string
}

/** Resolve the running profile directory from the environment DSH sets. */
export function defaultProfilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.length > 0) return env.DSH_PROFILE_DIR
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  if (typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.length > 0) return join(home, 'profiles', env.DSH_PROFILE)
  return undefined
}

/**
 * Ask the running host which versions its profile bundles actually are.
 *
 * The plugin-manager service is the authority here: a packaged app serves its
 * bundles from its own archive, so `profiles/node_modules` can hold a different
 * generation entirely. Without this read, version-sensitive findings would be
 * computed against the wrong baseline.
 *
 * @param ctx - the host context.
 * @returns bundle name → version, or undefined when the service is unavailable.
 */
async function liveBundleVersions(ctx: Context): Promise<Record<string, string> | undefined> {
  const manager = ctx.get('pluginManager' as never) as unknown as { listBundles?: () => Promise<unknown> } | undefined
  if (manager === undefined || typeof manager.listBundles !== 'function') return undefined
  try {
    const result = await Promise.resolve(manager.listBundles())
    const entries = (result as { entries?: unknown })?.entries
    if (!Array.isArray(entries)) return {}
    const out: Record<string, string> = {}
    for (const entry of entries) {
      const record = entry as { name?: unknown; version?: unknown }
      if (typeof record.name === 'string' && typeof record.version === 'string') out[record.name] = record.version
    }
    return out
  } catch {
    return undefined
  }
}

/**
 * Run one audit (asynchronous so the live host can be consulted first).
 *
 * @param ctx - the live context (used for the live half).
 * @param options - scope, profile path, and Node version overrides.
 * @returns the complete report, never throwing for a missing input: gaps land in `notes`.
 */
export async function runAudit(ctx: Context, options: AuditOptions = {}): Promise<AuditReport> {
  const scope: AuditScope = options.scope ?? 'all'
  const resolvedPath = options.profilePath ?? defaultProfilePath()
  const notes: string[] = []

  const liveSnapshot = scope === 'profile' ? undefined : collectLive(ctx)
  if (liveSnapshot !== undefined) notes.push(...liveSnapshot.notes)

  // Read the RUNNING bundle versions BEFORE the synchronous disk scan, so the
  // scan can refuse to judge versions against a baseline it cannot trust.
  const versions = scope === 'profile' ? undefined : await liveBundleVersions(ctx)
  if (liveSnapshot !== undefined && versions !== undefined) liveSnapshot.bundleVersions = versions

  let profileSnapshot
  if (scope !== 'live') {
    if (resolvedPath === undefined) {
      notes.push('未提供 profilePath，且环境变量 DSH_PROFILE_DIR / DSH_HOME+DSH_PROFILE 都不可用：跳过静态审计')
    } else {
      const extraRoots = [join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules')]
      profileSnapshot = collectStatic(resolvedPath, extraRoots, versions)
      notes.push(...profileSnapshot.notes)
      if (profileSnapshot.versionAuthorityReason !== undefined) {
        notes.push(profileSnapshot.versionAuthorityReason)
      }
    }
  }

  const findings = detect({
    ...(liveSnapshot === undefined ? {} : { live: liveSnapshot }),
    ...(profileSnapshot === undefined ? {} : { profile: profileSnapshot }),
    nodeVersion: options.nodeVersion ?? process.version,
  })

  return {
    generatedAt: new Date().toISOString(),
    profilePath: resolvedPath ?? '(running profile)',
    scope,
    summary: {
      critical: findings.filter((finding) => finding.severity === 'critical').length,
      warning: findings.filter((finding) => finding.severity === 'warning').length,
      info: findings.filter((finding) => finding.severity === 'info').length,
      liveEntries: liveSnapshot?.entries.length ?? 0,
      patchLayers: profileSnapshot?.layers.length ?? 0,
      scannedPackages: profileSnapshot?.packages.length ?? 0,
      declaredTools: Object.keys(profileSnapshot?.declaredTools ?? {}).length,
    },
    findings,
    notes,
  }
}

const TOOL_DESCRIPTION = `Audit the installed DeepSeek Harness plugins for conflicts, and get the exact patch that fixes each one.

Use this when a plugin is installed but does not work, when two plugins might be fighting, when the harness fails to boot after installing something, or before/after installing or disabling a plugin. It answers the question no install-time check can: which two things collide, and what do I change.

What it detects:
- a plugin stuck PENDING because it injects a service no plugin provides (silent, no error, no log);
- a tool id registered by two plugins (the later one fails to load as a whole row, and the error never names the other owner);
- duplicate Loader entry ids (whole-tree boot failure);
- a later patch layer silently replacing an earlier layer's config for the same row;
- a row disabled by one layer and re-inserted by another (the plugin you thought you turned off);
- an override addressing a row that no layer ever inserts (a silent no-op);
- one module mounted under two entry ids (double registration);
- two packages declaring the same tool id in their compiled sources (capability-level collision, invisible to version checks);
- declared dependency ranges and Node engines that the installed tree cannot satisfy;
- bundle patch files that are declared but missing on disk.

Scope: "live" inspects the running process, "profile" reads the profile directory on disk, "all" (default) does both. Prefer "all" unless the user only asks about what is currently loaded.

The report is a diagnosis, not a fix: every finding includes a repair to apply, but this tool changes nothing by itself.`

/**
 * How many turns of model context may carry the alert before it is re-checked.
 * The live half is cheap (a tree walk), so it is re-derived on every assembly;
 * the DISK half costs a filesystem scan of every loaded package, so its result
 * is cached for this many milliseconds. A profile change lands within one
 * window, and the audit tool always re-reads.
 */
const PROFILE_CACHE_MS = 30_000

/**
 * Build the prompt contribution that reports unresolved critical conflicts.
 *
 * Registered as dynamic CONTEXT rather than a static section because its text
 * must be recomputed per assembly, and because an empty string contributes
 * nothing — a healthy profile pays zero tokens for this plugin.
 *
 * The provider is synchronous (the prompt assembler awaits nothing here), so
 * the disk half is cached on a timer while the live half re-derives each time.
 *
 * @param ctx - the host context.
 * @param cache - a mutable cache shared across assemblies.
 * @param versions - live bundle versions, refreshed by the same cache window.
 * @returns the provider function for `systemPrompt.context`.
 */
function criticalContextProvider(
  ctx: Context,
  cache: { at: number; findings: readonly Finding[]; versions?: Readonly<Record<string, string>> },
) {
  return (): string => {
    const live = collectLive(ctx)
    const liveCritical = detect({ live, nodeVersion: process.version }).filter((finding) => finding.severity === 'critical')

    // The disk half costs a filesystem scan of every loaded package, so it is
    // cached; the live half is re-derived on every assembly.
    if (Date.now() - cache.at > PROFILE_CACHE_MS) {
      const profilePath = defaultProfilePath()
      if (profilePath === undefined) {
        cache.findings = []
      } else {
        const extraRoots = [join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules')]
        const snapshot = collectStatic(profilePath, extraRoots, cache.versions)
        cache.findings = detect({ profile: snapshot, nodeVersion: process.version }).filter(
          (finding) => finding.severity === 'critical',
        )
      }
      cache.at = Date.now()
    }

    const all = [...liveCritical, ...cache.findings]
    if (all.length === 0) return ''

    const lines = [
      '# 插件冲突告警（conflict-doctor 自动检测）',
      '',
      `当前组合存在 ${all.length} 个 critical 冲突。这些冲突不会自己报错，但会让插件静默失效：`,
      '',
      ...all
        .slice(0, 8)
        .map((finding) => `- **${finding.title}**（\`${finding.code}\`）→ 修复：${finding.fixes[0]?.label ?? '见报告'}`),
      ...(all.length > 8 ? [`- …以及另外 ${all.length - 8} 个`] : []),
      '',
      '需要完整证据与可粘贴的 patch 时，调用 `conflict_doctor` 工具或让用户执行 `/conflict-doctor`。',
      '在用户提出相关问题前不要主动修改任何插件配置。',
    ]
    return lines.join('\n')
  }
}

/**
 * Register the audit tool, the `/conflict-doctor` command, and the proactive
 * critical-conflict alert.
 *
 * @param ctx - the host context; `tools` must be available.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'conflict_doctor',
          description: TOOL_DESCRIPTION,
          parameters: {
            scope: {
              type: 'string',
              enum: ['live', 'profile', 'all'],
              description: 'Which half of the audit to run. Defaults to "all".',
            },
            profilePath: {
              type: 'string',
              description: 'Profile directory to read for the static half. Defaults to the running profile (DSH_PROFILE_DIR).',
            },
            format: {
              type: 'string',
              enum: ['markdown', 'json'],
              description: 'Response body format for the model-facing text. The structured fields are always returned.',
            },
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                summary: { type: 'json', required: true },
                findings: { type: 'array', items: { type: 'json' }, required: true },
                notes: { type: 'array', items: { type: 'string' }, required: true },
                report: { type: 'string', required: true },
                profilePath: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
            render: (_args, value) => {
              const record = value as unknown as { report?: unknown }
              return [{ type: 'text', text: typeof record.report === 'string' ? record.report : JSON.stringify(value, null, 2) }]
            },
          },
          async execute(args) {
            const request = (args ?? {}) as { scope?: AuditScope; profilePath?: string; format?: 'markdown' | 'json' }
            const report = await runAudit(ctx, {
              scope: request.scope ?? 'all',
              ...(request.profilePath === undefined ? {} : { profilePath: request.profilePath }),
            })
            // Fresh object literals (not the readonly interfaces) keep the value
            // assignable to the declared lossless-JSON output schema.
            return Promise.resolve({
              summary: { ...report.summary },
              findings: report.findings.map((finding) => ({
                code: finding.code,
                severity: finding.severity,
                title: finding.title,
                refs: [...finding.refs],
                impact: finding.impact,
                evidence: [...finding.evidence],
                fixes: finding.fixes.map((fix) => ({
                  kind: fix.kind,
                  label: fix.label,
                  detail: fix.detail,
                  ...(fix.snippet === undefined ? {} : { snippet: fix.snippet }),
                })),
              })),
              notes: [...report.notes],
              profilePath: report.profilePath,
              report: request.format === 'json' ? JSON.stringify(report, null, 2) : renderMarkdown(report),
            })
          },
          presentCall(args) {
            const request = (args ?? {}) as { scope?: AuditScope; profilePath?: string }
            return {
              card: 'generic',
              kind: 'read',
              title: `插件冲突审计 · scope=${request.scope ?? 'all'}${request.profilePath === undefined ? '' : ` · ${request.profilePath}`}`,
            }
          },
        }),
      ),
    'conflict-doctor: conflict_doctor tool',
  )

  // The command registry is optional: a composition without it still gets the
  // tool and the alert. Commands are read through ctx.get so a missing registry
  // can never park this plugin in PENDING.
  const commands = ctx.get('commands' as never) as unknown as
    | {
        register: (definition: {
          name: string
          description: string
          handler: () => { kind: 'success' | 'error'; text: string } | Promise<{ kind: 'success' | 'error'; text: string }>
        }) => () => void
      }
    | undefined

  if (commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(
      () =>
        commands.register({
          name: 'conflict-doctor',
          description: '诊断插件冲突：谁和谁撞了、为什么没生效，以及该改哪一行',
          handler: async () => {
            const report = await runAudit(ctx, { scope: 'all' })
            return { kind: 'success' as const, text: `${renderHeadline(report)}\n\n${renderMarkdown(report)}` }
          },
        }),
      'conflict-doctor: /conflict-doctor command',
    )
  }

  // Proactive half: with no finding the contributed text is empty, so a healthy
  // profile pays nothing. The system-prompt registry is likewise optional.
  const systemPrompt = ctx.get('systemPrompt' as never) as unknown as
    { context: (context: { name: string; order: number; text: () => string }) => () => void } | undefined
  if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
    const cache: { at: number; findings: readonly Finding[]; versions?: Readonly<Record<string, string>> } = {
      at: 0,
      findings: [],
    }
    // Seed the authority map asynchronously; the floating promise is deliberate
    // (the provider is synchronous) and cannot reject — liveBundleVersions
    // contains its own failure.
    liveBundleVersions(ctx)
      .then((map) => {
        if (map !== undefined) cache.versions = map
      })
      .catch(() => undefined)
    ctx.effect(
      () =>
        systemPrompt.context({
          name: 'conflict-doctor:critical-conflicts',
          order: 50,
          text: criticalContextProvider(ctx, cache),
        }),
      'conflict-doctor: critical-conflict alert',
    )
  }
}
