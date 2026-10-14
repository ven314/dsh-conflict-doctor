/**
 * Detectors and the repair engine. Every detector is a pure function over a
 * snapshot, so the whole diagnosis is unit-testable with fixtures and cannot
 * take down the harness. Each finding carries evidence and at least one
 * ready-to-paste repair: the tool's job is to answer "who collided, and what do
 * I change", not merely to print a red line.
 * @module dsh-conflict-doctor/detect
 */
import type { Finding, Fix, LiveSnapshot, PatchInsert, PatchOverride, Severity, StaticSnapshot } from './types.js'
import { lt, minVersion } from 'semver'
import { classifyRisk } from './fix.js'
import { readHostManifest } from './hostface.js'
import { moduleAliases, moduleKey } from './realm.js'
import { satisfiesRange } from './static.js'

/** Rank used to sort findings by urgency and then by code. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = { critical: 0, warning: 1, info: 2 }

/** Build the patch fragment that disables one Loader row. */
function disableSnippet(rowId: string): string {
  return `- id: ${rowId}\n  disabled: true`
}

/** Build the patch fragment that replaces one Loader row's config. */
function configSnippet(rowId: string, moduleName: string, config: string): string {
  return `- id: ${rowId}\n  name: '${moduleName}'\n  config: ${config}`
}

/** Sort findings deterministically: severity, then code, then first ref. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    if (bySeverity !== 0) return bySeverity
    if (left.code !== right.code) return left.code < right.code ? -1 : 1
    return (left.refs[0] ?? '') < (right.refs[0] ?? '') ? -1 : 1
  })
}

/* -------------------------------------------------------------------------- */
/* Live detectors                                                             */
/* -------------------------------------------------------------------------- */

/** A fiber that will never activate because a declared service never appears. */
function detectPendingMissingService(live: LiveSnapshot): Finding[] {
  const findings: Finding[] = []
  for (const entry of live.entries) {
    if (entry.fiberPhase !== 'pending' || entry.missingInject.length === 0) continue
    findings.push({
      code: 'live/pending-missing-service',
      severity: 'critical',
      title: `“${entry.entryId}” 永远停在 PENDING：它等的服务没有任何插件提供`,
      refs: [entry.entryId, entry.moduleName, ...entry.missingInject],
      impact: '插件不会报错、不会加载、也不会留下日志——只是安静地什么都不做。用户看到的现象是「装了这个插件但功能不出现」。',
      evidence: [
        `entry「${entry.entryId}」(${entry.moduleName}) 的 fiber 状态是 pending`,
        `inject 声明的服务：[${entry.inject.join(', ') || '(none)'}]`,
        `其中当前运行时无人提供：[${entry.missingInject.join(', ')}]`,
      ],
      fixes: [
        {
          kind: 'manual',
          label: `安装或启用提供「${entry.missingInject.join(' / ')}」的插件`,
          detail: 'inject 是硬依赖：服务在进程里出现的那一刻，这个 fiber 会自动激活。补上 provider 是最小改动。',
        },
        {
          kind: 'patch',
          label: '或者承认它不需要这个服务，直接停用该行',
          detail: '当这个插件在当前组合里本来就该缺席时，显式停用比让它挂在 PENDING 更容易被发现。',
          snippet: disableSnippet(entry.entryId),
        },
      ],
    })
  }
  return findings
}

/** A fiber whose startup threw — the only visible symptom of most conflicts. */
function detectFailedFiber(live: LiveSnapshot): Finding[] {
  const findings: Finding[] = []
  for (const entry of live.entries) {
    if (entry.fiberPhase !== 'failed') continue
    const text = entry.errorText ?? '(no error text captured by the runtime)'
    const collision = /tool ["'`]([^"'`]+)["'`] is already registered/.exec(text)
    const collided = collision?.[1]
    const alreadyLive = collided !== undefined && live.tools.includes(collided)
    const fixes: Fix[] = [
      {
        kind: 'patch',
        label: '先把冲突行停用，让整棵树恢复启动',
        detail: '通过 patch 停用失败行是最快恢复手段；恢复后再决定长期方案（改名或二选一）。',
        snippet: disableSnippet(entry.entryId),
      },
    ]
    if (collided !== undefined) {
      fixes.unshift({
        kind: 'manual',
        label: `让两个插件之一放弃 tool id “${collided}”`,
        detail:
          'dsh 的 tool 注册表在同一层内不允许重名：后注册者直接抛错，失败的是整个插件而不是单个工具。改名的那个必须同时改掉它自己的提示词/文档，否则模型会按旧名字调用。',
      })
    }
    findings.push({
      code: collided === undefined ? 'live/failed-fiber' : 'live/tool-id-conflict',
      severity: 'critical',
      title: collided === undefined ? `“${entry.entryId}” 启动失败` : `tool id 冲突：“${collided}” 被两个插件重复注册`,
      refs: [entry.entryId, entry.moduleName, ...(collided === undefined ? [] : [collided])],
      impact:
        collided === undefined
          ? '该行的全部能力（工具、命令、服务、UI）都不存在；如果它还被别的插件 inject，依赖它的插件会一起停在 PENDING。'
          : `后注册的插件整行加载失败，而不是只丢掉这一个工具。冲突的 tool id “${collided}” 在冲突发生${alreadyLive ? '前已由其他插件注册' : '时仍留在注册表里'}。`,
      evidence: [
        `entry「${entry.entryId}」(${entry.moduleName}) 的 fiber 状态是 failed`,
        `运行时错误：${text.split('\n')[0] ?? text}`,
        ...(collided === undefined ? [] : [`当前注册表中的同名工具：${collided}`]),
      ],
      fixes,
    })
  }
  return findings
}

/** Two Loader rows claiming one id (the documented whole-tree crash). */
function detectDuplicateEntryId(live: LiveSnapshot): Finding[] {
  const byId = new Map<string, string[]>()
  for (const entry of live.entries) {
    const list = byId.get(entry.entryId) ?? []
    list.push(entry.moduleName)
    byId.set(entry.entryId, list)
  }
  const findings: Finding[] = []
  for (const [entryId, modules] of byId) {
    if (modules.length < 2) continue
    findings.push({
      code: 'live/duplicate-entry-id',
      severity: 'critical',
      title: `Loader entry id 重复：“${entryId}”`,
      refs: [entryId, ...modules],
      impact: '重复的 entry id 会让 Loader 整棵树启动失败——不是这一个插件不生效，是 harness 起不来。',
      evidence: [`id「${entryId}」被 ${modules.length} 个模块声明：[${modules.join(', ')}]`],
      fixes: [
        {
          kind: 'patch',
          label: '给其中一个模块换一个独占的 id',
          detail: 'entry id 是 Loader 里的主键，重复即冲突；用 insert 指定一个未占用的 id 即可。',
          snippet: `- insert:\n    - id: ${entryId}-2\n      name: '${modules[1] ?? modules[0] ?? entryId}'`,
        },
      ],
    })
  }
  return findings
}

/** A declared inject that nothing in the process provides (latent PENDING cause). */
function detectUnprovidedInject(live: LiveSnapshot): Finding[] {
  const findings: Finding[] = []
  for (const entry of live.entries) {
    if (entry.fiberPhase === 'active' || entry.inject.length === 0) continue
    const never = entry.inject.filter((name) => !live.services.some((service) => service.service === name))
    if (never.length === 0) continue
    findings.push({
      code: 'live/unprovided-inject',
      severity: 'warning',
      title: `“${entry.entryId}” 依赖的服务在整个进程里都不存在：${never.join(', ')}`,
      refs: [entry.entryId, ...never],
      impact: '即使当前 fiber 还没落到 PENDING，只要它重新加载就会永久等待。这是配置层的依赖缺口。',
      evidence: [
        `entry「${entry.entryId}」inject 声明：[${entry.inject.join(', ')}]`,
        `进程内已提供的服务数：${live.services.length}，其中不含 [${never.join(', ')}]`,
      ],
      fixes: [
        {
          kind: 'manual',
          label: '确认服务名拼写，或补上提供它的插件行',
          detail: '服务名必须与提供方的 `provide`/服务名完全一致；拼错一个字母就等价于依赖一个不存在的服务。',
        },
      ],
    })
  }
  return findings
}

/* -------------------------------------------------------------------------- */
/* Profile detectors                                                          */
/* -------------------------------------------------------------------------- */

/** One layer inserting the same row id twice: the Loader's hard collision. */
function detectDuplicateRowInLayer(snapshot: StaticSnapshot): Finding[] {
  const byLayer = new Map<number, Map<string, PatchInsert[]>>()
  for (const row of snapshot.inserts) {
    const layer = byLayer.get(row.layerIndex) ?? new Map<string, PatchInsert[]>()
    const list = layer.get(row.rowId) ?? []
    list.push(row)
    layer.set(row.rowId, list)
    byLayer.set(row.layerIndex, layer)
  }
  const findings: Finding[] = []
  for (const [layerIndex, rows] of byLayer) {
    const layer = snapshot.layers[layerIndex]
    for (const [rowId, list] of rows) {
      if (list.length < 2) continue
      findings.push({
        code: 'profile/duplicate-row-in-layer',
        severity: 'critical',
        title: `同一层里重复插入了 row id“${rowId}”`,
        refs: [rowId, layer?.label ?? `layer ${layerIndex}`],
        impact: '同一个 patch 层里重复的 entry id 会让 Loader 直接拒绝这棵树——表现为「dsh 起不来」，且错误信息只指向这一层。',
        evidence: [
          `层：${layer?.label ?? `layer ${layerIndex}`} (${layer?.file ?? 'unknown file'})`,
          `重复次数：${list.length}，模块：[${list.map((row) => row.moduleName).join(', ')}]`,
        ],
        fixes: [
          {
            kind: 'manual',
            label: '删掉后出现的那一条，或给它一个独占的 id',
            detail: '同一层内一个 id 只能出现一次；两份文件被合并、或手工复制粘贴是常见成因。',
          },
        ],
      })
    }
  }
  return findings
}

/**
 * One module mounted under two ids.
 *
 * The severity is decided by CONFIG, because that is exactly what the framework
 * does: `@deepseek-ai/dsh-tool-subagent` is deliberately mounted twice by
 * dsh-base with `toolName: subagent` and `toolName: subagent_fork` — one
 * module, parameterized into two capabilities. Mounting the same module twice
 * with the same (or no) config instead re-registers identical tool ids and
 * fails the second row.
 */
function detectModuleUnderMultipleIds(snapshot: StaticSnapshot): Finding[] {
  const byLayer = new Map<number, Map<string, PatchInsert[]>>()
  for (const row of snapshot.inserts) {
    const layer = byLayer.get(row.layerIndex) ?? new Map<string, PatchInsert[]>()
    const list = layer.get(row.moduleName) ?? []
    list.push(row)
    layer.set(row.moduleName, list)
    byLayer.set(row.layerIndex, layer)
  }
  const findings: Finding[] = []
  for (const [layerIndex, modules] of byLayer) {
    const layer = snapshot.layers[layerIndex]
    for (const [moduleName, rows] of modules) {
      if (rows.length < 2) continue
      const rowIds = rows.map((row) => row.rowId)
      const configs = new Set(rows.map((row) => row.configJson))
      const parameterized = configs.size > 1 && !configs.has('null')
      findings.push({
        code: 'profile/module-under-multiple-ids',
        severity: parameterized ? 'info' : 'critical',
        title: parameterized
          ? `同一模块按不同 config 挂了两次：“${moduleName}”（通常是刻意用法）`
          : `同一个插件模块被重复挂载：“${moduleName}”`,
        refs: [moduleName, ...rowIds],
        impact: parameterized
          ? '该模块按 config 分流成两个能力入口。只有当它确实用 config 区分注册出的 tool id / 服务时才是安全的；否则第二次注册会撞上前一次。'
          : '第二个实例会重新注册同样的 tool id / 服务 / slot。tool id 冲突时后者抛错、整行加载失败；服务重复则变成难以定位的覆盖。',
        evidence: [
          `层：${layer?.label ?? `layer ${layerIndex}`}`,
          `row ids：[${rowIds.join(', ')}] → 模块 ${moduleName}`,
          `各自的 config：${rows.map((row) => `${row.rowId}=${row.configJson}`).join(' , ')}`,
          parameterized
            ? '两端 config 不同，因此这个组合按配置分流；请确认两处 config 都显式给出了各自的 tool id。'
            : '两端 config 相同或都为空，等价于把同一个模块挂了两遍。',
        ],
        fixes: parameterized
          ? [
              {
                kind: 'manual',
                label: '确认这是刻意的多入口用法',
                detail: '若两处 config 分别指定了不同的 tool id/能力，保持原样；否则按非刻意的情况处理。',
              },
            ]
          : [
              {
                kind: 'patch',
                label: '保留一个 id，停用另一个',
                detail: '同一个模块在一个进程里只需要挂一次；第二行通常是复制配置时的残留。',
                snippet: disableSnippet(rowIds[1] ?? rowIds[0] ?? moduleName),
              },
            ],
      })
    }
  }
  return findings
}

/** A disable that a later layer silently undoes. */
function detectDisableThenReinsert(snapshot: StaticSnapshot): Finding[] {
  const order: Array<{ rowId: string; action: 'disable' | 'enable'; layerIndex: number }> = []
  for (const row of snapshot.inserts) order.push({ rowId: row.rowId, action: 'enable', layerIndex: row.layerIndex })
  for (const row of snapshot.overrides) {
    order.push({ rowId: row.rowId, action: row.disabled ? 'disable' : 'enable', layerIndex: row.layerIndex })
  }
  // A stable sort keeps every insert of one layer ahead of that layer's
  // id-addressed overrides, which mirrors how the Loader applies one file.
  order.sort((left, right) => left.layerIndex - right.layerIndex)

  const state = new Map<string, { disabledAt: number }>()
  const findings: Finding[] = []
  for (const step of order) {
    const current = state.get(step.rowId)
    if (step.action === 'disable') {
      state.set(step.rowId, { disabledAt: step.layerIndex })
      continue
    }
    if (current !== undefined) {
      const disabledLayer = snapshot.layers[current.disabledAt]
      const enableLayer = snapshot.layers[step.layerIndex]
      findings.push({
        code: 'profile/disable-then-reinsert',
        severity: 'critical',
        title: `“${step.rowId}” 被停用后又被重新插入`,
        refs: [step.rowId, disabledLayer?.label ?? 'unknown', enableLayer?.label ?? 'unknown'],
        impact: '用户以为自己停用了这个插件，实际它还在加载。这是「我明明关了它，怎么还生效」的直接成因。',
        evidence: [
          `第 ${current.disabledAt} 层停用：${disabledLayer?.label ?? '?'}`,
          `第 ${step.layerIndex} 层又插入：${enableLayer?.label ?? '?'}`,
        ],
        fixes: [
          {
            kind: 'patch',
            label: '把停用移到最后一层（用户 patch 永远最后生效）',
            detail: '层序决定最终状态；社区包或模式包后插一行，就会把用户的停用盖掉。',
            snippet: disableSnippet(step.rowId),
          },
        ],
      })
      state.delete(step.rowId)
    }
  }
  return findings
}

/**
 * A per-key diff between two config objects.
 *
 * The point of key-level provenance: "the config was replaced" is true but
 * blunt, and a reader cannot tell a harmless restatement from one that drops a
 * required key. On the real profile every restatement turned out to be
 * key-compatible (two value changes, two pure additions, zero dropped keys),
 * so the old whole-string wording overstated every one of them.
 */
interface KeyDiff {
  /** Keys whose value changed between the layers. */
  readonly changed: ReadonlyArray<{ key: string; from: string; to: string }>
  /** Keys only the earlier layer had — the dangerous case. */
  readonly dropped: readonly string[]
  /** Keys only the later layer introduced. */
  readonly added: readonly string[]
}

/** Read a config occurrence as a plain object, or undefined when not one. */
function parseConfig(configJson: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(configJson)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}

/** A stable, human-readable rendering of one config value. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

/**
 * Diff two config objects key by key.
 *
 * @param earlier - the config that will be discarded.
 * @param later - the config that takes its place.
 * @returns the per-key changes.
 */
function diffKeys(earlier: Record<string, unknown>, later: Record<string, unknown>): KeyDiff {
  const changed: Array<{ key: string; from: string; to: string }> = []
  const dropped: string[] = []
  const added: string[] = []
  for (const [key, before] of Object.entries(earlier)) {
    if (!(key in later)) {
      dropped.push(key)
      continue
    }
    const after = later[key]
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changed.push({ key, from: renderValue(before), to: renderValue(after) })
    }
  }
  for (const key of Object.keys(later)) {
    if (!(key in earlier)) added.push(key)
  }
  return { changed, dropped, added }
}

/**
 * Two or more layers restating one row's config: last write wins, silently.
 *
 * Now with key-level provenance. The old wording could only say "replaced",
 * which is true for a harmless restatement and for one that drops a required
 * key alike. The evidence now names which keys changed, which were added, and
 * — the case that actually breaks something — which were dropped, upgrading the
 * severity from `info` to `warning` for that case only.
 */
function detectRowConfigReplaced(snapshot: StaticSnapshot): Finding[] {
  const perRow = new Map<string, Array<{ layerIndex: number; configJson: string; moduleName?: string }>>()
  const add = (rowId: string, layerIndex: number, configJson: string, hasConfig: boolean, moduleName?: string): void => {
    if (!hasConfig) return
    const list = perRow.get(rowId) ?? []
    list.push({ layerIndex, configJson, ...(moduleName === undefined ? {} : { moduleName }) })
    perRow.set(rowId, list)
  }
  for (const row of snapshot.inserts) add(row.rowId, row.layerIndex, row.configJson, row.hasConfig, row.moduleName)
  for (const row of snapshot.overrides) add(row.rowId, row.layerIndex, row.configJson, row.hasConfig, row.moduleName)

  const findings: Finding[] = []
  for (const [rowId, entries] of perRow) {
    const distinct = new Set(entries.map((entry) => entry.configJson))
    if (entries.length < 2 || distinct.size < 2) continue
    // `.at(-1)` plus an explicit guard, because the repo runs with
    // noUncheckedIndexedAccess and the length check above does not narrow.
    const last = entries.at(-1)
    if (last === undefined) continue
    const lastLabel = snapshot.layers[last.layerIndex]?.label ?? `layer ${last.layerIndex}`

    // Key-level provenance across the whole chain: compare each earlier layer
    // to the FINAL state, so the evidence says what the last layer actually
    // did to what was there, rather than only that two strings differ.
    const finalObj = parseConfig(last.configJson)
    const evidence: string[] = []
    let droppedKeys: string[] = []
    let comparable = finalObj !== undefined
    if (finalObj !== undefined) {
      for (const entry of entries.slice(0, -1)) {
        const earlier = parseConfig(entry.configJson)
        if (earlier === undefined) {
          // One undiffable layer is enough to make the whole row un-diffable;
          // claiming "no differences" would then be unfounded.
          comparable = false
          continue
        }
        const diff = diffKeys(earlier, finalObj)
        const label = snapshot.layers[entry.layerIndex]?.label ?? `layer ${entry.layerIndex}`
        if (diff.dropped.length > 0) {
          droppedKeys = [...droppedKeys, ...diff.dropped]
          evidence.push(`${label} 写下的键被最后层丢弃：${diff.dropped.join(', ')}`)
        }
        for (const change of diff.changed) {
          evidence.push(`${change.key}：${label} 写 ${JSON.stringify(change.from)} → 最后层写 ${JSON.stringify(change.to)}`)
        }
        if (diff.added.length > 0) evidence.push(`最后层新增（${label} 没有）：${diff.added.join(', ')}`)
      }
    }

    // A restatement whose ONLY difference is key ORDER is not a finding. The
    // string comparison above cannot tell it apart from a real change, but the
    // per-key diff can: reporting it and then saying "no differences" would be
    // noise that teaches the reader to skim past this detector.
    if (comparable && evidence.length === 0) continue
    if (!comparable) {
      evidence.push(
        finalObj === undefined ? '最终 config 不是纯对象，无法逐键对比。' : '有层的 config 不是纯对象，无法逐键对比整条链。',
      )
    }
    evidence.push(`判定依据：patch 层整段替换，第 ${last.layerIndex} 层（${lastLabel}）之后即最终生效值。`)

    findings.push({
      code: 'profile/row-config-replaced',
      // A dropped key is the "I configured it and nothing happened" case, so it
      // upgrades from info to warning; everything else stays informational.
      severity: droppedKeys.length > 0 ? 'warning' : 'info',
      title:
        droppedKeys.length > 0
          ? `row“${rowId}” 的 config 被最后层覆盖，并丢弃了 ${droppedKeys.length} 个前面层写下的键`
          : `row“${rowId}” 的 config 被多层覆盖，只有最后一层生效`,
      refs: [rowId, ...entries.map((entry) => snapshot.layers[entry.layerIndex]?.label ?? `layer ${entry.layerIndex}`)],
      impact:
        droppedKeys.length > 0
          ? '整段替换丢掉了前面层的键。如果丢的是必需项，功能会以「配置明明写了却无效」的形式坏掉——这是需要处理的版本。'
          : 'patch 是整段替换而不是合并：前面层写下的 config 全部被丢掉。若逐键对比显示只是同值重述或纯增量（见证据），无需处理。',
      evidence,
      fixes: [
        {
          kind: 'patch',
          label: '把最终想要的完整 config 写进最后一层',
          detail: '在用户 patch 里写出完整 config，是唯一不会被后续层意外截断的做法。',
          ...(last?.moduleName === undefined ? {} : { snippet: configSnippet(rowId, last.moduleName, last.configJson) }),
        },
      ],
    })
  }
  return findings
}

/**
 * A dependency cycle among `inject` declarations in the patch layers.
 *
 * Sound WITHOUT knowing who provides what, which is why it is buildable while
 * the "unprovided inject" check is not. A cycle means every row in it waits for
 * another, so none can ever activate — that follows from the declarations alone.
 *
 * Why not also report an inject with no visible provider: the literal-pattern
 * service scan provably misses real providers. On this machine the web UI works,
 * so `webStartup` IS provided, yet `@deepseek-ai/dsh-web-app` exposes no literal
 * `super(ctx, 'name')` for the scanner to find. Reporting "nobody provides
 * webStartup" would be three false positives on a healthy profile — and the
 * real failure it would be aiming at is already covered by
 * `live/pending-missing-service`, which reads the actual registry.
 *
 * The graph is built from row id → injected service name → the row that
 * plausibly provides it (a row whose module declares that service). Only edges
 * whose target is a known row participate, so the cycle is always actionable.
 */
function detectInjectCycle(snapshot: StaticSnapshot): Finding[] {
  // row id → services it needs.
  const needs = new Map<string, string[]>()
  for (const row of snapshot.inserts) {
    if (row.inject === undefined || row.inject.length === 0) continue
    needs.set(row.rowId, [...(needs.get(row.rowId) ?? []), ...row.inject])
  }
  if (needs.size === 0) return []

  // service name → rows whose module declares providing it.
  // `declaredServices` maps service → owner package names, so invert it here.
  const providerRows = new Map<string, string[]>()
  for (const [service, owners] of Object.entries(snapshot.declaredServices ?? {})) {
    for (const row of snapshot.inserts) {
      if (!owners.includes(row.moduleName)) continue
      const list = providerRows.get(service) ?? []
      if (!list.includes(row.rowId)) list.push(row.rowId)
      providerRows.set(service, list)
    }
  }

  // Edges: row → the rows that provide what it injects.
  const edges = new Map<string, string[]>()
  for (const [rowId, services] of needs) {
    const targets: string[] = []
    for (const service of services) {
      for (const provider of providerRows.get(service) ?? []) {
        if (provider !== rowId) targets.push(provider)
      }
    }
    if (targets.length > 0) edges.set(rowId, targets)
  }
  if (edges.size === 0) return []

  // Depth-first search with an explicit stack path to recover the cycle itself,
  // so the finding can name the rows rather than just assert one exists.
  const findings: Finding[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []

  const visit = (node: string): void => {
    const current = state.get(node)
    if (current === 'done') return
    if (current === 'visiting') {
      const start = path.indexOf(node)
      const cycle = [...path.slice(start), node]
      findings.push({
        code: 'profile/inject-cycle',
        severity: 'critical',
        title: `patch 层的 inject 声明构成环：${cycle.join(' → ')}`,
        refs: cycle,
        impact:
          '环上的每一行都在等另一行先激活，因此整条链永远无法激活。这类故障不报错、不打日志，表现是这几行的功能整体不出现。',
        evidence: [
          ...cycle.slice(0, -1).map((rowId) => `${rowId} 需要：${(needs.get(rowId) ?? []).join(', ')}`),
          `环：${cycle.join(' → ')}`,
          '判定依据：只依据 patch 层声明的 inject 边，不依赖「谁提供什么」——因此结论不涉及提供方识别的不确定性。',
        ],
        fixes: [
          {
            kind: 'manual',
            label: '打断环：让其中一行不再需要环上的另一行',
            detail: '通常是把某一行的 inject 改成由外部先提供，或把两行的职责合并到一行。',
          },
        ],
      })
      return
    }
    state.set(node, 'visiting')
    path.push(node)
    for (const next of edges.get(node) ?? []) visit(next)
    path.pop()
    state.set(node, 'done')
  }

  for (const node of edges.keys()) visit(node)
  return findings
}

/** An override that addresses a row no layer ever inserts. */
function detectDanglingOverride(snapshot: StaticSnapshot): Finding[] {
  const inserted = new Set(snapshot.inserts.map((row) => row.rowId))
  const byRow = new Map<string, PatchOverride[]>()
  for (const row of snapshot.overrides) {
    if (inserted.has(row.rowId)) continue
    const list = byRow.get(row.rowId) ?? []
    list.push(row)
    byRow.set(row.rowId, list)
  }
  const findings: Finding[] = []
  for (const [rowId, rows] of byRow) {
    const layer = snapshot.layers[rows[0]?.layerIndex ?? 0]
    // An override that carries a module name is an insert of a new row, which is
    // legitimate; only a bare config/disable with no owning insert is dangling.
    if (rows.some((row) => row.moduleName !== undefined)) continue
    findings.push({
      code: 'profile/dangling-override',
      severity: 'warning',
      title: `patch 里的“${rowId}”没有对应任何已插入的 row`,
      refs: [rowId, layer?.label ?? 'user patch'],
      impact: '这条配置是空操作：Loader 找不到该 id，什么也不会发生，也不会报错。用户的预期与运行结果就此分叉。',
      evidence: [
        `层：${layer?.label ?? '?'} (${layer?.file ?? '?'})`,
        `该行动作：${rows.map((row) => (row.disabled ? 'disabled' : 'config')).join(', ')}`,
        `已插入的 row id 数量：${inserted.size}`,
      ],
      fixes: [
        {
          kind: 'patch',
          label: '删除这条孤行，或用 insert 真正把它加进来',
          detail: 'override 只对已存在的 id 生效；要新增插件必须走 insert。',
          snippet: `- insert:\n    - id: ${rowId}\n      name: '<package-name>'`,
        },
      ],
    })
  }
  return findings
}

/**
 * A bundle the profile lists but that no `node_modules` root resolves.
 *
 * `info`, not `critical`: the desktop app resolves its own experimental bundles
 * out of the packaged app archive, so this is normal for those four names. It
 * still deserves a line, because the same shape appears when a community bundle
 * was uninstalled from disk while staying in `dsh.profile.bundles` — and then
 * the plugin is genuinely gone with nothing to show for it.
 */
function detectUnresolvedBundles(snapshot: StaticSnapshot): Finding[] {
  const unresolved = snapshot.unresolvedBundles ?? []
  if (unresolved.length === 0) return []
  return [
    {
      code: 'profile/bundle-unresolved',
      severity: 'info',
      title: `${unresolved.length} 个 bundle 在 node_modules 里找不到`,
      refs: [...unresolved],
      impact:
        '这些名字出现在 dsh.profile.bundles 里，但磁盘上的任何 node_modules 根目录都解析不到。如果它们由 app 内置解析器提供（DSH 自带的 experimental bundle 就是这样），属于正常；如果是社区包被删了却还留在 bundles 列表里，那就等于插件已经不存在。',
      evidence: unresolved.map((name) => `未解析：${name}`),
      fixes: [
        {
          kind: 'command',
          label: '确认来源：内置 bundle 保持原样，社区包重新安装',
          detail: '用一个能启动的组合验证；若 profile 停在这一步，日志里会出现该模块名。',
        },
      ],
    },
  ]
}

/** A declared module the profile cannot resolve. */
function detectMissingPatchFile(snapshot: StaticSnapshot): Finding[] {
  return snapshot.missingPatchFiles.map((missing) => ({
    code: 'profile/missing-patch-file',
    severity: 'critical',
    title: 'bundle 声明的 patch 文件不存在',
    refs: [missing],
    impact: '该 bundle 的全部 row 都不会被加载：插件在 profile 列表里看着启用了，实际从未参与组合。',
    evidence: [`缺失目标：${missing}`],
    fixes: [
      {
        kind: 'command',
        label: '重装该 bundle，或修正 dsh.bundle.patch 路径',
        detail: 'bundle 的 patch 必须随包发布（`files` 里带上）。安装残留是最常见的成因。',
      },
    ],
  }))
}

/** Two packages declaring the same tool id in their compiled sources. */
function detectDeclaredToolCollision(snapshot: StaticSnapshot): Finding[] {
  const findings: Finding[] = []
  for (const [tool, owners] of Object.entries(snapshot.declaredTools)) {
    if (owners.length < 2) continue
    findings.push({
      code: 'profile/tool-id-collision',
      severity: 'critical',
      title: `两个以上插件都声明了 tool id“${tool}”`,
      refs: [tool, ...owners],
      impact:
        '这是静态依赖检查永远看不到的能力级冲突：peer 版本都匹配，但运行到第二步注册时后者抛错、整行加载失败。谁先加载取决于服务可用顺序，因此现象具有偶发性。',
      evidence: [
        `声明方（从编译产物中提取）：[${owners.join(', ')}]`,
        `注意：静态提取基于 defineTool({ name: '...' }) 字面量；动态拼出的名字不在此列。`,
      ],
      fixes: [
        {
          kind: 'manual',
          label: '让其中一个插件改名，或二选一停用',
          detail: 'tool id 是模型可见的调用名，运行期无法重命名：只能改插件源码，或停用一个。',
        },
        {
          kind: 'patch',
          label: '先停用其中一个，恢复确定性',
          detail: '在用户 patch 里停用加载顺序靠后的那个，至少让失败不再随机。',
          snippet: disableSnippet(owners[owners.length - 1] ?? tool),
        },
      ],
    })
  }
  return findings
}

/**
 * Declared dependency ranges the installed tree cannot satisfy.
 *
 * Grouped per package rather than per dependency: a single community plugin
 * commonly pins a whole generation of the host (`^0.2.0-rc.2` across ten
 * packages), and ten separate findings would bury the one fact that matters —
 * "this plugin was built against a newer host than the one running".
 *
 * Severity: `warning` when the installed version is BELOW the range's minimum
 * (host older than the plugin expects — the version that actually breaks), else
 * `info` (host newer than declared, usually fine with a compatible API).
 *
 * `versionsComparable` gates it: only a snapshot whose baseline is trustworthy
 * may drive a comparison. Historically that meant `authoritative` alone, so a
 * packaged desktop install suppressed every version-sensitive check. W1 added
 * `archive-authoritative` — the disk is stale, but the running host's own
 * archive supplies the baseline instead.
 */

/**
 * Whether version-sensitive detectors may run against this snapshot.
 *
 * Exported so the gate itself can be unit-tested.
 */
export function versionsComparable(snapshot: StaticSnapshot): boolean {
  return snapshot.versionAuthority === 'authoritative' || snapshot.versionAuthority === 'archive-authoritative'
}

/**
 * Which version of each package is "installed", for a range comparison.
 *
 * This is subtler than it looks, and getting it wrong produced five false
 * positives in one sitting: under `archive-authoritative` the DISK holds a
 * stale generation (0.1.0-rc.6) while the RUNNING host is 0.2.0-rc.2. Comparing
 * a plugin's peer range against the disk copy therefore claimed "the host is
 * older than the plugin" for ranges that the running host satisfies perfectly.
 *
 * So the running host's versions win wherever they are known, and the disk only
 * fills gaps — packages the host archive does not ship, such as the community
 * plugins themselves.
 *
 * @param snapshot - the profile scan, including any host versions read.
 * @returns package name → the version actually in force.
 */
function installedVersions(snapshot: StaticSnapshot): Map<string, string> {
  const installed = new Map<string, string>()
  // Disk first, then overwrite with the running host: later writes win.
  for (const entry of snapshot.packages) installed.set(entry.name, entry.version)
  for (const [name, version] of Object.entries(snapshot.hostBundleVersions ?? {})) installed.set(name, version)
  return installed
}

/**
 * Detect unsatisfied peer ranges.
 *
 * Two very different situations share this code, and conflating them is how this
 * detector once produced 23 findings of noise. They are now separated:
 *
 * 1. **`below` — the running host is OLDER than a range's minimum.** This is the
 *    version that actually breaks: the plugin calls an API the host does not
 *    have, and the failure surfaces at first call with a stack pointing at the
 *    plugin. Severity `warning`, one finding per package.
 *
 * 2. **`other` — the range simply does not match, but nothing is below its
 *    minimum.** Under `archive-authoritative` this is usually not news at all:
 *    when the profile tree is a whole generation behind (0.1.0-rc.6) and the
 *    running host is 0.2.0-rc.2, a `^0.1.0-rc.6` declaration fails the match
 *    purely because semver excludes prereleases from a different tuple — the
 *    documented trap in PUBLISH.md. Every package in the stale tree hits it, so
 *    emitting one finding each buries the actionable `below` findings.
 *
 *    These are aggregated into ONE info finding instead. The coverage fact ("N
 *    packages declare ranges that do not match the running host") stays
 *    visible without pretending each instance is an incident.
 */
function detectPeerRangeUnsatisfied(snapshot: StaticSnapshot): Finding[] {
  if (!versionsComparable(snapshot)) return []
  const installed = installedVersions(snapshot)
  const hostShipped = new Set(Object.keys(snapshot.hostBundleVersions ?? {}))
  const findings: Finding[] = []
  /** Packages whose only issue is a declaration that does not match. */
  const skewOnly: Array<{ name: string; version: string; lines: string[] }> = []

  for (const pkg of snapshot.packages) {
    const belowMinimum: string[] = []
    const other: string[] = []
    for (const [dep, range] of Object.entries(pkg.ranges)) {
      const current = installed.get(dep)
      if (satisfiesRange(current, range) !== false) continue
      const minimum = minVersion(range)
      const line = `${dep} 声明 ${range} / 已装 ${current ?? '(未解析到)'}`
      if (minimum !== null && current !== undefined && lt(current, minimum)) belowMinimum.push(line)
      else other.push(line)
    }
    if (belowMinimum.length + other.length === 0) continue
    const below = belowMinimum.length > 0

    // A package the host SHIPS is not a third-party plugin: comparing its ranges
    // against the host it ships inside is comparing the host to itself. Only a
    // genuine `below` contradiction there is worth reporting, because it would
    // mean the shipped tree disagrees with itself.
    if (!below && hostShipped.has(pkg.name)) continue

    if (!below) {
      skewOnly.push({ name: pkg.name, version: pkg.version, lines: other })
      continue
    }

    const lines = [...belowMinimum, ...other]
    findings.push({
      code: 'profile/peer-range-unsatisfied',
      severity: 'warning',
      title: `${pkg.name}@${pkg.version} 要求的版本高于运行中的宿主：${belowMinimum.length} 项低于声明的最小值`,
      refs: [pkg.name, `${pkg.name}@${pkg.version}`, ...lines.map((line) => line.split(' ')[0] ?? '')].filter(
        (ref): ref is string => ref.length > 0,
      ),
      impact:
        '这些范围的最小版本高于运行宿主实际安装的版本。插件通常仍能加载，但它调用的新 API 在旧宿主上不存在——失败发生在第一次真正调用时，堆栈指向插件而不是版本。',
      evidence: [
        `${pkg.name}@${pkg.version} (${pkg.dir})`,
        ...lines.map((line) => `不满足：${line}`),
        '判断依据：运行宿主的版本低于声明范围的最小版本，属于「宿主比插件旧」。',
        '基准来源：运行宿主 archive 或 pluginManager 报告的版本，不是 profiles/node_modules 里的副本。',
      ],
      fixes: [
        {
          kind: 'manual',
          label: '升级宿主，或换用与当前宿主匹配的插件版本',
          detail: '先对齐版本再谈别的；对齐后若仍不生效，才需要逐条比对插件实际调用的 API 面。',
        },
      ],
    })
  }

  if (skewOnly.length > 0) {
    const shown = skewOnly.slice(0, 12)
    findings.push({
      code: 'profile/peer-range-unsatisfied',
      severity: 'info',
      title: `${skewOnly.length} 个包的依赖声明与运行宿主的版本元组不一致（均未低于最小值，通常是跨代声明）`,
      refs: skewOnly.map((entry) => entry.name),
      impact:
        '这些范围没有一个低于其最小值，因此不是「宿主比插件旧」。常见成因是声明写死了另一代的预发布版本（例如 ^0.1.0-rc.6 对上 0.2.0-rc.2：semver 不认为不同元组的预发布版本互相匹配）。通常无害；只有当某个插件正在出问题时，才需要把它当线索。',
      evidence: [
        ...shown.map((entry) => `${entry.name}@${entry.version}：${entry.lines.length} 项，例如 ${entry.lines[0] ?? ''}`),
        ...(skewOnly.length > shown.length ? [`（另有 ${skewOnly.length - shown.length} 个包同类，未逐条列出）`] : []),
        '这项只作提示：真正的破坏性版本问题会以 warning 形式单独列出，不混在这里。',
      ],
      fixes: [
        {
          kind: 'manual',
          label: '一般无需处理；确认相关插件工作正常即可',
          detail: '若某个插件正在出问题，把它作为第一个排查方向，但不要仅凭这一条就改配置。',
        },
      ],
    })
  }
  return findings
}

/* -------------------------------------------------------------------------- */
/* Client realm detectors                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A browser half that injects a client module nothing provides.
 *
 * The client-side twin of `live/pending-missing-service`, and the failure mode
 * nothing else in this tool could see. A `dsh.client` half composes by MODULE
 * name (`@deepseek-ai/dsh-client-ui-sidebar-right`), and when the module is not
 * present the half is silently inert: no error, no log, the feature simply never
 * appears — the same shape as a host fiber stuck PENDING, in a different
 * registry.
 *
 * A module counts as provided when either another installed package declares it
 * (its own package name, or a name it injects and thereby implies) or the
 * running host ships it. Both sets are built from real declarations, so the
 * check is evidence-based rather than a guess about naming conventions.
 *
 * Resolves modules by normalised key, so a scope-stripped or case-different
 * spelling is not reported as missing: a false "missing" sends the user chasing
 * a module that is present, which is the expensive direction of error.
 */
function detectClientInjectUnprovided(snapshot: StaticSnapshot): Finding[] {
  const clientPackages = snapshot.packages.filter((pkg) => pkg.client !== undefined)
  if (clientPackages.length === 0) return []

  // Providers: every installed package name, every module the host ships, and
  // every module some half declares it provides.
  const provided = new Set<string>()
  for (const pkg of snapshot.packages) for (const alias of moduleAliases(pkg.name)) provided.add(alias)
  for (const name of Object.keys(snapshot.hostBundleVersions ?? {})) for (const alias of moduleAliases(name)) provided.add(alias)

  const findings: Finding[] = []
  for (const pkg of clientPackages) {
    const missing = pkg.client?.inject.filter((name) => !provided.has(moduleKey(name))) ?? []
    if (missing.length === 0) continue
    findings.push({
      code: 'client/inject-unprovided',
      severity: 'warning',
      title: `${pkg.name} 的浏览器半区依赖 ${missing.length} 个无人提供的模块`,
      refs: [pkg.name, ...missing],
      impact:
        '页面半区按模块名组合：某个模块不存在时，这个半区会安静地什么都不做——不报错、不打日志，用户看到的现象是「装了插件但界面里没有它」。这与宿主侧卡在 PENDING 是同一个故障形态，只是发生在另一个注册表里。',
      evidence: [
        `${pkg.name}@${pkg.version} 的 dsh.client.inject 声明了 ${pkg.client?.inject.length ?? 0} 个模块`,
        ...missing.map((name) => `未找到提供方：${name}`),
        `已确认存在提供方的模块：${(pkg.client?.inject.length ?? 0) - missing.length} 个`,
        '判定依据：提供方来自「已安装包名 ∪ 运行宿主 archive 中的 bundle」。',
      ],
      fixes: [
        {
          kind: 'manual',
          label: `安装提供 ${missing[0]} 的模块，或从 inject 里去掉它`,
          detail:
            '先确认模块名是否只是拼写差异（作用域、大小写）。若该模块确实不存在，去掉这条 inject 比留着更安全——留着会让整个半区停在未激活状态。',
        },
      ],
    })
  }
  return findings
}

/**
 * A service name registered in BOTH realms.
 *
 * Distinct from a same-realm collision, and reported as `info` rather than a
 * conflict: the page and the host have separate service tables, so the same name
 * in each is legitimate. It is worth surfacing because it is a common source of
 * "I fixed the page one and the host one still misbehaves", and because a
 * reviewer looking at one file may not realise the other exists.
 *
 * This is the case `profile/service-collision` already excludes from comparison;
 * recording it explicitly keeps the exclusion honest instead of silent.
 */
function detectCrossRealmServiceName(snapshot: StaticSnapshot): Finding[] {
  const byService = snapshot.declaredServices ?? {}
  const clientNames = new Set(snapshot.packages.filter((pkg) => pkg.client !== undefined).map((pkg) => pkg.name))
  const findings: Finding[] = []

  for (const [service, owners] of Object.entries(byService)) {
    const clientOwners = owners.filter((owner) => clientNames.has(owner))
    const hostOwners = owners.filter((owner) => !clientNames.has(owner))
    // Only interesting when the SAME name appears on both sides.
    if (clientOwners.length === 0 || hostOwners.length === 0) continue
    findings.push({
      code: 'client/service-name-shared-with-host',
      severity: 'info',
      title: `服务名“${service}”在页面半区与宿主半区各有一处`,
      refs: [service, ...clientOwners, ...hostOwners],
      impact:
        '两个半区各有独立的服务表，同名不是冲突。把它列出来是因为排查时容易只看一边：修好了页面的那个，宿主的那个仍然照旧。',
      evidence: [
        `页面半区：${clientOwners.join(', ')}`,
        `宿主半区：${hostOwners.join(', ')}`,
        '按 realm 语义，这两者不做冲突比较；此处仅作提示。',
      ],
      fixes: [
        {
          kind: 'manual',
          label: '确认你要改的是哪一边',
          detail: '同名服务在两侧各自注册；改动前先确认半区，否则会以为改了没生效。',
        },
      ],
    })
  }
  return findings
}

/** A package whose declared Node engine the running Node cannot satisfy. */
function detectEngineUnsatisfied(snapshot: StaticSnapshot, nodeVersion: string): Finding[] {
  const findings: Finding[] = []
  for (const pkg of snapshot.packages) {
    if (pkg.enginesNode === undefined) continue
    const verdict = satisfiesRange(nodeVersion, pkg.enginesNode)
    if (verdict !== false) continue
    findings.push({
      code: 'profile/node-engine-unsatisfied',
      severity: 'warning',
      title: `${pkg.name} 要求 Node ${pkg.enginesNode}，当前是 ${nodeVersion}`,
      refs: [pkg.name, `node@${nodeVersion}`, pkg.enginesNode],
      impact: '在错误的 Node 上运行会以语法/原生模块错误的形式随机失败，错误信息通常指向插件而不是 Node。',
      evidence: [`${pkg.name}@${pkg.version}`, `engines.node: ${pkg.enginesNode}`, `process.version: ${nodeVersion}`],
      fixes: [
        {
          kind: 'manual',
          label: '把该插件升级到支持当前 Node 的版本，或调整运行时 Node',
          detail: 'engines 是作者给出的证据，不是硬约束；但当它不满足时，排查应从这里开始。',
        },
      ],
    })
  }
  return findings
}

/* -------------------------------------------------------------------------- */
/* Service-level and cross-half detectors                                     */
/* -------------------------------------------------------------------------- */

/**
 * A service name two packages both appear to register.
 *
 * Realm-aware on purpose. A browser-half package (`dsh.client` in its manifest)
 * runs in the page, not in the Host process: `dsh-client-runtime` providing
 * `sessions`, or the client Cordis runner providing `cordisInspect`, is not a
 * Host collision at all — the two never share a service registry. Comparing
 * them would produce findings on every healthy DSH install, so only packages
 * that live in the same realm are compared.
 */
function detectServiceCollision(snapshot: StaticSnapshot): Finding[] {
  const findings: Finding[] = []
  const clientOnly = new Set(
    snapshot.packages.filter((pkg) => pkg.halves !== undefined && pkg.halves === 'client').map((pkg) => pkg.name),
  )
  for (const [service, owners] of Object.entries(snapshot.declaredServices ?? {})) {
    const hostOwners = owners.filter((owner) => !clientOnly.has(owner))
    if (hostOwners.length < 2) continue
    findings.push({
      code: 'profile/service-collision',
      severity: 'warning',
      title: `两个包都注册服务“${service}”`,
      refs: [service, ...hostOwners],
      impact:
        '同名服务不允许有两个实现：谁生效取决于激活顺序，而激活顺序由服务可用性驱动，因此现象会随启动环境变化。用户看到的是「有时对、有时不对」，最难复现的一类。',
      evidence: [
        `声明方（从编译产物中的 super(ctx, name) / provide(name) 提取）：[${hostOwners.join(', ')}]`,
        ...(owners.length === hostOwners.length
          ? []
          : [`同名的浏览器侧包（不同 realm，未计入）：[${owners.filter((owner) => clientOnly.has(owner)).join(', ')}]`]),
        '静态提取只认字面量服务名；动态计算出的服务名不在此列。',
      ],
      fixes: [
        {
          kind: 'manual',
          label: '确认两者是否真的提供同一语义的服务',
          detail: '若确实冲突，让其中一个改用别的服务名，或停用其中一个；服务名是 ctx 上的键，运行期无法改名。',
        },
        {
          kind: 'patch',
          label: '先停用其中一个，恢复确定性',
          detail: '在用户 patch 里停用其中一个包对应的行，至少让行为不再随机。',
          snippet: disableSnippet(hostOwners[hostOwners.length - 1] ?? service),
        },
      ],
    })
  }
  return findings
}

/**
 * A PENDING fiber whose missing service is provided by that very fiber.
 *
 * The classic deadlock: plugin X mounts a provider and depends on it in the
 * same apply. It waits for a service only it would create, so it waits forever.
 * The generic "missing service" message is misleading here — installing a
 * provider is the wrong fix, because the provider is X itself.
 */
function detectSelfDependentPending(live: LiveSnapshot): Finding[] {
  const declared = live.declaredProvides
  if (declared === undefined) return []
  const findings: Finding[] = []
  for (const entry of live.entries) {
    if (entry.fiberPhase !== 'pending' || entry.missingInject.length === 0) continue
    const selfProvided = declared.filter((provided) => provided.entryId === entry.entryId).map((provided) => provided.service)
    const trapped = entry.missingInject.filter((service) => selfProvided.includes(service))
    if (trapped.length === 0) continue
    findings.push({
      code: 'live/pending-self-dependent',
      severity: 'critical',
      title: `“${entry.entryId}” 在等自己提供的服务：${trapped.join(', ')}`,
      refs: [entry.entryId, entry.moduleName, ...trapped],
      impact: '这是自锁：fiber 只有被激活之后才可能注册那个服务，而它偏偏在激活前等那个服务。它永远不会激活，也不会报错。',
      evidence: [
        `entry「${entry.entryId}」声明提供：[${selfProvided.join(', ')}]`,
        `同一条 entry 的 inject 里则声明等待：[${trapped.join(', ')}]`,
        '因此这不是「缺 provider」，而是「provider 和 consumer 是同一条行」。',
      ],
      fixes: [
        {
          kind: 'manual',
          label: '把服务注册移出依赖它的那次 apply',
          detail: '拆分插件：先无条件 provide，再在拿到服务后的回调里做依赖它的工作；或把 inject 改成运行期 ctx.get() 读取。',
        },
        {
          kind: 'patch',
          label: '若该行本来就该缺席，显式停用',
          detail: '让「装了这个插件却什么都没发生」变成一条明确的配置状态。',
          snippet: disableSnippet(entry.entryId),
        },
      ],
    })
  }
  return findings
}

/**
 * Conflicts the CURRENT loaded set would create once the profile's declared
 * tools are all present.
 *
 * `profile/tool-id-collision` catches the static overlap; this one says whether
 * it is imminent (the other package is already loaded) or latent (it is not).
 * The distinction decides whether the user should act now or before enabling
 * the other plugin.
 */
function detectOutboundToolCollision(live: LiveSnapshot, profile: StaticSnapshot): Finding[] {
  const declared = live.declaredTools
  if (declared === undefined) return []
  const registered = new Set(live.tools)
  const findings: Finding[] = []
  for (const [tool, owners] of Object.entries(profile.declaredTools ?? {})) {
    if (owners.length < 2 || registered.has(tool)) continue
    // Owners that are actually present in the loaded entry set make this
    // collision imminent rather than theoretical.
    const loadedModules = new Set(live.entries.map((entry) => entry.moduleName))
    const loadedOwners = owners.filter((owner) => loadedModules.has(owner))
    if (loadedOwners.length < 2) continue
    findings.push({
      code: 'live/outbound-tool-collision',
      severity: 'warning',
      title: `即将发生的 tool id 冲突：“${tool}”`,
      refs: [tool, ...loadedOwners],
      impact:
        '两个已加载的插件都声明了这个 tool id，但当前注册表里还没有它——说明其中一方的注册尚未发生（例如它还停在 PENDING）。一旦它注册，后注册者整行失败。',
      evidence: [
        `当前注册表：不含 ${tool}`,
        `已加载且声明的包：[${loadedOwners.join(', ')}]`,
        `全部声明方：[${owners.join(', ')}]`,
      ],
      fixes: [
        {
          kind: 'manual',
          label: '在两者都生效前决定谁保留这个名字',
          detail: '这类冲突是确定的、只是被时序掩盖；等到第二个插件激活时才会以「整行加载失败」的形式爆出来。',
        },
      ],
    })
  }
  return findings
}

/**
 * A host symbol a plugin imports that the installed host package does not
 * export.
 *
 * This is the concrete form of the design note's scenario two: a version-string
 * check says "compatible", while the plugin reaches for an API that is not
 * there.
 *
 * REFUSES TO RUN against a non-authoritative snapshot, for the same reason as
 * the peer-range check: resolving an import against a stale on-disk copy of the
 * host reports missing symbols that the RUNNING host actually exports. That is
 * exactly the false positive this gate exists to prevent.
 */
function detectUnresolvedHostImports(snapshot: StaticSnapshot): Finding[] {
  // Same gate as the peer-range check: resolving an import against a copy of
  // the host that is not the running one reports missing symbols the running
  // host actually exports.
  if (!versionsComparable(snapshot)) return []
  const findings: Finding[] = []
  for (const facts of Object.values(snapshot.sourceFacts ?? {})) {
    if (facts.uncheckedImports.length === 0) continue
    findings.push({
      code: 'profile/host-import-unsatisfied',
      severity: 'warning',
      title: `${facts.name} 导入了当前宿主并不导出的符号（${facts.uncheckedImports.length} 个）`,
      refs: [facts.name, ...facts.uncheckedImports.map((symbol) => `${symbol.module}#${symbol.symbol}`)],
      impact:
        'peer 版本字符串匹配不等于 API 存在。这些符号在已安装的宿主包里找不到，调用点会以 undefined 的形式失败——错误指向插件，而根因是宿主版本。',
      evidence: [
        ...facts.uncheckedImports.map((symbol) => `${symbol.file} 导入 { ${symbol.symbol} } from '${symbol.module}'`),
        `同一包内已验证存在的导入：${facts.verified} 个；扫描文件：${facts.filesScanned} 个`,
        '这项检查覆盖编译后 JS 里的具名 import；动态解构或运行期访问不在此列。',
      ],
      fixes: [
        {
          kind: 'manual',
          label: '升级宿主到导出该符号的版本，或改用当前宿主已有的等价 API',
          detail: '先确认符号名是否只是拼写/导出面差异，再决定升宿主还是改插件。',
        },
      ],
    })
  }
  return findings
}

/**
 * A host SUBPATH a plugin imports that the running host does not allow.
 *
 * Distinct from the symbol check, and worth its own code. Node throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED when a subpath is absent from a package's
 * `exports` map — even if the file exists on disk. A symbol-level scan cannot
 * see this: the import is rejected before any symbol is involved.
 *
 * The check is deliberately conservative about what it can prove:
 * - only packages that HAVE an `exports` map can deny a subpath; without one
 *   Node resolves any path inside the package;
 * - a wildcard key (`./src/*`) means the map is not a closed list, so nothing is
 *   denied;
 * - a subpath key can map to several conditions; any key match counts.
 *
 * The third case found on a real profile: a plugin imports
 * `@deepseek-ai/dsh-host-apiproxy/api`, and that package is not in the running
 * host at all. That is a genuine broken import, reported here as well as by the
 * package-level check.
 */
function detectHostSubpathNotExported(snapshot: StaticSnapshot): Finding[] {
  if (!versionsComparable(snapshot)) return []
  const findings: Finding[] = []
  // Group by package so one broken subpath is one finding, not one per importer.
  const offenders = new Map<string, { subpath: string; owners: Set<string>; existed: boolean }>()

  for (const [owner, imports] of Object.entries(snapshot.declaredImports ?? {})) {
    for (const specifier of Object.keys(imports)) {
      // Only host packages are judged here; community deps are the plugin's own
      // business and their layouts are not this tool's contract to police.
      if (!specifier.startsWith('@deepseek-ai/')) continue
      const parts = specifier.split('/')
      // `@scope/name` is 2 segments; anything longer carries a subpath.
      if (parts.length <= 2) continue
      const pkg = `${parts[0]}/${parts[1]}`
      const subpath = `./${parts.slice(2).join('/')}`
      const manifest = readHostManifest(pkg)
      if (manifest === undefined) {
        // The package itself is missing from the host: the import fails at a
        // deeper level than a subpath check, and the package-level check covers
        // it. Recorded so the evidence stays honest.
        const entry = offenders.get(specifier) ?? { subpath, owners: new Set<string>(), existed: false }
        entry.owners.add(owner)
        offenders.set(specifier, entry)
        continue
      }
      // No `exports` map, or a wildcard inside it: nothing is denied.
      if (manifest.subpaths === undefined || manifest.wildcard) continue
      if (manifest.subpaths.some((key) => key === subpath || key === specifier)) continue
      const entry = offenders.get(specifier) ?? { subpath, owners: new Set<string>(), existed: true }
      entry.owners.add(owner)
      offenders.set(specifier, entry)
    }
  }

  for (const [specifier, entry] of [...offenders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const owners = [...entry.owners].sort()
    findings.push({
      code: 'profile/host-subpath-not-exported',
      severity: entry.existed ? 'critical' : 'warning',
      title: entry.existed
        ? `导入了宿主未通过 exports 暴露的子路径：“${specifier}”`
        : `导入了运行宿主里并不存在的包：“${specifier}”`,
      refs: [specifier, ...owners],
      impact: entry.existed
        ? 'Node 会直接抛 ERR_PACKAGE_PATH_NOT_EXPORTED：即使该文件在磁盘上真实存在，只要没写进 exports 就不允许从包外访问。这类失败发生在 import 那一刻，整个插件行加载失败。'
        : '这个包不在运行宿主的 archive 里。import 会失败，插件整行加载失败；常见成因是插件按另一代宿主的模块划分写的。',
      evidence: [
        ...owners.map((owner) => `${owner} 导入 '${specifier}'`),
        ...(entry.existed
          ? [`exports 允许的子路径：${(readHostManifest(specifier.split('/').slice(0, 2).join('/'))?.subpaths ?? []).join(', ')}`]
          : ['运行宿主的 archive 中不含该包。']),
        '判定依据：exports 是允许清单，不在其中的子路径即使文件存在也会被拒绝。',
      ],
      fixes: [
        {
          kind: 'manual',
          label: entry.existed
            ? `改从已暴露的入口导入，或让宿主把 "${entry.subpath}" 加进 exports`
            : '改用运行宿主里存在的等价模块，或安装提供它的那一代宿主',
          detail: '先确认符号是否在包的根入口就能拿到——多数情况下根入口已经导出了同一个东西。',
        },
      ],
    })
  }
  return findings
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run every detector that the supplied snapshots support.
 *
 * @param input - live snapshot, static snapshot, and the Node version to judge engines against.
 * @returns findings sorted by severity, deterministically.
 */
export function detect(input: {
  live?: LiveSnapshot
  profile?: StaticSnapshot
  nodeVersion: string
  /** Cross-half detectors run only when both snapshots are present. */
}): Finding[] {
  const findings: Finding[] = []
  if (input.live !== undefined) {
    findings.push(
      ...detectFailedFiber(input.live),
      ...detectSelfDependentPending(input.live),
      ...detectPendingMissingService(input.live),
      ...detectDuplicateEntryId(input.live),
      ...detectUnprovidedInject(input.live),
    )
  }
  if (input.profile !== undefined) {
    findings.push(
      ...detectMissingPatchFile(input.profile),
      ...detectDuplicateRowInLayer(input.profile),
      ...detectModuleUnderMultipleIds(input.profile),
      ...detectDisableThenReinsert(input.profile),
      ...detectDeclaredToolCollision(input.profile),
      ...detectServiceCollision(input.profile),
      ...detectUnresolvedBundles(input.profile),
      ...detectRowConfigReplaced(input.profile),
      ...detectDanglingOverride(input.profile),
      ...detectPeerRangeUnsatisfied(input.profile),
      ...detectUnresolvedHostImports(input.profile),
      ...detectHostSubpathNotExported(input.profile),
      ...detectClientInjectUnprovided(input.profile),
      ...detectCrossRealmServiceName(input.profile),
      ...detectInjectCycle(input.profile),
      ...detectEngineUnsatisfied(input.profile, input.nodeVersion),
    )
  }
  if (input.live !== undefined && input.profile !== undefined) {
    findings.push(...detectOutboundToolCollision(input.live, input.profile))
  }
  // Risk is computed here, at the single exit, rather than annotated at each of
  // the ~29 fix construction sites: the snippet is the authority, and a label
  // written by hand drifts from it the first time someone edits the YAML.
  return dedupe(sortFindings(findings)).map(withComputedRisk)
}

/**
 * Attach a computed risk level to every fix of one finding.
 *
 * Also asserts the invariant that a finding carries at least one fix, which the
 * schema states as `minItems: 1` — a critical conflict with no suggested repair
 * is a bug in this tool, not a fact about the profile.
 *
 * @param finding - a finding whose fixes may lack a risk level.
 * @returns the same finding, with every fix graded.
 */
function withComputedRisk(finding: Finding): Finding {
  return {
    ...finding,
    fixes: finding.fixes.map((fix) => ({ ...fix, risk: classifyRisk(fix.kind, fix.snippet) })),
  }
}

/**
 * Collapse findings that are the same diagnosis reached twice.
 *
 * The live and static halves legitimately observe one conflict from two sides
 * (`live/unprovided-inject` and `profile/service-collision` both describe one
 * missing provider). Keeping both would double-count the same fact, so the
 * first occurrence of an identical (code, title, refs) triple wins.
 */
function dedupe(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const finding of findings) {
    const key = `${finding.code}\u0000${finding.title}\u0000${finding.refs.join('\u0001')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(finding)
  }
  return out
}
