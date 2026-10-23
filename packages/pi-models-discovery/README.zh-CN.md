# pi-models-discovery

通用模型发现插件：读取 `~/.pi/agent/models.json` 中带 `"discoverModels": true` 的 provider，请求 `GET {baseUrl}/models`（或配置的 `modelsUrl`）自动发现模型并注册，无需手写 `models` 数组。发现的模型直接出现在 Pi 的 `/model` 选择器中。每次启动自动刷新端点列表与配置的元数据目录，保存 JSON 文件；请求失败时保留上次成功的数据。

适合本地/自建 LLM 代理（一个网关暴露多个模型）、Ollama、vLLM 等 OpenAI 兼容服务。

## 安装

```bash
pi install npm:pi-models-discovery
```

## 配置

### 方式一：pi 终端内交互配置（推荐）

```
/config:model-discovery
```

命令打开配置面板，列出所有标记了 `discoverModels` 的 provider；选中某个 provider 打开它的字段页（发现开关、baseUrl、api 类型、apiKey、显示名、模型列表 URL、元数据 URL、元数据 provider），并可立即重新发现或删除它。添加 provider 时依次问 id、baseUrl、api 类型、apiKey（可留空）、显示名（可留空），写入 models.json 后**立即生效**（无需 /reload）。写入前自动备份到 `models.json.discovery-bak`。

注意：写回时 models.json 中的注释与自定义排版不被保留（会格式化为 4 空格缩进）。

### 方式二：手编 models.json

在 `~/.pi/agent/models.json` 的 provider 上加 `"discoverModels": true` 标记：

```json
{
  "providers": {
    "llm-proxy": {
      "name": "LLM Proxy",
      "baseUrl": "http://127.0.0.1:9000/pi/v1",
      "apiKey": "sk-1234",
      "api": "openai-completions",
      "discoverModels": true
    }
  }
}
```

`baseUrl` 和 `api` 必填；`apiKey` 可选（无鉴权服务可省略）。未启用元数据查询时，模型列表 URL、API 类型、`apiKey`、`headers` 和 `compat` 相同的 provider 共享一次发现请求。元数据目录按 URL 共享，每个 provider 单独解析匹配。

如果模型列表使用不同的端点，可在 models.json 中设置可选的 `modelsUrl`，值为模型列表的**完整 URL**（包含路径和所需查询参数）：

```json
{
  "providers": {
    "foo": {
      "baseUrl": "https://api.example.com/v1",
      "modelsUrl": "https://catalog.example.com/v1/models",
      "apiKey": "$FOO_API_KEY",
      "api": "openai-completions",
      "discoverModels": true
    }
  }
}
```

`modelsUrl` 仅用于模型发现和刷新，按原值请求；聊天请求仍使用 `baseUrl`。未配置或为空时，沿用 `{baseUrl}/models`。发现请求会将 provider 现有的 `apiKey` 和 `headers` 发送到该 URL，请使用可信端点。响应格式保持不变。

手编方式修改配置后需 `/reload` 生效；`/config:model-discovery` 命令的修改立即生效。

### 共用模型列表

部分网关只在一种协议路由返回模型列表，另一种路由能聊天但列表为空。可将 `modelsUrl` 指向共享列表，并设置区分大小写的 JavaScript 正则表达式 `modelIdRegex`，仅发现所需模型：

```json
{
  "providers": {
    "messages-gateway": {
      "baseUrl": "https://api.example.com/anthropic",
      "modelsUrl": "https://api.example.com/openai/models",
      "modelIdRegex": "^claude-",
      "api": "anthropic-messages",
      "discoverModels": true,
      "metadataUrl": "https://models.dev/api.json",
      "metadataProvider": "anthropic"
    }
  }
}
```

正则可选；留空或省略保留所有对话模型。使用 JavaScript 正则源码，不加 `/.../` 分隔符或标志。匹配区分大小写，默认可匹配 ID 任意位置；用 `^`、`$` 限定位置，如 `^claude-` 或 `^(claude-|gpt-)`。JSON 中须转义反斜杠：`"^model\\.v[0-9]+$"` 匹配 `model.v2` 等 ID。匹配后仍使用端点的原始 ID，保留大小写和空白。

修改正则会使模型缓存失效，设置面板修改立即生效。面板会拒绝无效正则；文件中的无效正则或筛选后的空列表使用正常的匹配缓存/手写回退。列表 URL 不改变聊天 URL 或协议。共享列表只表示网关列出了模型，须用 `/model_test` 确认指定路由可用。

已有的 `modelIdPrefix` 仍按字面前缀读取，并转换为转义后的锚定正则。显式设置的 `modelIdRegex` 优先，包括用于关闭筛选的空字符串。在面板中编辑 provider 时会保存新字段并删除 `modelIdPrefix`；转换后首次发现会刷新缓存。

### 可选的标准目录元数据

端点返回的模型列表决定可用性。要用 [models.dev](https://models.dev) 补齐缺失元数据，在 provider 上添加 `metadataUrl`，并按需指定 `metadataProvider`：

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "api": "openai-completions",
      "discoverModels": true,
      "metadataUrl": "https://models.dev/api.json",
      "metadataProvider": "anthropic"
    }
  }
}
```

插件先请求网关的 `/models`，再按 ID 匹配目录元数据。例如网关列出 `claude-sonnet-4-6` 时，可从目录的 `anthropic` 条目补齐上下文限制、输出限制、显示名、输入模态、推理标记和价格。只出现在目录中的模型不会注册。目录未收录的端点模型仍可用，沿用端点元数据和现有默认值。

| 字段 | 行为 |
| --- | --- |
| `metadataUrl` | 完整的 HTTP(S) 目录 URL。留空或省略关闭查询，保持仅从端点发现。接受 models.dev 的 provider/model 映射、模型数组或模型列表 API 的 `{ "data": [...] }`。请求超时为 5 秒。 |
| `metadataProvider` | models.dev 目录中精确的 provider ID，如 `anthropic` 或 `openai`。指定后只在该 provider 中查找；对扁平模型列表无影响。 |

未指定 `metadataProvider` 时，依次尝试当前配置 provider 中的精确模型 ID、带 provider 前缀的模型 ID（`anthropic/claude-sonnet-4-6`）、仅出现在一个目录 provider 中的精确模型 ID。遇到歧义沿用端点元数据和默认值，可指定 `metadataProvider` 消除歧义。精确 ID 优先。在选定的 `anthropic` 命名空间内（`metadataProvider: "anthropic"`、provider ID 为 `anthropic`，或带 `anthropic/` 前缀的 ID），Claude 系列 ID 还会匹配大小写差异和数字版本中的点号/连字符差异：`Claude-Sonnet-4.6` 可匹配 `claude-sonnet-4-6`。版本和日期后缀完整保留，归一后有歧义时不匹配；其他 provider 和扁平目录仍精确匹配。聊天请求始终使用端点返回的模型 ID。

**优先级：** Pi 的 `modelOverrides` 和现有 provider 思考配置仍照常生效。元数据字段依次优先使用有效端点值、目录值、默认值；显式 `false` 和零价格不会被覆盖，价格逐字段合并。目录价格属于所选目录 provider，网关收费可能不同，请用端点价格或 `modelOverrides` 指定实际费率。端点 `reasoning_options` 优先，缺失的控制项可由 models.dev 补齐并开启额外思考档位；端点 effort 能力、显式映射和用户覆盖仍优先。目录描述所选 provider 的控制项，依赖这些档位前须测试真实网关请求。

目录请求不会携带 provider 的 API key 或 headers；独立目录 API 须允许无鉴权读取。查询失败会显示警告，并在存在时使用已保存目录；端点发现仍可使用。端点请求失败或返回空列表时，目录条目不能证明可用性，保留匹配配置的模型缓存或手写模型回退。此处可用性指端点列出了模型，发现流程不会发送计费的聊天探测请求。

`modelsUrl`、`metadataUrl`、`metadataProvider` 均可在 `/config:model-discovery` 面板修改，立即生效。启动缓存保存补齐后的结果；修改元数据 URL 或 provider 会使缓存失效。启动默认自动刷新；设置 `refreshOnStartup: false` 后命中缓存时不联网，缓存缺失仍进行发现。离线注册表读取不联网，显式在线刷新重新读取两个来源。同一次启动或刷新中，多个 provider 共享目录请求，但各自的匹配结果互不混用。[config.example.json](./config.example.json) 提供可合并进 `models.json` 的完整示例。

## 刷新缓存

```
/config:model-discovery-refresh
```

强制重新拉取所有发现 provider 的模型列表并更新模型缓存和元数据 JSON，逐个提示结果。

## 元数据文件与模型选择

插件在 Pi agent 目录管理两个文件（支持 `PI_CODING_AGENT_DIR`）：

- `extensions/pi-models-discovery/metadata.json`：按来源 URL 保存归一化模型目录和 `fetchedAt` 时间戳。启动和在线刷新时更新；目录请求失败时使用该 URL 的上次成功数据。不会保存网关凭证或 headers。
- `extensions/pi-models-discovery/cache.json`：端点已列出的模型及合并后元数据，用于离线注册和网关失败时回退。仅复用匹配网关配置指纹的缓存。

`models.json` 保留网关配置，自动发现不改写它；只有在设置面板修改 provider 时才写回。清空 `metadataUrl` 关闭目录查询。`refreshOnStartup` 默认 `true`，可在 `/config:model-discovery` 的布尔设置行切换。

通过 Pi 的 `/model` 选择已注册的网关模型。Embedding 和其他明确非对话条目会被排除。provider 使用 `openai-completions` 时，声明 `capabilities.chat: false`、`capabilities.responses: true` 的模型会改用 `openai-responses`；模型显式声明的 `api` 也优先于 provider 协议。未声明能力时沿用配置协议，独立目录元数据不会改变网关路由。

## 测试网关模型

```text
/model_test                         # 当前选中模型
/model_test my-gateway/model-id     # 单个模型，model-id 可包含斜杠
/model_test my-gateway/*            # 此 provider 的所有已注册模型
/model_test all                     # 仅测试 discoverModels provider 的模型
```

也支持唯一的裸模型 ID 或 provider ID；有歧义时须写 `provider/model-id`。命令参数补全列出已注册模型和 provider 分组。

每次测试发送独立的“请仅回复 OK”提示，通过 `pi-model-request` 使用 Pi 解析的鉴权、网关 URL、headers 和 provider 会话归属头。输出最多 64 token，总超时 30 秒，不重试，不携带工具或对话历史。模型逐个测试，显示通过/失败、协议、耗时、错误原因和汇总；非空文本响应表示请求成功，空文本、API/鉴权错误与超时判定为失败。当前模型选择和对话不会改变。

测试会发送真实请求，可能产生网关费用；发现过程仅请求模型列表和目录。通过表示当时的小型文本请求成功，不代表已验证图片、工具、思考档位或上下文上限。模型若将输出预算耗尽于推理而未返回文本，测试无法确认可用性，应结合错误结果判断。

## 行为

- **启动**：先注册匹配配置的模型缓存，再刷新端点列表与元数据目录。provider 设置 `refreshOnStartup: false` 后，缓存命中时跳过启动联网刷新；缓存文件位于 `~/.pi/agent/extensions/pi-models-discovery/cache.json`。provider 配置指纹（baseUrl+api+apiKey+headers+compat+modelsUrl+modelIdRegex+metadataUrl+metadataProvider）变化时缓存自动失效，重新走网络发现。
- **在线刷新**：`/config:model-discovery-refresh` 或 `/model` 打开时触发的 `refreshModels` 在线重新发现，并同步更新缓存。
- **离线 / 拉取失败**：保留匹配配置的模型缓存，否则保留 models.json 里手写的 `models`（如有，作为回退），并通过会话内 notify 显式警告，不静默降级；单个 provider 失败不影响其他 provider。
- **apiKey 解析**（仅发现请求）：支持字面量与 `$ENV_VAR` / `${ENV_VAR}` 插值；`!command` 形式跳过发现并显式警告（聊天请求仍由 pi 自身解析执行，不受影响）。
- 端点与配置目录都缺失元数据时，发现的模型默认参数为 `reasoning: true`、`input: ["text", "image"]`、cost 全 0、`contextWindow` 1M、`maxTokens` 64K、`compat.supportsDeveloperRole: false`。服务返回的元数据按下表替换这些默认值；provider 级 `compat` 会合并进每个发现的模型。
- 发现的模型默认将 `thinkingLevelMap.xhigh` / `max` 设为 `null`，不再假定所有后端支持这些额外档位。标准档位仍沿用 Pi 默认映射。模型列表声明的思考元数据可逐模型开启或隐藏档位（见[思考档位](#思考档位)）。若服务支持额外档位，可在 provider 的 `compat.thinkingLevelMap` 中显式开启，也可将任一不支持的档位置为 `null`。
- 非推理模型可设置 provider 的 `compat.reasoning: false`，让 `/thinking` 只提供 `off`。`reasoning` 和 `thinkingLevelMap` 会提取到模型顶层，其余 `compat` 字段（如 `supportsReasoningEffort`、`thinkingFormat`）正常转发。混合模型网关可用 `modelOverrides` 按 model.id 覆盖。旧缓存会在启动时应用当前推理配置，无需联网刷新。

下面是本地非推理服务的配置；若要开启已确认支持的额外档位，改用 `"thinkingLevelMap": { "xhigh": "xhigh", "max": "max" }` 并移除 `"reasoning": false`。

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "discoverModels": true,
      "compat": {
        "reasoning": false,
        "supportsReasoningEffort": false,
        "thinkingLevelMap": { "xhigh": null, "max": null }
      }
    }
  }
}
```

旧的 `/model-discovery`、`/model-discovery-refresh`、`/pi-model-discovery` 和 `/pi-model-discovery-refresh` 名称仍作为兼容别名保留。

## 模型元数据

发现流程按下表的优先级读取每个模型的元数据，使用第一个有效值：

| Pi 字段 | 模型列表字段，按优先级排列 |
| --- | --- |
| `name` | `name`、`display_name`，最后回退到模型 ID |
| `contextWindow` | `context_window`、`contextWindow`、`max_model_len`（vLLM）、`context_length`、`max_context_length`、`max_input_tokens`（Anthropic）、`limit.context`（models.dev） |
| `maxTokens` | `max_tokens`、`maxTokens`、`max_output_tokens`、`max_completion_tokens`、`limit.output`（models.dev） |
| `input` | 始终包含 `text`。显式包含 `text` 和/或 `image` 的 `input` 数组列出 `image` 时加入 `image`；否则看 `capabilities.vision` 或 `capabilities.image_input` 是否支持，最后读取 `modalities.input`（models.dev） |
| `reasoning` | provider 的 `compat.reasoning`、模型的 `reasoning`、`capabilities.reasoning`、`capabilities.thinking` |

能力字段可为布尔值或 `{ "supported": false }` 这样的对象。显式 `false` 会保留：不支持图片时使用 `input: ["text"]`，不支持推理时使用 `reasoning: false`。缓存启动和在线刷新均保留元数据。未声明的能力沿用既有默认值，额外思考档位只由服务声明的思考元数据开启。

token 上限必须为正的安全整数；无效值会回退到下一个别名或既有默认值。名称必须为非空字符串；`input` 中不支持的值会被忽略。

费用采用**每百万 token 的价格**，与 Pi 的 `cost` 字段一致：

| Pi cost 字段 | 模型列表字段，按优先级排列 |
| --- | --- |
| `input` | `cost.input`、`pricing.input_per_million` |
| `output` | `cost.output`、`pricing.output_per_million` |
| `cacheRead` | `cost.cacheRead`、`cost.cache_read`、`pricing.cache_read_input_per_million` |
| `cacheWrite` | `cost.cacheWrite`、`cost.cache_write`、`pricing.cache_creation_input_per_million` |

仅接受有限的非负数，零是有效价格。缺失或无效价格默认使用零。其他计价单位、长上下文阶梯价和模态专用价格不会映射到这四个字段；逐模型调整可使用 `modelOverrides`。

启动刷新会用服务元数据替换旧缓存默认值；用 `/config:model-discovery-refresh` 可立即刷新，包括已关闭启动刷新的情形。

### 思考档位

模型条目可用三种方式声明思考控制项。插件会在元数据缓存和模型缓存中保存声明，并在启动时重建最终映射。

**显式映射**：依次读取 `thinkingLevelMap`、`thinking_level_map`，格式与 Pi 相同。使用第一个含有效项的别名，整体生效，不跨别名合并。键只能是 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；值须为非空字符串（发给后端的值）或 `null`（隐藏该档位），其余项忽略。

**models.dev 控制项。** `reasoning_options` 列出可调整的控制项，例如：

```json
{
  "reasoning_options": [
    { "type": "effort", "values": ["low", "medium", "high", "xhigh", "max"] },
    { "type": "toggle" }
  ]
}
```

`effort.values` 是完整列表，未列出的已知 effort 档位会隐藏。OpenAI effort API 的 `none` 映射为 Pi 的 `off`；`toggle` 或 `budget_tokens` 控制项保留 `off`，不含 `none` 的仅 effort 模型隐藏 `off`。格式错误的控制项和未知 effort 值会忽略。预算控制项会保存校验后的 `min`/`max`，手动思考继续使用 Pi 现有的预算档位和预算计算。

对 `anthropic-messages`，有 effort 但无预算控制项，或 effort 列表含 `max`/`xhigh`（需自适应思考）时，自动选择自适应思考；只有 `low`/`medium`/`high` 加预算控制项的模型（如 Opus 4.5）仍使用手动预算。provider 显式设置 `compat.forceAdaptiveThinking: true` 或 `false` 优先于推导。自适应模式下 Pi 的 `minimal` 是原生 `low` 的别名。`toggle` 不描述每个 effort 的限制或 Sonnet 的 `between_tools` 模式，这些仍须显式配置或网关验证。

端点控制项优先，匹配目录只补齐缺失的 `reasoning_options`；目录的 `thinkingLevelMap` 和 `capabilities.effort` 不替代端点声明。

**effort 能力**：`capabilities.effort` 用布尔值或 `{ "supported": 布尔 }` 列出后端 effort 值，与 Anthropic 模型列表的格式一致：

```json
{ "effort": { "supported": true, "low": { "supported": false }, "medium": { "supported": true },
  "high": { "supported": false }, "max": { "supported": false } } }
```

只在 Pi 实际发送该 effort 值的请求路径上解读：

| `api` | 条件 | Pi 档位 → 后端 effort |
| --- | --- | --- |
| `anthropic-messages` | 由 `reasoning_options` 推导，或 provider 的 `compat.forceAdaptiveThinking: true`（`output_config.effort`） | `minimal` 与 `low` → `low`；其余同名 |
| `openai-responses` | 始终（`reasoning.effort`） | 同名 |
| `openai-completions` | 未设置 `compat.thinkingFormat` 或为 `"openai"`，且 `compat.supportsReasoningEffort` 不为 `false`（`reasoning_effort`） | 同名 |

档位对应的后端值显式支持时，该档位映射到这个值；显式不支持时置为 `null`；未列出时沿用默认值：标准档位保留，`xhigh` / `max` 仍隐藏。档位不会改映射到其他后端值。`effort.supported: false` 会关闭目录的 effort 控制项。格式错误的项、其他 API，以及 Anthropic 预算式思考（非自适应模式时 Pi 不发送 effort）都沿用默认值。按上例，自适应思考的 Anthropic 模型只提供 `off` 和 `medium`。OpenAI 两行假定 Pi 会发送 `reasoning_effort`；Pi 会按 URL 对部分服务（如 xAI、Z.ai）关闭它，这类服务请显式设置 `compat`。

每个档位单独解析，优先级从低到高：

1. 默认值：`xhigh` 和 `max` 为 `null`。
2. 端点 `reasoning_options`，缺失时用匹配目录的控制项。
3. 由端点 `capabilities.effort` 推导的档位。
4. 端点模型的显式映射。
5. provider 的 `compat.thinkingLevelMap`，包括显式 `null`。
6. models.json 中 `modelOverrides[modelId].thinkingLevelMap`，由 Pi 叠加。

provider 的 `compat.reasoning: false` 仍会让所有模型只提供 `off`。

缓存按模型保存服务声明的思考元数据，启动时重新校验，再结合当前 provider 配置重建最终映射，因此缓存启动、离线读取与在线刷新结果一致。旧版本写入的缓存没有声明元数据，即使其中存过额外档位，也沿用默认值，直到下一次在线刷新。旧元数据缓存中的推理控制项会在下一次成功刷新目录后补齐。元数据只是服务端或目录 provider 的声明；依赖某个档位前，请用真实请求确认。

## 卸载

```bash
pi remove pi-models-discovery
```

卸载后 provider 回退为 models.json 中的静态配置（手写 `models` 或空）。
