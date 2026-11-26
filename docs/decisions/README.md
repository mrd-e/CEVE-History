# 架构决策记录（ADR）

这里维护影响多个任务的长期技术决策及理由。改工作流、依赖策略、持久化边界或代理协作规则前，先查本索引，再读适用的已采纳记录；普通修复不必新建 ADR。

## 索引

| 编号 | 状态 | 决策 | 涉及范围 |
| --- | --- | --- | --- |
| [0001](0001-translator-latest.md) | 已采纳 | 翻译框架跟随最新默认分支，不固定 commit 或 tag | translator、天书自动收录、翻译回归 CI |
| [0002](0002-static-site-and-private-kb.md) | 已采纳 | 公开静态站、私有资料库和翻译框架分离 | 构建、kb 路径、公开派生数据 |
| [0003](0003-official-sections-and-deals.md) | 已采纳 | 天书、正史、折扣平级，折扣清单独立维护 | 导航、集合、网址、历年优惠对照 |
| [0004](0004-shared-navigation-and-reading.md) | 已采纳 | 导航与长文能力共用，返回直达指定目录 | 共享组件、基础交互、阅读样式 |
| [0005](0005-worker-gated-news-automation.md) | 已采纳 | Worker 检测变化，Actions 按需收录与部署 | RSS、补丁检测、无变化退出、冷却 |
| [0006](0006-bounded-resumable-translation.md) | 已采纳 | 翻译最多两轮复核，按持久化阶段恢复 | Opus high、任务复用、附件与保留意见 |
| [0007](0007-news-publication-state.md) | 已采纳 | 页面与订阅状态共同落盘，补丁按真实快照增量更新 | 人工收录、待办、章节指纹、失败恢复 |
| [0008](0008-concurrent-git-writers.md) | 已采纳 | 多仓库与自动化共写时保留工作区和远端成果 | 提交授权、机器人提交、历史改写 |
| [0009](0009-facts-judgment-and-review-boundaries.md) | 已采纳 | 事实快照、人工判断与功能复审分别维护 | 当前／历史归属、雷达与阵营、复审指纹 |
| [0010](0010-news-deals-registration.md) | 已采纳 | 收录天书时判断折扣增补，与页面同一提交 | 自动收录、折扣清单、失败回滚 |

## 当前结构与读取入口

| 要改什么 | 先读 | 实现入口 |
| --- | --- | --- |
| 网站技术栈、构建或资料存储 | 0002 | `eleventy.config.js`、`scripts/workspace.mjs`、`scripts/bilibili-public.mjs` |
| 官方板块、网址或折扣功能 | 0003、0004、0010 | `src/_data/sections.js`、`scripts/news-lore.mjs`、`scripts/news-calendar.mjs` |
| 返回、目录或长文交互 | 0004 | `src/_includes/back.njk`、`scripts/article-prose.mjs`、`src/assets/js/article-ui.js` |
| 定时检测、工作流或部署触发 | 0005、0008 | `.github/news-worker.mjs`、`.github/workflows/news.yml`、`.github/workflows/deploy.yml` |
| 翻译版本、模型、复核或重试 | 0001、0006 | `scripts/ci-news/sync.py`、`scripts/ci-news/runtime.py`、独立 `translator/` |
| 收录、补丁更新或订阅状态 | 0007、0008、0010 | `scripts/news-workbench.mjs`、`scripts/news-publication.mjs`、`scripts/ci-news/publication.py` |
| 身份、快照、评分或复审失效 | 0009 | `scripts/person-identity.mjs`、`scripts/activity.mjs`、`scripts/review.mjs` |

“已采纳”表示后续工作须遵守的选择，不代表本地改动已提交、相关回归已通过或线上部署已生效。具体字段、取材与写作规则、视觉尺寸和命令参数仍以关联专题规范维护，不在本索引复制。

## 防止决策回退

- 先核对已采纳 ADR、专题规范与当前实现，再决定改法。实现冲突是需要处理或报告的差异，不能仅因代码已经这样写就反向改掉决策。
- 当前明确的变更授权可以改变既有选择；旧会话摘要、本机记忆、未采纳建议和旧 OpenSpec 草稿不能自行推翻已采纳记录。先核对依据，不按文件修改时间或摘要新旧猜测优先级。
- 已知旧方案：`openspec/changes/news-lore-and-calendar/` 仍有天书子分区和活动泳道设计，冲突部分见 0003；GitHub 定时轮询见 0005 的替代选择。不得为让旧草稿或旧断言通过而恢复这些行为。
- 本地在途实现与已部署行为分别核实。发现缺实现、缺回归或部署差异时如实报告，不能把新增 ADR 当成问题已经修复。

## 维护流程

1. 新决策按顺序新增 `NNNN-英文短名.md`，使用下方模板，并更新索引；状态为“提议”“已采纳”“已取代”或“已撤销”。当前任务明确确定的决定可直接记为已采纳，不增加确认步骤。
2. 已采纳决策是后续实现约束。实现与其冲突时，应按当前明确授权修订决策；没有变更授权时遵守既有记录。
3. 改变已采纳决策时新增记录，旧记录保留理由，标记“已取代”并双向关联。文字澄清和事实勘误可以原地修正。
4. 长期技术选择与理由在 ADR 维护，目录指令和操作文档引用对应记录，专题细则仍在各自规范维护。OpenSpec 管本次变更的方案与任务；跨任务仍生效的决定落入 ADR，不能只留在被忽略的草稿、会话或本机记忆中。修订或归档 OpenSpec 时同步冲突部分，不用修改产品来迁就旧方案。
5. 收尾核对决策、实现、测试和操作文档一致；可自动核验的关键约束加入回归测试。只记录技术背景和权衡，不记录对话、提出者身份或任务日志。

## 模板

```markdown
# NNNN：决策标题

- 状态：提议 / 已采纳 / 已取代 / 已撤销
- 日期：YYYY-MM-DD（UTC）
- 范围：涉及的模块或流程
- 关联：相关 ADR / 规范 / 实现入口

## 背景

要解决的问题与现有约束。

## 决策

具体必须遵守的行为和例外边界。

## 理由与取舍

选择依据、代价及不采用的方案。

## 验收

能判断实现是否遵守决策的检查方法。
```
