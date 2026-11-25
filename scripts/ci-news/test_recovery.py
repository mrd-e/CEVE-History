"""以真实框架和假模型验证断点恢复、额度故障及状态登记；不联网。"""

import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import publication
import runtime
import sync

SOURCE = "# Flight test\n\nThe flight test starts at 12:00 UTC.\n"
PATCH_SOURCE = "# Version\n\nIntro\n\n## Patch Notes for 2026-11-25.1\n\nFixed"
PATCH_BODY = "前言\n\n## **2026-11-25.1补丁说明**\n\n已修复"
SLUG = "patch-notes-version-24-02"


def material(prompt):
    return json.loads(prompt.split("只输出 JSON。\n")[-1])


def passing_agent(prompt):
    data = material(prompt)
    if "report_format" in data:
        return json.dumps(dict(data["report_format"], verdict="pass", findings=[], reviewer_context="independent"))
    return json.dumps([{"id": "b001", "zh": "飞行测试"}, {"id": "b002", "zh": "飞行测试于12:00 UTC开始。"}])


class RecoveryTests(unittest.TestCase):
    def test_patch_prefix_survives_a_later_section_failure(self):
        source = PATCH_SOURCE + "\n\n## Patch Notes for 2026-11-24.1\n\nFixed"
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, EVE_TRANSLATOR_JOBS=tmp, PYTHONUTF8="1"):
            def agent(prompt):
                data = material(prompt)
                if "report_format" in data:
                    if "2026-11-24" in data["job"]:
                        raise sync.ClaudeUnavailable("后节额度不足")
                    return passing_agent(prompt)
                return json.dumps([{"id": b["id"], "zh": {"Version": "版本", "Intro": "前言", "Fixed": "已修复"}.get(
                    b["source"], b["source"].replace("Patch Notes for", "补丁说明"))} for b in data["blocks"]])
            with patch.object(sync, "claude", side_effect=agent):
                with self.assertRaises(sync.ClaudeUnavailable):
                    sync.patch_translation(SLUG, source, {}, None)
            with patch.object(sync, "claude", side_effect=passing_agent) as calls:
                text, _, _ = sync.patch_translation(SLUG, source, {}, None)
                self.assertIn("2026-11-24.1补丁说明", text)
                self.assertEqual(calls.call_count, 1)

    def test_resume_after_review_interruption_and_reuse_completed_render(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, EVE_TRANSLATOR_JOBS=tmp, PYTHONUTF8="1"):
            def interrupted(prompt):
                if "report_format" in material(prompt):
                    raise sync.ClaudeUnavailable("服务不可用")
                return passing_agent(prompt)
            with patch.object(sync, "claude", side_effect=interrupted) as first:
                with self.assertRaises(sync.ClaudeUnavailable):
                    sync.translate(SOURCE, "resume")
                self.assertEqual(first.call_count, 2)
            with patch.object(sync, "claude", side_effect=passing_agent) as second:
                rendered = sync.translate(SOURCE, "resume")
                self.assertEqual(second.call_count, 1)
                self.assertIn("12:00 UTC", rendered)
            with patch.object(sync, "claude", side_effect=AssertionError("不应重写或重审")):
                self.assertEqual(sync.translate(SOURCE, "resume"), rendered)
            self.assertEqual(len(list(Path(tmp).glob("*/manifest.json"))), 1)

    def test_completed_draft_is_revalidated_after_pack_and_host_changes(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, EVE_TRANSLATOR_JOBS=tmp, PYTHONUTF8="1"):
            with patch.object(sync, "claude", side_effect=passing_agent):
                expected = sync.translate(SOURCE, "upgrade")
            manifest_file = next(Path(tmp).glob("*/manifest.json"))
            manifest = json.loads(manifest_file.read_text("utf-8"))
            manifest["data_pack"] = "old-pack"
            runtime.atomic_json(manifest_file, manifest)
            host_file = manifest_file.with_name("host.json")
            host = json.loads(host_file.read_text("utf-8"))
            host["signature"] = "old-host"
            runtime.atomic_json(host_file, host)
            with patch.object(sync, "claude", side_effect=AssertionError("已验证的成稿不应重译")):
                self.assertEqual(sync.translate(SOURCE, "upgrade"), expected)
            self.assertTrue(manifest_file.with_name("compatibility-check.json").exists())
            self.assertEqual(json.loads(manifest_file.read_text("utf-8"))["data_pack"], "old-pack")
            self.assertEqual(len(list(Path(tmp).glob("*/manifest.json"))), 1)

    def test_resume_revising_and_keep_second_round_objections(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, EVE_TRANSLATOR_JOBS=tmp, PYTHONUTF8="1"):
            def first_agent(prompt):
                data = material(prompt)
                if "review_packet" in data:
                    raise sync.ClaudeUnavailable("中断修订")
                if "report_format" in data:
                    return json.dumps(dict(data["report_format"], verdict="revise", reviewer_context="reviewer1",
                                           findings=[{"id": "F1", "block": "b002", "severity": "critical",
                                                      "source_quote": "starts at 12:00 UTC", "problem": "措辞", "fix": "改措辞"}]))
                return passing_agent(prompt)
            with patch.object(sync, "claude", side_effect=first_agent):
                with self.assertRaises(sync.ClaudeUnavailable):
                    sync.translate(SOURCE, "revision")
            def second_agent(prompt):
                data = material(prompt)
                if "review_packet" in data:
                    return json.dumps({"draft": [], "responses": [{"finding": "F1", "action": "declined", "note": "事实已经准确"}]})
                self.assertEqual(data["round"], 2)
                return json.dumps(dict(data["report_format"], verdict="revise", reviewer_context="reviewer2",
                                       findings=[{"id": "F2", "block": "b002", "severity": "critical",
                                                  "source_quote": "starts at 12:00 UTC", "problem": "保留意见", "fix": "调整措辞"}]))
            with patch.object(sync, "claude", side_effect=second_agent) as calls:
                self.assertIn("12:00 UTC", sync.translate(SOURCE, "revision"))
                self.assertEqual(calls.call_count, 2)
            report = json.loads(next(Path(tmp).glob("*/publication-report.json")).read_text("utf-8"))
            self.assertEqual(report["delivery"]["disputed_blocks"], ["b002"])
            self.assertTrue(report["delivery"]["reasons"])

    def test_legacy_revised_job_resumes_pending_second_review(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, EVE_TRANSLATOR_JOBS=tmp, PYTHONUTF8="1"):
            execute = sync.framework
            def before_second_packet(command, *args, **kwargs):
                if command == "review" and "--writer-context" in args:
                    state = json.loads((Path(tmp) / args[0] / "state.json").read_text("utf-8"))
                    if state["phase"] == "revised":
                        raise sync.ClaudeUnavailable("第二轮送审前中断")
                return execute(command, *args, **kwargs)
            def interrupted_agent(prompt):
                data = material(prompt)
                if "review_packet" in data:
                    return json.dumps({"draft": [], "responses": [
                        {"finding": "F1", "action": "declined", "note": "事实已准确，保留原稿"}]})
                if "report_format" in data:
                    if data["round"] == 2:
                        raise sync.ClaudeUnavailable("第二轮复核中断")
                    return json.dumps(dict(data["report_format"], verdict="revise", reviewer_context="reviewer1",
                                           findings=[{"id": "F1", "block": "b002", "severity": "critical",
                                                      "source_quote": "starts at 12:00 UTC", "problem": "措辞", "fix": "改措辞"}]))
                return passing_agent(prompt)
            with patch.object(sync, "claude", side_effect=interrupted_agent), \
                    patch.object(sync, "framework", side_effect=before_second_packet):
                with self.assertRaises(sync.ClaudeUnavailable):
                    sync.translate(SOURCE, "legacy")
            host_file = next(Path(tmp).glob("*/host.json"))
            self.assertEqual(json.loads(host_file.with_name("state.json").read_text("utf-8"))["phase"], "revised")
            host_file.unlink()
            with patch.object(sync, "claude", side_effect=passing_agent) as calls:
                self.assertIn("12:00 UTC", sync.translate(SOURCE, "legacy"))
                self.assertEqual(calls.call_count, 1)
            self.assertEqual(len(list(Path(tmp).glob("*/manifest.json"))), 1)

    def test_quota_is_not_a_json_retry_and_is_persisted(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, EVE_TRANSLATOR_JOBS=tmp):
            response = subprocess.CompletedProcess([], 1, "You've hit your 5-hour limit · resets 2pm (UTC)", "")
            with patch.object(sync.subprocess, "run", return_value=response) as calls:
                with self.assertRaises(sync.ClaudeUnavailable):
                    sync.claude_output(["fake"], "test")
                with self.assertRaises(sync.ClaudeUnavailable):
                    sync.claude_output(["fake"], "test")
                self.assertEqual(calls.call_count, 1)
            self.assertTrue(runtime.cooling(Path(tmp)))
            with patch.object(sync, "model_json", side_effect=sync.ClaudeUnavailable("quota")) as calls:
                with self.assertRaises(sync.ClaudeUnavailable):
                    sync.host_step("translate-article", "写稿", {}, lambda _: None)
                self.assertEqual(calls.call_count, 1)

    def test_quota_reset_utc_and_structured_usage(self):
        clock = datetime(2026, 11, 25, 11, 25, tzinfo=timezone.utc)
        self.assertEqual(runtime.retry_time("resets 2pm (UTC)", clock).hour, 14)
        self.assertEqual(runtime.retry_time("resets 10:30am (UTC)", clock).day, 26)
        with tempfile.TemporaryDirectory() as tmp:
            result = runtime.record_call(Path(tmp), "prompt", json.dumps({"result": "answer", "is_error": False,
                                         "usage": {"input_tokens": 12}, "total_cost_usd": 0.1}), "secret-for-test", 0, 2, "secret-for-test")
            self.assertEqual(result, (0, "answer", "***"))
            record = json.loads(next(Path(tmp).glob("calls/*.json")).read_text("utf-8"))
            self.assertEqual(record["usage"]["usage"]["input_tokens"], 12)

    def test_semantic_decision_is_registered_before_save_and_check(self):
        with patch.object(sync, "framework") as framework, patch.object(sync, "model_json", return_value={
                "draft": [{"id": "b001", "zh": "暗影"}], "decisions": [
                    {"source": "Shadow", "zh": "暗影", "basis": "这里是普通阴影，非该舰船实体"}]}):
            sync.save_text_draft("job", "writer", {})
            self.assertEqual([call.args[0] for call in framework.call_args_list], ["decide", "save", "check"])

    def test_real_framework_accepts_non_entity_semantic_decision(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, EVE_TRANSLATOR_JOBS=tmp, PYTHONUTF8="1"):
            def agent(prompt):
                data = material(prompt)
                if "report_format" in data:
                    self.assertTrue(data["decisions"])
                    return passing_agent(prompt)
                return json.dumps({"draft": [{"id": "b001", "zh": "阴影"}, {"id": "b002", "zh": "修复了阴影。"}],
                                   "decisions": [{"source": "Shadow", "zh": "阴影", "basis": "此处是图形阴影，非该 SDE 舰船实体"}]})
            with patch.object(sync, "claude", side_effect=agent):
                self.assertIn("修复了阴影", sync.translate("# Shadow\n\nFixed a shadow.\n", "meaning"))

    def test_official_proofread_rejects_date_drift_retries_and_caches(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, EVE_TRANSLATOR_JOBS=tmp):
            answers = [[{"before": "11月25日", "after": "11月26日"}], []]
            with patch.object(sync, "model_json", side_effect=answers) as calls:
                self.assertEqual(sync.proofread("11月25日开始", "Starts November 25"), "11月25日开始")
                self.assertEqual(calls.call_count, 2)
            with patch.object(sync, "model_json", side_effect=AssertionError("不应再校订")):
                self.assertEqual(sync.proofread("11月25日开始", "Starts November 25"), "11月25日开始")

    def test_publish_rolls_back_page_and_state_when_validation_fails(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, EVE_TRANSLATOR_JOBS=str(Path(tmp) / "jobs")):
            root = Path(tmp)
            page = root / f"{SLUG}.md"
            page.write_text("原稿", "utf-8")
            state_file = root / "state.json"
            state_file.write_text(json.dumps({"pending": [SLUG], "sections": {}, "deploy": False}), "utf-8")
            original = state_file.read_bytes()
            def command(args, **kwargs):
                if args[2] == "add":
                    page.write_text("失败候选稿", "utf-8")
                    state_file.write_text(json.dumps({"pending": [], "sections": {SLUG: {}}, "deploy": True}), "utf-8")
                else:
                    raise subprocess.CalledProcessError(1, args)
            with patch.object(sync, "NEWS", root), patch.object(sync, "STATE", state_file), \
                    patch.object(sync, "prepare_page", return_value=("# 稿件", "site", {})), \
                    patch.object(sync, "run", side_effect=command), patch.object(sync, "git_save") as save:
                with self.assertRaises(SystemExit):
                    sync.publish()
                save.assert_not_called()
            self.assertEqual(page.read_text("utf-8"), "原稿")
            self.assertEqual(state_file.read_bytes(), original)

    def test_failure_during_translation_does_not_undo_parallel_state_or_page_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_file = root / "state.json"
            page = root / f"{SLUG}.md"
            page.write_text("原稿", "utf-8")
            def prepare(*args):
                state_file.write_text(json.dumps({"pending": [SLUG], "sections": {}, "parallel": 1}), "utf-8")
                page.write_text("并行人工修改", "utf-8")
                raise ValueError("翻译失败")
            with patch.object(sync, "STATE", state_file), patch.object(sync, "NEWS", root), \
                    patch.object(sync, "prepare_page", side_effect=prepare), patch.object(sync, "git_save"):
                sync.write_state({"pending": [SLUG], "sections": {}})
                with self.assertRaises(SystemExit):
                    sync.publish()
                self.assertEqual(sync.read_state()["parallel"], 1)
                self.assertEqual(page.read_text("utf-8"), "并行人工修改")

    def test_push_retry_and_commit_are_limited_to_requested_paths(self):
        for changed in (0, 1):
            with self.subTest(changed=changed), patch.object(sync, "run") as run, \
                    patch.object(sync.subprocess, "run", return_value=subprocess.CompletedProcess([], changed)):
                sync.git_save(["state.json"], "测试")
                self.assertEqual(run.call_args.args[0], ["git", "push", "origin", "HEAD:main"])
                commits = [c.args[0] for c in run.call_args_list if c.args[0][1] == "commit"]
                self.assertEqual(len(commits), changed)
                if commits:
                    self.assertEqual(commits[0], ["git", "commit", "--only", "-m", "测试", "--", "state.json"])

    def test_global_quota_stops_remaining_articles_and_saves_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / "state.json"
            with patch.object(sync, "STATE", state_file), patch.object(sync, "NEWS", Path(tmp)), \
                    patch.object(sync, "prepare_page", side_effect=sync.ClaudeUnavailable("quota")) as prepare, \
                    patch.object(runtime, "cooling", return_value="2099-01-01T00:00:00Z"), patch.object(sync, "git_save"):
                sync.write_state({"pending": ["one", "two"], "sections": {}, "deploy": False})
                with self.assertRaises(SystemExit):
                    sync.publish()
                self.assertEqual(prepare.call_count, 1)
                self.assertEqual(sync.read_state()["pending"], ["one", "two"])
                self.assertIn("modelRetryAfter", sync.read_state())


class PublicationTests(unittest.TestCase):
    def state(self):
        return {"baseline": [], "pending": [SLUG, "other"], "sections": {}, "deploy": False, "parallel": "preserved"}

    def test_snapshot_required_and_dates_must_match(self):
        for source in (None, PATCH_SOURCE.replace("2026-11-25.1", "2026-11-24.1")):
            with self.assertRaises(ValueError):
                publication.record(self.state(), SLUG, PATCH_BODY, True, source)

    def test_manual_completion_preserves_unrelated_work_and_registers_actual_source(self):
        state = self.state()
        result = publication.record(state, SLUG, PATCH_BODY, True, PATCH_SOURCE)
        self.assertEqual(result["pending"], ["other"])
        self.assertEqual(result["parallel"], "preserved")
        self.assertEqual(result["sections"][SLUG]["2026-11-25.1"]["source"], publication.digest("Fixed"))
        self.assertTrue(result["deploy"])
        self.assertEqual(state["pending"], [SLUG, "other"])

    def test_auto_fingerprints_cannot_claim_a_different_source(self):
        with self.assertRaisesRegex(ValueError, "实际英文快照"):
            publication.record(self.state(), SLUG, PATCH_BODY, True, PATCH_SOURCE,
                               {"intro": {"source": "wrong"}})


def archive(files):
    data = BytesIO()
    with zipfile.ZipFile(data, "w") as output:
        for name, value in files.items():
            output.writestr(name, value)
    return data.getvalue()


class ArtifactTests(unittest.TestCase):
    def test_legacy_artifacts_keep_the_most_advanced_whole_job(self):
        newest = archive({"job/state.json": '{"phase":"in_review"}', "job/draft.jsonl": "new", "job/report.json": "new"})
        older = archive({"job/state.json": '{"phase":"passed"}', "job/draft.jsonl": "finished", "job/report.json": "finished"})
        outputs = [json.dumps({"workflow_runs": [{"id": 2}, {"id": 1}]}).encode()]
        for ident, data in ((2, newest), (1, older)):
            outputs.extend([json.dumps({"artifacts": [{"id": ident, "name": f"translator-jobs-{ident}", "expired": False}]}).encode(), data])
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 0, out) for out in outputs]):
            runtime.restore(Path(tmp), "owner/repo")
            self.assertEqual((Path(tmp) / "job/report.json").read_text(), "finished")
            self.assertEqual((Path(tmp) / "job/draft.jsonl").read_text(), "finished")

    def test_unsafe_zip_is_rejected_before_any_write(self):
        outputs = [b'{"workflow_runs":[{"id":1}]}',
                   b'{"artifacts":[{"id":1,"name":"translator-jobs-1","expired":false}]}',
                   archive({"safe.txt": "safe", "../escape.txt": "unsafe"})]
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 0, out) for out in outputs]):
            with self.assertRaises(ValueError):
                runtime.restore(Path(tmp), "owner/repo")
            self.assertEqual(list(Path(tmp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
