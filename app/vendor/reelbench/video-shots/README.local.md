# MotionStage 集成说明

上游仓库：[eternityspring/reelbench-skills](https://github.com/eternityspring/reelbench-skills)。固定版本：`1b51af897b6a57556b85dfe96e0427e231b4b613`。许可证见 `LICENSE`；上游文件内容未修改，逐文件 SHA-256 见 `upstream.json`。本说明为本地新增，不属于上游代码。

项目使用 `scripts/video-shots.mjs` 导出的景别、类别、运镜、节奏词表、`validate` 和 `renderMd`。未运行仓库安装器，也不在 HTTP 主线程调用上游同步 FFmpeg。原片抽帧、视觉模型适配、队列与报告文件由 `studio/shot-analysis*.mjs` 实现。

本地差异：

- 保留现有切镜器；精确源帧号和 PTS 微秒是项目真值。上游秒数及 S01 连号只用于报告交换，额外保存 `stableShotId`。
- 词表增加显式 `unknown`，要求说明原因；上游枚举检查将其标为待修正，不冒充通过。
- 关键帧命名为 `frames/f000000123.jpg`，由源帧证据检查替代上游图片命名检查。
- 无像素运动实测或人工参考的检查明确为 skipped。模型未配置时保留底稿并报告 blocked。
- 分批模型输出不能写入机器时间或角色分组。人物、动物与未知主体均是带参考图的视觉候选。
- 报告 HTML 使用项目限制路径的产物接口；机器语义与人工覆盖分别保存，修改后更新报告。
