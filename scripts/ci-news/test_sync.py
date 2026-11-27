"""订阅队列、滚动补丁和通过复核的交付边界。"""

import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from subprocess import CalledProcessError
from unittest.mock import patch

import sync

os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)  # 失败路径会请维修代理；离线测试不许真的调用模型
LORE_SINCE = "2026-09-23"
OLD_LORE = (("empires/old", "Sat, 13 Nov 2021 17:44:17 GMT"),)


def lore_rss(*items):
    rows = "".join(f"<item><link>{sync.LORE_SITE}/{key}</link><pubDate>{date}</pubDate></item>" for key, date in items)
    return f"<rss><channel>{rows}</channel></rss>".encode()


class NewsSyncTests(unittest.TestCase):
    def test_claude_failure_reports_both_streams_without_token(self):
        script = ("import os, sys; print('subscription error', os.environ['CLAUDE_CODE_OAUTH_TOKEN']);"
                  "print('container diagnostic', file=sys.stderr); sys.exit(1)")
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
                os.environ, CLAUDE_CODE_OAUTH_TOKEN="secret-for-test", EVE_TRANSLATOR_JOBS=tmp):
            with self.assertRaises(ValueError) as error:
                sync.claude_output([sys.executable, "-c", script], "")
        self.assertIn("subscription error", str(error.exception))
        self.assertIn("container diagnostic", str(error.exception))
        self.assertNotIn("secret-for-test", str(error.exception))

    def test_real_framework_with_offline_draft_and_report(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
                os.environ, EVE_TRANSLATOR_JOBS=tmp, PYTHONUTF8="1"):
            def agent(prompt):
                material = json.loads(prompt.split("只输出 JSON。\n")[-1])
                if "report_format" in material:
                    self.assertIn("12:00 UTC", material["preview"])
                    return json.dumps(dict(material["report_format"], verdict="pass", findings=[],
                                           reviewer_context="offline-reviewer"))
                corrected = "validation" in material
                if corrected:
                    self.assertIn("check", material["validation"])
                    material = material["materials"]
                body = "飞行测试于12:00 UTC开始。" if corrected else "飞行测试开始。"
                return json.dumps([{"id": block["id"], "zh": zh} for block, zh in
                                   zip(material["blocks"], ["飞行测试", body], strict=True)])

            with patch.object(sync, "claude", side_effect=agent) as calls:
                result = sync.translate("# Flight test\n\nThe flight test starts at 12:00 UTC.\n", "offline")
                self.assertEqual(result, "# 飞行测试\n\n飞行测试于12:00 UTC开始。")
                self.assertEqual(calls.call_count, 3)

    def host_revision(self, action, second_round="pass"):
        """真实框架加假模型：第 1 轮退修，宿主修订按 action 处理，第 2 轮按 second_round 结论。"""
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
                os.environ, EVE_TRANSLATOR_JOBS=tmp, PYTHONUTF8="1"):
            seen = []

            def agent(prompt):
                material = json.loads(prompt.split("只输出 JSON。\n")[-1])
                if "review_packet" in material.get("materials", material):
                    seen.append("revise")
                    finding = material.get("materials", material)["report"]["findings"][0]["id"]
                    if action == "broken":  # 修订稿丢了时间，两次都过不了检查
                        return json.dumps({"draft": [{"id": "b002", "zh": "飞行测试于中午开始。"}],
                                           "responses": [{"finding": finding, "action": "fixed", "note": "已改"}]})
                    if action == "declined":
                        return json.dumps({"draft": [], "responses": [
                            {"finding": finding, "action": "declined", "note": "原译已表达开始时间，无需改"}]})
                    return json.dumps({"draft": [{"id": "b002", "zh": "飞行测试于12:00 UTC开始。"}],
                                       "responses": [{"finding": finding, "action": "fixed", "note": "已补"}]})
                if "report_format" in material.get("materials", material):
                    packet = material.get("materials", material)
                    if packet["round"] == 2:
                        seen.append("review-2")
                        findings = [] if second_round == "pass" else [
                            {"id": "R1", "block": "b002", "severity": "critical", "source_quote": "starts at 12:00 UTC",
                             "problem": "仍嫌生硬", "fix": "改为“于……开始”"}]
                        return json.dumps(dict(packet["report_format"], verdict=second_round, findings=findings,
                                               reviewer_context="offline-reviewer-2"))
                    seen.append("review-1")
                    if "validation" not in material:
                        return json.dumps(dict(packet["report_format"], verdict="revise", findings="b002"))
                    return json.dumps(dict(packet["report_format"], verdict="revise", reviewer_context="offline-reviewer",
                                           findings=[{"id": "F1", "block": "b002", "severity": "critical",
                                                      "source_quote": "starts at 12:00 UTC",
                                                      "problem": "措辞生硬", "fix": "改为“于……开始”"}]))
                seen.append("write")
                return json.dumps([{"id": block["id"], "zh": zh} for block, zh in
                                   zip(material["blocks"], ["飞行测试", "飞行测试在12:00 UTC开始。"], strict=True)])

            with patch.object(sync, "claude", side_effect=agent):
                result = sync.translate("# Flight test\n\nThe flight test starts at 12:00 UTC.\n", "offline")
            revisions = ["revise", "revise"] if action == "broken" else ["revise"]
            self.assertEqual(seen, ["write", "review-1", "review-1", *revisions, "review-2"])
            return result

    def test_real_framework_host_revision_and_second_review(self):
        self.assertEqual(self.host_revision("fixed"), "# 飞行测试\n\n飞行测试于12:00 UTC开始。")

    def test_real_framework_declined_finding_goes_to_second_review(self):
        self.assertEqual(self.host_revision("declined"), "# 飞行测试\n\n飞行测试在12:00 UTC开始。")

    def test_unregistrable_revision_keeps_submitted_draft(self):
        with redirect_stderr(StringIO()):
            self.assertEqual(self.host_revision("broken"), "# 飞行测试\n\n飞行测试在12:00 UTC开始。")

    def test_second_round_objection_still_publishes(self):
        self.assertEqual(self.host_revision("declined", second_round="revise"),
                         "# 飞行测试\n\n飞行测试在12:00 UTC开始。")

    def test_baseline_pending_and_rollover(self):
        state = sync.discover(None, ["old"], "v1", "one")
        self.assertEqual(state["pending"], [])
        state = sync.discover(state, ["b", "a"], "v1", "two")
        self.assertEqual(state["pending"], ["a", "b", "v1"])
        state = sync.discover(state, ["b", "old"], "v2", "two")
        self.assertEqual(state["pending"], ["a", "b", "v1", "v2"])

    def scan(self, updated="2026-11-20T11:00:10Z", lore=lambda column: lore_rss(*OLD_LORE)):
        """假订阅跑一轮扫描，返回 (写入的状态或 None, 错误输出)。lore 按栏目给出 RSS 或抛错。"""
        slug = "patch-notes-version-24-02"
        pages = {f"{sync.ccp.SITE}/rss": f"<rss><channel><item><link>{sync.ccp.page_url(slug)}</link></item></channel></rss>",
                 f"{sync.ccp.SITE}/news": f'<a href="/news/view/{slug}"><strong>Patch Notes</strong></a>'}
        state = sync.discover(None, [slug], slug, sync.digest("补丁正文"))
        state.update(patchPublishedAt="2026-11-20T11:00:10Z", lore={"since": LORE_SINCE, "seen": [], "pending": []})

        def fetch(url):
            if url in pages:
                return pages[url].encode()
            column = re.fullmatch(rf"{re.escape(sync.LORE_SITE)}/feed/([a-z-]+)\.rss", url)
            self.assertIsNotNone(column, url)
            return lore(column[1])

        errors = StringIO()
        with (patch.object(sync.ccp, "fetch", side_effect=fetch),
              patch.object(sync, "article", return_value={"markdown": "补丁正文", "updated": updated}),
              patch.object(sync, "read_state", return_value=state),
              patch.object(sync, "write_state") as write,
              patch.object(sync, "run") as run,
              redirect_stdout(StringIO()), redirect_stderr(errors)):
            sync.scan()
        run.assert_not_called()
        return (write.call_args.args[0] if write.called else None), errors.getvalue()

    def test_scan_only_writes_changed_state_and_never_commits(self):
        self.assertIsNone(self.scan()[0])
        self.assertEqual(self.scan(updated="2026-11-26T11:00:10Z")[0]["lore"]["pending"], [])
        fresh = lore_rss(("chronicles/fresh", "Wed, 11 Nov 2026 08:25:04 GMT"), *OLD_LORE)
        self.assertEqual(self.scan(lore=lambda column: fresh)[0]["lore"]["pending"], ["chronicles/fresh"])

    def test_scan_skips_unreadable_lore_column_without_blocking_news(self):
        def lore(column):
            if column == "lore":
                raise OSError("HTTP 503")
            if column in ("empires", "factions"):
                return b"<html>" if column == "empires" else lore_rss()
            return lore_rss((f"{column}/fresh", "Wed, 11 Nov 2026 08:25:04 GMT"))

        state, errors = self.scan(lore=lore)
        expected = [f"{column}/fresh" for column in sync.LORE_COLUMNS if column not in ("empires", "factions", "lore")]
        self.assertEqual(sorted(state["lore"]["pending"]), sorted(expected))
        for column in ("empires", "factions", "lore"):
            self.assertIn(f"正史 {column} 订阅本轮跳过", errors)

    def test_lore_feed_dates_and_discovery(self):
        items = sync.lore_feed(lore_rss(("chronicles/b", "Wed, 11 Nov 2026 08:25:04 GMT"),
                                        ("chronicles/a", "Thu, 01 Oct 2026 01:00:00 +0800"), *OLD_LORE))
        self.assertEqual(items, [("chronicles/b", "2026-11-11"), ("chronicles/a", "2026-09-30"), ("empires/old", "2021-11-13")])
        for xml in (lore_rss(), lore_rss(("chronicles/a", "不是日期")),
                    b"<rss><channel><item><link>https://example.org/chronicles/a</link>"
                    b"<pubDate>Wed, 11 Nov 2026 08:25:04 GMT</pubDate></item></channel></rss>"):
            with self.subTest(xml=xml), self.assertRaises(ValueError):
                sync.lore_feed(xml)
        self.assertEqual(sync.discover_lore(None, items, "2026-11-01"),
                         {"since": "2026-11-01", "seen": [], "pending": ["chronicles/b"]})
        lore = {"since": LORE_SINCE, "seen": ["chronicles/b"], "pending": ["lore/x"]}
        self.assertEqual(sync.discover_lore(lore, items, "2026-11-27")["pending"], ["lore/x", "chronicles/a"])
        self.assertEqual(lore["pending"], ["lore/x"])

    def test_lore_columns_match_node_tools(self):
        source = (sync.ROOT / "scripts/news-lore.mjs").read_text("utf-8")
        block = re.search(r"export const LORE_COLUMNS = \[(.*?)\];", source, re.S)
        self.assertEqual(tuple(re.findall(r"key: '([a-z-]+)'", block[1])), sync.LORE_COLUMNS)

    def publish_lore(self, keys, translator, published, existing=()):
        """假工作台与假翻译跑一轮只有正史待办的收录。
        published 给出各短名的原文发布日期，缺席即无日期设定页。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "lore").mkdir()
            for slug in existing:
                (root / "lore" / f"{slug}.md").write_text("人工页", "utf-8")
            calls = []

            def workbench(*args, accept=(0,)):
                calls.append(args[2])
                slug = args[1].rsplit("/", 1)[1]
                if args[2] == "--out":
                    self.assertEqual(accept, (0, 3))
                    if slug not in published:
                        return {"slug": slug, "status": "undated"}
                    Path(args[3]).write_text(f"# {slug}\n\nBody", "utf-8")
                    return {"slug": slug, "status": "draft", "meta": {"published": published[slug]}}
                (root / "lore" / f"{slug}.md").write_text(Path(args[3]).read_text("utf-8"), "utf-8")
                return {"slug": slug, "status": "written"}

            with (patch.object(sync, "NEWS", root), patch.object(sync, "STATE", root / "state.json"),
                  patch.dict(os.environ, EVE_TRANSLATOR_JOBS=str(root / "jobs")),
                  patch.object(sync, "workbench", side_effect=workbench),
                  patch.object(sync, "translate", side_effect=translator),
                  patch.object(sync.runtime, "cooling", return_value="2026-11-27T15:00:00Z"),
                  patch.object(sync, "save") as save, redirect_stdout(StringIO()), redirect_stderr(StringIO())):
                sync.write_state({"pending": [], "deploy": False,
                                  "lore": {"since": LORE_SINCE, "seen": ["chronicles/done"], "pending": keys}})
                unfinished = None
                try:
                    sync.publish()
                except SystemExit as error:
                    unfinished = str(error)
                paths, message = save.call_args.args
                return {"state": sync.read_state(), "saved": [path.name for path in paths], "message": message,
                        "calls": calls, "unfinished": unfinished, "pages": sorted(p.name for p in (root / "lore").iterdir())}

    def test_publish_lore_translates_only_articles_first_published_after_start(self):
        keys = ["chronicles/fresh", "chronicles/edited-old", "empires/undated", "lore/existing"]
        sources = []

        def translator(source, label):
            sources.append((source, label))
            return "# 新篇\n\n译文"

        run = self.publish_lore(keys, translator, {"fresh": LORE_SINCE, "edited-old": "2019-05-01"}, existing=["existing"])
        self.assertIsNone(run["unfinished"])
        self.assertEqual(sources, [("# fresh\n\nBody", "fresh")])
        self.assertEqual(run["state"]["lore"], {"since": LORE_SINCE, "seen": ["chronicles/done", *keys], "pending": []})
        self.assertTrue(run["state"]["deploy"])
        self.assertEqual((run["saved"], run["message"]), (["fresh.md"], "正史：收录 fresh"))
        self.assertEqual(run["calls"], ["--out", "--file", "--out", "--out"])
        self.assertEqual(run["pages"], ["existing.md", "fresh.md"])

    def test_publish_lore_failure_keeps_pending(self):
        dates = {"a": "2026-11-01", "b": "2026-11-02"}

        def flaky(source, label):
            if label == "a":
                raise ValueError("复核未通过")
            return "# 乙\n\n译文"

        run = self.publish_lore(["chronicles/a", "chronicles/b"], flaky, dates)
        self.assertEqual(run["unfinished"], "未完成：chronicles/a")
        self.assertEqual(run["state"]["lore"]["pending"], ["chronicles/a"])
        self.assertEqual(run["state"]["lore"]["seen"], ["chronicles/done", "chronicles/b"])
        self.assertEqual((run["saved"], run["message"], run["pages"]), (["b.md"], "正史：收录 b", ["b.md"]))

        def unavailable(source, label):
            raise sync.ClaudeUnavailable("额度用尽")

        run = self.publish_lore(["chronicles/a", "chronicles/b"], unavailable, dates)
        self.assertEqual(run["unfinished"], "未完成：chronicles/a、chronicles/b")
        self.assertEqual(run["state"]["lore"]["pending"], ["chronicles/a", "chronicles/b"])
        self.assertEqual(run["state"]["modelRetryAfter"], "2026-11-27T15:00:00Z")
        self.assertEqual((run["saved"], run["message"], run["pages"]), ([], "天书：等待订阅额度恢复", []))
        self.assertEqual(run["calls"], ["--out"])

    def test_news_quota_stop_skips_lore(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with (patch.object(sync, "NEWS", root), patch.object(sync, "STATE", root / "state.json"),
                  patch.object(sync, "prepare_page", side_effect=sync.ClaudeUnavailable("额度用尽")),
                  patch.object(sync.runtime, "cooling", return_value=None),
                  patch.object(sync, "publish_lore") as lore, patch.object(sync, "save"),
                  redirect_stderr(StringIO())):
                sync.write_state({"pending": ["a"], "sections": {}, "deploy": False,
                                  "lore": {"since": LORE_SINCE, "seen": [], "pending": ["chronicles/x"]}})
                with self.assertRaises(SystemExit):
                    sync.publish()
            lore.assert_not_called()

    def test_publish_requests_deploy_only_for_changed_page(self):
        slug = "patch-notes-version-24-02"
        for before, after in ((None, "新页面"), ("旧页面", "更新页面"), ("原页面", "原页面")):
            with self.subTest(before=before, after=after), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                page = root / f"{slug}.md"
                if before is not None:
                    page.write_text(before, "utf-8")
                state = sync.discover(None, [slug], slug, "source")
                state["pending"] = [slug]

                def run(args, **kwargs):
                    if args[2] == "add":
                        page.write_text(after, "utf-8")
                        recorded = sync.read_state()
                        recorded["pending"] = []
                        recorded["sections"][slug] = {}
                        sync.write_state(recorded)

                with (patch.object(sync, "NEWS", root), patch.object(sync, "FRAMEWORK", root),
                      patch.object(sync, "STATE", root / "state.json"),
                      patch.object(sync, "prepare_page", return_value=("# 标题", "site", {})),
                      patch.object(sync, "run", side_effect=run),
                      patch.object(sync, "save") as save):
                    sync.write_state(state)
                    sync.publish()
                    saved = sync.read_state()
                    self.assertEqual(saved["pending"], [])
                    self.assertEqual(saved["deploy"], before != after)
                    save.assert_called_once()
                    self.assertEqual(page in save.call_args.args[0], before != after)

    def test_save_makes_one_commit_and_requests_deploy_only_after_push(self):
        gh = ["gh", "workflow", "run", "deploy.yml", "--ref", "main"]
        for deploy, changed, dispatch_fails in ((False, 0, False), (False, 1, False), (True, 1, False), (True, 1, True)):
            with (self.subTest(deploy=deploy, changed=changed, dispatch_fails=dispatch_fails),
                  tempfile.TemporaryDirectory() as temp):
                state_file, page = Path(temp) / "state.json", Path(temp) / "page.md"
                calls = []

                def command(args, **kwargs):
                    calls.append(args)
                    if args == gh and dispatch_fails:
                        raise CalledProcessError(1, gh)

                with (patch.object(sync, "STATE", state_file), patch.object(sync, "run", side_effect=command),
                      patch.object(sync.subprocess, "run", return_value=sync.subprocess.CompletedProcess([], changed))):
                    sync.write_state({"deploy": deploy})
                    if dispatch_fails:
                        with self.assertRaises(CalledProcessError):
                            sync.save([page], "天书：收录 a")
                    else:
                        sync.save([page], "天书：收录 a")
                steps = [args[1] for args in calls]
                commits = [args for args in calls if args[1] == "commit"]
                saved = json.loads(state_file.read_text("utf-8"))
                if changed:
                    self.assertEqual(commits[0], ["git", "commit", "--only", "-m", "天书：收录 a", "--",
                                                  str(state_file), str(page)])
                if not deploy:
                    self.assertEqual(steps, ["add", "commit", "push"] if changed else ["add"])
                    self.assertFalse(saved["deploy"])
                elif not dispatch_fails:
                    self.assertEqual(steps, ["add", "commit", "push", "workflow"])
                    self.assertFalse(saved["deploy"])
                else:
                    # 请求失败才补一个待重试提交，Worker 下个整点再试。
                    self.assertEqual(steps, ["add", "commit", "push", "workflow", "add", "commit", "push"])
                    self.assertEqual(commits[1][4], "天书：站点部署待重试")
                    self.assertTrue(saved["deploy"])

    def test_finish_commits_scan_or_retries_deploy_without_publishing(self):
        for scanned, message in (("M state.json\n", "天书：更新订阅待办"), ("", "天书：已请求站点部署")):
            with self.subTest(scanned=bool(scanned)), patch.object(sync, "save") as save, \
                    patch.object(sync, "run") as run:
                run.return_value.stdout = scanned
                sync.finish()
            save.assert_called_once_with([], message)

    def test_source_links(self):
        rss = "<rss><channel><item><link>{}</link></item></channel></rss>"
        self.assertEqual(sync.feed_slugs(rss.format(sync.ccp.page_url("new"))), ["new"])
        with self.assertRaises(ValueError):
            sync.feed_slugs(rss.format("https://example.org/news/view/new"))
        with self.assertRaises(ValueError):
            sync.current_patch("<a>Patch Notes</a>")

    def test_stale_official_section_falls_back_to_translation(self):
        first = "# Version\n\nIntro\n\n## Patch Notes for 2026-11-20.1\n\nOne"
        zh = {"intro": "# 版本\n\n前言", "2026-11-20.1": "原官译"}
        slug = "patch-notes-version-24-02"
        with patch.object(sync, "proofread", side_effect=lambda text, source: text):
            text, origin, hashes = sync.patch_translation(slug, first, {}, None, zh)
            self.assertEqual(origin, "official")
            page = "---\ntitle: 标题\n---\n" + text.split("\n", 1)[1]
            changed = first.replace("One", "Two")
            translated, origin, _ = sync.patch_translation(
                slug, changed, hashes, page, zh, translator=lambda *args: "# 标题\n\n新译文")
            self.assertEqual(origin, "site")
            self.assertIn("新译文", translated)
            self.assertNotIn("原官译", translated)

    def test_patch_incremental_and_editorial_changes(self):
        first = "# Version\n\nIntro\n\n## **Patch Notes for 2026-11-20.1**\n\nOne"
        second = first + "\n\n## Patch Notes for 2026-11-20.2\n\nTwo"
        slug = "patch-notes-version-24-02"
        calls = []

        def translate(source, label):
            calls.append(label)
            return "# 测试\n\n段落 " + source.splitlines()[-1]

        text, origin, hashes = sync.patch_translation(slug, first, {}, None, translator=translate)
        self.assertEqual(origin, "site")
        body = text.split("\n", 1)[1].replace("段落 One", "人工校订")
        page = "---\ntitle: 标题\n---\n" + body
        calls.clear()
        text, _, _ = sync.patch_translation(slug, second, hashes, page, translator=translate)
        self.assertEqual(calls, [slug + "-2026-11-20.2"])
        self.assertIn("人工校订", text)
        calls.clear()
        sync.patch_translation(slug, first.replace("One", "Corrected"), hashes, page, translator=translate)
        self.assertEqual(calls, [slug + "-2026-11-20.1"])

    def test_existing_patch_requires_baseline_before_any_translation(self):
        slug = "patch-notes-version-24-02"
        source = "# Version\n\nIntro\n\n## Patch Notes for 2026-11-24.1\nNew\n\n## Patch Notes for 2026-11-18.1\nOld"
        page = "---\ntitle: 标题\n---\n前言\n\n## **2026-11-18.1补丁说明**\n已发译文"
        for previous in ({}, {"intro": {"source": sync.digest("old intro")}}):
            with self.subTest(previous=previous), patch.object(sync, "proofread") as proofread:
                with self.assertRaisesRegex(ValueError, "已发布段落缺少原文指纹：.*2026-11-18.1"):
                    sync.patch_translation(slug, source, previous, page, translator=self.fail)
                proofread.assert_not_called()

    def test_patch_demotes_inner_h2(self):
        source = "# Version\n\nIntro\n\n## **Patch Notes for 2026-11-20.1**\n\n## Defect Fixes:\n\n### Graphics:\n\n- Fixed"
        rendered, _, _ = sync.patch_translation(
            "patch-notes-version-24-02", source, {}, None,
            translator=lambda text, label: "# 标题\n\n" + ("前言" if label.endswith("intro") else "## 缺陷修复：\n\n### 画面：\n\n- 已修复"),
        )
        self.assertIn("## **2026-11-20.1补丁说明**", rendered)
        self.assertIn("### 缺陷修复：", rendered)
        self.assertIn("#### 画面：", rendered)
        self.assertNotIn("\n## 缺陷修复：", rendered)

    def test_review_gate(self):
        # 本项只验证 render 的交付门槛；兼容核验由恢复测试中的真实任务覆盖。
        from eve_translator.jobs import prepare
        with tempfile.TemporaryDirectory() as temp:
            draft = Path(temp) / "translation.md"
            draft.write_text("# 飞行\n\n译文", "utf-8")
            job, _ = prepare(Path(temp), markdown="# Flight\n\nText", origin={"label": "gate"})
            job.save_state(dict(job.state, phase="passed"))
            for labels in (["已复核"], ["复核后修订"], ["待复核"], ["已复核", "部分译文"]):
                def command(name, *args, **kwargs):
                    return {"prepare": {"job": job.id}, "check": {}, "review": {},
                            "status": {"phase": "passed"}, "render": {
                                "file": str(draft), "delivery": {"labels": labels, "skipped_checks": []}
                            }}[name]
                with self.subTest(labels=labels), patch.dict(os.environ, EVE_TRANSLATOR_JOBS=temp), \
                        patch.object(sync, "framework", command), \
                        patch.object(sync, "revalidate_completed", return_value=True), \
                        patch.object(sync, "claude") as agent:
                    if labels in (["已复核"], ["复核后修订"]):
                        self.assertIn("译文", sync.translate("source", "test"))
                    else:
                        with self.assertRaises(ValueError):
                            sync.translate("source", "test")
                    self.assertEqual(agent.call_count, 0)

    def test_failure_detail(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp) / "jobs" / "sample"
            job.mkdir(parents=True)
            (job / "report.json").write_text(json.dumps({"findings": [
                {"severity": "critical", "block": "b004", "problem": "漏译", "fix": "补译"}]}), "utf-8")
            with patch.object(sync, "FRAMEWORK", Path(temp)):
                detail = sync.failure_detail("sample", {"reasons": ["修订处理尚未登记"]}, "  已结束\n")
        self.assertIn("修订处理尚未登记", detail)
        self.assertIn("report.json critical b004：漏译 → 补译", detail)
        self.assertIn("修订输出：已结束", detail)


if __name__ == "__main__":
    unittest.main()
