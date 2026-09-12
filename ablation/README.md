# Repository ablation experiments

This directory turns the repository's existing verification suites into a
repeatable, behavior-level ablation experiment. It is intended for this
application repository; it is not a machine-learning feature ablation.

The runner copies tracked and nonignored untracked working-tree files into a disposable directory, applies one
mutation at a time, runs the relevant verifier, and restores the temporary
file. Production files in the real checkout are never modified.

The 2026-09-12 matrix has 71 cases (39 Worker and 32 Android). Reports are
[`WORKER-20260912.md`](WORKER-20260912.md) and the combined
[`ANDROID-20260912.md`](ANDROID-20260912.md). Individual phases remain in
`ANDROID-STATIC-20260912.md`, `ANDROID-DEVICE-20260912.md` and `ANDROID-PAGINATION-20260912.md`.
The device report isolates the new progressive library and archived-image
features; the full unmodified App also has a nine-test device regression suite.
The pagination rerun uses an explicitly released second response; the first
device report preserves the initial timing-related baseline failure.

## Outcome meanings

- `KILLED_TEST`: a Worker or Android JVM assertion observed the regression.
- `KILLED_DEVICE`: a focused Android instrumentation assertion observed a
  regression that survived JVM tests.
- `KILLED_BUILD`: compilation, schema bootstrap, packaging, or test startup
  failed before an assertion could observe behavior.
- `SURVIVED`: the selected verification surface passed despite the ablation.
- `TIMEOUT`: the experiment did not produce a result within its time budget.

A surviving ablation is a test gap. It is not evidence that the production
behavior should be removed.

## Run

Install the normal project dependencies first, then run from the repository
root:

```bash
shnote --what "运行完整消融实验" --why "测量现有测试对生产能力移除的检出率" py -f ablation/run.py
```

Run one subsystem or one case:

```bash
shnote --what "运行 Worker 消融" --why "评估后端测试的行为检出能力" py -f ablation/run.py -- --platform worker
shnote --what "运行单项消融" --why "复现一个具体实验结果" py -f ablation/run.py -- --case worker-public-auth
```

Validate mutation anchors after changing production code:

```bash
shnote --what "校验消融锚点" --why "防止实验在代码漂移后改写错误位置" py -f ablation/run.py -- --validate
```

Android device escalation requires a booted emulator or device. Every focused
instrumentation test is first run against unmodified code. A failed baseline is
recorded and all mutations depending on it remain JVM-level `SURVIVED` instead
of being assigned a false device result:

```bash
shnote --what "运行含设备测试的消融" --why "覆盖 Activity、Compose 和 DataStore 行为" py -f ablation/run.py -- --platform android --device --serial emulator-5558
```

Results are written to `ablation/results/latest.json` and
`ablation/RESULTS.md`. The Markdown report includes baselines, the behavioral
detection rate, every case result, surviving ablations, and a production-file
coverage map.

## Scope

The matrix treats executable production behavior as the independent variable:

- `worker/src`, all D1 migrations, authentication, routing, CRUD, cache,
  enrichment leases/retries, and R2 image safeguards;
- Android Kotlin production code, share extraction, serialization, network
  clients, persistence, ViewModel projections, Compose navigation, lifecycle,
  updates, Manifest entry points, and user-visible error resources.

Tests are the outcome metric and are never mutated. Documentation, dependency
locks, build configuration, CI workflows, and the non-runtime HTML design
reference remain controls. Type-only Kotlin records are reported as structural
coverage through the behavior that consumes them.
