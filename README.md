# dsh-conflict-doctor

**插件冲突治理：把「装上了但没生效」变成一条可执行的结论。**

DSH 有大量手段告诉你插件*装上了*；没有任何手段告诉你插件*没在工作*。三类真实故障全部是静默的：

| 现象                         | 实际发生的事                                                               | 现有工具为什么看不见           |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| 装完插件，功能不出现         | fiber 停在 `PENDING`，等一个没人提供的服务，不报错、不打日志               | 没有报错就没有信号             |
| 装第二个插件后整个功能没了   | tool id 重复 → 后注册者抛错 → **整行**加载失败，错误信息不指出另一个 owner | 错误只说「already registered」 |
| 「我明明关了它，怎么还生效」 | 后一层 patch 把前一层的 `disabled`/`config` 盖掉了                         | 层语义是整段替换、最后一层胜出 |

本插件把运行期图谱与磁盘上的 patch 层对齐，给出**谁和谁撞了 + 改哪一行**。

## 它检测什么

**运行期（live）**

| code                           | 严重度   | 含义                                                                              |
| ------------------------------ | -------- | --------------------------------------------------------------------------------- |
| `live/tool-id-conflict`        | critical | 两个插件注册同一个 tool id；从失败 fiber 的错误里认出冲突名，并确认它已在注册表中 |
| `live/failed-fiber`            | critical | 任何启动失败的 fiber，带原始错误首行                                              |
| `live/pending-missing-service` | critical | fiber 停在 PENDING 且 `inject` 的服务无人提供——静默失败的根源                     |
| `live/duplicate-entry-id`      | critical | 两个模块占用同一个 Loader entry id（整树启动失败）                                |
| `live/unprovided-inject`       | warning  | 声明依赖的服务在整个进程里都不存在（下次重载就会挂）                              |

**磁盘组合（profile）**

| code                                | 严重度          | 含义                                                                                                                                                           |
| ----------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile/duplicate-row-in-layer`    | critical        | 同一 patch 层里 row id 重复                                                                                                                                    |
| `profile/module-under-multiple-ids` | critical / info | 同一模块挂两次。**config 不同 → info**（`dsh-tool-subagent` 用 `toolName: subagent` / `subagent_fork` 刻意挂两次）；config 相同或为空 → critical（真的挂重了） |
| `profile/disable-then-reinsert`     | critical        | 某层停用、后面的层又插进来                                                                                                                                     |
| `profile/missing-patch-file`        | critical        | bundle 声明的 `dsh.bundle.patch` 在磁盘上不存在                                                                                                                |
| `profile/tool-id-collision`         | critical        | 两个包在编译产物里声明了同一个 tool id。**这是静态版本比对永远覆盖不到的能力级冲突**                                                                           |
| `profile/peer-range-unsatisfied`    | warning / info  | 按包分组。已装版本**低于**声明最小值 → warning（宿主比插件旧，真会坏）；只是声明更旧 → info。**仅在版本权威性已确认时运行**（见下）                            |
| `profile/host-import-unsatisfied`   | warning         | 插件从宿主包里 import 了一个**当前宿主并不导出**的符号。这是「peer 版本字符串匹配 ≠ API 存在」的具体形态。**仅在版本权威性已确认时运行**                       |
| `profile/service-collision`         | warning         | 两个包注册同名服务。**按 realm 过滤**：浏览器侧包（`dsh.client`）不与宿主共享服务表，不参与比对                                                                |
| `profile/row-config-replaced`       | info            | 多层依次替换同一 row 的 config（DSH 的层语义，符合预期时无需处理，所以只作提示）                                                                               |
| `profile/dangling-override`         | warning         | patch 里的 `- id: X` 不对应任何已插入的 row（空操作，不报错）                                                                                                  |
| `profile/node-engine-unsatisfied`   | warning         | `engines.node` 不满足当前 Node。**仅在版本权威性已确认时运行**                                                                                                 |
| `profile/bundle-unresolved`         | info            | `dsh.profile.bundles` 里的名字在 node_modules 里解析不到                                                                                                       |

运行期还有两条需要跨两半才能看出的：

| code                           | 严重度   | 含义                                                                                         |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------- |
| `live/pending-self-dependent`  | critical | fiber 等的服务正是**它自己**要提供的——自锁，永远不会激活。修复不是「装 provider」            |
| `live/outbound-tool-collision` | warning  | 两个**已加载**的插件都声明了同一 tool id，而该 id 还没进注册表：冲突是确定的，只是被时序掩盖 |

### 版本权威性：一次真实的误报与修正

这是本工具最重要的一条设计约束，来自一次被实测证伪的错误。

打包的桌面应用从**自己的 archive** 提供 profile bundle（`@deepseek-ai/dsh-base@0.2.0-rc.2`），而 `profiles/node_modules` 里可能是另一代（`0.1.0-rc.6`）。早期版本直接拿磁盘副本当基准，于是产出了 7 条**并不存在**的冲突：声称社区插件 import 了宿主没有的符号、peer 范围不满足。实测把那些符号在运行宿主的 archive 里数出来——`IconBranchOutlineRegular` 7 处、`resolveImageAttachmentAccess` 13 处，**全都在**。

所以现在：插件启动时先向 `pluginManager` 问运行中的真实版本，再决定要不要做版本敏感的判断。

- 两边一致 → `authoritative`，正常比对；
- 不一致 → `stale-disk`，**跳过** peer / import / engines 三类检查，并在报告里说明原因；
- 读不到运行版本 → `unknown`，同样跳过。

宁可不报，也不拿错误的基准报。结构类检查（重复 row、双挂载、层覆盖、配置被替换）不依赖版本，任何时候都照常运行。

每条 finding 都带 `refs`（涉及对象）、`evidence`（证据，不是猜测）、`impact`（会怎么坏）和至少一条 `fix`；能用 patch 修的直接给出可粘贴的 YAML。

## 安装

从插件市场（Settings → Plugin Market）搜索安装，或直接：

```bash
dsh plugin --profile web add dsh-conflict-doctor
```

然后把包名加进该 profile `package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-conflict-doctor"] } }
}
```

或者不安装，直接用 overlay 验证组合层：

```bash
dsh --profile web --patch <path-to>/conflict-doctor/cordis.patch.yml --dump-config
```

> **关于名字。** npm 上的 `dsh-plugin-doctor` 是另一个作者的工具，做的是「兼容性 / 安全性 / 隔离安装 / 回滚」。本插件做的是**冲突诊断与修复**——谁和谁撞了、为什么静默失效、改哪一行。定位不同但名字几乎相同，会在市场上造成安装歧义，因此本包定名为 `dsh-conflict-doctor`。

## 使用

模型侧工具：

```
conflict_doctor { scope: "all" | "live" | "profile", profilePath?: string, format?: "markdown" | "json" }
```

用户侧命令：

```
/conflict-doctor
```

- `scope: "live"` — 只看运行中的进程（Loader 树、fiber 状态、服务、tool 注册表）
- `scope: "profile"` — 只读磁盘（bundle 清单 → 每层 patch → row ledger）
- `scope: "all"`（默认）— 两者都有

## 设计取向

1. **只读。** 不注册服务、不改配置、不碰注册表，只读 + 报告。一个「治理」插件自己成为故障源是荒谬的。
2. **只有一个硬依赖 `tools`。** `loader`/`commands`/`systemPrompt`/`pluginManager` 全部在用时 `ctx.get`——一个诊断插件如果自己停在 PENDING 就是个笑话。注册全部包在 `ctx.effect()` 里，卸载时干净撤销。
3. **宁缺毋滥。** 每条检测器都在真实 profile 上跑过并调过阈值。真实数据把第一版的 23 条噪音收敛到可执行的少数几条；宁可不报，也不拿错误基准报。
4. **纯函数内核。** 采集（`live.ts` / `static.ts` / `source.ts`）→ 检测（`detect.ts`）→ 渲染（`render.ts`）都是纯函数，可以用 fixture 单测，不需要启动 harness。38 项检查覆盖每个检测器的正例+反例、真实 profile 扫描、以及 Cordis 集成。

## 主动播报

有 critical 冲突时，插件会把它写进**系统提示**（`systemPrompt.context`，order 50），而不是等你来问。没有冲突时贡献空字符串——健康的组合为此付出 0 token。内容只报结论与第一条修复，并明确要求模型在用户提出相关问题前**不要**擅自改配置。

## 能力边界（老实说）

- **tool id 归属无法 100% 归因。** dsh 的 tool 注册表不记录注册者，公开 API 也拿不到调用方 fiber。所以运行期只报告「冲突名 + 失败行」，跨插件的冲突归属由静态扫描（`defineTool({ name: '...' })` 字面量）补上。动态拼出的 tool 名不在静态视野内。
- **静默覆盖只能报症状。** `profile/row-config-replaced` 里无法判断被丢掉的那层 config 是否必需——因为语义上就是整段替换。
- **版本敏感的检查有真实基准。** 打包桌面版从自己的 archive 提供 bundle（`dsh-base@0.2.0-rc.2`），而 `profiles/node_modules` 里可能是另一代（`0.1.0-rc.6`）。现在直接从**运行宿主的 archive** 读取版本与导出面，判定为 `archive-authoritative` 后照常比对；只有既无 archive 又无运行版本时才弃权，并在报告里写明原因。详见 [`docs/version-authority.md`](docs/version-authority.md)。
- **名称类静态提取只认字面量。** `super(ctx, 'name')`、`provide('name')`、`defineTool({ name: '...' })` 能认；拼接出来的名字不能。所以报告措辞是「声明于编译产物」而不是「运行期已注册」。
- **`engines` / peer 是证据不是因果。** 范围不满足不等于一定坏，但它是「插件调了宿主里不存在的 API」的第一嫌疑人。
- **`!!js` 不求值。** 审计按原样记录 profile 提供的表达式——求值等于在审计里执行用户代码。因此 `disabled: !!js ...` 这类条件停用无法判定真假，相关行按「未停用」处理。
- **fiber 错误文本**读的是运行时记录的错误对象（`fiber._error`，非公开字段），取不到时降级为「无错误文本」而不是抛错。

## 开发

```bash
pnpm install
pnpm build      # tsc -> lib/
pnpm test       # 63 项检查：fixture 检测器 + asar/导出面 + 真实 profile 扫描 + Cordis 集成
pnpm check      # 发布与质量门禁：元数据 / 版本 / tarball / 入口 / golden / 性能
node test/check-metadata.mjs   # 发布元数据：name / engines.dsh / files / peer 声明
```

`test/run.mjs` 分五段：**Part A** 每个检测器的正例/反例 fixture（含版本权威性闸门）；**Part B** 对 `$DSH_PROFILE_DIR` 真实 profile 做扫描；**Part C** 把 `apply()` 装进真实 Cordis 容器，验证工具/命令/告警注册、`execute` 输出契约、以及卸载后 `ctx.effect` 干净撤销；**Part D** asar 读取器的合成归档（复刻真实布局，包括那处短 8 字节的 header 字段）；**Part E** 导出面提取与四态判定，含 README 记录的那次误报的回归测试。

`test/emit-report.mjs` 用真实数据写出仓库根目录的 `conflict-doctor-report.md`。它不再硬编码宿主版本，因此报告反映的是运行宿主真正的导出面。

## 路线图

- ~~把 findings 主动播报进系统提示~~ ✅ 已实现（`systemPrompt.context`，无冲突时 0 token）
- ~~服务级冲突：两个插件提供同一个服务名~~ ✅ 已实现（realm 感知）
- ~~对「属性级 API 缺失」做真实比对~~ ✅ 已实现（import ↔ 导出面），并在实测中修正了基准错误
- ~~把版本权威性做彻底~~ ✅ 已实现：零依赖 asar 读取器 + 运行宿主导出面 + 四态判定（`archive-authoritative`）。实测在真实桌面 profile 上把结论从 5 条提升到 42 条，其中 32 条导入冲突经逐一核实为真
- slot / 客户端侧冲突（需要 Client Provider 配合）
- 补丁层语义模拟器：把「config 被替换」升级为键级 provenance，判出被丢掉的层是否必需
- `live/outbound-tool-collision` 的时序预测：结合 fiber 的 `inject` 等待状态，预告「这一行一旦激活就会撞」
- `--fail-on` / SARIF 输出，便于在 CI 里当门禁

MIT
