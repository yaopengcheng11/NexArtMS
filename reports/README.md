# 验证记录

本目录保留 JWM 原型开发过程中的局部验证与界面截图。它们记录特定版本和本机环境下的结果，不表示所有规划功能都已完成。首次 GitHub 发布的检查另见 `publication-check.json`。

| 文件 | 范围 |
|---|---|
| `baseline.json` | 原视频、V2 MP4、时长、帧数与音频对齐 |
| `rig-m0.json`、`browser-m0.json` | 刚性层级、三档显示、单骨权重、合成姿态与场景保护 |
| `browser-scene.json`、`scene-evidence.md` | 固定场景、镜头切换、参考帧、保存和未完成事项 |
| `dcc-summary.md`、`dcc-*.json` | Blender 内合成角色 GLB／BLEND／FBX／USD 的有限往返验证 |
| `rehearsal-browser.json`、`rehearsal-live.json` | 五阶段流程演练、刷新恢复与下载 |
| `comparison-browser.json` | 两路实际解码帧、定位、模式、音频、速度及故障处理 |
| `comparison-live.json` | 47 镜完整回放的本机播放时钟采样 |
| `comparison-style.json`、`comparison-style-*.png` | 浅色风格、并排／叠加、小屏布局与交互 |

## 解读边界

- `npm run check` 的自动检查使用合成姿态及可丢弃存储夹具；不执行浏览器或 Blender。
- 双视频的时钟偏差不等同于任意设备上每一瞬间的显示帧都完全相同。暂停定位另用实际呈现帧时间检查。
- DCC 报告针对合成单肘动画，不涵盖原片全片动作、相机或目标软件的完整生产流程。
- Maya、Houdini、动作去抖以及全片三维整包仍未完成实测验收。
- 部分截图展示旧界面；当前浅色对照界面以 `comparison-style-*.png` 为准。
- 历史本机绝对路径已归一化；端口与本机运行地址保留为执行时的环境信息。

完整状态见 [执行进度](../docs/progress.md)。
