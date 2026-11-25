---
name: add-news
description: 为新伊甸野史的“天书”板块收录一篇 EVE Online 官方新闻：官网有中文版就照录并订正明显错误，没有就用 translator 翻译，再写成站内页面。收到 eveonline.com 新闻链接、要求“收录／翻译这篇官方新闻”时使用。
---

# 收录官方新闻

字段与边界见 `src/news/AGENTS.md`。链接须是 `https://www.eveonline.com/news/view/<短名>`（带语言前缀的也行，工具会换回英文原文）。

1. **先找官方中文版。** `npm run news -- official <链接>`。
   - 退出码 0：已写成 `src/news/<短名>.md`（`translation: official`），跳到第 3 步。
   - 返回 `status: skipped`：页面已存在；确需按官网新版重写时加 `--force`（保留手工 `category`）。
   - 退出码 3：官网没有中文版，走第 2 步。
2. **翻译。** 在 `translator/` 目录里按 `translator/.agents/skills/translate-article/SKILL.md` 全流程走（prepare → 草稿 → save → check → 独立复核 → render），不跳步，不改 `jobs/` 以外的文件。拿到 `translator/jobs/<任务>/translation.md` 后回仓库根目录：
   `npm run news -- add <链接> --file translator/jobs/<任务>/translation.md`
   默认 `translation: site`。译稿首行须是“# 中文标题”；译稿开头的“> 原文：”出处行会自动去掉。交付标记为“待复核”或“待修订”时，在汇报里写明。
3. **通读订正与长文排版。** 读一遍生成的正文：官方中文版只订正明显错字、漏译、名称前后不一和排版错误，不改写措辞；本站译文按译者交付说明处理“待核对”名称。
   - **合辑式补丁说明（`patch-notes-version-*`）专项核对**：严格按 `src/news/AGENTS.md` 检查——`title` 须为 `补丁说明——<版本号>版本`；全篇仅每日补丁标题用 `##` 且写成 `## **YYYY-MM-DD.N补丁说明**`（无空格、不重号），官网原文误标为 H2 的“功能与改动／缺陷修复”等当日内部标题一律降为 `###` 及以下；版本已有页面时只按日增量补译新增或改动小节，不整篇推倒重来（每小时自动收录见 `docs/news-automation.md`）。
   - 官方中文版逐张打开正文图片亲眼看：图里有没译的英文（图表标题、图例、条目名、海报字等）时，在该图下补“图中文字”引用块，格式同 translator 成稿——首行 `> **图中文字**`，空引用行后逐行 `> - 中文（英文）`，名称按 SDE 与官方译文，纯数字照抄；装饰图和标志不加。图打不开或看不清时在汇报里列出。看分类是否合适，不合适加 `category:` 覆盖。
   - **长文排版判断（必查）**：正文超过约 2,000 字或含多组结构化参数／清单时，按 `docs/article-layout.md` 逐项判断，不必拘泥官网原文形式——① 决定是否用 `toc`／`tocDepth` 显式控制目录；② 将并列同构的舰船属性、多势力装备／改装件、多组简报等重组为 `::: 分页`；③ 将 15 行以上的冗长清单、大表格或与正文重复的长段图中文字收进自解释标题的 `::: 折叠`。不删改任何原文事实、数字与图片。
4. **登记折扣。** 商城折扣或赠送的促销公告，按正文在 `src/news/calendar.json` 写一条（字段、买赠归类与渠道判定见 `src/news/AGENTS.md`：勿把“买 A 送 B”标成赠送，勿轻信官译“新伊甸商城”而忽略美元／网页商城链接）；同一次折扣已有条目的，把本篇短名加进该条 `news`，不另起。
5. **收尾。** `npm run news:check`，折扣漏登提示里不应有本篇。生成页与现稿一致时核读 `/news/` 卡片和详情页；没生成就如实报告未核读。

## 正史板块：点名收录一篇 lore

只收被点名的 universe.eveonline.com 文章，不顺手补译同栏目其他篇。链接形如 `https://universe.eveonline.com/<栏目>/<短名>`。

1. **抓英文稿。** `npm run news -- lore <链接> --out <草稿.md>`：取标题、YC 日期、官方栏目、封面和正文，写成“# 英文标题”开头的待译稿。草稿放草稿目录，不放 `src/`。
2. **翻译。** 在 `translator/` 里按 `translator/.agents/skills/translate-article/SKILL.md` 全流程走，入口用 `prepare --file <草稿.md> --label <短名>`。人名、势力、地名、舰船先查 SDE 与官方中文版既有译名，与天书已有译法保持一致；lore 专有名词没有官方译名时按译者交付的“待核对”清单在汇报里列出。
3. **落盘。** 回仓库根目录：`npm run news -- lore <链接> --file translator/jobs/<任务>/translation.md`，写成 `src/news/lore/<短名>.md`（`translation: site`）；页面已存在时加 `--force` 才重写。
4. **收尾。** `npm run news:check`，核读 `/lore/` 卡片和详情页。

eveonline.com 上的 lore 类新闻（突发、背景事件等）照普通天书流程收录，再在该篇加 `lore: true` 交叉列入正史。

批量导入一批已下载的官方中文 Markdown 用 `npm run news -- import <目录> --registry <登记.jsonl>`，登记表每行有 `local_path` 与中文页 `url`。
