# MiniMax 连接测试修复验收

日期：2026-09-27。

## 根因

用户配置的 `https://api.minimax.cn/v1` 是官方 Base URL，`MiniMax-M3` 支持图片输入。原程序直接 POST 到 Base URL。无凭证复现得到 HTTP 301，Location 指向 `http://api.minimax.cn/v1/`；原有 `redirect: error` 将其抛为 fetch 错误，随后被统一显示成“视觉模型网络请求失败”。同主机的完整 `/v1/chat/completions` 路径在无凭证探测中正常返回 HTTP 401。

文档依据：[MiniMax 官方 OpenAI 兼容说明](https://platform.minimax.cn/docs/api-reference/text-openai-api)。

## 修复

- 标准协议识别根地址或以 `/v数字` 结尾的 Base URL，在原主机、原协议上补全 API 路径。完整自定义路径和 JSON HTTP 地址不变。
- 保存的用户地址和密钥不迁移、不清除；表单及测试卡显示实际请求地址。
- HTTP 重定向仍不跟随，避免把密钥转发到 HTTP 或其他主机；用明确诊断取代笼统网络错误。
- DNS、证书、连接拒绝、中断、超时、HTTP 状态和输出格式错误分别提示，只输出本地固定诊断，不回显远端正文。
- MiniMax 使用 `reasoning_split` 分离思考内容；M3 单图连接测试关闭 thinking、限制输出长度，视频分析保留默认 thinking。
- 仅改变 Base URL 尾斜杠或切换到同协议的等效完整地址会保留密钥；实际目标改变、显式清钥的原有规则保留。
- 已知云供应商缺密钥时在 DNS 和网络请求之前明确提示；localhost 与自定义免鉴权服务继续可用。
- 前端检测后台连接测试能力版本；旧后台禁用测试和供应商保存，并显示重启提示，防止新页面配旧后台继续产生失败请求或清除密钥。

## 验证证据

- 定向测试：46/46 通过，含四协议、Base URL、等效地址保留密钥、缺钥零请求、禁止重定向、网络错误分类、并发配置保护和 HTTP 集成。
- 浏览器：35/35 通过，真实本机 HTTP、随机 PNG、无真实密钥，包含旧后台禁测、禁保存、表单直接提交保护和恢复新后台。见 [browser.json](browser.json)、[桌面截图](desktop.png)、[手机截图](mobile.png)。
- `npm run build` 通过。Vite 保留既有大包提示。
- 14:55 的真实请求：使用用户当时的 MiniMax-M3 配置发送一张合成 PNG，图片识别和 JSON 校验通过，用时 2643ms；未发送项目视频，该次测试未改变供应商、模型、配置版本、保存地址和密钥状态。见 [real-minimax-test.json](real-minimax-test.json)。当时回读 8199 公共 API 为 `visionVerified: true`；这不代表后续修改过的配置仍然通过。
- 15:02 的后续失败：公共 API 显示地址已改为 `/v1/`，旧后台仍直接请求此地址并返回 404；旧保存逻辑已清除密钥，`hasApiKey: false`。本轮未恢复、复制或修改真实密钥，没有再次外呼。
- 真实 8199 页面只读复核：旧后台警告可见、测试和保存按钮禁用、不再宣称旧后台会使用新路径。见 [live-old-backend.png](live-old-backend.png)。

## 运行状态

新构建已生成。8199 后台进程仍是旧版本（PID 35288）；停止并重启的工具请求被自动审批拒绝，原因仅返回 `blocked by policy`，因此尚未执行。已向用户申请确认重启。刷新后新页面会阻止向旧后台继续保存供应商或发送连接测试；重启成功后还需要用户在设置页重新填写已被旧版清除的 API Key，才能再次真实验证。
