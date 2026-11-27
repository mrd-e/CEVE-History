"""收录任务的持久化、附件恢复和调用诊断；不调用模型。"""

import hashlib
import json
import os
import re
import subprocess
import shutil
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from time import monotonic
from uuid import uuid4


class ClaudeUnavailable(ValueError):
    """模型服务不可用，不能按回答格式错误重试。"""


def now():
    return datetime.now(timezone.utc)


def timestamp(value=None):
    return (value or now()).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8")
    temporary.replace(path)


def jobs_root(framework):
    return Path(os.environ.get("EVE_TRANSLATOR_JOBS") or framework / "jobs")


def signature(framework):
    """绑定实际工具、技能和数据包；本地未提交修正也进入兼容标识。"""
    digest = hashlib.sha256()
    paths = [*framework.glob("eve_translator/*.py"),
             *framework.glob(".claude/skills/*/SKILL.md"), framework / "reference/manifest.json"]
    for path in sorted(paths):
        if path.exists():
            digest.update(path.relative_to(framework).as_posix().encode())
            digest.update(path.read_bytes())
    for name in ("sync.py", "runtime.py", "publication.py"):
        digest.update((Path(__file__).parent / name).read_bytes())
    return digest.hexdigest()


def environment(framework):
    """兼容标识加上代理镜像和工作流：任一处改动都说明有人修过，搁置的待办可以重新排队。"""
    digest = hashlib.sha256(signature(framework).encode())
    for path in (Path(__file__).parent / "Dockerfile", Path(__file__).parents[2] / ".github/workflows/news.yml"):
        if path.exists():
            digest.update(path.read_bytes())
    return digest.hexdigest()


@contextmanager
def stage(label, job):
    started = monotonic()
    print(f"[{job}] 开始{label}", flush=True)
    try:
        yield
    finally:
        print(f"[{job}] 结束{label}，耗时 {monotonic() - started:.1f} 秒", flush=True)


def retry_time(message, clock=None):
    clock = clock or now()
    match = re.search(r"resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(UTC\)", message, re.I)
    if not match:
        return clock + timedelta(hours=1)
    hour, minute = int(match[1]), int(match[2] or 0)
    if match[3]:
        hour = hour % 12 + (12 if match[3].lower() == "pm" else 0)
    if hour > 23 or minute > 59:
        return clock + timedelta(hours=1)
    result = clock.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return result if result > clock else result + timedelta(days=1)


def quota_failure(message):
    return bool(re.search(r"(?:hit.*limit|rate.?limit|usage.?limit|quota|extra usage)", message, re.I))


def cooling(root):
    path = root / "service.json"
    if not path.exists():
        return None
    value = json.loads(path.read_text("utf-8"))
    retry = value.get("retry_after")
    return retry if retry and future(retry) else None


def future(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) > now()


def record_call(root, prompt, stdout, stderr, returncode, elapsed, token=None):
    """完整保留响应；仅保存提示指纹和长度，不把凭据写入附件。"""
    def redact(value):
        return value.replace(token, "***") if token else value
    stdout, stderr = redact(stdout or ""), redact(stderr or "")
    record = {"at": timestamp(), "elapsed_seconds": round(elapsed, 3),
              "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
              "prompt_characters": len(prompt), "returncode": returncode,
              "stdout": stdout, "stderr": stderr}
    try:
        envelope = json.loads(stdout)
    except ValueError:
        envelope = None
    if isinstance(envelope, dict) and "result" in envelope:
        record["usage"] = {key: envelope[key] for key in
                           ("usage", "total_cost_usd", "num_turns", "duration_ms", "modelUsage")
                           if key in envelope}
        output = envelope["result"]
        returncode = returncode or int(bool(envelope.get("is_error")))
    else:
        output = stdout
    record["returncode"] = returncode
    atomic_json(root / "calls" / f"{uuid4().hex}.json", record)
    print(f"模型调用：{elapsed:.1f} 秒；用量：{json.dumps(record.get('usage', {}), ensure_ascii=False)}", flush=True)
    return returncode, str(output), stderr


def restore(root, repository):
    """恢复最近完整附件；附件累计保存，因此后一次失败不会遮住更早的成稿。"""
    def api(endpoint, binary=False):
        result = subprocess.run(["gh", "api", endpoint], check=True, capture_output=True)
        return result.stdout if binary else json.loads(result.stdout)
    runs = api(f"repos/{repository}/actions/workflows/news.yml/runs?branch=main&status=completed&per_page=30")
    for run in runs["workflow_runs"]:
        artifacts = api(f"repos/{repository}/actions/runs/{run['id']}/artifacts")["artifacts"]
        artifact = next((a for a in artifacts if a["name"].startswith("translator-jobs-") and not a["expired"]), None)
        if not artifact:
            continue
        archive = zipfile.ZipFile(BytesIO(api(f"repos/{repository}/actions/artifacts/{artifact['id']}/zip", True)))
        # 全部检查后才写，拒绝目录穿越与符号链接。
        entries = []
        for info in archive.infolist():
            path = root / info.filename
            if not path.resolve().is_relative_to(root.resolve()) or info.filename.startswith("/") or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("恢复附件含不安全路径")
            if not info.is_dir():
                entries.append((info, path))
        groups = {}
        for info, path in entries:
            groups.setdefault(path.relative_to(root).parts[0], []).append((info, path))
        for name, members in groups.items():
            state = next((i for i, p in members if p.name == "state.json"), None)
            if state is not None:
                incoming = json.loads(archive.read(state))
                existing = root / name / "state.json"
                draft = next((i for i, p in members if p.name == "draft.jsonl"), None)
                count = len(archive.read(draft).splitlines()) if draft else 0
                if existing.exists() and progress(json.loads(existing.read_text("utf-8")),
                                                   len((existing.parent / "draft.jsonl").read_text("utf-8").splitlines())
                                                   if (existing.parent / "draft.jsonl").exists() else 0) >= progress(incoming, count):
                    continue
                # 整个任务作为快照替换，不能拼接不同轮次的 state/report/draft。
                target = (root / name).resolve()
                if target == root.resolve() or not target.is_relative_to(root.resolve()):
                    raise ValueError("任务恢复目标超出任务目录")
                if target.exists():
                    shutil.rmtree(target)
            for info, path in members:
                if state is not None or not path.exists():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(archive.read(info))
        print(f"已恢复运行 {run['id']} 的 {len(entries)} 个任务文件", flush=True)
        if "recovery.json" in groups:
            break
    atomic_json(root / "recovery.json", {"format": 1, "restored_at": timestamp()})


def progress(state, count=0):
    return (state.get("review_round") or 1,
            {"drafting": 1, "in_review": 2, "revising": 3, "revised": 4,
             "passed": 5, "closed": 5}.get(state.get("phase"), 0), count)
