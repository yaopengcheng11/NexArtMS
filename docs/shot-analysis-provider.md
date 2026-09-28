# 拉片视觉模型配置与协议

本地 schema 版本：`shot-analysis-v1`；提示词版本：`shot-analysis-prompt-v1`。词表、确定性检查和 Markdown 交换报告实际复用仓库内固定的 reelbench `video-shots` 代码；版本、许可证和哈希见 `vendor/reelbench/video-shots/upstream.json`。

上传会先完成原片时间映射、切镜和证据抽帧。**只有明确配置视觉模型后，后台才会发送自动语义分析请求。没有默认供应商、模型或语义假数据降级。** 未配置时保留可查看底稿并显示 `blocked`。对话中由助手逐帧查看、填写的分析属于人工辅助分析，不意味着桌面应用已获得可自动调用的视觉 API。

## 在界面添加视觉模型

1. 点击项目中的 **模型设置**，再点击 **添加供应商**。选择供应商模板或自定义供应商。
2. 填写供应商名称，选择接口协议，填写供应商的 **Base URL**、API Key 和视觉模型 ID。选用 Chat Completions、Responses 或 Anthropic Messages 后，程序负责确定对应的请求路径与消息格式，用户无需手动添加路径；页面只读显示实际请求地址。多个模型 ID 每行一个。自定义 JSON HTTP 协议使用完整请求地址。
3. 点击 **保存供应商**。保存只记录配置，不自动选择供应商、测试连接或发送项目视频。
4. 保存后会定位到页面顶部的 **模型连接测试** 区。在 **用于拉片的模型** 下拉框选中一个模型，点击 **测试连接**。界面显示测试中、连接成功或失败原因；有未保存修改时，先保存再测试。切换模型只展示该模型和当前配置版本的测试结果。再次打开设置会自动选择默认供应商，没有默认时选择第一个已保存的供应商。
5. 点击 **设为默认视觉模型**，返回项目发起一次新的拉片分析。新上传的项目会使用新默认模型，已生成的拉片结果会保留。

OpenAI 和 Anthropic 模板提供 Base URL。其他供应商模板提供名称和协议起点，请填写供应商文档中的 Base URL。模板名称不代表该供应商所有模型、订阅或 Coding Plan 都支持视觉 API；程序不会自动替换模型或将文本接口当作视觉接口。为兼容已有配置，已保存的完整自定义请求路径仍可使用，不需要重新配置密钥。

可编辑或删除已保存的供应商。密钥输入框留空时保留已有密钥，也可明确清除。同一协议下 `/v1`、`/v1/` 及其对应完整请求地址视为等效，互相修改会保留密钥；**改为不同的实际请求地址且没有重新输入密钥时，会清除旧密钥**，避免把原服务的凭据发送到新地址。添加供应商、删除供应商、修改设置都不会自动发送用户视频。

## 图片测试能证明什么

“测试连接”只向所选地址发送一张程序生成的随机三色竖条 PNG，不发送项目帧或视频。服务必须返回有效 JSON，并正确回答条纹数量、图案和从左到右的颜色，才显示“连接成功 · 图片输入通过”并记录 `visionPassed: true`。HTTP 200、能够聊天或返回任意 JSON 都不算通过。测试使用一次调用、30 秒超时；供应商可能对此调用计费。

MiniMax 中国区可使用官方 Base URL `https://api.minimax.cn/v1`，选择 OpenAI Chat Completions 兼容协议，实际向同一 HTTPS 主机的 `/v1/chat/completions` 请求。此兼容不会改写保存的配置或清除已保存密钥。MiniMax 请求使用 `reasoning_split: true` 分离思考内容以保留纯 JSON；M3 的单图连接测试关闭 thinking 并限制输出长度，全片分析保留模型默认 thinking。参见 [MiniMax 官方 OpenAI 兼容文档](https://platform.minimax.cn/docs/api-reference/text-openai-api)。

失败会区分 DNS、连接拒绝、中断、HTTPS 证书、超时、重定向、HTTP 状态和 JSON 格式问题；不回显远端正文或底层错误中的敏感信息。重定向仍被拒绝，尤其不会将密钥转发到 HTTP 地址或其他主机。原来直接请求 `/v1` 触发的重定向不会再被笼统误报成网络失败。

已知云供应商未保存密钥时，会在网络请求前提示重新填写 API Key，本地免鉴权和自定义服务不受影响。若页面加载了新版本而后台仍是旧进程，界面会明确提示更新后台并禁用测试，避免前端显示新路径而后台仍调用旧路径。重启后台后刷新页面即可重新检测；已清除的密钥需要在设置页重新输入，不会自动恢复或从其他配置复制。

测试结果绑定供应商配置版本和模型 ID。编辑配置后旧测试失效；测试期间配置发生变化，迟到结果不会写入新版本。测试通过只确认该次请求能接收图片并回答简单视觉问题，不能保证视频人物归并、动物识别、动作或运镜分析准确。仍需用代表性素材检查全片拉片结果和不确定项。未测试也可以设为默认，但界面会提示图片输入尚未验证。

## 密钥与本机配置

配置保存在运行服务所选数据根目录的 `data/private/model-settings.json`，不写入前端打包产物或浏览器存储。默认项目的 `data/` 和验收用 `.checks/` 已被 Git 忽略；如通过 `STUDIO_DATA_ROOT` 使用其他目录，也应把该目录视为本机私有运行数据。

- **Windows：** API Key 使用当前 Windows 账户的 DPAPI 加密后落盘，仅后端在请求时解密。更换账户或迁移机器后可能需要重新输入。加解密通过隐藏子进程的管道完成，不把密钥放入命令行、日志或公共响应。
- **非 Windows：** 当前实现只在服务进程内保存密钥；配置可以持久化，密钥在重启后需要重新输入。不会静默降级为明文存储。
- 前端只接收 `hasApiKey` 等状态，不接收已保存密钥。模型请求报错只记录经过限制的错误信息或 HTTP 状态码，不写入远端错误正文、鉴权头或密钥。
- 模型设置接口仅允许本机服务 Host、同源请求，以及 JSON 格式的写入。远端模型地址必须为 HTTPS；显式配置的 `localhost`、`127.0.0.1`、`[::1]` 可使用 HTTP。URL 不接受用户名、密码、查询参数或片段，HTTP 重定向不自动跟随。配置地址和 DNS 解析会排除私网、链路本地及元数据服务；当前没有连接级 DNS 固定。

## 无模型、取消默认与任务快照

没有可用默认模型时，原片时间映射、切镜、证据抽帧仍会完成，语义分析显示受阻，未知字段会如实保留。配置好模型后应发起**新的分析运行**；旧的受阻运行不会自行改用新模型。

点击 **取消默认** 会停用后续自动语义分析，不会自动退回环境变量中的模型，也不会删除已有结果或取消已经开始的请求。需要停止正在执行的分析时使用项目的取消任务功能。重新选择默认模型可恢复后续分析。

每个新运行保存模型配置快照，包含供应商 ID、配置版本、模型 ID、接口协议、请求地址、运行参数和指纹，**不包含 API Key**。切换全局默认模型只影响后续运行，正在执行的运行继续使用自己的快照。队列中或正在执行的任务引用某供应商时，界面修改或删除该供应商会被拒绝；可选择另一个供应商作为新任务的默认。

配置版本、接口地址或密钥发生变化后，旧快照不能悄悄换用新配置。恢复旧任务时如配置不再匹配，会明确失败，需要发起新分析。复用旧机器语义还要求原片、精确镜头边界、模型快照指纹和语义 schema/提示词版本一致。人工字段与机器生成字段分开保存。

多个本机服务共享同一数据目录时，配置提交会获取文件写入锁，并在锁内重新核对磁盘版本。旧页面或旧服务的写入会返回版本冲突，刷新后重试即可；不会用旧列表覆盖别处新添加的供应商。若显示配置写入锁持续被占用，应检查相关服务状态，程序不会自动删除来源不明的锁文件。

## 环境变量兼容配置

首次使用、还未在界面选择或取消默认模型时，服务仍可读取显式配置的环境变量。环境变量修改需要在新服务进程中生效。界面选中供应商后使用该供应商自己的配置；即使它的密钥为空，也不会继承环境变量中的密钥。不要把真实密钥写入项目文档、源代码或 Git。

| 环境变量 | 内容 |
| --- | --- |
| `STUDIO_SHOT_ANALYSIS_PROVIDER` | 用户明确选择的供应商标识；记录在运行溯源中 |
| `STUDIO_SHOT_ANALYSIS_MODEL` | 供应商支持视觉输入的准确模型 ID；没有自动替换 |
| `STUDIO_SHOT_ANALYSIS_ENDPOINT` | 标准协议的 Base URL 或完整 POST 地址；自定义 JSON HTTP 需完整地址 |
| `STUDIO_SHOT_ANALYSIS_PROTOCOL` | `openai-chat-completions`、`openai-responses`、`anthropic-messages` 或 `json-http` |
| `STUDIO_SHOT_ANALYSIS_API_KEY` | 如端点需要鉴权，设置该服务的 API Key；Anthropic 使用 `x-api-key`，其余协议使用 Bearer token |

项目运行状态返回 `{configured,provider,model,reason?}` 等概况；模型设置界面可以读取已配置的请求地址和模型列表以便编辑，但不能读取密钥或鉴权头。

## 有界运行参数

| 环境变量 | 默认 | 允许范围 | 含义 |
| --- | --- | --- | --- |
| `STUDIO_SHOT_ANALYSIS_TIMEOUT_MS` | 60000 | 100–300000 | 单次 HTTP 尝试超时 |
| `STUDIO_SHOT_ANALYSIS_MAX_ATTEMPTS` | 2 | 1–3 | 超时、网络错误、408/429/5xx 的最大尝试次数；401/403 和格式错误不重试 |
| `STUDIO_SHOT_ANALYSIS_BATCH_SIZE` | 4 | 1–8 | 每批镜头数，依序请求以保持主体目录一致 |
| `STUDIO_SHOT_ANALYSIS_MAX_CALLS` | 64 | 1–256 | 每次阶段运行的逻辑调用预算，包含概览与密集复核；HTTP 重试次数另受 MAX_ATTEMPTS 约束 |

每个 HTTP 请求最多 32 MB，响应最多 4 MB。正常每镜提取 0%、15%、50%、85%、100% 位置的原片帧；不超过 12 帧的短镜最多取 9 帧。对含不确定项或切点建议的镜头最多再补一次 9 帧密集核查。仍不能判定时保留 `unknown` 和原因。所有时间来自源帧 PTS，不从四舍五入后的秒数反推。

上述环境变量调参用于环境配置模式。界面配置当前采用固定默认运行参数：60 秒超时、最多 2 次尝试、每批 4 镜头、每阶段 64 次逻辑调用；这些参数会随运行快照保存。图片连接测试使用单独的 30 秒、1 次尝试预算。

全片概览最多均匀选择 32 张证据图，因此它只是建立初始主体候选。后续每批携带主体目录和最多 8 张已有主体参考图，可补充新主体。主体 ID 稳定引用，人物/动物/未知分别记录；现阶段不将候选直接写成检测轨迹、叙事角色或已确认真实身份。

调用、尝试、失败调用数与 token 数（仅累计供应商成功响应报告的值，失败调用的消耗未知）记录到运行 `quality.usage`，供应商与模型、超时、批次和预算保存到运行元数据。密钥和原始网络响应错误不进入报告。

## 支持的四种协议

| 协议 ID | 图片请求与鉴权 | JSON 结果来源 |
| --- | --- | --- |
| `openai-chat-completions` | `messages[].content` 中的 `image_url`，Bearer token | `choices[0].message.content` |
| `openai-responses` | `input[].content` 中的 `input_image`，Bearer token | `output` 消息中的 `output_text` |
| `anthropic-messages` | `messages[].content` 中的 base64 `image`，`x-api-key` 与 `anthropic-version: 2023-06-01` | `content` 中的文本块 |
| `json-http` | 下述自有拉片 JSON 契约，Bearer token（如需要） | HTTP 响应 JSON 对象本身 |

OpenAI 图片请求结构参考 [官方 Images and vision 文档](https://developers.openai.com/api/docs/guides/images-vision)，Anthropic 图片结构参考 [官方 Vision 文档](https://platform.claude.com/docs/en/build-with-claude/vision)。兼容服务仍需实际测试所选模型和协议，不能仅凭供应商名称判断兼容性。

### OpenAI Chat Completions

`openai-chat-completions` 使用明确填写的地址和模型，发送 `POST`：

```json
{
  "model": "用户配置的模型 ID",
  "response_format": {"type": "json_object"},
  "messages": [{"role": "user", "content": [
    {"type": "text", "text": "schema、允许词表、全片概览、镜头边界与证据索引"},
    {"type": "text", "text": "source_frame=12; pts_us=500000; shot=S02"},
    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,...", "detail": "high"}}
  ]}]
}
```

要求 `choices[0].message.content` 是纯 JSON 字符串，不接受 Markdown 围栏；`finish_reason: "length"` 判为截断失败。所选接口必须同时支持多图、视觉、JSON 对象响应。兼容性不足时明确失败，不换模型或协议。

### OpenAI Responses

`openai-responses` 向完整请求地址发送 `input` 用户消息，内容使用 `input_text` 和带 base64 data URL 的 `input_image`，并通过 `text.format: {"type":"json_object"}` 要求 JSON。从返回的消息项中读取 `output_text`，解析为 JSON 对象。`status: "incomplete"`、`failed` 或非 JSON 输出视为失败。

### Anthropic Messages

`anthropic-messages` 使用 `messages` 用户消息，图片为 `{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"..."}}`，支持 JPEG、PNG、WebP、GIF。请求设置 `max_tokens: 8192`，在提示词中要求纯 JSON；不发送 OpenAI 专用的 `response_format`。响应中的文本块必须可解析为 JSON 对象；`stop_reason: "max_tokens"` 判为截断失败。

### 自定义 JSON HTTP

`json-http` 适用于自有视觉服务。请求结构：

```json
{
  "schemaVersion": "shot-analysis-v1",
  "mode": "overview",
  "model": "明确配置的模型 ID",
  "prompt": "固定指令与完整 schema/词表",
  "input": {
    "mediaHash": "sha256",
    "shotSetRevision": "准确源帧边界哈希",
    "subjectCatalog": [],
    "overview": "",
    "shots": [{"id": "S01", "startFrame": 0, "endFrameExclusive": 24, "startUs": 0, "endUs": 1000000}],
    "evidenceFrames": [{"frameIndex": 0, "ptsUs": 0, "shotId": "S01", "dataUrl": "data:image/jpeg;base64,..."}]
  }
}
```

概览响应：

```json
{
  "summary": "只描述全片抽样实际支持的概览",
  "subjects": [{"id": "A", "kind": "person", "name": "人物候选甲", "description": "红色外衣、短发", "referenceFrames": [0], "uncertain": true}],
  "issues": []
}
```

逐镜请求 `mode: "batch"`，额外携带 `neighboringShots` 及必要时的 `refinement`。响应：

```json
{
  "annotations": [{
    "shotId": "S01",
    "annotation": {
      "size": "medium",
      "category": "subject",
      "camera": "unknown",
      "frame": "红衣男子站在画框左侧，右侧背景可见一扇窗户",
      "action": "站立；手部动作被桌面遮挡",
      "composition": "主体位于左侧，背景窗户在右侧",
      "scene": "室内；地点无法确定",
      "subjects": ["A"],
      "evidenceFrames": [0],
      "uncertainties": ["单帧不足以判断运镜"]
    }
  }],
  "subjects": [],
  "issues": []
}
```

每个批次必须为所请求镜头各返回一条标注，不能遗漏、重复或修改镜号与机器时间。`subjects` 仅用于补充候选；已有 ID 类型不得改变。每条标注必须引用本镜实际发送的帧，每个主体必须引用实际发送的参考帧。未提供音频，因此模型输出非空 `audio` 或 `dialogue` 类别会被拒绝；人工核看片后可自行修正。

字段范围见 `studio/shot-analysis-schema.mjs`。景别、类别、运镜采用上游枚举，本地显式增加 `unknown` 并要求原因；上游词表门仍会将该值显示为待修正，不伪装通过。`cutSuggestions` 只能提出镜内 `split` 或边界 `merge` 建议，不自动改动切点。首版模型不标可选的节奏角色，避免不完整节奏表被当成全片结论。

连接测试使用 `mode: "vision_test"`；`input.evidenceFrames` 只包含生成的测试 PNG，不含项目数据。服务需根据图片返回 `{"colorsLeftToRight":["实际颜色英文名"],"pattern":"vertical-stripes","count":3}`。颜色从 `red`、`green`、`blue`、`yellow`、`magenta`、`cyan` 中随机选取三种，正确顺序只存在于图像像素中，不随请求发送答案。

## 失败、恢复和报告

- 单批失败保留其他成功批次，并生成 `ready_with_issues`；全部失败保持 `failed`，未配置或鉴权失败为 `blocked`。
- 重试复用已成功标注；重抽或重新分析不会覆盖人工字段。新运行按原片和精确边界复用，不依靠 S01 连号匹配。
- 复用还要求 provider、model、schemaVersion、promptVersion 及模型快照指纹一致。任务恢复时如果配置版本已变化，快照校验会拒绝继续；需新建运行使用新配置。不会将旧模型文本改贴成新模型来源。
- 取消会中止网络与 FFmpeg 子进程；提交前校验原片及活动边界。迟到响应不能覆盖新版本。
- 分析输出保存为 JSON 批次，报告提供 `report.json`、`report.md`、`report.html` 和上游交换格式 `reelbench-shots.json`。HTML 的图片使用当前项目/运行的受限文件接口，点击镜头可定位原片。
- 本地精确帧/证据检查及上游纯规则分别记录通过、失败、跳过。没有像素运动曲线时，上游运镜实测门明确跳过；没有人工参考时，视觉判断正确性明确未验收。
- 上游交换表显示使用 S01 连号，但包含 `stableShotId`；精确源帧、微秒、实际稳定 ID 和人工覆盖以 `report.json` 为准。

本机配置与协议验证：`node --test scripts/studio-model-settings.test.mjs scripts/studio-model-settings-integration.test.mjs scripts/studio-shot-analysis-provider.test.mjs`。本轮 29 项通过，覆盖四种协议的请求/响应、真实生成 PNG 的像素校验、401/429/超时/取消、多实例版本冲突、慢加密期间的提交保护、快照锁定、迟到测试拒写、秘密不外泄和 Windows DPAPI 持久化往返。HTTP 整合测试使用真实 FFmpeg 合成小视频，验证模型选择立即生效、执行中配置保护、换地址重新分析与人工覆盖保留。输出中仅有 Node 内置 SQLite 的实验性功能提示。没有发起真实远端模型请求；这些结果不代表某个真实供应商或视频语义已验收。

引擎另有 `scripts/studio-shot-analysis-engine.test.mjs`，覆盖真实 FFmpeg VFR 抽帧、未知项、失败恢复、人工覆盖与过期响应阻断。非 Windows 的会话密钥重启行为、真实供应商多图长度限制、真实模型语义质量仍需在对应环境验收。
