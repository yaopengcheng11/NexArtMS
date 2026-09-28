# 全片拉片结果

状态：ready_with_issues；模型：codex-session / session-visual-review

**原片帧号与微秒时间为项目真值；上游交换表的两位小数仅用于显示。**

校验：通过 15 / 失败 0 / 跳过 5。跳过不表示通过。

## 待修正项

- 全片 [session_visual_review] 这是一版本次会话完成的视觉分析；后台自动视觉API仍需另行配置。
- 全片 [sampled_motion_limits] 所有候选段均已查看证据，但离散关键帧不能穷尽快速招式、精确接触和连续运镜；所标运镜为描述性判断，不能直接作为三维相机轨迹。
- 全片 [subject_count_scope] 已查看证据中持续区分2名人物，未见动物；右下角固定叠加图形不计作主体。
- S01 [session_uncertainty] F12已经出现脚部新画面，当前切点比视觉切换晚约一帧。
- S01 [cut_suggestion] 源帧 12：F12已出现新的脚部近景，建议切点向前校正到此处并合并后续重复边界。
- S02 [session_uncertainty] 仅见裤腿和鞋，以衣着和前后动作暂归P1；快速运动使运镜方向不确定。
- S02 [cut_suggestion] 源帧 13：F12/F13同为脚部动作，当前13的边界比可见切换晚一帧，配合S01在12拆分后移除此界。
- S03 [session_uncertainty] 仅两帧且疑似跨越真正切点，不能可靠给出统一景别或运镜。
- S03 [cut_suggestion] 源帧 23：F23视野变宽，疑似真正视角切换；请逐帧复核。
- S03 [cut_suggestion] 源帧 22：F22仍为前段上升脚部，疑似边界偏早。
- S04 [session_uncertainty] 极短仰角动作镜头；与前一候选末帧连续，需核对重复切点。
- S04 [cut_suggestion] 源帧 24：F23/F24起跳仰角画面连续，疑似重复切点。
- S06 [session_uncertainty] 画面上仰与人物跳升同时发生，关键帧不足以区分机位转动和取景变化。
- S07 [session_uncertainty] 与上一候选腾空动作连续，F46疑似动作造成的多切；短段运镜不能确定。
- S07 [cut_suggestion] 源帧 46：空中转体踢腿与前段动作连续，疑似快速人物运动造成多切。
- S08 [session_uncertainty] P1仅见白鞋及裤腿，通过衣着和相邻镜头关联。
- S09 [session_uncertainty] 只见腿脚，无法仅凭采样确认完整走位轨迹；按服装关联P2。
- S10 [session_uncertainty] P1身份由酒红裤与白鞋关联，未见面部。
- S12 [session_uncertainty] 仅脚部，沿用P1服装关联。
- S13 [session_uncertainty] 只有两帧，无法判断运镜；F133与前段落地动作连续，疑似重复切点。
- S13 [cut_suggestion] 源帧 133：同一脚部落地缓冲视角连续，仅两帧不应因裤摆变化独立成镜。
- S14 [session_uncertainty] 只有两帧，无法判断运镜；与前两段共享同一脚部视角，F135疑似多切。
- S14 [cut_suggestion] 源帧 135：同一脚部视角由下蹲过渡到起跳，疑似运动造成多切。
- S15 [session_uncertainty] F137仍为脚部局部，真正切换可能在随后一帧；应逐帧核对该边界。
- S16 [session_uncertainty] 只有两帧；与后段同视角格挡连续，F156疑似多切。
- S17 [session_uncertainty] 采样中的构图随快速接触变化，无法可靠分离运镜；P1以腿部衣着关联。
- S17 [cut_suggestion] 源帧 156：与前两帧相同低角度防守视角，抬臂动作连续。
- S18 [session_uncertainty] 只见腿脚，按服装归入P2。
- S19 [session_uncertainty] 不从离散证据推断每次踢击是否实际命中。
- S20 [session_uncertainty] 离散帧不够确认具体受力或接触顺序。
- S22 [session_uncertainty] 镜头尺度变化主要来自人物靠近，未据此标为推进镜头。
- S23 [session_uncertainty] 短促摆动的方向与幅度未精确求解；与下一候选是否连续需连看边界。
- S24 [session_uncertainty] F282附近快速换向可产生误切，但主体与视角也明显变化，保留候选待复核；运镜不确定。
- S25 [session_uncertainty] 采样未覆盖每次接触，不标记精确命中时刻。
- S26 [session_uncertainty] 由人物距离改变造成景别变化，不能据此断言镜头拉远。
- S29 [session_uncertainty] 主体运动占主导，跟随幅度仅作描述性判断。
- S31 [session_uncertainty] 无法从关键帧确定接触强度；短镜运镜不明。
- S32 [session_uncertainty] 与上一段机位尺度明显不同，保留当前边界；是否同一连续拍摄需复核原片。
- S33 [session_uncertainty] 动作很短且有模糊，无法可靠判断相机运动。
- S34 [session_uncertainty] 不从该段单独断言接下来具体使用的招式。
- S35 [session_uncertainty] 采样只覆盖动作关键姿态，不确定每次攻击接触的顺序。
- S36 [session_uncertainty] P2只见衣袖或腿部，按连续服装关联；快速近景无法判断运镜。
- S38 [session_uncertainty] 人物后撤与取景调整混合，无法确定是否有独立推拉镜头。
- S39 [session_uncertainty] 长镜关键帧间隔较大，不能列出每一招或精确接触；跟随方向需看原片连续运动。
- S43 [session_uncertainty] F796附近和下一候选开头动作连续，疑似主体大幅移动引发多切。
- S44 [session_uncertainty] 长段采样无法穷尽拳路与击打次数；F796疑似上一段的连续跟随。
- S44 [cut_suggestion] 源帧 796：冲近的蓝灰衣人物与前段尾帧连续，可能是跟随画面造成过切。
- S45 [session_uncertainty] 镜头跟随近身交锋微移，不输出精确相机轨迹。
- S46 [session_uncertainty] 接触区域被手臂遮挡，不能确认精确抓握或受力；运镜不确定。
- S47 [session_uncertainty] 长镜关键帧没有覆盖每一次接触，具体招式数和命中不确定。
- S48 [session_uncertainty] 低角度、近端遮挡和快速运动影响判断，运镜方向不确定。
- S50 [session_uncertainty] 相机上仰为多帧构图变化的描述性判断，未计算连续角度。
- S51 [session_uncertainty] 仅两帧，不能确认运镜；与上一段跳升连续，F1056疑似多切。
- S51 [cut_suggestion] 源帧 1056：同一蓝灰衣人物的上举起跳延续为收膝，疑似运动造成多切。
- S52 [session_uncertainty] 遮挡使膝与脚的接触位置不明确，保留“抬膝或短踢”而不强断招式。
- S53 [session_uncertainty] 极短近景，抓握细节与运镜不明；和后段动作连续。
- S54 [session_uncertainty] F1082与前一候选动作和背景连续，疑似重复切点；不判断实际受力与运镜。
- S54 [cut_suggestion] 源帧 1082：两人的颈肩接触和背景与前段连续，建议核看后合并。
- S55 [session_uncertainty] 无法仅凭衣服遮挡判断是否实际命中；不统计击打次数。
- S56 [session_uncertainty] 长镜离散证据不覆盖所有关节接触，连续运镜和攻击次数需原片核对。
- S57 [session_uncertainty] 人物后撤造成尺度减小，不将其自动解释为镜头拉远。

# 项目 p-a581fb7a8dd2 拉片 sa-b37164cfc557 · 拉片报告

- 总时长：50.14 秒　镜头数：57　每分钟切次：68.2
- 平均镜长：0.88 秒　中位镜长：0.63 秒　最短 / 最长：0.08 / 4.08 秒
- 960×540（16:9） · 24 fps · 有声

**景别**（片数 · 占时）：中景 11镜 · 33%　中近景 18镜 · 30%　中远景 9镜 · 13%　特写 13镜 · 13%　全景 5镜 · 11%　unknown 1镜 · 0%
**类别**（片数 · 占时）：主体 38镜 · 75%　反应 10镜 · 17%　插入特写 9镜 · 9%
**运镜**（片数 · 占时）：固定 28镜 · 48%　跟拍 9镜 · 36%　unknown 19镜 · 15%　上摇 1镜 · 1%

## 镜头表

| # | 时间 | 秒 | 景别 | 类别 | 运镜 | 画面 | 节奏 | 主体 | 画面文字 | 声音 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | 00:00.00—00:00.54 | 0.54 | 中近景 | 主体 | 固定 | 灰绿宽袖上衣男子在土坡前架拳，身体前倾后向画面右侧挥臂，末帧转为地面与白鞋局部。 |  | P1 |  |  |
| S02 | 00:00.54—00:00.92 | 0.38 | 特写 | 插入特写 | unknown | 酒红裤腿与白鞋掠过铺有枯草的土面，双脚蹬地后向上离开地面，扬起灰尘。 |  | P1 |  |  |
| S03 | 00:00.92—00:01.00 | 0.08 | unknown | 主体 | unknown | 白鞋和酒红裤脚从前景升起，末帧视野变宽，远处出现蓝灰衣人物与场地。 |  | P1、P2 |  |  |
| S04 | 00:01.00—00:01.21 | 0.21 | 中远景 | 主体 | unknown | 灰绿衣酒红裤男子腾空蜷腿，在仰角天空前转身；蓝灰衣男子较小地站在远处下方。 |  | P1、P2 |  |  |
| S05 | 00:01.21—00:01.63 | 0.42 | 中近景 | 反应 | 固定 | 蓝灰立领套装男子胸前收拳，抬头看向画面右上方，身后可见灰色石质建筑与土坡。 |  | P2 |  |  |
| S06 | 00:01.63—00:01.92 | 0.29 | 中远景 | 主体 | unknown | 灰绿衣男子在蓝天下抬膝腾空，酒红裤腿摆动，白鞋向镜头前方伸出。 |  | P1 |  |  |
| S07 | 00:01.92—00:02.33 | 0.42 | 中远景 | 主体 | unknown | 酒红裤男子悬在天空前，一腿伸出、一腿收起，身体继续旋转，白鞋从中间移向左方。 |  | P1 |  |  |
| S08 | 00:02.33—00:03.21 | 0.88 | 中近景 | 主体 | 固定 | 蓝灰衣男子抬起双臂遮挡头面，来自右上方的白鞋与酒红裤腿压入前景，他随之侧身低头。 |  | P2、P1 |  |  |
| S09 | 00:03.21—00:04.08 | 0.88 | 特写 | 插入特写 | 跟拍 | 蓝灰长裤和黑鞋在枯草土面连续交替落地，灰色石质背景相对横向滑动。 |  | P2 |  |  |
| S10 | 00:04.08—00:04.46 | 0.38 | 特写 | 插入特写 | 固定 | 酒红裤腿下的白鞋自上方接近地面，在土坡背景前先后落向枯草覆盖的土面。 |  | P1 |  |  |
| S11 | 00:04.46—00:05.38 | 0.92 | 中景 | 主体 | 固定 | 蓝灰衣男子在绿色土坡前扭转上身，先展开手臂，再把前臂收回防守位置。 |  | P2 |  |  |
| S12 | 00:05.38—00:05.54 | 0.17 | 特写 | 插入特写 | 固定 | 白鞋和酒红裤脚落到枯草地面，双脚相继接触土面，裤摆因冲量向两侧摆开。 |  | P1 |  |  |
| S13 | 00:05.54—00:05.63 | 0.08 | 特写 | 插入特写 | unknown | 酒红裤摆盖住小腿，两只白鞋压在地面上，膝部进一步下沉。 |  | P1 |  |  |
| S14 | 00:05.63—00:05.71 | 0.08 | 特写 | 插入特写 | unknown | 白鞋从屈膝后的地面位置向上抽离，酒红裤腿迅速上提并出现运动模糊。 |  | P1 |  |  |
| S15 | 00:05.71—00:06.42 | 0.71 | 全景 | 主体 | 固定 | 开头仍有白鞋近景，随后转到开阔场地：灰绿衣男子从右方跃起踢向左侧蓝灰衣男子。 |  | P1、P2 |  |  |
| S16 | 00:06.42—00:06.50 | 0.08 | 中近景 | 反应 | unknown | 蓝灰衣男子在仰角天空下抬头，肩臂从低处开始向上抬起。 |  | P2 |  |  |
| S17 | 00:06.50—00:06.96 | 0.46 | 中近景 | 主体 | unknown | 白鞋与酒红裤腿自右上方踢来，蓝灰衣男子举起双手和前臂接挡，随后压低头身。 |  | P2、P1 |  |  |
| S18 | 00:06.96—00:07.50 | 0.54 | 特写 | 插入特写 | 固定 | 蓝灰裤黑鞋在干草地面一前一后调整位置，前脚踩稳，后脚抬起再落下。 |  | P2 |  |  |
| S19 | 00:07.50—00:08.17 | 0.67 | 中景 | 主体 | 固定 | 灰绿衣男子正对镜头，白鞋抬到对手头胸高度；蓝灰衣男子背对镜头占左前景，并低头躲闪。 |  | P1、P2 |  |  |
| S20 | 00:08.17—00:09.63 | 1.46 | 全景 | 主体 | 固定 | 开阔土场中灰绿衣男子跃过或掠过对手，蓝灰衣男子向后翻倒到地面，随后翻身抬起上身。 |  | P1、P2 |  |  |
| S21 | 00:09.63—00:10.17 | 0.54 | 中近景 | 反应 | 固定 | 蓝灰立领男子由背侧转向镜头，抬起双拳重新建立防守，绿色土坡占据背景。 |  | P2 |  |  |
| S22 | 00:10.17—00:10.67 | 0.5 | 中远景 | 主体 | 固定 | 灰绿衣男子在土场转体抬起酒红裤腿，白鞋由低处扫向镜头前方，身体逐渐贴近画框。 |  | P1 |  |  |
| S23 | 00:10.67—00:11.75 | 1.08 | 中近景 | 主体 | 跟拍 | 蓝灰衣男子用双臂迎住从左侧伸来的酒红裤白鞋，身体随来腿后仰下沉，取景跟着交手动作摆动。 |  | P2、P1 |  |  |
| S24 | 00:11.75—00:12.08 | 0.33 | 中近景 | 主体 | unknown | 灰绿衣男子先以背侧朝向镜头，接着转头和上身，拳臂从胸前挥向侧方。 |  | P1 |  |  |
| S25 | 00:12.08—00:13.33 | 1.25 | 中远景 | 主体 | 固定 | 灰绿衣男子位于左侧抬腿踢向右侧蓝灰衣男子，后者抬臂挡住并后仰侧闪。 |  | P1、P2 |  |  |
| S26 | 00:13.33—00:14.71 | 1.38 | 中景 | 主体 | 固定 | 蓝灰衣男子从左近处迅速移向场地中央，转身停住后双拳收在胸前。 |  | P2 |  |  |
| S27 | 00:14.71—00:15.29 | 0.58 | 中近景 | 反应 | 固定 | 灰绿衣男子正对对手站立，先观察，再将一掌伸向前方、另一手收至脸侧。 |  | P1 |  |  |
| S28 | 00:15.29—00:16.08 | 0.79 | 中景 | 反应 | 固定 | 蓝灰立领男子在坡前将一臂向外摆开，又收回双拳，注视画外对手。 |  | P2 |  |  |
| S29 | 00:16.08—00:16.63 | 0.54 | 中近景 | 主体 | 跟拍 | 灰绿衣男子保持前掌后拳，从原位突然向镜头右前方冲出，面部和手臂产生拖影。 |  | P1 |  |  |
| S30 | 00:16.63—00:17.46 | 0.83 | 全景 | 主体 | 固定 | 灰绿衣男子从左侧助跑起跳，身体几乎横置着向右侧蓝灰衣男子伸腿，后者站定迎挡。 |  | P1、P2 |  |  |
| S31 | 00:17.46—00:17.88 | 0.42 | 中近景 | 主体 | unknown | 白鞋从左侧伸向蓝灰衣男子的胸前，男子交叉前臂接挡，随后向右下方失去平衡。 |  | P1、P2 |  |  |
| S32 | 00:17.88—00:18.67 | 0.79 | 中远景 | 主体 | 固定 | 蓝灰衣男子在低机位前向后翻落，肩背接近草地，双腿抬起后收拢滚动。 |  | P2 |  |  |
| S33 | 00:18.67—00:18.96 | 0.29 | 中近景 | 主体 | unknown | 灰绿衣男子在仰角天空前向前迈近，一手在身前、一手向外张开，目光朝下方对手。 |  | P1 |  |  |
| S34 | 00:18.96—00:19.46 | 0.5 | 特写 | 主体 | 固定 | 俯拍中蓝灰衣男子躺在枯草地上，双臂护在头侧，弯曲的膝腿抬向镜头并遮住部分面部。 |  | P2 |  |  |
| S35 | 00:19.46—00:20.33 | 0.88 | 全景 | 主体 | 固定 | 左侧灰绿衣人物靠近，右侧蓝灰衣人物从地上翻身弹起，继而身体前移，双方再次踢挡接触。 |  | P1、P2 |  |  |
| S36 | 00:20.33—00:20.83 | 0.5 | 特写 | 插入特写 | unknown | 灰绿上衣胸腹占据画面，蓝灰裤腿和黑鞋自右侧伸入，鞋面碰向上衣，灰绿衣身体向后偏移。 |  | P1、P2 |  |  |
| S37 | 00:20.83—00:22.42 | 1.58 | 全景 | 主体 | 固定 | 两人在坡前交手，蓝灰衣人物降低身体，以单手撑地的姿态把腿横向甩向站立的灰绿衣人物。 |  | P1、P2 |  |  |
| S38 | 00:22.42—00:24.08 | 1.67 | 中近景 | 反应 | unknown | 灰绿衣人物从近处收回身体，站定后把一掌举向前方、另一手护于颈胸附近。 |  | P1 |  |  |
| S39 | 00:24.08—00:27.63 | 3.54 | 中景 | 主体 | 跟拍 | 蓝灰衣人物起初单独站在坡前，随后冲向灰绿衣人物；镜头随其移动，转为两人近距离拳臂交错。 |  | P1、P2 |  |  |
| S40 | 00:27.63—00:29.58 | 1.96 | 中远景 | 主体 | 固定 | 两人在石质建筑前相对站立，灰绿衣人物转身挥臂，蓝灰衣人物侧身移步回应，随后拉开一些距离。 |  | P1、P2 |  |  |
| S41 | 00:29.58—00:30.96 | 1.38 | 中景 | 反应 | 固定 | 蓝灰衣男子独自站在石构和坡面前，双拳交替微调，身体随脚下步伐小幅起伏。 |  | P2 |  |  |
| S42 | 00:30.96—00:32.54 | 1.58 | 中近景 | 反应 | 固定 | 灰绿衣男子固定在画面左中部，一拳在脸旁，另一拳伸向前方，目光持续看向画外对手。 |  | P1 |  |  |
| S43 | 00:32.54—00:33.17 | 0.63 | 中近景 | 主体 | 固定 | 蓝灰衣男子从架拳状态向前冲近，前臂从胸前横摆，脸和手在末段产生运动模糊。 |  | P2 |  |  |
| S44 | 00:33.17—00:37.25 | 4.08 | 中景 | 主体 | 跟拍 | 镜头从冲近的蓝灰衣人物移向两人交锋，灰绿衣人物抬臂挡拆，双方拳臂反复在头胸前交错。 |  | P1、P2 |  |  |
| S45 | 00:37.25—00:39.04 | 1.79 | 中近景 | 主体 | 跟拍 | 反向视角下灰绿衣人物面对镜头，蓝灰衣人物以背肩作前景；灰绿衣挥臂，蓝灰衣低头并反手回应。 |  | P1、P2 |  |  |
| S46 | 00:39.04—00:39.88 | 0.83 | 特写 | 主体 | unknown | 灰绿衣男子抬起张开的手掌靠近头侧，蓝灰衣人物从右侧贴近，其前臂压入肩颈附近；两人同时低下身体。 |  | P1、P2 |  |  |
| S47 | 00:39.88—00:42.25 | 2.38 | 中近景 | 主体 | 跟拍 | 两人在石构前重新拉起身体，拳掌交替伸向对方面部，灰绿衣人物抬臂后蓝灰衣人物向下闪开。 |  | P1、P2 |  |  |
| S48 | 00:42.25—00:43.00 | 0.75 | 中景 | 主体 | unknown | 低机位看见灰绿衣人物的腰腹与挥动衣袖，蓝灰衣人物在右侧起身挥臂，身体向后侧移。 |  | P1、P2 |  |  |
| S49 | 00:43.00—00:43.54 | 0.54 | 中景 | 反应 | 固定 | 灰绿衣男子在木质屏障前回转上身，先把手臂向外甩开，再重新收至身前并朝对手看去。 |  | P1 |  |  |
| S50 | 00:43.54—00:44.00 | 0.46 | 中远景 | 主体 | 上摇 | 逆光下蓝灰衣人物向前助跑，双臂上举，身体逐渐升起，取景随之增加天空比例。 |  | P2 |  |  |
| S51 | 00:44.00—00:44.08 | 0.08 | 中景 | 主体 | unknown | 蓝灰衣人物在天空前把膝部抬到胸腹前，身躯蜷起，前臂随腾空姿态收拢。 |  | P2 |  |  |
| S52 | 00:44.08—00:44.83 | 0.75 | 中远景 | 主体 | 固定 | 低机位仰拍两人，蓝灰衣人物从右侧抬膝或抬腿靠向左侧灰绿衣人物，对方抬手护住上身。 |  | P1、P2 |  |  |
| S53 | 00:44.83—00:45.08 | 0.25 | 特写 | 主体 | unknown | 灰绿衣男子面部位于近景，蓝灰衣袖和白色袖口从右侧进入，手臂接近他的两侧颈肩。 |  | P1、P2 |  |  |
| S54 | 00:45.08—00:45.63 | 0.54 | 特写 | 主体 | unknown | 蓝灰衣人物双手靠在灰绿衣男子颈肩两侧，灰绿衣男子先低下脸、再抬头向侧方扭转。 |  | P1、P2 |  |  |
| S55 | 00:45.63—00:47.00 | 1.38 | 特写 | 插入特写 | 跟拍 | 俯斜角下两人的腰腿贴近，蓝灰裤腿多次屈膝抬向酒红裤的腰腹附近，随后黑鞋回到地面。 |  | P1、P2 |  |  |
| S56 | 00:47.00—00:49.33 | 2.33 | 中景 | 主体 | 跟拍 | 两人在石构前近身缠斗，蓝灰衣双臂靠近灰绿衣肩颈；随后两人分开，灰绿衣挥动手臂向侧前方还击。 |  | P1、P2 |  |  |
| S57 | 00:49.33—00:50.13 | 0.79 | 中近景 | 反应 | 固定 | 蓝灰衣男子近景中头身先向后侧摆动，随后退开些许，把双拳收回胸前重新站稳。 |  | P2 |  |  |

## 质量门

- ✅ **时间轴连续**
- ✅ **时长自洽**
- ✅ **镜号纪律**
- ❌ **景别枚举**
  - S03：unknown 不在词表里（可选：none / extreme-wide / wide / medium-wide / medium / medium-close / close / extreme-close）
- ✅ **类别枚举**
- ❌ **运镜枚举**
  - S02：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S03：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S04：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S06：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S07：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S13：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S14：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S16：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S17：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S24：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S31：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S33：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S36：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S38：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S46：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S48：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S51：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S53：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
  - S54：unknown 不在词表里（可选：static / push-in / pull-out / zoom-in / zoom-out / pan-left / pan-right / tilt-up / tilt-down / truck-left / truck-right / pedestal-up / pedestal-down / tracking / arc / whip-pan / handheld / shake / rack-focus / micro-push / roll / drone）
- ✅ **转场枚举**
- ✅ **画面描述可核对**
- ✅ **画面描述不重复**
- ✅ **主体对账**
- ✅ **类别要有证据**
- ⊘ **运镜实测对账**（没有给 --track，跳过（视为通过））
- ✅ **边界来自检测**
- ⊘ **关键帧齐全**（没有检查关键帧目录，跳过（视为通过））
- ✅ **节奏分析可核对**