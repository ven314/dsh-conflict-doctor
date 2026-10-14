# Realm 模型：为什么页面半区不能和宿主半区比

这份文档记录客户端（浏览器）半区的真实契约，以及**为什么计划里的几个检测器没有实现**——
它们缺乏可靠的证据来源，硬做会产出这个项目最不能接受的东西：误报。

## 一、realm 是什么

DSH 的插件可以有两半：宿主侧（Node 进程）与页面侧（浏览器）。两半各有独立的
服务表与 tool 注册表，因此**同名不是冲突**。

| realm    | 判定                                                       | 谁在里面                                   |
| -------- | ---------------------------------------------------------- | ------------------------------------------ |
| `host`   | 没有 `dsh.client`（**absence 就是信号**，不显式写 `host`） | `@deepseek-ai/dsh-*` 等                    |
| `client` | 清单里有 `dsh.client`                                      | `dshmarket`、`dsh-better-sidebar` 等 45 个 |

`profile/service-collision` 早就按 realm 过滤了，但那个排除是**沉默的**。现在
`client/service-name-shared-with-host` 把它显式记下来（info），因为排查时容易只看一边：
修好了页面的那个，宿主的那个仍然照旧。

## 二、真实的 `dsh.client` 契约（实测，不是猜的）

遍历已装 profile 的全部 45 个客户端包，`dsh.client` 只出现过这些键：

```
[7] inject, platform
[1] platform
```

也就是：`platform` 恒为 `"web"`（45/45 无一例外），`inject` 是**客户端模块名**的列表，
不是服务名：

```json
"dsh.client": {
  "platform": "web",
  "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-sidebar-right", ...]
}
```

全 profile 去重后有 **26** 个不同的注入模块名。

`dsh.*` 清单字段的**完整**词表（遍历所有已装包得到）：

```
bundle(9)  client(8)  compatibility(2)  engines(1)  manifestVersion(1)
```

**没有 slot 声明字段，也没有 RPC 通道字段。**

## 三、已实现的检测器

### `client/inject-unprovided`（warning）

宿主侧 `live/pending-missing-service` 的客户端孪生。当某个半区 inject 的模块无人提供时，
这个半区会**安静地什么都不做**——不报错、不打日志，用户看到的是「装了插件但界面里没有它」。
这与宿主侧卡在 PENDING 是同一个故障形态，只是发生在另一个注册表里。

提供方来自真实声明，不来自命名约定：

```
提供方集合 = { 已安装包的包名 } ∪ { 运行宿主 archive 里的 bundle 名 }
```

按归一化键比较（去作用域、转小写），因此 `Dsh-Client-UI-Sidebar-Right` 与
`@deepseek-ai/dsh-client-ui-sidebar-right` 视为同一个模块。**归一化的方向是刻意的**：
漏报只是少一条线索，而误报会让人去追一个并不存在的模块。

本机真实数据上：**0 条命中**（26 个注入模块全部有提供方），这是正确的结果。

### `client/service-name-shared-with-host`（info）

同名服务在两个半区各出现一次。不是冲突（各有独立服务表），但显式列出。
真实 profile 上 4 条，全部经核实为真：`dsh-cordis-client-runner` vs
`dsh-cordis-host-runner`、`dsh-client-runtime` vs `dsh-session` 等。

## 四、**没有**实现的检测器，以及原因

计划里的 W2-3 / W2-5 / W2-6 / W2-7 都要求从产物里提取 slot / RPC / 服务名。实测下来
这些没有可靠来源，做了就是猜：

| 计划项                                        | 实测结论                                                                                                                                                            | 决定                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| W2-3 `client/duplicate-slot-registration`     | 清单里**没有** slot 字段；slot id 只存在于压缩后的 bundle 代码里。实测扫描 `dsh-better-sidebar` 时 `registerSlot` 6 次命中**全部是注释和文档文本**，不是 API 调用。 | **不做**。从压缩产物里正则提 slot id 会直接产出误报。 |
| W2-5 `client/rpc-channel-collision`           | 同上：`channel`/`rpc` 的命中都是内部缓存概念或注释，不是可提取的接口。                                                                                              | **不做**。                                            |
| W2-6 `client/service-declared-in-wrong-realm` | 需要「哪些服务是 host-only」的权威清单。宿主 export 面里没有任何字段声明这一点，无法判断。                                                                          | **不做**。                                            |
| W2-7 `client/tool-id-shadowed-by-host`        | 真实数据里客户端包只声明了 **1 个** tool id（`sidebar_open`，`dsh-better-sidebar`），与宿主侧 25 个**零重叠**。检测器永不触发。                                     | **不做**，等出现真实案例再说。                        |
| W2-4 `client/slot-provider-missing`           | 与 W2-3 同因（无 slot 字段）。但它的**可判定部分**已由 `client/inject-unprovided` 覆盖：模块缺失就是最硬的「提供方不存在」。                                        | 由 `inject-unprovided` 覆盖。                         |
| W2-8 `client/bundle-not-in-client-manifest`   | profile 里不存在「客户端 manifest」这一产物，无从比对。                                                                                                             | **不做**。                                            |

写下来是因为「计划里列了但没做」必须能解释，否则下一个人会以为漏了。

### 平台支持检查也被否掉了

`platform` 在 45/45 个包里恒为 `"web"`，没有任何取值差异。一个检测器若只在单一取值上运行，
它永远不会触发，也无法被真实数据验证。等出现 `"desktop"` / `"mobile"` 之类的第二个取值时再说。

## 五、realm 维度进入报告

findings 按 code 前缀（`live/` `profile/` `client/` `fix/`）分组渲染，因为两个半区的**修法不同**：
宿主侧的 row 问题在 `cordis.patch.yml` 里改，而页面侧的问题通常**没有配置修法**。
未知前缀会落到「其他」标题下而不是消失——一条静默丢失的结论比一个难看的标题更糟。

## 六、测试覆盖（Part F，9 项）

| 检查 | 内容                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------- |
| F1   | 无人提供的客户端模块被报出                                                                            |
| F2   | 已安装包提供时不报                                                                                    |
| F3   | 运行宿主提供时不报                                                                                    |
| F4   | 大小写/作用域写法不同**不**误报                                                                       |
| F5   | 没有 `dsh.client` 的包永不被当客户端判定                                                              |
| F6   | 跨 realm 同名服务是 info，且证据写明「不做冲突比较」                                                  |
| F7   | `realmOf` / `comparableRealm` 与声明一致；跨 realm 不可比                                             |
| F8   | 畸形 `dsh.client`（`true` / `'web'` / `null` / `{}`）仍标记为客户端半区**存在**，且 `inject` 恒为列表 |
| F9   | 报告按 realm 分组；未知前缀不丢失；运行期排在磁盘组合之前                                             |

F4 与 F8 是这套测试里最值钱的两条：它们钉住的是「**不要因为拼写或畸形声明而误报**」，
也就是这个项目最贵的一类错误。
