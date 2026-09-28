# reelbench-skills 对当前项目的适用性

检查日期：2026-09-27。

结论：`video-shots` 很适合当前“素材导入后先拉片”的阶段，建议采用它的分析流程和输出契约，并针对快速剪辑、原始帧时间轴和主体身份扩展。它本身不负责自动跨镜头身份归并、动物识别、三维动作或相机轨迹求解。

## 仓库中可用的部分

| Skill | 当前用途 |
|---|---|
| `video-shots` | 首选。检测切点、提取每镜首尾附近关键帧、生成联系表，由当前模型补充景别/类别/运镜/画面/节奏，再校验、修正和生成拉片报告。 |
| `video-sync` | 后续用于生成原片与镜头信息同步显示的审阅视频。它读取已完成的 shots.json，不执行拉片。 |
| `video-scrub` | 清理视频元数据，与当前要解决的拉片质量问题关系不大。 |

来源：[仓库首页](https://github.com/eternityspring/reelbench-skills)、[video-shots 定义](https://github.com/eternityspring/reelbench-skills/blob/main/skills/video-shots/SKILL.md)、[video-sync 定义](https://github.com/eternityspring/reelbench-skills/blob/main/skills/video-sync/SKILL.md)。

## 本机实际验证

只在隔离输出目录进行了源码检查、自测和 seed 试跑，没有安装全局 skill、修改应用导入链路或覆盖项目数据。没有把旧镜头表的语义复制进新结果。

- 上游自测：**449 项断言全部通过**，见 [selftest.log](selftest.log)。这是脚本单元断言，不是当前视频的完整拉片验收。
- 输入：本项目 `public/reference.mp4`，与已导入测试项目的原片 SHA256 一致；50.125 秒、24 fps、1203 帧。
- 对照：项目已有的 47 镜人工纠正参考表，按 ±2 帧进行一对一匹配。

| 参数 | 生成候选镜头数 | 匹配参考切点 | 漏掉参考切点 | 未匹配候选切点 |
|---|---:|---:|---:|---:|
| 默认 threshold=0.3、min=0.3s | 34 | 33 / 46 | 13 | 0 |
| threshold=0.3、min=0.08s | 36 | 34 / 46 | 12 | 1 |

这两次仅完成 seed 阶段，语义字段仍为空。不能把它们当成完整的拉片结果，也不能仅凭总镜头数选参数。见 [evaluation.json](evaluation.json)、[默认底稿](default-shots.json)、[短镜底稿](short-cuts-shots.json)。

## 接入时必须处理的边界

1. **语义分析仍需模型。** Node 脚本主要负责测量、抽帧、编辑边界和校验；景别、画面、运镜等需要当前会话模型看图填写。要在产品后台自动运行，必须增加明确的模型调用与任务管理，不能只执行 seed 命令。
2. **保留原片时间基准。** 上游脚本把时长和切点保留两位小数，本片 50.125 秒在其 meta 中变成 50.13 秒。项目的原始 PTS、微秒和帧索引应继续作为权威数据；两位小数只适合作报告展示，切点应对齐原始 PTS。
3. **区分主体身份与叙事分组。** 上游 cast 是人工/模型维护的编号，不是自动人脸或跨镜头重识别结果。项目仍需独立的人物/动物类别、source identity、镜内轨迹以及用户叙事组关系。
4. **质量门只验证有限条件。** 时间连续、字段枚举、文本长度、引用关系等不证明视觉判断正确；运动量来自采样后的像素差，不能分离主体运动与相机运动，更不是动作捕捉。单镜短于 1 秒时，运镜质量门也不作同样的实测约束。
5. **跳过与通过必须分开。** 上游内部 skipped gate 同时可带 ok=true，不能只看顶层 ok。关键帧门主要检查 a 帧存在；本项目应另查 a/b 两张图能解码、属于正确源片和镜头，并检查实际短切。
6. **保持用户要求的自动流程。** 自动处理全片，输出附带不确定项的可修正初稿，最后统一修正；不把每项不确定判断变成必须人工确认后才能继续的步骤。

源码依据：[video-shots.mjs](https://github.com/eternityspring/reelbench-skills/blob/main/skills/video-shots/scripts/video-shots.mjs)。

## 建议当前只推进这一段

素材导入 → 原片 PTS/切点候选 → 每镜关键帧与必要密集采样 → 模型逐镜标注 → 拉片数据与可视化审阅结果。

这一段稳定后，再让人物/动物身份、用户叙事分组和 3D 重建消费它的结果。`video-sync` 可以在镜头表完成后帮助检查原片与分析是否对得上。

## 来源可追溯性

Git 克隆与 ls-remote 遇到网络失败，GitHub API 另返回未认证访问限额。随后从官方 raw.githubusercontent.com/main 取得所需文本源码并检查。未能锁定 commit SHA；已在 evaluation.json 保存检查时间、实际执行脚本 SHA256 和输入视频 SHA256。本次未执行仓库安装器。
