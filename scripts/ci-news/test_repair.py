"""失败计次、维修代理、搁置与重新排队，以及代理容器的命令隔离自检；不联网，不调用模型。"""

import json
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import sync

os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)  # 失败路径会请维修代理；离线测试不许真的调用模型


class FailureBudgetTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        temp = Path(stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.root = temp
        self.ci = temp / "scripts/ci-news"
        self.ci.mkdir(parents=True)
        (self.ci / "sync.py").write_text("旧脚本", "utf-8")
        self.environment = "F0"
        self.summary = temp / "summary.md"
        for name, value in {"ROOT": temp, "CI": self.ci, "STATE": temp / "state.json"}.items():
            stack.enter_context(patch.object(sync, name, value))
        stack.enter_context(patch.object(sync.runtime, "environment", side_effect=lambda framework: self.environment))
        stack.enter_context(patch.object(sync.repair, "used", False, create=True))
        stack.enter_context(patch.dict(os.environ, EVE_TRANSLATOR_JOBS=str(temp / "jobs"),
                                       GITHUB_STEP_SUMMARY=str(self.summary)))
        os.environ.pop("NEWS_REQUEUE_PARKED", None)  # patch.dict 退出时还原
        stack.enter_context(redirect_stderr(StringIO()))
        stack.enter_context(redirect_stdout(StringIO()))
        sync.write_state({"pending": ["a", "b"], "feed": [], "sections": {}, "deploy": False,
                          "lore": {"since": "2026-09-23", "seen": [], "pending": ["chronicles/x"]}})

    def fail(self, key="a", error=None, queue="news"):
        paths = []
        parked = sync.record_failure(queue, key, error or ValueError("复核未通过"), paths)
        return parked, paths, sync.read_state()

    def test_without_repair_three_failures_park_and_only_outside_changes_requeue(self):
        self.assertFalse(self.fail()[0])
        self.assertFalse(self.fail()[0])
        parked, _, state = self.fail()
        self.assertTrue(parked)
        self.assertEqual(state["pending"], ["b"])
        self.assertEqual(state["failures"]["a"]["attempts"], 3)
        self.assertIn("已搁置", self.summary.read_text("utf-8"))

        sync.requeue(state)
        self.assertEqual(state["pending"], ["b"])
        state["repairedEnvironment"] = self.environment = "F1"  # 维修代理自己改出的环境不算有人修过
        sync.requeue(state)
        self.assertEqual(state["pending"], ["b"])
        self.environment = "F2"
        sync.requeue(state)
        self.assertEqual(state["pending"], ["b", "a"])
        self.assertEqual({k: state["failures"]["a"][k] for k in ("attempts", "repairs", "parked")},
                         {"attempts": 0, "repairs": 0, "parked": False})

    def test_parked_lore_leaves_discovery_until_environment_changes(self):
        for _ in range(sync.MAX_ATTEMPTS):
            parked, _, state = self.fail("chronicles/x", queue="lore")
        self.assertTrue(parked)
        self.assertEqual((state["lore"]["pending"], state["lore"]["seen"]), ([], ["chronicles/x"]))
        self.assertEqual(sync.discover_lore(state["lore"], [("chronicles/x", "2026-11-27")], "2026-11-27")["pending"], [])
        self.environment = "F1"
        sync.requeue(state)
        self.assertEqual((state["lore"]["pending"], state["lore"]["seen"]), (["chronicles/x"], []))

    def test_manual_requeue_unparks_everything_without_environment_change(self):
        for _ in range(sync.MAX_ATTEMPTS):
            self.fail()
            self.fail("chronicles/x", queue="lore")
        state = sync.read_state()
        with patch.dict(os.environ, NEWS_REQUEUE_PARKED="false"):
            sync.requeue(state)
        self.assertEqual((state["pending"], state["lore"]["pending"]), (["b"], []))
        with patch.dict(os.environ, NEWS_REQUEUE_PARKED="true"):
            sync.requeue(state)
        self.assertEqual((state["pending"], state["lore"]["pending"]), (["b", "a"], ["chronicles/x"]))
        self.assertFalse(any(entry["parked"] for entry in state["failures"].values()))

    def test_patch_relisted_by_discover_is_unparked_and_stale_records_dropped(self):
        for _ in range(sync.MAX_ATTEMPTS):
            self.fail()
        self.fail("b")
        state = sync.read_state()
        state["pending"] = ["a"]  # 原文更新后 discover 列回待办；b 已经由别处处理掉
        sync.requeue(state)
        self.assertEqual(list(state["failures"]), ["a"])
        self.assertFalse(state["failures"]["a"]["parked"])
        state["pending"] = []
        sync.requeue(state)
        self.assertNotIn("failures", state)

    def test_success_clears_the_record(self):
        self.fail()
        state = sync.read_state()
        sync.clear_failure(state, "a")
        self.assertNotIn("failures", state)

    def agent(self, verdict, edit=None):
        def answer(prompt, **options):
            self.assertTrue(options.get("workspace"))
            self.assertIn(str(self.ci), prompt)
            self.assertEqual(json.loads(prompt.rsplit("\n", 1)[-1])["item"], "a")
            if edit:
                edit()
            return json.dumps(verdict, ensure_ascii=False)
        return patch.object(sync, "claude", side_effect=answer)

    def edit_scripts(self):
        (self.ci / "sync.py").write_text("新脚本", "utf-8")
        (self.ci / "test_new.py").write_text("新测试", "utf-8")

    def test_tested_script_fix_is_kept_for_the_run_commit(self):
        with patch.dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN="t"), \
                self.agent({"verdict": "fixed", "cause": "缺 socat", "advice": "镜像补装 socat"}, self.edit_scripts), \
                patch.object(sync, "offline_tests", return_value=None):
            parked, paths, state = self.fail()
        self.assertFalse(parked)
        self.assertEqual(sorted(p.name for p in paths), ["sync.py", "test_new.py"])
        self.assertEqual((self.ci / "sync.py").read_text("utf-8"), "新脚本")
        failure = state["failures"]["a"]
        self.assertEqual((failure["repairs"], failure["cause"], failure["fixed"]),
                         (1, "缺 socat", ["scripts/ci-news/sync.py", "scripts/ci-news/test_new.py"]))
        self.assertEqual(state["repairedEnvironment"], "F0")
        self.assertIn("已自动修复", self.summary.read_text("utf-8"))

    def test_untested_or_unclaimed_fixes_are_reverted(self):
        cases = (({"verdict": "fixed"}, "离线测试未通过（退出码 1）：FAILED", "离线测试未通过"),
                 ({"verdict": "retry"}, None, "结论是 retry 却改了文件"))
        for verdict, tests, reason in cases:
            with self.subTest(verdict=verdict), patch.object(sync.repair, "used", False), \
                    patch.dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN="t"), self.agent(verdict, self.edit_scripts), \
                    patch.object(sync, "offline_tests", return_value=tests) as offline:
                parked, paths, state = self.fail()
                self.assertEqual(paths, [])
                self.assertEqual((self.ci / "sync.py").read_text("utf-8"), "旧脚本")
                self.assertFalse((self.ci / "test_new.py").exists())
                self.assertIn(reason, state["failures"]["a"]["rejected"])
                self.assertNotIn("repairedEnvironment", state)
                self.assertEqual(offline.called, verdict["verdict"] == "fixed")

    def test_agent_failure_is_reverted_and_does_not_hide_the_original_error(self):
        def crash(prompt, **options):
            self.edit_scripts()
            raise sync.ClaudeUnavailable("Reached max turns")
        with patch.dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN="t"), patch.object(sync, "claude", side_effect=crash):
            parked, paths, state = self.fail()
        self.assertEqual((parked, paths), (False, []))
        self.assertEqual((self.ci / "sync.py").read_text("utf-8"), "旧脚本")
        failure = state["failures"]["a"]
        self.assertEqual(failure["error"], "复核未通过")
        self.assertIn("维修代理未完成", failure["rejected"])

    def test_symlinks_are_removed_and_reject_the_fix(self):
        def link():
            (self.ci / "sync.py").write_text("新脚本", "utf-8")
            try:
                (self.ci / "secret").symlink_to(self.root / "state.json")
            except OSError:
                self.skipTest("当前系统不许建符号链接")
        with patch.dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN="t"), self.agent({"verdict": "fixed"}, link), \
                patch.object(sync, "offline_tests", return_value=None):
            _, paths, state = self.fail()
        self.assertEqual(paths, [])
        self.assertFalse((self.ci / "secret").exists() or (self.ci / "secret").is_symlink())
        self.assertIn("符号链接", state["failures"]["a"]["rejected"])

    def test_park_verdict_parks_at_once(self):
        with patch.dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN="t"), \
                self.agent({"verdict": "park", "cause": "令牌过期", "advice": "更新仓库密钥"}):
            parked, _, state = self.fail()
        self.assertTrue(parked)
        self.assertEqual(state["pending"], ["b"])
        self.assertEqual(state["failures"]["a"]["advice"], "更新仓库密钥")

    def test_repair_budget_one_per_run_two_per_item_none_for_model_outage(self):
        with patch.dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN="t"), self.agent({"verdict": "retry"}) as agent:
            self.fail()
            self.fail("b")  # 同一轮第二篇不再修
            self.assertEqual(agent.call_count, 1)
            sync.repair.used = False
            self.fail()
            sync.repair.used = False
            self.fail()  # a 已修过两次
            self.assertEqual(agent.call_count, 2)
            sync.repair.used = False
            self.fail("b", sync.ClaudeUnavailable("Claude 调用失败（退出码 1）：overloaded"))
            self.assertEqual(agent.call_count, 2)
        state = sync.read_state()
        self.assertTrue(state["failures"]["a"]["parked"])
        self.assertEqual(state["failures"]["b"]["attempts"], 2)

    def test_fixed_item_gets_one_more_try_past_the_cap(self):
        with patch.dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN="t"), self.agent({"verdict": "fixed"}):
            for _ in range(sync.MAX_ATTEMPTS - 1):
                self.fail()
            sync.repair.used = False
            parked, _, state = self.fail()
        self.assertFalse(parked)
        self.assertEqual(state["failures"]["a"]["attempts"], sync.MAX_ATTEMPTS)

    def test_publish_commits_the_fix_with_the_run(self):
        fix = sync.CI / "sync.py"
        with patch.object(sync, "NEWS", self.root), patch.dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN="t"), \
                patch.object(sync, "prepare_page", side_effect=ValueError("check 失败")), \
                patch.object(sync, "repair", return_value=({"verdict": "fixed"}, [fix]), used=False), \
                patch.object(sync, "publish_lore", return_value=False), patch.object(sync, "save") as save:
            sync.write_state({"pending": ["a"], "sections": {}, "deploy": False})
            with self.assertRaises(SystemExit):
                sync.publish()
        save.assert_called_once_with([fix], "天书：自动修复收录脚本")

    def test_unexpected_errors_are_counted_then_raised(self):
        with patch.object(sync, "NEWS", self.root), \
                patch.object(sync, "prepare_page", side_effect=KeyError("意外")), patch.object(sync, "save"):
            sync.write_state({"pending": ["a"], "sections": {}, "deploy": False})
            with self.assertRaises(KeyError):
                sync.publish()
        self.assertEqual(sync.read_state()["failures"]["a"]["attempts"], 1)


class AgentContainerTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.jobs = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        stack.enter_context(patch.object(sync.container, "built", True, create=True))
        stack.enter_context(patch.dict(os.environ, EVE_TRANSLATOR_JOBS=str(self.jobs), CLAUDE_CODE_OAUTH_TOKEN="t"))
        stack.enter_context(patch.object(sync.runtime, "cooling", return_value=None))

    def test_repair_workspace_hides_git_credentials_and_skips_sandbox_gate(self):
        if not hasattr(os, "getuid"):
            self.skipTest("容器参数只在 Linux 运行器上生成")
        root = Path(tempfile.mkdtemp(dir=self.jobs))
        (root / ".git").mkdir()
        with patch.object(sync, "ROOT", root), \
                patch.object(sync, "claude_output", return_value='{"verdict": "retry"}') as call, \
                patch.object(sync, "sandbox_ready", side_effect=AssertionError("维修代理不等命令隔离")):
            sync.claude("修", workspace=True)
            translator = sync.container()
        args = call.call_args.args[0]
        self.assertIn(f"{root}:{root}:ro", args)
        self.assertEqual(args[args.index("--tmpfs", args.index("-w")) + 1], str(root / ".git"))
        for directory in (self.jobs, sync.CI):
            self.assertIn(f"{directory}:{directory}:rw", args)
        self.assertEqual(args[args.index("--max-turns") + 1], "60")
        self.assertEqual(args[args.index("--tools") + 1], "Read,Write,Edit,Bash")
        self.assertEqual(translator.count("--tmpfs"), 1)  # 只挂翻译框架时没有 .git 要遮

    def test_sandbox_trial_failure_stops_before_any_model_call(self):
        if not hasattr(os, "getuid"):
            self.skipTest("容器参数只在 Linux 运行器上生成")
        (self.jobs / "job").mkdir()
        failed = subprocess.CompletedProcess([], 1, "", "bwrap: setting up uid map: Permission denied")
        sync.sandbox_ready.__dict__.pop("error", None)
        self.addCleanup(sync.sandbox_ready.__dict__.pop, "error", None)
        with patch.object(sync.subprocess, "run", return_value=failed) as trial, \
                patch.object(sync, "claude_output", side_effect=AssertionError("不应调用模型")):
            for _ in range(2):
                with self.assertRaises(sync.EnvironmentFailure) as error:
                    sync.claude("写稿", "job")
            self.assertIn("uid map", str(error.exception))
            self.assertEqual(trial.call_count, 1)  # 一轮只试一次

    def test_sandbox_refusal_in_agent_output_is_an_environment_failure(self):
        (self.jobs / "job").mkdir()
        with patch.object(sync, "container", return_value=["docker"]), patch.object(sync, "sandbox_ready"), \
                patch.object(sync, "claude_output", return_value="Sandbox dependencies not available: socat not installed"):
            with self.assertRaises(sync.EnvironmentFailure):
                sync.claude("写稿", "job")
            self.assertEqual(sync.claude("诊断"), "Sandbox dependencies not available: socat not installed")


if __name__ == "__main__":
    unittest.main()
