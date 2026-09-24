# 样片与技术资产

本仓库保留当前 JWM 原型运行所需的固定样例。浏览页面不会调用生成服务或重新执行姿态检测。

| 位置 | 内容与来源 | 用途 |
|---|---|---|
| `public/reference.mp4` | 用户提供的 JWM 原视频的对照预览版本 | 原片播放，24 fps、1,203 帧、50.125 秒 |
| `public/reference-frames/` | 按镜头数据从原片抽取的 141 张首／中／尾帧 | 场景与关键姿态参考 |
| `public/project/scene.json` | 根据原片估计的固定白模场景与初步机位 | 正式工作台的初始场景 |
| `public/project/shots.json` | 47 镜头的帧边界、描述和角色信息 | 项目时间基线 |
| `public/demo/v2.mp4` | 旧版 Three.js V2 导出的 1280 × 720 视频，使用原片声音 | 完整镜头演练与 MP4 下载 |
| `public/demo/v2-frames/` | 从 V2 视频抽取的 47 张镜头中间帧 | 关键姿态阶段的对照样例 |
| `public/probes/rig.glb` | 程序创建的 CL2 刚性角色技术样例，来自三档共用骨架实现 | 骨架、权重、动画结构试验 |
| `public/probes/dcc/` | 同一合成角色的 BLEND／FBX／USD 格式试验文件 | Blender 往返验证和下载演示 |
| `examples/jwm-v2/data/` | 原片二维姿态检测结果与人工补点 | 重建旧版姿态数据 |
| `examples/jwm-v2/src/pose-data.json` | 旧版逐帧姿态、角色匹配与镜头布局 | 实时预演输入 |
| `examples/jwm-v2/src/background-data.json` | 旧版逐帧山坡轮廓 | 旧版背景显示；新固定场景不依赖它 |

以上角色与场景都属于简化表达。原片只能提供有限视角，尺度、深度和遮挡区域存在估计；V2 仍有动作抖动。技术模型不包含经过正式确认的全片角色、场景、动作或摄影机动画。

原始 `jwm.mov` 未重复放入仓库；历史报告中的 `source-media/jwm.mov` 是该输入的归一化来源标记。报告中原开发机器的绝对路径已改为仓库相对路径或来源标记，数值验证结果保留。

## 替换或重新准备素材

在项目根目录运行，需安装 FFmpeg；脚本支持 `FFMPEG` 指定可执行文件。

```sh
node scripts/extract-reference-frames.mjs /path/to/source.mov
node scripts/prepare-rehearsal.mjs /path/to/existing-v2.mp4
```

抽帧依据当前镜头表中的整数帧边界。请使用与当前时间基线一致的 24 fps 视频。原片播放器文件需放在 `public/reference.mp4`；更换素材后重新构建，使 `dist/` 中的视频和图片与 `public/` 保持一致。

当前页面没有通用上传和自动重建流程。更换成另一部影片需要同时准备其镜头分析、场景、角色与动作数据。
