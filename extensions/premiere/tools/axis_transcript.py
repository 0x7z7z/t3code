#!/usr/bin/env python3
"""Axis transcript protocol v1. No Premiere or GPU dependency; all times are seconds.

map --manifest clips.json --output mapped.json
  Manifest: {requestId, projectId, sequenceId, clips:[{transcript: "WhisperX.json",
  sequenceStart: 10, sequenceEnd: 20, sourceIn: 5, sourceOut: 15}]}.
  Constant speed clips are supported; reverse/time-remapped clips must be excluded.
reconcile --input mapped.json --script script.txt|md|docx|pdf --output final.json
  PDF extraction uses optional pypdf (or installed pdftotext). No automatic installs.
Both commands write atomically. A final map output is already a valid panel handoff.
"""
import argparse
import difflib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import unicodedata
import zipfile
from xml.etree import ElementTree


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("Times must be finite, nonnegative seconds")
    return float(value)


def timed_words(data):
    rows = data.get("word_segments", data.get("words"))
    if rows is None:
        rows = [w for s in data.get("sentences", data.get("segments", [])) for w in s.get("words", [])]
    output = []
    for row in rows:
        text = row.get("word", row.get("text", "")).strip()
        # Untimed tokens cannot safely be placed on a cut sequence. Report and omit them.
        if text and row.get("start") is not None and row.get("end") is not None:
            start, end = number(row["start"]), number(row["end"])
            if end > start:
                output.append({"word": text, "start": start, "end": end})
    return output, len(rows) - len(output)


def map_clips(manifest, base=Path(".")):
    words, skipped = [], 0
    if not manifest.get("clips"):
        raise ValueError("No voice-over clips supplied")
    for clip_index, clip in enumerate(manifest["clips"]):
        seq_start, source_in, source_out = (number(clip[k]) for k in ("sequenceStart", "sourceIn", "sourceOut"))
        seq_end = number(clip.get("sequenceEnd", seq_start + source_out - source_in))
        if source_out <= source_in or seq_end <= seq_start or clip.get("reverse") or clip.get("timeRemapped"):
            raise ValueError("Require positive, constant-speed, forward VO clip ranges")
        source = json.loads((base / clip["transcript"]).read_text(encoding="utf-8-sig"))
        rows, omitted = timed_words(source)
        skipped += omitted
        scale = (seq_end - seq_start) / (source_out - source_in)
        for row in rows:
            start, end = max(source_in, row["start"]), min(source_out, row["end"])
            if end <= start:
                continue
            words.append({"word": row["word"], "start": seq_start + (start - source_in) * scale,
                          "end": seq_start + (end - source_in) * scale, "clip": clip_index})
    words.sort(key=lambda w: (w["start"], w["end"]))
    if not words:
        raise ValueError("No timed words inside the used VO ranges")
    return {"version": 1, "requestId": manifest["requestId"], "projectId": manifest["projectId"],
            "sequenceId": manifest["sequenceId"], "status": "complete", "words": words,
            "metadata": {"scriptChecked": False, "untimedWordsOmitted": skipped}}


def extract_script(filename):
    filename = Path(filename)
    suffix = filename.suffix.lower()
    if suffix == ".docx":
        with zipfile.ZipFile(filename) as archive:
            root = ElementTree.fromstring(archive.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        return "\n".join("".join(p.itertext()) for p in root.findall(".//w:p", ns))
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
            return "\n".join(page.extract_text() or "" for page in PdfReader(filename).pages)
        except ImportError:
            if not shutil.which("pdftotext"):
                raise ValueError("PDF extraction needs pypdf or pdftotext; use an authoritative text export") from None
            return subprocess.check_output(["pdftotext", "-layout", str(filename), "-"], encoding="utf-8")
    if suffix not in (".txt", ".md"):
        raise ValueError("Use TXT, Markdown, DOCX or PDF script text")
    text = filename.read_text(encoding="utf-8-sig")
    if suffix == ".md":
        # Headings and pronunciation guides are editorial annotations, not VO.
        text = re.sub(r"(?m)^\s*#.*$", "", text)
        text = re.sub(r"\([^)]*[A-Z]{2,}[^)]*\)", "", text)
        text = re.sub(r"[*_`]|\\(?=[.])", "", text)
    return text


def normalize(word):
    return "".join(c for c in unicodedata.normalize("NFKC", word).casefold() if c.isalnum())


def reconcile(data, script):
    words = data["words"]
    tokens = [t for t in script.split() if normalize(t)]
    a, b = [normalize(w["word"]) for w in words], [normalize(t) for t in tokens]
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    coverage = sum(block.size for block in matcher.get_matching_blocks()) / max(1, len(a))
    confidence = round(coverage, 4)  # Exact-token anchor coverage, not a calibrated probability.
    changes, output, unresolved = [], [], 0
    opcodes = matcher.get_opcodes()
    if coverage < 0.55:
        return {**data, "metadata": {**data.get("metadata", {}), "scriptChecked": False,
                "reconciliation": {"confidence": confidence, "changes": [], "changedWords": 0,
                                   "status": "review-required", "reason": "Script matches fewer than 55% of spoken words"}}}
    for index, (tag, i, j, k, l) in enumerate(opcodes):
        original, replacement = words[i:j], tokens[k:l]
        if tag == "equal":
            for word, token in zip(original, replacement):
                output.append({**word, "word": token})
                if word["word"] != token:
                    changes.append({"before": word["word"], "after": token, "start": word["start"],
                                    "end": word["end"], "words": 1})
            continue
        # Do not add unspoken script passages or remove ad-libs. Only bounded,
        # short substitutions have enough evidence to change authoritative spelling.
        anchored = index > 0 and index + 1 < len(opcodes) and opcodes[index - 1][0] == "equal" and opcodes[index + 1][0] == "equal"
        same_clip = original and len({w.get("clip", 0) for w in original}) == 1
        contiguous = all(right["start"] - left["end"] <= 0.5 for left, right in zip(original, original[1:]))
        if tag != "replace" or not anchored or max(j - i, l - k) > 8 or not same_clip or not contiguous:
            output.extend(original)
            unresolved += 1
            continue
        start, end = original[0]["start"], original[-1]["end"]
        if len(original) == len(replacement):
            output.extend({**word, "word": token} for word, token in zip(original, replacement))
            changes.append({"before": " ".join(w["word"] for w in original), "after": " ".join(replacement),
                            "start": start, "end": end, "words": len(replacement)})
            continue
        start = max(start, words[i - 1]["end"] if i else start)
        end = min(end, words[j]["start"] if j < len(words) else end)
        if end <= start:
            output.extend(original)
            unresolved += 1
            continue
        weights = [max(1, len(normalize(t))) for t in replacement]
        total, elapsed = sum(weights), 0
        for token, weight in zip(replacement, weights):
            output.append({**original[0], "word": token, "start": start + (end - start) * elapsed / total,
                           "end": start + (end - start) * (elapsed + weight) / total})
            elapsed += weight
        changes.append({"before": " ".join(w["word"] for w in original), "after": " ".join(replacement),
                        "start": start, "end": end, "words": len(replacement)})
    return {**data, "words": output, "metadata": {**data.get("metadata", {}), "scriptChecked": True,
            "reconciliation": {"confidence": confidence, "changes": changes,
                               "changedWords": sum(c["words"] for c in changes),
                               "unresolvedRegions": unresolved, "status": "checked"}}}


def write_atomic(filename, data):
    filename = Path(filename)
    filename.parent.mkdir(parents=True, exist_ok=True)
    temporary = filename.with_name(filename.name + ".tmp")
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, filename)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    mapping = sub.add_parser("map")
    mapping.add_argument("--manifest", type=Path, required=True)
    fixing = sub.add_parser("reconcile")
    fixing.add_argument("--input", type=Path, required=True)
    fixing.add_argument("--script", type=Path, required=True)
    for child in (mapping, fixing):
        child.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "map":
        data = map_clips(json.loads(args.manifest.read_text(encoding="utf-8-sig")), args.manifest.parent)
    else:
        data = reconcile(json.loads(args.input.read_text(encoding="utf-8-sig")), extract_script(args.script))
    write_atomic(args.output, data)
    print(json.dumps({"words": len(data["words"]), **data["metadata"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
