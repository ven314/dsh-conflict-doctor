# 输出契约与 CI 集成

这份文档说明 `dsh-conflict-doctor` 对外承诺的**稳定接口**：JSON 结构、退出码、
以及如何在 CI 里当门禁。它们是契约，不是实现细节——破坏它们需要升 major。

## 1. JSON 契约

权威定义：[`schema/audit-report.schema.json`](../schema/audit-report.schema.json)（JSON Schema 2020-12）。

```bash
node lib/cli.js --format json --out report.json
node test/check-schema.mjs report.json    # 用一个不依赖外部库的校验器验证
```

顶层字段：

| 字段               | 说明                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `schemaVersion`    | 契约版本。**只有既有字段改变含义时才自增**；新增字段不自增                  |
| `generatedAt`      | ISO-8601 时间戳                                                             |
| `profilePath`      | 被审计的 profile 目录，或 `(running profile)`                               |
| `scope`            | `live` / `profile` / `all`                                                  |
| `summary`          | 各 severity 计数 + 覆盖率计数                                               |
| `findings`         | 冲突列表，按 severity → code → 首个 ref 稳定排序                            |
| `notes`            | 覆盖率缺口，以及任何被 withhold 的检查的原因                                |
| `versionAuthority` | 版本基准是否为运行宿主（见 [`version-authority.md`](version-authority.md)） |

每条 finding：

| 字段       | 说明                                                                 |
| ---------- | -------------------------------------------------------------------- |
| `code`     | 稳定机器码，形如 `realm/kind`（`live/` `profile/` `client/` `fix/`） |
| `severity` | `critical` / `warning` / `info`                                      |
| `title`    | 人话结论                                                             |
| `refs`     | 涉及对象（entry id、row id、包名、tool 名）                          |
| `impact`   | 会怎么坏，用用户能懂的话                                             |
| `evidence` | **证明**这条结论的事实，至少一条；非猜测                             |
| `fixes`    | 至少一条修复；能用 patch 修的给出可粘贴 YAML                         |

### 稳定承诺

- **只增不改。** 消费方必须容忍未知属性（`additionalProperties: false` 是对**生产者**的约束，
  防止我们写出拼错的字段）；新增字段不升 `schemaVersion`。
- **既有字段改变含义 = 破坏性变更**，升 `schemaVersion` 并在 CHANGELOG 说明。
- `code` 值本身是稳定标识：可以新增，不会重命名。CI 可以按 code 白名单忽略已知项。
- 空 `findings` **不等于**「绝对安全」：`notes` 里可能说明某项检查为何没跑。
  消费方必须把 `notes` 一起展示，否则会把「没查」误读成「没问题」。

## 2. 命令行

```bash
node lib/cli.js [--profile <dir>] [--scope live|profile|all] \
                [--format markdown|json] [--fail-on none|warning|critical] [--out <file>]
```

`npx conflict-doctor` 等价（`package.json` 的 `bin`）。

| 退出码 | 含义                                                 |
| ------ | ---------------------------------------------------- |
| `0`    | 在请求的阈值下干净                                   |
| `1`    | 有 warning，且 `--fail-on warning`                   |
| `2`    | 有 critical（默认阈值）                              |
| `3`    | 审计**没能运行**（参数错误、没有 profile、内部异常） |

默认阈值是 `critical`：warning 不会挂掉构建，但会打印出来。

`3` 与 `1`/`2` 分开是刻意的：CI 需要区分「发现了问题」和「工具自己坏了」。
把工具故障当成发现问题，会让人以为代码有问题；反过来则会漏掉真实冲突。

未知参数、非法 `--fail-on`、非法 `--scope` **一律拒绝启动**（退出码 3）。
在 CI 里静默忽略一个拼错的 flag，等于门禁没生效。

`--scope live` 在命令行下不可用（没有运行中的 harness），会明确报错而不是假装跑了一次干净的 live 扫描。

## 3. CI 用法

```yaml
- name: audit plugin conflicts
  run: node lib/cli.js --format json --out conflict-report.json --fail-on critical

- name: keep the report even when it fails
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: conflict-report
    path: conflict-report.json
```

按 code 忽略已知项（在 CI 脚本里过滤 `findings[].code`），不要用 `--fail-on none`
一关了之：那样新增的真实冲突也会被吞掉。

## 4. 契约由测试守护

| 检查            | 内容                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `check-schema`  | 真实 profile 报告 + 一个 CLI 生成的 JSON 文件都必须通过 schema；JSON 往返必须逐字节等价                         |
| `E19`           | 校验器必须**拒绝** 13 种畸形输入（缺字段、非法枚举、空 evidence、非法 code 前缀等）——只会说 ok 的校验器等于没有 |
| `E20`           | 退出码与 `--fail-on` 的组合，含 `none` 永不因 finding 失败，以及非法值的拒绝                                    |
| `check-tarball` | 发布产物必须包含 `schema/` 与 `lib/cli.js`，且不得泄漏 `src/`、`test/`                                          |

schema 校验器（`test/check-schema.mjs`）自己实现 2020-12 中用到的子集，不引入校验库依赖：
本插件会被装进别人的 harness，一个可能与 schema 漂移的校验器比没有 schema 更糟。
它直接从磁盘读 schema 文件，因此 schema 始终是唯一事实来源。
