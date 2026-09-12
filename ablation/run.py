#!/usr/bin/env python3
"""Run repository ablations in a disposable working copy."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from cases import CASES, EXCLUDED_TRACKED_CODE, STRUCTURAL_COVERAGE


ROOT = Path(__file__).resolve().parents[1]
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


@dataclass
class TestStats:
    total: int = 0
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    failed_tests: tuple[str, ...] = ()


@dataclass
class RunResult:
    case_id: str
    platform: str
    area: str
    description: str
    file: str
    verifier: str
    status: str
    elapsed_seconds: float
    return_code: int | None
    tests: TestStats
    device_test: str | None = None
    diagnostic: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--platform",
        choices=("all", "worker", "android"),
        default="all",
        help="Select the production subsystem to mutate.",
    )
    parser.add_argument("--case", action="append", default=[], help="Run only a case id; repeatable.")
    parser.add_argument("--validate", action="store_true", help="Validate all mutation anchors without running tests.")
    parser.add_argument("--device", action="store_true", help="Escalate eligible Android survivors to device tests.")
    parser.add_argument("--serial", help="ANDROID_SERIAL used by --device, for example emulator-5558.")
    parser.add_argument("--timeout-worker", type=int, default=120)
    parser.add_argument("--timeout-android", type=int, default=240)
    parser.add_argument("--timeout-device", type=int, default=600)
    parser.add_argument("--json", type=Path, default=ROOT / "ablation/results/latest.json")
    parser.add_argument("--report", type=Path, default=ROOT / "ablation/RESULTS.md")
    parser.add_argument("--keep-worktree", action="store_true", help="Keep the disposable copy for debugging.")
    return parser.parse_args()


def selected_cases(args: argparse.Namespace) -> list[dict[str, Any]]:
    cases = [case for case in CASES if args.platform == "all" or case["platform"] == args.platform]
    if args.case:
        requested = set(args.case)
        known = {str(case["id"]) for case in CASES}
        missing = requested - known
        if missing:
            raise SystemExit(f"Unknown case id(s): {', '.join(sorted(missing))}")
        cases = [case for case in cases if case["id"] in requested]
    return cases


def tracked_files() -> list[Path]:
    completed = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    return sorted({Path(item.decode()) for item in completed.stdout.split(b"\0") if item and (ROOT / item.decode()).is_file()})


def copy_repository(destination: Path) -> None:
    for relative in tracked_files():
        source = ROOT / relative
        if not source.exists():
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    # local.properties is intentionally untracked, but a disposable Android
    # build still needs the checkout's SDK location.
    local_properties = ROOT / "android/local.properties"
    if local_properties.is_file():
        shutil.copy2(local_properties, destination / "android/local.properties")

    node_modules = ROOT / "worker/node_modules"
    if node_modules.is_dir():
        (destination / "worker/node_modules").symlink_to(node_modules, target_is_directory=True)
    else:
        raise SystemExit("worker/node_modules is missing; run npm ci in worker/ before the experiment")


def validate_case(case: dict[str, Any], root: Path) -> None:
    path = root / str(case["file"])
    if not path.is_file():
        raise ValueError(f"{case['id']}: target does not exist: {case['file']}")
    mutation = case["mutation"]
    if mutation["kind"] == "empty_file":
        if path.stat().st_size == 0:
            raise ValueError(f"{case['id']}: target is already empty")
        return
    if mutation["kind"] != "replace":
        raise ValueError(f"{case['id']}: unsupported mutation kind {mutation['kind']}")
    text = path.read_text(encoding="utf-8")
    actual = text.count(str(mutation["old"]))
    expected = int(mutation.get("count", 1))
    if actual != expected:
        raise ValueError(f"{case['id']}: expected {expected} anchor(s), found {actual} in {case['file']}")


def apply_case(case: dict[str, Any], root: Path) -> str:
    path = root / str(case["file"])
    original = path.read_text(encoding="utf-8")
    mutation = case["mutation"]
    if mutation["kind"] == "empty_file":
        suffix = path.suffix.lower()
        marker = "-- ablated by ablation/run.py\n" if suffix == ".sql" else ""
        path.write_text(marker, encoding="utf-8")
        return original

    old = str(mutation["old"])
    new = str(mutation["new"])
    expected = int(mutation.get("count", 1))
    if original.count(old) != expected:
        raise ValueError(
            f"{case['id']}: expected {expected} anchor(s), found {original.count(old)} in {case['file']}"
        )
    path.write_text(original.replace(old, new), encoding="utf-8")
    return original


def junit_stats(paths: Iterable[Path]) -> TestStats:
    total = passed = failed = skipped = 0
    failed_tests: list[str] = []
    for path in paths:
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError):
            continue
        suites = [root] if root.tag == "testsuite" else list(root.findall("testsuite"))
        for suite in suites:
            suite_total = int(suite.attrib.get("tests", 0))
            suite_failed = int(suite.attrib.get("failures", 0)) + int(suite.attrib.get("errors", 0))
            suite_skipped = int(suite.attrib.get("skipped", 0))
            total += suite_total
            failed += suite_failed
            skipped += suite_skipped
            passed += max(0, suite_total - suite_failed - suite_skipped)
            for test in suite.findall("testcase"):
                if test.find("failure") is not None or test.find("error") is not None:
                    class_name = test.attrib.get("classname", "")
                    name = test.attrib.get("name", "unknown")
                    failed_tests.append(f"{class_name}.{name}".strip("."))
    return TestStats(total, passed, failed, skipped, tuple(failed_tests[:8]))


def remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def verifier_command(
    verifier: str,
    root: Path,
    case: dict[str, Any] | None,
    args: argparse.Namespace,
) -> tuple[list[str], Path, int, list[Path]]:
    if verifier == "worker_test":
        report = root / "worker/.ablation-junit.xml"
        remove_path(report)
        return (
            ["npm", "test", "--", "--reporter=junit", "--outputFile=.ablation-junit.xml"],
            root / "worker",
            args.timeout_worker,
            [report],
        )
    if verifier == "worker_typecheck":
        return (["npm", "run", "typecheck"], root / "worker", args.timeout_worker, [])
    if verifier == "android_unit":
        results = root / "android/app/build/test-results/testDebugUnitTest"
        remove_path(results)
        return (
            ["./gradlew", "--dependency-verification", "strict", "--console=plain", "testDebugUnitTest"],
            root / "android",
            args.timeout_android,
            [results],
        )
    if verifier == "android_build":
        return (
            [
                "./gradlew",
                "--dependency-verification",
                "strict",
                "--console=plain",
                "lintDebug",
                "assembleDebug",
                "compileDebugAndroidTestKotlin",
            ],
            root / "android",
            args.timeout_android,
            [],
        )
    if verifier == "android_device":
        if case is None or not case.get("device_test"):
            raise ValueError("android_device requires a case with device_test")
        results = root / "android/app/build/outputs/androidTest-results/connected"
        remove_path(results)
        test_name = str(case["device_test"])
        test_class = str(case.get("device_class", "com.alpenl.cairn.share.ShareActivityInstrumentedTest")) + f"#{test_name}"
        return (
            [
                "./gradlew",
                "--dependency-verification",
                "strict",
                "--console=plain",
                "connectedDebugAndroidTest",
                f"-Pandroid.testInstrumentationRunnerArguments.class={test_class}",
            ],
            root / "android",
            args.timeout_device,
            [results],
        )
    raise ValueError(f"unknown verifier: {verifier}")


def execute_verifier(
    verifier: str,
    root: Path,
    args: argparse.Namespace,
    case: dict[str, Any] | None = None,
) -> tuple[int | None, float, TestStats, str, bool]:
    command, cwd, timeout, result_roots = verifier_command(verifier, root, case, args)
    env = os.environ.copy()
    env.update({"CI": "1", "NO_COLOR": "1", "TERM": "dumb"})
    if verifier == "android_device":
        if not args.serial:
            raise ValueError("--serial is required with --device")
        env["ANDROID_SERIAL"] = args.serial

    started = time.monotonic()
    timed_out = False
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
        )
        return_code: int | None = completed.returncode
        output = completed.stdout
    except subprocess.TimeoutExpired as exc:
        return_code = None
        timed_out = True
        stdout = exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        output = stdout + f"\nTimed out after {timeout}s"
    elapsed = time.monotonic() - started

    junit_files: list[Path] = []
    for result_root in result_roots:
        if result_root.is_file():
            junit_files.append(result_root)
        elif result_root.is_dir():
            junit_files.extend(result_root.rglob("*.xml"))
    stats = junit_stats(junit_files)
    clean_output = ANSI_ESCAPE.sub("", output)
    diagnostic = diagnostic_excerpt(clean_output, stats)
    return return_code, elapsed, stats, diagnostic, timed_out


def diagnostic_excerpt(output: str, stats: TestStats) -> str:
    if stats.failed_tests:
        return "; ".join(stats.failed_tests)
    interesting = [
        line.strip()
        for line in output.splitlines()
        if any(
            token in line
            for token in (
                "FAILED",
                "FAILURE:",
                "error:",
                "Error:",
                "Timed out",
                "No tests found",
                "INSTALL_FAILED",
            )
        )
    ]
    return " | ".join(interesting[-4:])[:800]


def classify(return_code: int | None, stats: TestStats, timed_out: bool, verifier: str) -> str:
    if timed_out:
        return "TIMEOUT"
    if return_code == 0:
        return "SURVIVED"
    if stats.failed > 0:
        return "KILLED_DEVICE" if verifier == "android_device" else "KILLED_TEST"
    return "KILLED_BUILD"


def baseline(
    verifier: str,
    root: Path,
    args: argparse.Namespace,
    case: dict[str, Any] | None = None,
    required: bool = True,
) -> dict[str, Any]:
    return_code, elapsed, stats, diagnostic, timed_out = execute_verifier(verifier, root, args, case)
    status = "PASS" if return_code == 0 and not timed_out else "FAIL"
    label = verifier
    if verifier == "android_device" and case is not None:
        label = f"android_device:{case['device_test']}"
    result = {
        "verifier": label,
        "status": status,
        "elapsed_seconds": round(elapsed, 3),
        "return_code": return_code,
        "tests": asdict(stats),
        "diagnostic": diagnostic,
    }
    if required and status != "PASS":
        raise RuntimeError(f"baseline {verifier} failed: {diagnostic or 'no diagnostic'}")
    return result


def run_case(
    case: dict[str, Any],
    root: Path,
    args: argparse.Namespace,
    device_baselines: dict[str, bool],
) -> RunResult:
    validate_case(case, root)
    path = root / str(case["file"])
    original = apply_case(case, root)
    try:
        verifier = str(case["verifier"])
        return_code, elapsed, stats, diagnostic, timed_out = execute_verifier(verifier, root, args, case)
        status = classify(return_code, stats, timed_out, verifier)
        if case["area"] == "schema" and status == "KILLED_TEST":
            status = "KILLED_BUILD"
        device_test = None
        if status == "SURVIVED" and case["platform"] == "worker" and verifier == "worker_test":
            code2, elapsed2, _stats2, diagnostic2, timeout2 = execute_verifier(
                "worker_typecheck", root, args, case
            )
            elapsed += elapsed2
            verifier = f"{verifier}+worker_typecheck"
            if code2 != 0 or timeout2:
                return_code = code2
                diagnostic = diagnostic2
                status = classify(code2, TestStats(), timeout2, "worker_typecheck")
        if status == "SURVIVED" and args.device and case.get("device_test"):
            device_test = str(case["device_test"])
            if device_baselines.get(device_test, False):
                code2, elapsed2, stats2, diagnostic2, timeout2 = execute_verifier(
                    "android_device", root, args, case
                )
                elapsed += elapsed2
                return_code = code2
                stats = stats2
                diagnostic = diagnostic2
                status = classify(code2, stats2, timeout2, "android_device")
                verifier = f"{verifier}+android_device"
            else:
                verifier = f"{verifier}+android_device_skipped"
                skip_note = f"device baseline failed for {device_test}"
                diagnostic = f"{diagnostic}; {skip_note}".strip("; ")
        return RunResult(
            case_id=str(case["id"]),
            platform=str(case["platform"]),
            area=str(case["area"]),
            description=str(case["description"]),
            file=str(case["file"]),
            verifier=verifier,
            status=status,
            elapsed_seconds=round(elapsed, 3),
            return_code=return_code,
            tests=stats,
            device_test=device_test,
            diagnostic=diagnostic,
        )
    finally:
        path.write_text(original, encoding="utf-8")


def git_revision() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    return completed.stdout.strip() if completed.returncode == 0 else "unknown"


def production_files() -> list[str]:
    prefixes = (
        "worker/src/",
        "worker/migrations/",
        "android/app/src/main/java/",
    )
    explicit = {"android/app/src/main/AndroidManifest.xml", "android/app/src/main/res/values/strings.xml"}
    return sorted(str(path) for path in tracked_files() if str(path).startswith(prefixes) or str(path) in explicit)


def coverage_map(cases: list[dict[str, Any]]) -> dict[str, list[str]]:
    coverage: dict[str, list[str]] = defaultdict(list)
    for case in cases:
        coverage[str(case["file"])].append(str(case["id"]))
        for path in case.get("covers", []):
            coverage[str(path)].append(str(case["id"]))
    for path, ids in STRUCTURAL_COVERAGE.items():
        coverage[path].extend(ids)
    return {path: list(dict.fromkeys(ids)) for path, ids in coverage.items()}


def markdown_report(payload: dict[str, Any]) -> str:
    results = payload["results"]
    baselines = payload["baselines"]
    statuses = Counter(item["status"] for item in results)
    lines = [
        "# Cairn Share repository ablation results",
        "",
        f"Generated: `{payload['generated_at']}`",
        "",
        f"Revision: `{payload['revision']}`",
        "",
        f"Cases: `{len(results)}`",
        "",
        "## Method",
        "",
        "Each case changes one behavior in a disposable copy of the tracked repository. The original source is never mutated. "
        "Worker cases run the Vitest/D1 suite, Android cases run JVM tests or build gates, and eligible Android survivors are "
        "escalated to one focused device test when `--device` is enabled. Device escalation occurs only when that exact test "
        "passes first on unmodified code.",
        "",
        "A result of `SURVIVED` means the selected verification surface still passed; it does not prove the removed behavior is "
        "unnecessary. `KILLED_TEST` and `KILLED_DEVICE` mean assertions observed the regression. `KILLED_BUILD` means only the "
        "compiler, schema bootstrap, packaging, or test runtime stopped it.",
        "",
        "## Baselines",
        "",
        "| Verifier | Status | Tests | Passed | Failed | Seconds |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for item in baselines:
        tests = item["tests"]
        lines.append(
            f"| `{item['verifier']}` | {item['status']} | {tests['total']} | {tests['passed']} | "
            f"{tests['failed']} | {item['elapsed_seconds']:.3f} |"
        )
    lines.extend(
        [
            "",
            "## Summary",
            "",
            "| Result | Count |",
            "| --- | ---: |",
        ]
    )
    for status in ("KILLED_TEST", "KILLED_DEVICE", "KILLED_BUILD", "SURVIVED", "TIMEOUT"):
        lines.append(f"| `{status}` | {statuses.get(status, 0)} |")

    behavioral = sum(statuses[name] for name in ("KILLED_TEST", "KILLED_DEVICE"))
    completed = len(results) - statuses.get("TIMEOUT", 0)
    score = (100.0 * behavioral / completed) if completed else 0.0
    lines.extend(
        [
            "",
            f"Behavioral detection rate: **{behavioral}/{completed} ({score:.1f}%)**. "
            "Compiler/schema kills are reported separately and are not counted as assertion detection.",
            "",
            "## Case Results",
            "",
            "| Case | Platform | Area | Result | Tests | Seconds | File |",
            "| --- | --- | --- | --- | ---: | ---: | --- |",
        ]
    )
    for item in results:
        tests = item["tests"]
        test_cell = f"{tests['passed']}/{tests['total']}"
        lines.append(
            f"| `{item['case_id']}` | {item['platform']} | {item['area']} | `{item['status']}` | "
            f"{test_cell} | {item['elapsed_seconds']:.3f} | `{item['file']}` |"
        )

    survivors = [item for item in results if item["status"] == "SURVIVED"]
    lines.extend(["", "## Surviving Ablations", ""])
    if not survivors:
        lines.append("None.")
    else:
        lines.append("These are concrete gaps in the verification surface, not recommendations to delete the feature:")
        lines.append("")
        for item in survivors:
            lines.append(f"- `{item['case_id']}`: {item['description']} (`{item['file']}`)")

    coverage = payload["coverage"]
    lines.extend(
        [
            "",
            "## Production File Coverage",
            "",
            "| File | Ablation cases |",
            "| --- | --- |",
        ]
    )
    for path in payload["production_files"]:
        ids = coverage.get(path, [])
        label = ", ".join(f"`{item}`" for item in ids) if ids else "**UNMAPPED**"
        lines.append(f"| `{path}` | {label} |")

    lines.extend(["", "## Scope Exclusions", ""])
    for path, reason in EXCLUDED_TRACKED_CODE.items():
        lines.append(f"- `{path}`: {reason}")
    lines.extend(
        [
            "",
            "Generated assets, dependency metadata, Gradle/Wrangler configuration, CI workflows, tests, and documentation are "
            "controls or delivery infrastructure rather than production behaviors; they are validated by the final repository gates, "
            "not treated as ablation variables.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    cases = selected_cases(args)
    errors: list[str] = []
    for case in cases:
        try:
            validate_case(case, ROOT)
        except ValueError as exc:
            errors.append(str(exc))
    if errors:
        print("Mutation anchor validation failed:", file=sys.stderr)
        for item in errors:
            print(f"- {item}", file=sys.stderr)
        return 2
    if args.validate:
        print(f"Validated {len(cases)} ablation cases.")
        return 0

    if args.device and not args.serial:
        print("--serial is required when --device is enabled", file=sys.stderr)
        return 2

    work_parent = Path(tempfile.mkdtemp(prefix="cairn-share-ablation-"))
    worktree = work_parent / "repo"
    worktree.mkdir()
    try:
        print(f"Preparing disposable repository: {worktree}", flush=True)
        copy_repository(worktree)
        platforms = {str(case["platform"]) for case in cases}
        baselines: list[dict[str, Any]] = []
        if "worker" in platforms:
            print("Baseline: worker_test", flush=True)
            baselines.append(baseline("worker_test", worktree, args))
            print("Baseline: worker_typecheck", flush=True)
            baselines.append(baseline("worker_typecheck", worktree, args))
        if "android" in platforms:
            print("Baseline: android_unit", flush=True)
            baselines.append(baseline("android_unit", worktree, args))
            print("Baseline: android_build", flush=True)
            baselines.append(baseline("android_build", worktree, args))
            if args.device:
                seen_device_tests: set[str] = set()
                for case in cases:
                    device_test = case.get("device_test")
                    if not device_test or str(device_test) in seen_device_tests:
                        continue
                    seen_device_tests.add(str(device_test))
                    print(f"Baseline: android_device:{device_test}", flush=True)
                    baselines.append(baseline("android_device", worktree, args, case, required=False))

        device_baselines: dict[str, bool] = {}
        for item in baselines:
            if item["verifier"].startswith("android_device:"):
                test_name = item["verifier"].split(":", 1)[1]
                device_baselines[test_name] = item["status"] == "PASS"

        results: list[RunResult] = []
        for index, case in enumerate(cases, 1):
            print(f"[{index}/{len(cases)}] {case['id']}", flush=True)
            result = run_case(case, worktree, args, device_baselines)
            results.append(result)
            print(
                f"  {result.status} ({result.elapsed_seconds:.3f}s, "
                f"tests {result.tests.passed}/{result.tests.total})",
                flush=True,
            )

        payload = {
            "schema_version": 1,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "revision": git_revision(),
            "command": " ".join(sys.argv),
            "device_enabled": args.device,
            "device_serial": args.serial,
            "baselines": baselines,
            "results": [asdict(item) for item in results],
            "production_files": production_files(),
            "coverage": coverage_map(cases),
        }
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        args.report.write_text(markdown_report(payload), encoding="utf-8")
        print(f"JSON: {args.json}")
        print(f"Report: {args.report}")
        return 0
    except (RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        print(f"Experiment aborted: {exc}", file=sys.stderr)
        return 1
    finally:
        if args.keep_worktree:
            print(f"Kept disposable repository: {worktree}")
        else:
            shutil.rmtree(work_parent, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
