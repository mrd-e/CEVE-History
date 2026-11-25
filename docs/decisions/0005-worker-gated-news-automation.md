# 0005：Worker 检测变化，Actions 按需收录与部署

- 状态：已采纳
- 日期：2026-11-25（UTC）
- 范围：Cloudflare Worker、新闻工作流、订阅扫描、Pages 调度
- 关联：[自动收录操作](../news-automation.md)、[翻译执行](0006-bounded-resumable-translation.md)、[收录状态](0007-news-publication-state.md)

## 背景

单靠 GitHub 定时任务存在排队与延迟；无条件触发工作流又会反复安装依赖、扫描甚至部署。补丁合辑还可能原址更新而没有新的 RSS 条目，不能只检测文章短名。

## 决策

- Cloudflare Worker 负责轻量检测与触发，不调用模型、不翻译、不直接发布网站。每十分钟查 RSS；整点另查当前补丁版本与更新时间，并考虑待办和待部署请求。
- 新闻 Actions 保持 `workflow_dispatch` 入口，由 Worker 或人工触发；不再增加另一套 GitHub 定时轮询或本机常驻轮询。
- Worker 使用公开订阅状态判断是否需要唤起 Actions，调用前检查是否已有未完成的新闻运行；新闻工作流串行执行，不取消正在完成的译文任务。
- Worker 的检测只是预筛，Actions 仍须以实际原文指纹核对变化。缓存或时间戳造成多触发时，重复运行也不能重复送译或部署。
- 来源无变化、没有到期可处理的待办、没有待部署请求时直接结束。纯订阅状态变化不触发 Pages；只有网站内容变化才建立部署请求，失败部署可单独重试。
- 模型额度冷却同时约束 Worker 调度和宿主模型调用；不能仅在一层加延时。冷却期间已完成文章仍允许部署。

## 理由与取舍

廉价检测留在 Worker，依赖安装、翻译与发布留在 Actions。保留补丁的独立检测来弥补 RSS，接受整点检测、缓存与 GitHub 排队带来的延迟，不承诺实时发布。没有变化就不消耗模型额度，也不重复构建网站。

## 验收

- 实现入口：`.github/news-worker.mjs`、`.github/workflows/news.yml` 与 `scripts/ci-news/sync.py` 的扫描、发布和部署阶段。
- 回归入口为 `scripts/news-worker.test.mjs`、`scripts/news-workflow.test.mjs` 与 Python 扫描测试。修改此流程时须验证无变化不调度、已有运行不重复调度、补丁独立检测、冷却和部署边界，以及 Actions 最终指纹判断；现有用例未覆盖的路径需补充验证。
- 仓库代码、Cloudflare 已部署脚本和触发表达式分别验证；本地测试通过不能报告线上配置已生效。
