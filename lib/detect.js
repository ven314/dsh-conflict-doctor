import { lt, minVersion } from 'semver';
import { satisfiesRange } from './static.js';
/** Rank used to sort findings by urgency and then by code. */
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
/** Build the patch fragment that disables one Loader row. */
function disableSnippet(rowId) {
    return `- id: ${rowId}\n  disabled: true`;
}
/** Build the patch fragment that replaces one Loader row's config. */
function configSnippet(rowId, moduleName, config) {
    return `- id: ${rowId}\n  name: '${moduleName}'\n  config: ${config}`;
}
/** Sort findings deterministically: severity, then code, then first ref. */
export function sortFindings(findings) {
    return [...findings].sort((left, right) => {
        const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
        if (bySeverity !== 0)
            return bySeverity;
        if (left.code !== right.code)
            return left.code < right.code ? -1 : 1;
        return (left.refs[0] ?? '') < (right.refs[0] ?? '') ? -1 : 1;
    });
}
/* -------------------------------------------------------------------------- */
/* Live detectors                                                             */
/* -------------------------------------------------------------------------- */
/** A fiber that will never activate because a declared service never appears. */
function detectPendingMissingService(live) {
    const findings = [];
    for (const entry of live.entries) {
        if (entry.fiberPhase !== 'pending' || entry.missingInject.length === 0)
            continue;
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
        });
    }
    return findings;
}
/** A fiber whose startup threw — the only visible symptom of most conflicts. */
function detectFailedFiber(live) {
    const findings = [];
    for (const entry of live.entries) {
        if (entry.fiberPhase !== 'failed')
            continue;
        const text = entry.errorText ?? '(no error text captured by the runtime)';
        const collision = /tool ["'`]([^"'`]+)["'`] is already registered/.exec(text);
        const collided = collision?.[1];
        const alreadyLive = collided !== undefined && live.tools.includes(collided);
        const fixes = [
            {
                kind: 'patch',
                label: '先把冲突行停用，让整棵树恢复启动',
                detail: '通过 patch 停用失败行是最快恢复手段；恢复后再决定长期方案（改名或二选一）。',
                snippet: disableSnippet(entry.entryId),
            },
        ];
        if (collided !== undefined) {
            fixes.unshift({
                kind: 'manual',
                label: `让两个插件之一放弃 tool id “${collided}”`,
                detail: 'dsh 的 tool 注册表在同一层内不允许重名：后注册者直接抛错，失败的是整个插件而不是单个工具。改名的那个必须同时改掉它自己的提示词/文档，否则模型会按旧名字调用。',
            });
        }
        findings.push({
            code: collided === undefined ? 'live/failed-fiber' : 'live/tool-id-conflict',
            severity: 'critical',
            title: collided === undefined
                ? `“${entry.entryId}” 启动失败`
                : `tool id 冲突：“${collided}” 被两个插件重复注册`,
            refs: [entry.entryId, entry.moduleName, ...(collided === undefined ? [] : [collided])],
            impact: collided === undefined
                ? '该行的全部能力（工具、命令、服务、UI）都不存在；如果它还被别的插件 inject，依赖它的插件会一起停在 PENDING。'
                : `后注册的插件整行加载失败，而不是只丢掉这一个工具。冲突的 tool id “${collided}” 在冲突发生${alreadyLive ? '前已由其他插件注册' : '时仍留在注册表里'}。`,
            evidence: [
                `entry「${entry.entryId}」(${entry.moduleName}) 的 fiber 状态是 failed`,
                `运行时错误：${text.split('\n')[0] ?? text}`,
                ...(collided === undefined ? [] : [`当前注册表中的同名工具：${collided}`]),
            ],
            fixes,
        });
    }
    return findings;
}
/** Two Loader rows claiming one id (the documented whole-tree crash). */
function detectDuplicateEntryId(live) {
    const byId = new Map();
    for (const entry of live.entries) {
        const list = byId.get(entry.entryId) ?? [];
        list.push(entry.moduleName);
        byId.set(entry.entryId, list);
    }
    const findings = [];
    for (const [entryId, modules] of byId) {
        if (modules.length < 2)
            continue;
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
        });
    }
    return findings;
}
/** A declared inject that nothing in the process provides (latent PENDING cause). */
function detectUnprovidedInject(live) {
    const findings = [];
    for (const entry of live.entries) {
        if (entry.fiberPhase === 'active' || entry.inject.length === 0)
            continue;
        const never = entry.inject.filter((name) => !live.services.some((service) => service.service === name));
        if (never.length === 0)
            continue;
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
        });
    }
    return findings;
}
/* -------------------------------------------------------------------------- */
/* Profile detectors                                                          */
/* -------------------------------------------------------------------------- */
/** One layer inserting the same row id twice: the Loader's hard collision. */
function detectDuplicateRowInLayer(snapshot) {
    const byLayer = new Map();
    for (const row of snapshot.inserts) {
        const layer = byLayer.get(row.layerIndex) ?? new Map();
        const list = layer.get(row.rowId) ?? [];
        list.push(row);
        layer.set(row.rowId, list);
        byLayer.set(row.layerIndex, layer);
    }
    const findings = [];
    for (const [layerIndex, rows] of byLayer) {
        const layer = snapshot.layers[layerIndex];
        for (const [rowId, list] of rows) {
            if (list.length < 2)
                continue;
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
            });
        }
    }
    return findings;
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
function detectModuleUnderMultipleIds(snapshot) {
    const byLayer = new Map();
    for (const row of snapshot.inserts) {
        const layer = byLayer.get(row.layerIndex) ?? new Map();
        const list = layer.get(row.moduleName) ?? [];
        list.push(row);
        layer.set(row.moduleName, list);
        byLayer.set(row.layerIndex, layer);
    }
    const findings = [];
    for (const [layerIndex, modules] of byLayer) {
        const layer = snapshot.layers[layerIndex];
        for (const [moduleName, rows] of modules) {
            if (rows.length < 2)
                continue;
            const rowIds = rows.map((row) => row.rowId);
            const configs = new Set(rows.map((row) => row.configJson));
            const parameterized = configs.size > 1 && !configs.has('null');
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
            });
        }
    }
    return findings;
}
/** A disable that a later layer silently undoes. */
function detectDisableThenReinsert(snapshot) {
    const order = [];
    for (const row of snapshot.inserts)
        order.push({ rowId: row.rowId, action: 'enable', layerIndex: row.layerIndex });
    for (const row of snapshot.overrides) {
        order.push({ rowId: row.rowId, action: row.disabled ? 'disable' : 'enable', layerIndex: row.layerIndex });
    }
    // A stable sort keeps every insert of one layer ahead of that layer's
    // id-addressed overrides, which mirrors how the Loader applies one file.
    order.sort((left, right) => left.layerIndex - right.layerIndex);
    const state = new Map();
    const findings = [];
    for (const step of order) {
        const current = state.get(step.rowId);
        if (step.action === 'disable') {
            state.set(step.rowId, { disabledAt: step.layerIndex });
            continue;
        }
        if (current !== undefined) {
            const disabledLayer = snapshot.layers[current.disabledAt];
            const enableLayer = snapshot.layers[step.layerIndex];
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
            });
            state.delete(step.rowId);
        }
    }
    return findings;
}
/**
 * Two or more layers restating one row's config: last write wins, silently.
 *
 * Reported as `info` on purpose. This pattern is the documented DSH layering
 * contract ("each mode bundle restates its complete configuration"), so on a
 * healthy profile it fires legitimately. It is still worth showing, because the
 * same mechanism silently drops a REQUIRED config written in an earlier layer —
 * the user-visible symptom being "I configured it and nothing happened".
 */
function detectRowConfigReplaced(snapshot) {
    const perRow = new Map();
    const add = (rowId, layerIndex, configJson, hasConfig, moduleName) => {
        if (!hasConfig)
            return;
        const list = perRow.get(rowId) ?? [];
        list.push({ layerIndex, configJson, ...(moduleName === undefined ? {} : { moduleName }) });
        perRow.set(rowId, list);
    };
    for (const row of snapshot.inserts)
        add(row.rowId, row.layerIndex, row.configJson, row.hasConfig, row.moduleName);
    for (const row of snapshot.overrides)
        add(row.rowId, row.layerIndex, row.configJson, row.hasConfig, row.moduleName);
    const findings = [];
    for (const [rowId, entries] of perRow) {
        const distinct = new Set(entries.map((entry) => entry.configJson));
        if (entries.length < 2 || distinct.size < 2)
            continue;
        const labels = entries.map((entry) => `${snapshot.layers[entry.layerIndex]?.label ?? `layer ${entry.layerIndex}`} → ${entry.configJson}`);
        const last = entries[entries.length - 1];
        findings.push({
            code: 'profile/row-config-replaced',
            severity: 'info',
            title: `row“${rowId}” 的 config 被多层覆盖，只有最后一层生效`,
            refs: [rowId, ...entries.map((entry) => snapshot.layers[entry.layerIndex]?.label ?? `layer ${entry.layerIndex}`)],
            impact: 'patch 是整段替换而不是合并：前面层写下的 config 全部被丢掉。如果那层写的是必需项（而不是模式差异），功能会以「配置明明写了却无效」的形式坏掉。',
            evidence: labels,
            fixes: [
                {
                    kind: 'patch',
                    label: '把最终想要的完整 config 写进最后一层',
                    detail: '在用户 patch 里写出完整 config，是唯一不会被后续层意外截断的做法。',
                    ...(last?.moduleName === undefined ? {} : { snippet: configSnippet(rowId, last.moduleName, last.configJson) }),
                },
            ],
        });
    }
    return findings;
}
/** An override that addresses a row no layer ever inserts. */
function detectDanglingOverride(snapshot) {
    const inserted = new Set(snapshot.inserts.map((row) => row.rowId));
    const byRow = new Map();
    for (const row of snapshot.overrides) {
        if (inserted.has(row.rowId))
            continue;
        const list = byRow.get(row.rowId) ?? [];
        list.push(row);
        byRow.set(row.rowId, list);
    }
    const findings = [];
    for (const [rowId, rows] of byRow) {
        const layer = snapshot.layers[rows[0]?.layerIndex ?? 0];
        // An override that carries a module name is an insert of a new row, which is
        // legitimate; only a bare config/disable with no owning insert is dangling.
        if (rows.some((row) => row.moduleName !== undefined))
            continue;
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
        });
    }
    return findings;
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
function detectUnresolvedBundles(snapshot) {
    const unresolved = snapshot.unresolvedBundles ?? [];
    if (unresolved.length === 0)
        return [];
    return [
        {
            code: 'profile/bundle-unresolved',
            severity: 'info',
            title: `${unresolved.length} 个 bundle 在 node_modules 里找不到`,
            refs: [...unresolved],
            impact: '这些名字出现在 dsh.profile.bundles 里，但磁盘上的任何 node_modules 根目录都解析不到。如果它们由 app 内置解析器提供（DSH 自带的 experimental bundle 就是这样），属于正常；如果是社区包被删了却还留在 bundles 列表里，那就等于插件已经不存在。',
            evidence: unresolved.map((name) => `未解析：${name}`),
            fixes: [
                {
                    kind: 'command',
                    label: '确认来源：内置 bundle 保持原样，社区包重新安装',
                    detail: '用一个能启动的组合验证；若 profile 停在这一步，日志里会出现该模块名。',
                },
            ],
        },
    ];
}
/** A declared module the profile cannot resolve. */
function detectMissingPatchFile(snapshot) {
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
    }));
}
/** Two packages declaring the same tool id in their compiled sources. */
function detectDeclaredToolCollision(snapshot) {
    const findings = [];
    for (const [tool, owners] of Object.entries(snapshot.declaredTools)) {
        if (owners.length < 2)
            continue;
        findings.push({
            code: 'profile/tool-id-collision',
            severity: 'critical',
            title: `两个以上插件都声明了 tool id“${tool}”`,
            refs: [tool, ...owners],
            impact: '这是静态依赖检查永远看不到的能力级冲突：peer 版本都匹配，但运行到第二步注册时后者抛错、整行加载失败。谁先加载取决于服务可用顺序，因此现象具有偶发性。',
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
        });
    }
    return findings;
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
 * REFUSES TO RUN against a non-authoritative snapshot. When the profile's
 * on-disk copies are not the host that is actually running, every comparison
 * here would be against the wrong baseline and would report conflicts that do
 * not exist — so the honest output is nothing plus a coverage note.
 */
function detectPeerRangeUnsatisfied(snapshot) {
    // Both non-authoritative verdicts suppress the check. `stale-disk` means the
    // on-disk copies are demonstrably not the running host; `unknown` means that
    // could not be established. Either way a comparison would be a guess, and a
    // version checker that guesses is worse than one that stays quiet.
    if (snapshot.versionAuthority !== 'authoritative')
        return [];
    const installed = new Map(snapshot.packages.map((entry) => [entry.name, entry.version]));
    const findings = [];
    for (const pkg of snapshot.packages) {
        const belowMinimum = [];
        const other = [];
        for (const [dep, range] of Object.entries(pkg.ranges)) {
            const current = installed.get(dep);
            if (satisfiesRange(current, range) !== false)
                continue;
            const minimum = minVersion(range);
            const line = `${dep} 声明 ${range} / 已装 ${current ?? '(未解析到)'}`;
            if (minimum !== null && current !== undefined && lt(current, minimum))
                belowMinimum.push(line);
            else
                other.push(line);
        }
        if (belowMinimum.length + other.length === 0)
            continue;
        const below = belowMinimum.length > 0;
        const lines = [...belowMinimum, ...other];
        findings.push({
            code: 'profile/peer-range-unsatisfied',
            severity: below ? 'warning' : 'info',
            title: below
                ? `${pkg.name}@${pkg.version} 是按更晚的宿主版本构建的：${belowMinimum.length} 项声明高于当前安装`
                : `${pkg.name}@${pkg.version} 的依赖声明比当前安装更旧：${other.length} 项`,
            refs: [pkg.name, `${pkg.name}@${pkg.version}`, ...lines.map((line) => line.split(' ')[0] ?? '')].filter((ref) => ref.length > 0),
            impact: below
                ? '这些范围的最小版本高于当前进程里安装的版本。插件通常仍能加载，但它调用的新 API 在旧宿主上不存在——失败发生在第一次真正调用时，堆栈指向插件而不是版本。'
                : '插件声明的是更旧的宿主版本，通常仍然可用；只有在 API 发生破坏性变更时才需要处理。',
            evidence: [
                `${pkg.name}@${pkg.version} (${pkg.dir})`,
                ...lines.map((line) => `不满足：${line}`),
                ...(below
                    ? ['判断依据：已安装版本低于声明范围的最小版本，属于「宿主比插件旧」。']
                    : ['判断依据：只是声明更旧，未低于最小值。']),
            ],
            fixes: [
                {
                    kind: 'manual',
                    label: below ? '升级宿主，或换用与当前宿主匹配的插件版本' : '确认插件在当前宿主上仍按预期工作',
                    detail: below
                        ? '先对齐版本再谈别的；对齐后若仍不生效，才需要逐条比对插件实际调用的 API 面。'
                        : '这种漂移一般无害；如果该插件正在出问题，把它作为第一个排查方向。',
                },
            ],
        });
    }
    return findings;
}
/** A package whose declared Node engine the running Node cannot satisfy. */
function detectEngineUnsatisfied(snapshot, nodeVersion) {
    const findings = [];
    for (const pkg of snapshot.packages) {
        if (pkg.enginesNode === undefined)
            continue;
        const verdict = satisfiesRange(nodeVersion, pkg.enginesNode);
        if (verdict !== false)
            continue;
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
        });
    }
    return findings;
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
function detectServiceCollision(snapshot) {
    const findings = [];
    const clientOnly = new Set(snapshot.packages.filter((pkg) => pkg.halves !== undefined && pkg.halves === 'client').map((pkg) => pkg.name));
    for (const [service, owners] of Object.entries(snapshot.declaredServices ?? {})) {
        const hostOwners = owners.filter((owner) => !clientOnly.has(owner));
        if (hostOwners.length < 2)
            continue;
        findings.push({
            code: 'profile/service-collision',
            severity: 'warning',
            title: `两个包都注册服务“${service}”`,
            refs: [service, ...hostOwners],
            impact: '同名服务不允许有两个实现：谁生效取决于激活顺序，而激活顺序由服务可用性驱动，因此现象会随启动环境变化。用户看到的是「有时对、有时不对」，最难复现的一类。',
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
        });
    }
    return findings;
}
/**
 * A PENDING fiber whose missing service is provided by that very fiber.
 *
 * The classic deadlock: plugin X mounts a provider and depends on it in the
 * same apply. It waits for a service only it would create, so it waits forever.
 * The generic "missing service" message is misleading here — installing a
 * provider is the wrong fix, because the provider is X itself.
 */
function detectSelfDependentPending(live) {
    const declared = live.declaredProvides;
    if (declared === undefined)
        return [];
    const findings = [];
    for (const entry of live.entries) {
        if (entry.fiberPhase !== 'pending' || entry.missingInject.length === 0)
            continue;
        const selfProvided = declared
            .filter((provided) => provided.entryId === entry.entryId)
            .map((provided) => provided.service);
        const trapped = entry.missingInject.filter((service) => selfProvided.includes(service));
        if (trapped.length === 0)
            continue;
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
        });
    }
    return findings;
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
function detectOutboundToolCollision(live, profile) {
    const declared = live.declaredTools;
    if (declared === undefined)
        return [];
    const registered = new Set(live.tools);
    const findings = [];
    for (const [tool, owners] of Object.entries(profile.declaredTools ?? {})) {
        if (owners.length < 2 || registered.has(tool))
            continue;
        // Owners that are actually present in the loaded entry set make this
        // collision imminent rather than theoretical.
        const loadedModules = new Set(live.entries.map((entry) => entry.moduleName));
        const loadedOwners = owners.filter((owner) => loadedModules.has(owner));
        if (loadedOwners.length < 2)
            continue;
        findings.push({
            code: 'live/outbound-tool-collision',
            severity: 'warning',
            title: `即将发生的 tool id 冲突：“${tool}”`,
            refs: [tool, ...loadedOwners],
            impact: '两个已加载的插件都声明了这个 tool id，但当前注册表里还没有它——说明其中一方的注册尚未发生（例如它还停在 PENDING）。一旦它注册，后注册者整行失败。',
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
        });
    }
    return findings;
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
function detectUnresolvedHostImports(snapshot) {
    // Same gate as the peer-range check: resolving an import against a copy of
    // the host that is not the running one reports missing symbols the running
    // host actually exports.
    if (snapshot.versionAuthority !== 'authoritative')
        return [];
    const findings = [];
    for (const facts of Object.values(snapshot.sourceFacts ?? {})) {
        if (facts.uncheckedImports.length === 0)
            continue;
        findings.push({
            code: 'profile/host-import-unsatisfied',
            severity: 'warning',
            title: `${facts.name} 导入了当前宿主并不导出的符号（${facts.uncheckedImports.length} 个）`,
            refs: [facts.name, ...facts.uncheckedImports.map((symbol) => `${symbol.module}#${symbol.symbol}`)],
            impact: 'peer 版本字符串匹配不等于 API 存在。这些符号在已安装的宿主包里找不到，调用点会以 undefined 的形式失败——错误指向插件，而根因是宿主版本。',
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
        });
    }
    return findings;
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
export function detect(input) {
    const findings = [];
    if (input.live !== undefined) {
        findings.push(...detectFailedFiber(input.live), ...detectSelfDependentPending(input.live), ...detectPendingMissingService(input.live), ...detectDuplicateEntryId(input.live), ...detectUnprovidedInject(input.live));
    }
    if (input.profile !== undefined) {
        findings.push(...detectMissingPatchFile(input.profile), ...detectDuplicateRowInLayer(input.profile), ...detectModuleUnderMultipleIds(input.profile), ...detectDisableThenReinsert(input.profile), ...detectDeclaredToolCollision(input.profile), ...detectServiceCollision(input.profile), ...detectUnresolvedBundles(input.profile), ...detectRowConfigReplaced(input.profile), ...detectDanglingOverride(input.profile), ...detectPeerRangeUnsatisfied(input.profile), ...detectUnresolvedHostImports(input.profile), ...detectEngineUnsatisfied(input.profile, input.nodeVersion));
    }
    if (input.live !== undefined && input.profile !== undefined) {
        findings.push(...detectOutboundToolCollision(input.live, input.profile));
    }
    return dedupe(sortFindings(findings));
}
/**
 * Collapse findings that are the same diagnosis reached twice.
 *
 * The live and static halves legitimately observe one conflict from two sides
 * (`live/unprovided-inject` and `profile/service-collision` both describe one
 * missing provider). Keeping both would double-count the same fact, so the
 * first occurrence of an identical (code, title, refs) triple wins.
 */
function dedupe(findings) {
    const seen = new Set();
    const out = [];
    for (const finding of findings) {
        const key = `${finding.code}\u0000${finding.title}\u0000${finding.refs.join('\u0001')}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(finding);
    }
    return out;
}
