# 打造终极个人 AI 工作区：Mr. Mak Workspace 深度解析与实战指南

> **视频来源**：Stefan 3D AI — *《My Full AI Workspace - A Year in the Making, Now Yours for Free / The AI Workspace Behind My Dream Game》*  
> **开源项目**：[witnesstodark/mr-mak-workspace](https://github.com/witnesstodark/mr-mak-workspace)  
> **核心定位**：专为 CLI 编程 Agent（Claude Code、OpenAI Codex CLI）与 3D/独立游戏开发者设计的双窗口桌面工作台环境。

---

## 目录
1. [背景与核心痛点：为什么需要这个工作区？](#一背景与核心痛点为什么需要这个工作区)
2. [工作区核心架构：双窗口协同设计](#二工作区核心架构双窗口协同设计)
3. [安装部署与环境配置](#三安装部署与环境配置)
4. [关键功能深度解析](#四关键功能深度解析)
   - [4.1 终端持久化与多 Agent 协同](#41-终端持久化与多-agent-协同)
   - [4.2 极速资产拖放与剪贴板图床机制](#42-极速资产拖放与剪贴板图床机制)
   - [4.3 项目看板与卡片系统 (Projects & Cards)](#43-项目看板与卡片系统-projects--cards)
   - [4.4 Skills 共享机制与 MCP 工具中心](#44-skills-共享机制与-mcp-工具中心)
5. [高阶亮点：Mr. Mak 实时语音总监 (Voice Orchestrator)](#五高阶亮点mr-mak-实时语音总监-voice-orchestrator)
6. [实战工作流：Blender + Unity 3D 游戏开发联动](#六实战工作流blender--unity-3d-游戏开发联动)
7. [核心总结与开发建议](#七核心总结与开发建议)

---

## 一、背景与核心痛点：为什么需要这个工作区？

在过去一年里，Stefan 致力于利用 AI 打造属于自己的独立游戏（涉及 Blender 建模、Unity 引擎、AI 图像与纹理生成）。在这个过程中，他大量依赖新一代基于 CLI 的自主编程 Agent（如 **Claude Code**、**OpenAI Codex CLI**）。虽然这些 Agent 能力强大，但在真实开发场景下暴露了显著的摩擦成本：

| 传统 CLI 开发痛点 | Mr. Mak Workspace 解决方案 |
| :--- | :--- |
| **上下文丢失与会话繁杂**：频繁重启终端导致上下文断裂，多个命令行窗口杂乱无章。 | **会话持久化与状态恢复**：支持多 Tab 分页、状态保存、会话重载恢复。 |
| **多模态交互极其低效**：终端无法原生粘贴截图，向 Agent 提供参考图需要手动保存并输入绝对路径。 | **智能拖拽与剪贴板捕获**：截图直接 `Ctrl+V`，系统自动写入 `inbox/attachments` 并传入 Agent。 |
| **项目资产与文档割裂**：代码、提示词、3D 资产、研究文档分散在各处，缺乏统一直观看板。 | **右侧可视化文件与文档看板**：Markdown 即时编辑预览，音视频/图像内建查看器。 |
| **多 Agent 技能孤岛**：Claude Code 与 Codex 的自定义技能（Skills）不能通用，维护繁琐。 | **跨 Agent 技能共享层**：统一由 `.agents/skills/` 维护，一键双向同步。 |
| **频繁切换视窗**：双手在 Blender/Unity 操作时无法高效输入提示词。 | **实时语音协同助手（Mr. Mak）**：通过自然语音拆解任务并调度 CLI Agent 执行。 |

---

## 二、工作区核心架构：双窗口协同设计

Mr. Mak Workspace 采用独特的**双窗口桌面架构**，兼顾了程序员最喜爱的极简终端环境与创作者需要的可视化资产管理看板。

```
+-----------------------------------------------------------------------------------+
|                                Mr. Mak Workspace                                  |
+---------------------------------------+-------------------------------------------+
|         左侧窗口：CLI 终端工作台         |          右侧窗口：资产/项目可视化看板       |
| (Chats & Multi-Agent Terminal)        |   (Explorer, Docs, Cards & Tools)         |
+---------------------------------------+-------------------------------------------+
| [Tab 1: Claude Code] [Tab 2: Codex] + | [文件树] inbox/ | projects/ | knowledge/  |
| ------------------------------------- | ----------------------------------------- |
| > Running task: update player.cs      | [当前活动卡片]                             |
| > Agent inspecting unity log...       |   - Research 调研笔记 (Markdown)          |
|                                       |   - Prompts 提示词资产库                   |
| [输入框: 支持拖拽文件/粘贴截图自动映射]   |   - Motion Tests 视频/3D 效果预览         |
|                                       | ----------------------------------------- |
|                                       | [右侧抽屉] MCP 管理 | Skills 库 | 设置     |
+---------------------------------------+-------------------------------------------+
```

1. **左侧窗口（CLI Chats）**：
   - 纯粹的终端执行环境，支持在原生 Shell 下运行 Claude Code 与 Codex。
   - 带有标签页（Tabs），支持彩色标记、会话固定（Pin）与活动指示器（执行中、等待输入、新回复提醒）。
2. **右侧窗口（Workspace Dashboard）**：
   - 文件与目录结构化浏览器（支持快速跳转至 `inbox`、`projects`、`workspace`、`knowledge`、`processes`）。
   - 内置 Markdown 编辑器与渲染器（无需打开外部编辑器即可查看与编辑开发文档）。
   - 多媒体预览面板（支持 3D 贴图、参考图全屏放大对比、视频动效即时播放）。

---

## 三、安装部署与环境配置

### 1. 前置依赖准备
在安装工作区之前，需在本地安装并登录至少一个主流 CLI Agent：
- **Claude Code CLI**：已通过终端认证登录。
- **OpenAI Codex CLI**：已通过终端认证登录。
- *(可选)* **Node.js** 与 **Python** 环境（用于本地服务与技能同步脚本）。

### 2. 获取代码与安装
通过 GitHub 克隆官方仓库：
```bash
git clone https://github.com/witnesstodark/mr-mak-workspace.git
cd mr-mak-workspace
```

- **Windows 用户**：可以直接从 GitHub Releases 下载打包好的桌面安装程序，或双击项目根目录下的 `Start Mr. Mak.cmd` 启动。
- 首次启动时，程序会提示选择用于管理的本地项目根目录。

### 3. 环境变量配置 (`.env`)
复制项目根目录下的 `.env.example` 为 `.env`，根据需要启用对应的高阶服务：
```ini
# 可选：用于启用 Mr. Mak 实时语音总监（基于 OpenAI Realtime API）
OPENAI_API_KEY=your_openai_api_key

# 可选：用于集成 fal.ai 图像/视频生成服务
FAL_KEY=your_fal_api_key

# 可选：语音协调器指定的模型覆盖（留空则默认使用 Codex 配置）
MRMAK_COORDINATOR_MODEL=

# 可选：用于第三方聚合大模型网关
OPENROUTER_API_KEY=
```

---

## 四、关键功能深度解析

### 4.1 终端持久化与多 Agent 协同
- **持久化会话（Persistent Sessions）**：传统的终端一旦关闭进程即销毁。Mr. Mak 内部维护了会话连接池与状态持久化机制，重新打开或重启电脑后，之前的交互历史与运行状态依然完整保存。
- **双 Agent 并行**：可以在 Tab 1 运行 Claude Code 编写主逻辑代码，在 Tab 2 运行 Codex 编写测试或构建脚本，两者共享同一个项目上下文，互不冲突。

### 4.2 极速资产拖放与剪贴板图床机制
在以往使用 CLI Agent 时，让大模型分析一张图片需要手动保存图片、复制路径、粘贴到命令行。Mr. Mak 做了系统级拦截与优化：
1. **拖入文件/文件夹**：直接将文件从看板或 Windows Explorer 拖入终端输入框，自动转化为标准化相对路径。
2. **剪贴板图像捕获**：使用截图工具截图后，直接在聊天窗口按 `Ctrl+V`，工作区会自动将截图保存至 `inbox/attachments/[timestamp].png`，并自动把路径输入终端，供 Agent 识别分析。

### 4.3 项目看板与卡片系统 (Projects & Cards)
工作区鼓励按模块化“卡片”组织复杂工程，例如视频中展示的 *Arachne* 与 *Mr. Mak 64* 游戏资产卡片：
- **卡片内部分栏**：
  - `Research`：技术方案选型、API 文档摘录与灵感来源。
  - `Design Versions`：模型版本演进、2D/3D 资产迭代记录。
  - `Prompts`：可复用的结构化提示词资产库。
  - `Motion Tests`：动效生成视频、动画剪辑回放。

### 4.4 Skills 共享机制与 MCP 工具中心

#### 技能多向同步 (`skills:sync`)
- 为了防止把大量定制逻辑写入全局 System Prompt 造成上下文膨胀，工作区在项目级维护技能。
- 维护基准源：`.agents/skills/`
- 同步命令：
  ```bash
  npm run skills:sync
  ```
  执行后，系统会自动将自定义技能编译分发至 `.claude/skills/` 及 Codex 适用的技能目录，保证不同 Agent 具备相同的上下文操作能力。

#### MCP (Model Context Protocol) 深度支持
- **MCP 侧边栏面板**：直观展示哪些 MCP 工具属于“全局环境”，哪些属于“当前项目专属”。
- **Higgsfield MCP**：
  - 视频重点展示的媒体生成 MCP。
  - 允许 Agent 直接在工作流中生成高质量图像、角色多角度参考、短视频预览及 3D GLB 资产，并由工作区自动下载到项目资源目录。

---

## 五、高阶亮点：Mr. Mak 实时语音总监 (Voice Orchestrator)

视频中最引人注目的功能是右下角集成的虚拟人物 **Mr. Mak** 语音助手：

```
[ 开发者语音指令 ]
       │
       ▼ (实时语音流)
[ Mr. Mak (语音协调器) ]  <--- 基于 OpenAI Realtime API
       │
       ├─► 任务拆解与逻辑编排
       │
       ├──► 调度 [Claude Code CLI] 执行复杂 C#/Python 代码重构
       └──► 调度 [Codex / 其它 Agent] 处理文件资产或执行编译命令
```

### 核心运作逻辑：
1. **免键盘操作**：当开发者在 Blender 中雕刻或在 Unity 中摆放场景时，双手无法脱离鼠标与快捷键。
2. **语音呼叫分配**：直接说话（例如：“*Hey Mark, 请检查 Unity Console 里的 NullReferenceException 报错，并帮我修改 PlayerMovement.cs*”）。
3. **主从调度模式**：语音协调器（Mr. Mak）拥有高层级控制权，它本身不直接写全部代码，而是将命令精准转化为给底层 Claude Code / Codex 的提示词，并驱动 CLI 执行。

---

## 六、实战工作流：Blender + Unity 3D 游戏开发联动

Stefan 在视频后半部分演示了他在日常游戏制作中的标准分屏协作流：

```
+-----------------------------------+-----------------------------------+
|         屏幕 1 (主操作视口)         |         屏幕 2 (辅助控制台)         |
+-----------------------------------+-----------------------------------+
|                                   |  Mr. Mak Workspace (左侧终端)      |
|  Blender (3D 资产制作/绑定/脚本)    |   - Claude Code 运行自动化建模脚本  |
|               OR                  | --------------------------------- |
|  Unity (场景搭建/组件调试/游戏运行) |  Mr. Mak Workspace (右侧看板)      |
|                                   |   - Higgsfield 生成的原画参考      |
|                                   |   - 实时错误文档与任务清单         |
+-----------------------------------+-----------------------------------+
```

### 实际操作闭环：
1. **资产生成与概念验证**：
   - 在右侧 Workspace 中通过 Higgsfield MCP 生成道具/角色的概念图与视频动效。
   - 图片自动进入项目看板进行全屏高保真对照。
2. **Blender Python 自动化脚本编写**：
   - 告诉 Agent 需批量优化的网格参数或 UV 展开方式。
   - Claude Code 在左侧终端编写并运行 Python 脚本，直接操控后台的 Blender 实例完成资产批处理。
3. **Unity 逻辑编写与热调试**：
   - 当 Unity 编译报错时，直接在终端让 Agent 捕获 Unity 编辑器日志。
   - Agent 原地更新 C# 脚本，Unity 自动重新编译生效，实现“只动嘴、不动代码”的闭环迭代。

---

## 七、核心总结与开发建议

1. **核心哲学**：不要将时间浪费在终端窗口切换、路径复制和断点重来上。把琐碎的上下文传递、文件存储自动化，让开发者保持在心流（Flow State）之中。
2. **工具选型互补**：
   - **Claude Code / Codex**：负责底层的深思熟虑、代码编写与系统命令执行；
   - **Mr. Mak Workspace**：负责把肉眼可见的资产、笔记、会话状态与语音输入牢牢锁在一起；
   - **MCP**：将外部生态（3D 软件、云端生图、搜索引擎）无缝挂载为 Agent 的外肢。
3. **推荐使用姿势**：
   - 如果你正在使用 Cursor、VS Code 搭配 Claude Code，但经常觉得多模态传图麻烦、终端会话容易乱，Mr. Mak Workspace 是一个极佳的专职“工作台”外挂。