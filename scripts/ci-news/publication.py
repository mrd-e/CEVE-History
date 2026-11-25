"""人工和自动收录共用的状态计算；仅按实际英文快照登记，不联网、不写文件。"""

import hashlib
import json
import re
import sys
from copy import deepcopy

PATCH = re.compile(r"patch-notes-version-\d+(?:-\d+)+")
DAY = r"\d{4}-\d{2}-\d{2}\.\d+"
EN = re.compile(rf"^##\s+\**Patch Notes for ({DAY})\**\s*$", re.M | re.I)
ZH = re.compile(rf"^##\s+\**({DAY})补丁说明\**\s*$", re.M)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def sections(markdown, pattern):
    matches = list(pattern.finditer(markdown))
    if not matches:
        raise ValueError("补丁正文缺少每日标题")
    result = {"intro": markdown[:matches[0].start()].strip()}
    for i, match in enumerate(matches):
        if match[1] in result:
            raise ValueError(f"补丁编号重复 {match[1]}")
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        result[match[1]] = markdown[match.end():end].strip()
    return result


def record(state, slug, body, changed, source=None, fingerprints=None):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*", slug):
        raise ValueError("新闻短名无效")
    result = deepcopy(state)
    if PATCH.fullmatch(slug):
        if not source:
            raise ValueError(f"{slug} 缺少翻译所用英文快照，请指定 --source-snapshot <source.md>；不能用最新官网冒充旧译文依据")
        source = source.replace("\r\n", "\n").replace("\r", "\n")
        parts = sections(source, EN)
        translated = sections(body, ZH)
        if parts.keys() != translated.keys():
            raise ValueError(f"{slug} 英文快照与译文日期不一致，不能登记完成")
        hashes = fingerprints if fingerprints is not None else {
            key: {"source": digest(value), "zh": None, "official": False} for key, value in parts.items()}
        if not isinstance(hashes, dict) or hashes.keys() != parts.keys() or any(
                not isinstance(hashes[k], dict) or hashes[k].get("source") != digest(v) for k, v in parts.items()):
            raise ValueError(f"{slug} 章节指纹与实际英文快照不符")
        result.setdefault("sections", {})[slug] = hashes
        if result.get("patch") == slug:
            if result.get("observed") != digest(source):
                result.pop("patchPublishedAt", None)
            result["observed"] = digest(source)
    # 普通新闻滚出 RSS 后再返回，也不应把已人工收录的稿件当成新待办。
    if slug not in result.setdefault("baseline", []):
        result["baseline"].append(slug)
    result["pending"] = [s for s in result.get("pending", []) if s != slug]
    result["deploy"] = result.get("deploy", False) or changed
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(record(**json.load(sys.stdin)), ensure_ascii=False))
    except (ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
