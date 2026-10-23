---
name: configure-pi-models-discovery
description: "配置与排查 models.json 的动态模型发现、缓存刷新、鉴权和离线回退。Use when adding discoverModels providers or refreshing model catalogs."
---

# 配置 pi-models-discovery

## 诊断

读取实际 Pi agent 目录中的：

- `models.json`：provider 配置；
- `extensions/pi-models-discovery/cache.json`：启动模型缓存；
- `extensions/pi-models-discovery/metadata.json`：按来源 URL 保存的独立元数据目录与刷新时间；
- `models.json.discovery-bak`：交互配置写回前的备份。

只处理带 `discoverModels: true` 的 provider。确认 `baseUrl`、`api`、可选 `modelsUrl` / `apiKey`、headers/compat 以及服务的模型列表响应。发现请求使用 `GET modelsUrl`（完整 URL，不追加 `/models`）；未配置或为空时使用 `GET {baseUrl}/models`。`modelsUrl` 仅影响发现和刷新，不改变聊天请求的 `baseUrl`；它会接收现有鉴权信息，须使用可信端点。

元数据查询是可选的：设置 `metadataUrl: "https://models.dev/api.json"` 或独立模型目录 API，必要时用 `metadataProvider` 指定精确目录 provider。目录请求不携带端点凭证。端点列表决定可用性，只补齐端点模型的缺失字段，不注册目录独有模型、不发聊天探测请求。歧义 ID 须指定元数据 provider。在选定的 `anthropic` 命名空间内，Claude ID 支持大小写和数字版本中点号/连字符归一匹配，如 `Claude-Sonnet-4.6` → `claude-sonnet-4-6`；保留版本与日期后缀，归一后歧义不匹配。其他 provider 和扁平目录只精确匹配。目录价格可能与网关不同；实际费率用端点元数据或 `modelOverrides`。目录 JSON 自动更新，查询失败警告并尝试该 URL 的上次成功数据；启动默认刷新，`refreshOnStartup: false` 可关闭缓存命中时的启动联网；修改元数据来源立即使模型缓存失效。

## 修改

优先使用 `/config:model-discovery` 添加、删除或重新发现 provider；命令会备份并格式化重写 `models.json`，注释与原排版不会保留。手工修改时，provider 至少提供 `baseUrl`、`api`、`discoverModels: true`；修改后需要 `/reload`。

`apiKey` 可用字面量、`$ENV_VAR` 或 `${ENV_VAR}`；`!command` 不用于发现请求，会被跳过并警告。不要把密钥写入 Skill、仓库或回复。

## 共享列表

路由可正常聊天但 `/models` 为空时，可显式把 `modelsUrl` 指向同网关的共享模型列表，并用区分大小写的 JavaScript 正则源码 `modelIdRegex`（如 `^claude-` 或 `^(claude-|gpt-)`）限定模型。不加 `/.../` 分隔符或标志，留空不过滤，`^`/`$` 限定匹配位置；JSON 中反斜杠须转义。无效正则走匹配缓存/手写回退，面板拒绝保存；旧 `modelIdPrefix` 按字面前缀兼容读取，面板编辑后转为新字段。模型 ID 保持原样，聊天仍使用 provider 的 `baseUrl` 和 `api`。不要把其他协议的所有模型注册到此路由；用 `/model_test provider/model` 验证实际可用性。

## 思考等级

发现的模型默认隐藏 `xhigh` / `max`（映射为 `null`），标准档位沿用 Pi 默认映射。provider 的 `compat.thinkingLevelMap` 可显式开启支持的档位或将不支持的档位置 `null`；非推理服务用 `compat.reasoning: false` 关闭推理，必要时配合 `compat.supportsReasoningEffort: false`。这两个扩展配置字段会提取到模型顶层，其余 compat 正常转发。逐模型差异用 `modelOverrides` 按 model.id 覆盖。旧缓存启动时会应用当前 compat 配置，无需联网刷新。

模型列表若返回 `thinkingLevelMap` / `thinking_level_map` 或 `capabilities.effort`，会逐模型开启或隐藏档位（解读条件与优先级见 README「思考档位」）。端点或匹配 models.dev 目录的 `reasoning_options` 会保存 effort 完整列表、toggle 和预算限制；未列出的 effort 隐藏。Anthropic 有 effort 且无预算，或支持 `max`/`xhigh` 时自动启用自适应思考；Opus 4.5 等 low/medium/high 加预算模型保持手动预算。provider 的 `compat.forceAdaptiveThinking` 显式值优先。仅 effort 且无 toggle/预算/none 的模型隐藏 off，自适应 minimal 映射为 low。provider 的 `compat.thinkingLevelMap` 逐项覆盖声明，`modelOverrides` 优先级最高。不要仅凭 `/thinking` 能选到某档位就认定后端支持，应以真实请求确认。

## 模型元数据

模型列表若返回名称、上下文窗口、输出上限、图片/推理能力或每百万 token 价格，发现时会自动读取，别名优先级见 README「模型元数据」表；provider 的 `compat.reasoning` 仍优先于服务声明。缺失或无效的字段沿用默认值，不要为服务已正确声明的元数据另加 `compat.reasoning` 或 `modelOverrides`。升级插件后缓存仍是旧默认值时，用 `/config:model-discovery-refresh` 重新拉取。

## 验证

- `/config:model-discovery-refresh` 强制联网刷新并更新缓存；旧命令名仅为兼容别名。
- 打开 `/model` 也会触发在线刷新。
- `/model_test` 测试当前模型；`/model_test provider/model` 测试单个模型；`provider/*` 逐个测试该 provider，`all` 只测试带发现标记的 provider。测试会发送真实的小型文本请求，报告协议、耗时和错误，不修改当前模型或历史。成功仅确认当时的文本请求，不证明其他能力。
- Embedding 等明确非对话条目不注册；声明仅支持 Responses 的模型自动选择该协议。
- 逐个 provider 报告成功或失败。失败时保留匹配配置的缓存，或保留 `models.json` 中手写的 `models` 作为显式离线回退，但不能把缓存或静态模型冒充本次发现成功。
