# 自动混剪还原 V2 实现 Review

> 修复状态：本报告中的 R01–R14 已在后续修复并验收。见[修复与实片验收结果](G:/AITOOLS/NexArtMotionStage/NexArtMS/reports/v2-fix-acceptance/README.md)。以下保留修复前发现及证据；完整 V2 还原质量仍未达标。

日期：2026-09-27  
范围：当前工作目录中自动任务链、人物/动物身份、分组、代理配置、整片播放与交付链路。  
基准：[V2 开发计划](G:/AITOOLS/NexArtMotionStage/NexArtMS/docs/automatic-reconstruction-plan-v2.md)。

## 结论

**当前版本需要修复，不能按“V2 计划已全部完成”验收。** 自动串联任务、临时分组、按组保存 CL 档位和整片播放器已经建立，但正常操作路径仍有播放失效、身份被错误合并、重跑受阻及人物/动物互相影响的问题。

本报告列出 14 项可定位的问题：7 项 P1、7 项 P2。P1 表示会破坏核心播放、身份正确性或默认工作流，应先修；P2 表示需要修复的边界、修正入口或状态准确性问题。另将计划中明确未贯通的功能单列，避免把全部未开发内容混作回归缺陷。

本轮只新增本报告；没有修改业务实现，没有修改现有项目数据。

## 验证依据与限制

| 检查 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `npm run check` | 102 项通过，0 失败，0 跳过 | 现有自动测试全部通过 |
| `npm run build` | TypeScript 与 Vite 构建通过 | 当前代码可编译、打包 |
| 临时 SQLite 身份夹具 | 复现临时组保护、稳定 ID 误合并、空结果残留、整理人物清空动物、动物修正 API 问题 | 使用真实 store 与项目操作函数，不接触现有数据库 |
| 临时任务运行器夹具 | 复现动物单独检测越界回退、零检出中断自动链 | 使用真实 job runner 与 store；检测器返回受控结果，未运行真实模型 |
| 真实路由＋内存 store 夹具 | 复现缺动物/相机仍返回 `ready` 与 100% | 实际调用项目详情路由；不是完整模型端到端测试 |
| Node/tsx 数学与采样夹具 | 复现镜头选择、骨段方向、多人落点、旧动作采样、预览/导出差异 | 验证相关函数与 rig 的实际输出 |
| UI 组件数据流审查 | 确认动物详情不可达、队列混入动物 | 本轮没有执行浏览器点击复现 |

临时文件均在系统临时目录中创建，关闭数据库并校验清理目标后删除。未重新跑真实混剪上传到最终视频的完整验收；历史截图和历史验收报告不视为本轮完成证据。

## P1：优先修复

### R01 第二镜及后续镜头加载不到自身动作

- 位置：[StudioPlayback.tsx:30](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/StudioPlayback.tsx:30)，镜头 ID 的来源见[第 129 行](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/StudioPlayback.tsx:129)。
- 原因：`followShot` 保存 `S02` 等镜头 ID，却被 `Number(followShot) || 0` 当作时间传给 `shotAt`。非数字 ID 变成 0，懒加载始终定位第一镜。
- 影响：后续镜头即使已有有效动作文件，播放器仍显示站立占位。
- 证据：受控调用得到 `followShot=S02 → lazy-load target=S01`。
- 修复方向：保存并使用一致的数据类型；按镜头 ID 查找，或传入当前 PTS。
- 回归验收：至少三个镜头，各自有不同动作；顺序播放、直接 seek 第三镜、倒退至第二镜，均加载并显示对应动作。

### R02 骨骼世界旋转被重复叠加，简单姿态也会变形

- 位置：[studio-stage-math.ts:94](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/studio-stage-math.ts:94)。
- 原因：静止方向到目标世界方向的旋转，又乘了一次父骨骼世界旋转，之后再转回局部坐标，导致父旋转重复作用。
- 影响：上臂、前臂等父子骨段无法共同对齐观测方向，直接破坏动作还原。
- 证据：前臂目标方向 `[0,-1,0]`，应用姿态后的实际方向为 `[-0.98776,0.15596,0]`，夹角约 **98.97°**。现有测试只检查四元数归一化等属性，未检查实际骨段方向。
- 修复方向：明确 rest 方向、目标方向与父变换所在坐标系，再计算局部旋转。
- 回归验收：垂臂、平举、屈肘以及根节点转向等姿态，验证 rig 应用后各骨段的世界方向误差，而非仅验证四元数长度。

### R03 同镜多人的初始落点丢失，全部重叠到原点

- 位置：[studio-timeline.ts:80](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/studio-timeline.ts:80)、[第 85 行](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/studio-timeline.ts:85)；局部根运动来源见 [pose3d.mjs:155](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/pose3d.mjs:155)。
- 原因：每条动作轨迹减去自己的初始骨盆位置，只留下相对根位移；播放器直接使用该结果，没有补回镜头内初始落点。无动作代理也统一放在 `[0,0]`。
- 影响：原片画面左右分开的角色会重叠，无法保留构图、间距和走位关系。旧静态三维确认视图已有按框估计落点的逻辑，整片播放器没有接上。
- 证据：人物框分别在 `x=.1` 和 `x=.7` 的两条轨迹，首帧采样的根位置均为 `[0,0,0]`。
- 修复方向：为每个镜头内实例保存统一场景坐标下的初始变换，并组合局部动作与相对根运动；占位代理也使用该落点。
- 回归验收：两人分别站在画面左右，包含有动作及无动作情况；首帧和后续采样保持合理相对位置，seek 结果一致。

### R04 动作失效或重算后，播放器仍使用旧缓存

- 位置：[StudioPlayback.tsx:34](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/StudioPlayback.tsx:34)、[studio-timeline.ts:66](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/studio-timeline.ts:66)；静态视图也有同类缓存路径：[StudioStage.tsx:48](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/StudioStage.tsx:48)。
- 原因：动作缓存只按 `trackId` 建立；已加载或请求失败过的轨迹不再请求。产物失效、角色尺度/绑定改变或重算没有使缓存失效，采样器也不检查当前有效动作引用。
- 影响：用户按要求在全片初稿之后修改，页面可能继续播放旧结果；一次暂时的请求失败也会永久阻止当前挂载期间的再次加载。
- 证据：当前 `motionRefs={}`，传入旧缓存后采样仍返回 `quality:'solved'`。对应请求条件会跳过已缓存的轨迹。
- 修复方向：缓存键包含动作产物版本或有效引用；产物失效时清理缓存，丢弃过期响应，并允许失败重试。
- 回归验收：保持页面打开，修改角色尺度/分组、重算同一轨迹，验证动作更新；主动失效后不能显示旧动作；首次请求失败后可恢复。

### R05 自动临时分组被误判成人工决定，默认初稿之后无法重新检测

- 位置：[db.mjs:342](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/db.mjs:342)。
- 原因：替换保护只检查 `reviewed` 或绑定状态 `bound/ignored`，没有区分自动临时绑定和用户确认。自动初稿已经把人物绑定到临时组，因此下一次检测被拦截。
- 影响：用户尚未做任何确认，仅完成默认自动流程，就遇到“已有人工核对或归组”的 409。
- 证据：临时 SQLite 中执行 `insertTracks → summarizePeople → ensureProvisionalGroups → insertTracks`；身份 `reviewed=false`、绑定 `updated_by='auto'`，最后一步仍返回 409。
- 修复方向：按绑定来源、临时组状态及人工确认记录识别保护对象；保持人工决定保护，但允许自动临时结果的安全重跑。
- 回归验收：默认全自动生成后直接重跑成功；用户确认/编辑过的绑定依旧受保护；两类情况分别测试。

### R06 稳定 ID 复用绕过人工确认和同框排斥，静默合并不同人物

- 位置：[project-operations.mjs:194](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/project-operations.mjs:194)，候选范围见[第 184 行](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/project-operations.mjs:184)。
- 原因：虽然聚类输入排除了已核对人物，稳定 ID 复用却搜索全部旧人物质心，仅按外观相似度复用身份，没有重新应用人工约束及同镜重叠检查。
- 影响：用户核对好的源人物身份会被自动加入另一个同时出现的人物，唯一人物数量和后续叙事分组一起出错。
- 证据：已核对红衣人物 A；同镜重叠时段人工补标相似衣着人物 B；整理人物后身份从 2 个变为 1 个。A 保持 `reviewed=true`，但已包含 A/B 两条同时出现的轨迹。
- 修复方向：稳定映射也必须遵守身份约束；未经明确证据或用户操作，不向受保护身份自动加入新出场，并检查同框冲突。
- 回归验收：已核对 A 与新补标的相似外观 B 同时出现，整理后仍为两个身份；真正可重用的未确认旧身份保持 ID 稳定。

### R07 单独检测动物时，模型缺失会转而替换人物结果

- 位置：[jobs.mjs:142](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/jobs.mjs:142)。
- 原因：动物模型缺失时，`runSubjects !== 'person'` 的回退条件同时覆盖 `both` 和用户明确选择的 `animal`，随后运行人物检测并写入人物轨迹。
- 影响：用户选择“只检测动物”，实际人物候选却被替换；有人工保护时，则可能变成与本次目标无关的失败。任务输出写了降级信息，并不能消除越过检测范围的问题。
- 证据：真实 runner＋临时 SQLite＋受控检测器，实际调用序列为 `['animal','person']`；任务 `done`，原有人物轨迹变为 `superseded`，新增人物轨迹。
- 修复方向：仅对请求中包含人物的 `both` 允许降级完成人物分支；单独动物检测缺依赖时保留人物数据，明确报告动物未完成。
- 回归验收：分别测试 `person/animal/both` 与动物模型缺失；`animal` 分支不得调用人物检测或修改人物轨迹。

## P2：需修复

### R08 本次零检出的类别不会清理旧检测结果

- 位置：[db.mjs:338](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/db.mjs:338)。
- 原因：替换范围从返回的 `specs` 推断，而不是来自本次实际检测范围；输出为零的类别根本不进入替换循环。
- 证据：原有一个人物和一个动物，执行空结果替换成功后，两者仍 `active`；`both` 只返回人物时，也会保留旧动物。
- 修复方向：显式传入成功完成检测的类别；区分“已成功检测且零检出”与“模型不可用而未检测”。
- 回归验收：单类空结果、双类空结果、双类中一类空结果均正确替换；未请求或未成功检测的类别保持原样，人工保护仍生效。

### R09 按已知人物数量整理会清空动物身份

- 位置：[project-operations.mjs:166](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/project-operations.mjs:166)。
- 原因：聚类输入只选人物，清空 `person_id` 的 SQL 却覆盖所有 active 轨迹，随后只回填人物并删除空身份。
- 证据：项目有未确认人物及动物，设置 `sourcePeopleCount=1` 并整理后，动物身份卡从 1 变为 0；动物轨迹仍 active，但 `person_id=null`。已核对动物也可能因第 159 行的全类别保护检查阻止人物整理。
- 修复方向：输入、保护、解绑、回填及空身份清理都限定到人物类别。
- 回归验收：动物已核对/未核对两种状态下调整已知人物数量，动物身份、名称及出场映射均不变化。

### R10 动作文件数量被当成初稿质量，缺失内容仍可能显示 100% 和 ready

- 位置：[router.mjs:92](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/router.mjs:92)；动作文件生成条件见 [jobs.mjs:217](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/jobs.mjs:217)。
- 原因：分母只包含已绑定人物，分子只看 `motion_ref` 是否存在；动物、未绑定人物、有效动作时间及相机缺失都不参与质量状态。两帧有效动作就可以生成引用。
- 证据：真实项目详情路由，输入一个有动作引用的人物、一个无动作动物、零相机和已完成 motion job，返回 `state='ready', coveragePct=100, solvedCount=1, boundCount=1`。长轨迹只有两帧有效时同样可以达到文件计数的 100%。
- 修复方向：保留“动作产物条数”作为独立信息，质量覆盖率按计划使用主体可见时间；缺动物、无动作区间、缺相机/占位相机等进入问题摘要，并与任务执行成功分开。
- 回归验收：稀疏有效帧、未绑定人物、无动作动物、相机缺失分别产生可见问题；生成结束且能播放不等于质量完整。

### R11 人物集合被复用于动物 UI，详情打不开且待核对队列错误

- 位置：[StudioPeople.tsx:71](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/StudioPeople.tsx:71)、[第 74 行](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/StudioPeople.tsx:74)。
- 原因：`knownTrackIds` 和 `openPerson` 都只从人物集合计算；动物卡却使用同一个打开 ID，待核对队列则遍历所有轨迹。
- 影响：点击动物“查看镜头”后找不到详情，改名/核对入口不可达；已经有动物身份的轨迹仍进入待核对队列，而归属下拉框又只有人物，提交会被服务端 422 拒绝。
- 证据：组件条件与集合数据流确定；本轮未做浏览器交互复现。
- 修复方向：详情按统一实体 ID 查找；待核对队列和目标身份按 subject 分开，已归属集合覆盖该类别全部身份。
- 回归验收：人物及动物卡都能展开正确镜头；已归属动物不进入未归属队列；动物候选仅提供同类身份目标，混合批量操作不会误带另一类别。

### R12 动物身份修正 API 仍保留人物专用限制

- 位置：[project-operations.mjs:87](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/project-operations.mjs:87)、[第 125 行](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/project-operations.mjs:125)。
- 原因：归入/移回待核对操作无条件拒绝动物轨迹；拆分和合并检查的 `members` 又排除了全部动物。
- 证据：动物出场归入动物身份及移回待核对均返回 422；动物身份拆分返回 400；同镜同时出现的两只狗手动合并却通过，身份数量从 2 变为 1，因为冲突检查面对空成员集合。
- 修复方向：校验源/目标是否同一 subject，并在该类别成员上执行拆分、归入和同框检查；拆出新身份时继承 subject/species。不能只修前端入口。
- 回归验收：动物身份可以合法拆分、归入和释放；不同物种不得合并，同镜不同动物个体不得因漏检约束误并；叙事分组与源身份合并分开测试。

### R13 无相机解的镜头继承上一镜相机，seek 结果依赖播放历史

- 位置：[StudioPlayback.tsx:111](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/StudioPlayback.tsx:111)。
- 原因：有解时写入相机位置/FOV/up/target，无解分支只打开 OrbitControls，没有应用当前镜头明确的默认相机。
- 影响：从已解相机的 A 镜播放到无解的 B 镜，会沿用 A；刷新后直接进入 B 则采用初始化相机。同一时间点呈现不同构图。
- 证据：相机写入分支审查，未执行浏览器截图对照。
- 修复方向：采样结果在无解时也提供确定的默认相机；将用户自由观察状态与用于还原的相机状态分开。
- 回归验收：顺序播放、直接 seek、倒放后 seek 和刷新直达同一无解镜头，默认还原视角一致。

### R14 全片零主体检出时，自动链中断且要求用户先补标

- 位置：[jobs.mjs:48](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/jobs.mjs:48)。
- 原因：自动 detect 后仍进入 people 任务，空轨迹被当作错误；不会生成可审查的空舞台初稿或继续以占位方式完成时间线。
- 影响：真正的全空镜视频，或模型完全漏检的视频，不能遵循“先自动生成全片，最后统一修正”的流程。
- 证据：真实 runner＋临时 SQLite＋零结果检测器，得到 `detect=done`、`people=failed（请先检测人物或补标出场）`，没有后续 motion 任务。
- 修复方向：区分技术失败和合法空结果；允许空镜/零识别结果完成默认舞台时间线，并记录零检出及待复核状态。
- 回归验收：纯空镜视频可播放完整时长；零检出可在结束后补标，不要求先补标才能生成初稿；模型技术失败仍明确报告。

## 计划范围中尚未贯通的部分

以下与上面的已确认缺陷分开看待。当前 [progress.md:11](G:/AITOOLS/NexArtMotionStage/NexArtMS/docs/progress.md:11) 也明确记录了部分边界，因此不能把当前交付表述为整个 V2 完成。

1. **动物分组、代理与动作链路未完成。** [project-operations.mjs:107](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/project-operations.mjs:107) 仍拒绝动物代理归组；[studio-timeline.ts:62](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/studio-timeline.ts:62) 将动物排除出整片播放。动物存在于检测/身份列表，不代表完成用户要求的动物还原。
2. **连续运镜与根运动联合细化仍待完成。** 进度文档列为 P6；当前自动链只到 motion。不能用已有相机模块或逐帧姿态文件代替全片构图、动作和运镜验收。
3. **每组 CL 配置尚未贯通静态确认和导出。** [StudioStage.tsx:199](G:/AITOOLS/NexArtMotionStage/NexArtMS/src/StudioStage.tsx:199) 仍使用面板独立 CL 状态；[build-export-package.mjs:93](G:/AITOOLS/NexArtMotionStage/NexArtMS/scripts/build-export-package.mjs:93) 仍走旧 `buildProxyRig`。CL 配置持久化已经存在，但不等于所有输出一致。
4. **预览和导出仍采用不同采样。** 网页使用最近帧与 250ms 占位判定；[proxy-rig.mjs:49](G:/AITOOLS/NexArtMotionStage/NexArtMS/studio/proxy-rig.mjs:49) 移除空帧并建立插值动画。受控样例中，0 秒 x=0、1 秒 x=2，在 0.4 秒网页为 x=0/placeholder，导出动画为 x=0.8。需要统一时间采样与缺失区间政策，不能仅通过函数注释声明共用。
5. **最终视频渲染和完整验收尚未完成。** [build-export-package.mjs:131](G:/AITOOLS/NexArtMotionStage/NexArtMS/scripts/build-export-package.mjs:131) 明确标记预览视频渲染未实现；A01–A18 尚无逐项完成证据。

## 建议修复与复验顺序

1. **保护身份与检测范围：R05、R06、R07、R08、R09。** 先避免重跑和人工修正破坏结果，并补“自动临时绑定”和“零检出”测试。
2. **恢复整片播放的正确性：R01、R02、R03、R04、R13。** 使用至少三个镜头、两个同镜人物、不同动作及一个无相机解镜头验证顺播/seek/修改后重播。
3. **完成修正入口与状态表达：R10、R11、R12、R14。** 让用户能在初稿后修改人物和动物，并看到实际缺失内容。
4. **继续完成已列出的计划范围。** 动物完整链路、连续相机/根运动、统一 CL 与采样/导出，完成后逐项验收 A01–A18。

复验至少应包含：一段三镜混剪、一段同镜双人、一段人物＋动物、一段纯动物、一段纯空镜，以及同项目上的“生成→修改→局部重算→不刷新播放→重跑检测”。真实素材质量指标需要带真值或人工标注的样本，不能用合成夹具或测试全通过替代。
