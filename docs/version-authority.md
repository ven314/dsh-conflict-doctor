# 版本权威性：为什么「拿磁盘副本比对」会造出并不存在的冲突

这份文档解释一个设计约束——**版本敏感的检查必须与「正在运行的宿主」比对**——
以及它如何从一次被实测证伪的误报，演进成今天从宿主 archive 直接读取导出面。

## 问题

打包的桌面版 DSH 从**自己的 archive** 提供 profile bundle：

| 位置                                             | 内容                               | 谁在用           |
| ------------------------------------------------ | ---------------------------------- | ---------------- |
| `…/Programs/DeepSeek Harness/resources/app.asar` | `@deepseek-ai/dsh-base@0.2.0-rc.2` | **运行中的进程** |
| `~/.dsh/profiles/desktop/node_modules`           | `@deepseek-ai/dsh-base@0.1.0-rc.6` | 磁盘上的一份副本 |

两者不是同一代。早期版本直接拿磁盘副本当基准做导入符号比对，产出了 **7 条并不存在的冲突**：
声称社区插件 import 了宿主没有的符号。实测把那些符号在运行宿主的 archive 里数出来——
`IconBranchOutlineRegular` 7 处、`resolveImageAttachmentAccess` 13 处，**全都在**。

结论：一次被证伪的误报，比十次「可能有问题」更伤信任。宁可不报，也不能拿错误的基准报。

## 四态判定

`resolveVersionAuthority` 返回四种判定之一。判定本身是纯函数，可直接单测。

| 判定                    | 何时                                                | 版本敏感检查              |
| ----------------------- | --------------------------------------------------- | ------------------------- |
| `authoritative`         | 运行宿主报的版本 == 磁盘版本                        | 正常比对                  |
| `archive-authoritative` | 磁盘 ≠ 运行宿主，**但读到了运行宿主自己的 archive** | 以 archive 为基准正常比对 |
| `stale-disk`            | 磁盘 ≠ 运行宿主，且只有版本号、没有 archive         | 跳过并说明原因            |
| `unknown`               | 运行宿主完全无法读取                                | 跳过并在报告里明说        |

判定顺序（先满足者胜出）：

```
liveHost == diskHost                          → authoritative
archiveHost 存在且 != diskHost                 → archive-authoritative
archiveHost 存在且 diskHost 不存在             → archive-authoritative
liveHost 存在且 != diskHost                    → stale-disk
否则                                           → unknown
```

### 为什么要有第四态

前三态是 0.1.0 的原始设计，问题在于：**在一个典型的桌面安装上，它等于让最有价值的三类检查
全部失效**。`stale-disk` 一律弃权，于是「插件调了宿主不导出的 API」这种静默故障永远不会被报出来。

`archive-authoritative` 用「读取运行宿主自己的字节」替代弃权。这不是放宽标准，
而是换了一个更硬的证据来源：磁盘副本是二手猜测，archive 是进程真正加载的东西。

### 弃权仍然存在，只是不再滥用

当 archive 找不到时（非打包安装、装在未知位置），判定退回 `unknown`，
并且**必须在报告里写明**（见下）。`versionsComparable()` 是唯一的闸门：

```ts
export function versionsComparable(snapshot: StaticSnapshot): boolean {
  return snapshot.versionAuthority === 'authoritative' || snapshot.versionAuthority === 'archive-authoritative'
}
```

## 怎么读 archive

`src/asar.ts` 实现了零依赖的 asar 读取。格式本身很小，但真实文件有两处只有测量才能发现的行为：

### 1. u32 header 字段不能用来定位 JSON 树

真实 121 MB archive 的 u32 @4 报 `3392056`，而 JSON 树实际到 `3392064`——**差 8 字节**。
按它切片会得到 `Unterminated string`，看起来像文件损坏。改为对树做括号匹配，
只扫字节不扫字符（结构字符全是 ASCII，UTF-8 保证多字节序列里不会出现它们），
并且**按需扩大读取窗口**：先读 `headerSize + 256KB`，不平衡才翻倍。
早期实现总是读 `headerSize + 64MB`，一次冷启动要多花十几秒去读随后就丢掉的字节。

### 2. 内容偏移相对于「树的末尾」，不是文件开头

用 SHA-256 反推出来的（这是唯一可靠的办法）：`package.json` 声明 offset `117911453`，
但它的字节实际起于 `121303517`，差值恰好是 `16 + treeLen`。所以：

```
contentBase = 16 + treeLen
realOffset  = contentBase + declaredOffset
```

`size` / `offset` 在现代 Electron 里还可能写成**字符串**（为了超过 2^53 的偏移不丢精度），
因此 `typeof === 'number'` 的判断会把它们全部拒掉。

**验证方式**：archive 里每个文件都带 `integrity.hash`。读取器对
`package.json`、`dsh/package.json`、`@deepseek-ai/dsh-base/package.json` 三个文件
算 SHA-256 并与之比对，**0 处不匹配**才算通过。这比「能读出东西」强得多。

## 导出面如何提取

`src/surface.ts` 从一个入口出发收集「这个包允许别人 import 什么」：

1. 有 `exports` 就按它的子路径映射走（`types` → `import` → `default` → `require` 依次尝试）；
2. 否则 `types` / `typings` 优先于 `main`——`.d.ts` 表达意图，没有 CJS/ESM 歧义；
3. 两者都不可用才退化为「目录联合」，并**永远标记为 incomplete**。

随后跟随 `export * from`、`export {} from`、相对 `import` 形成闭包，带深度上限与环检测。
同时识别 CJS 产物（`exports.x =`、`module.exports = {...}`、`Object.defineProperty(exports, …)`），
因为打包产物经常与 manifest 的 `type` 字段说法不一致。

提取结果**刻意是上近似**：任何文件导出的名字都算数。理由是错误不对称——
漏报只是少一条线索，误报会让用户去追一个并不存在的冲突。

### 实测踩到的四个坑

| 现象                                                      | 根因                                                                  | 现在的做法                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| 入口变成 `pkg/./package.json`，**所有**宿主符号都被判缺失 | manifest 写 `./lib/index.js`，字符串拼接没归一化 `.`                  | 路径统一归一化                                            |
| `exports.types` 指向的 `.d.ts` 在产物里不存在             | 打包时剥掉了类型文件                                                  | 依次回退到下一个候选，而不是放弃                          |
| `dsh-base` 报 0 个导出                                    | 它真的只写 `export {};`——它是 bundle，不是库                          | 0 个名字就是事实；标记 incomplete，避免被读成「全都缺失」 |
| 扁平包扫描**死循环**                                      | 目录联合与入口闭包**共用** visited 集合，而前者遍历目录、后者遍历文件 | 各自独立的 visited 集合 + 深度上限                        |

最后一条尤其值得记：共用一个 `Set` 时，一个从未以「文件」身份被记录的目录会被反复入栈。
单元测试里 500 个文件的包直接挂住，靠超时才被发现。

## 降级必须说话

任何一处读取失败都走「记录 note」而不是抛错。但**沉默的跳过是不可接受的**：
如果 archive 找不到却什么都不说，读者会以为「版本敏感检查跑了，没发现问题」，
而事实是**它们根本没跑**。所以：

- archive 找不到 → note 说明原因，并提示 `DSH_INSTALL_ROOT` / `DSH_APP_ASAR` 可指定位置；
- archive 读取抛错 → note 带上原始错误信息；
- 判定非 `versionsComparable` → 报告 coverage 段必须出现 `versionAuthorityReason`。

## 性能预算

| 操作                                | 预算    | 实测       |
| ----------------------------------- | ------- | ---------- |
| `collectHostFacts`（500 个 bundle） | ≤ 400ms | ~130–220ms |
| 单个包的导出面（热）                | ≤ 10ms  | 1–2ms      |
| 整个 profile 扫描（138 包）         | ≤ 6s    | ~1.9s      |

两条缓存是必需的，不是优化：

1. **archive 句柄不关**。`openAsar` 要解码约 3.4MB 的 JSON 树；每个包关一次、重开一次，
   一次全量扫描就是 8 秒的重复解析。`closeHostArchive()` 在审计结束时释放。
2. **导出面按包名缓存**。同一个宿主包会被几十个插件 import。

失败也缓存（negative caching）：损坏的包不会被每个 import 它的插件重试一遍。

## 安全边界

包名来自插件源码里的 import 语句，属于可被影响的数据。`isSafePackageName()` 按 npm 自身
的名字语法做白名单，拒绝任何含 `..` 或越界 `/` 的输入；`readHostSurface` 在入口处执行该检查。
archive 内部路径同样只经由解码后的树解析，不接触文件系统路径。

## 测试覆盖

| 检查    | 内容                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| D1–D9   | asar 布局：短 8 字节的 header 字段、字符串偏移、相邻文件不串读、UTF-8、目录不可当文件读、遍历防护、损坏文件可读报错 |
| E1–E9   | 导出面：`./` 路径归一化、`.d.ts` 缺失回退、混合别名列表、`export *` 闭包、环终止、CJS 形态、空入口退化、文件预算    |
| E10–E11 | 真实 archive 端到端；README 记录的两个误报符号必须仍然解析得到                                                      |
| E12     | 全部 unchecked import 都要能在运行宿主的真实导出面里被证伪                                                          |
| E13–E14 | 四态判定与闸门                                                                                                      |
| E15     | 包名逃逸防护                                                                                                        |
| E16     | 缺宿主时报告必须明说，不能静默跳过                                                                                  |

E11 是这套测试里最重要的一条：它把项目历史上那次误报钉成了回归测试。
`resolveImageAttachmentAccess` 必须永远解析得到；`assertNever` 必须永远解析不到——
**两个方向都要成立**，否则要么重演误报，要么把真实冲突吞掉。
