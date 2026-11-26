"""订阅队列、滚动补丁和通过复核的交付边界。"""

import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from subprocess import CalledProcessError
from unittest.mock import patch

import sync


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

    def test_scan_only_writes_changed_state_and_never_commits(self):
        slug = "patch-notes-version-24-02"
        feed = f"<rss><channel><item><link>{sync.ccp.page_url(slug)}</link></item></channel></rss>"
        news = f'<a href="/news/view/{slug}"><strong>Patch Notes</strong></a>'
        state = sync.discover(None, [slug], slug, sync.digest("补丁正文"))
        state["patchPublishedAt"] = "2026-11-20T11:00:10Z"
        for updated, written in ((state["patchPublishedAt"], False), ("2026-11-26T11:00:10Z", True)):
            with (self.subTest(written=written),
                  patch.object(sync.ccp, "fetch", side_effect=[feed.encode(), news.encode()]),
                  patch.object(sync, "article", return_value={"markdown": "补丁正文", "updated": updated}),
                  patch.object(sync, "read_state", return_value=state),
                  patch.object(sync, "write_state") as write,
                  patch.object(sync, "run") as run,
                  redirect_stdout(StringIO())):
                sync.scan()
            self.assertEqual(write.called, written)
            run.assert_not_called()

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
