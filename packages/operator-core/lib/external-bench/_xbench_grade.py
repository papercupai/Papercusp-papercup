#!/usr/bin/env python3
"""Grade one arm's collected diffs with the official swe_bench_pro_eval.py (--use_local_docker).

Reads <OUT_DIR>/<arm>.json (perTask + diffs-<arm>/<instance>.diff), builds the predictions JSON
[{instance_id, patch, prefix}], runs the eval over the SAME sample.jsonl, and prints the
per-instance resolved map from eval_results.json. The TS grader (swe-bench-pro.ts) runs this exact
command; we drive it directly here so the grading step is decoupled/resumable from generation.
"""
import ast, csv, hashlib, json, os, posixpath, re, subprocess, sys

OUT_DIR = os.environ.get("XBENCH_OUT_DIR", "/tmp/xbench-compare-out")
SAMPLE = os.environ.get("XBENCH_SAMPLE", "/tmp/xbench-sample.jsonl")
EVAL_DIR = os.environ.get("PAPERCUSP_SWEBENCH_EVAL_DIR", "/home/dev/.papercusp/bench-harnesses/SWE-bench_Pro-os")
PY = os.environ.get("PAPERCUSP_SWEBENCH_PYTHON", os.path.join(EVAL_DIR, ".venv/bin/python"))
WORKERS = os.environ.get("PAPERCUSP_SWEBENCH_NUM_WORKERS", "4")
DOCKERHUB_USER = os.environ.get("PAPERCUSP_SWEBENCH_DOCKERHUB_USER", "jefzda")

arm = sys.argv[1] if len(sys.argv) > 1 else "hive"
arm_json = os.path.join(OUT_DIR, f"{arm}.json")
diffs_dir = os.path.join(OUT_DIR, f"diffs-{arm}")
grade_out = os.path.join(OUT_DIR, f"grade-{arm}")
os.makedirs(grade_out, exist_ok=True)

frozen = json.loads(os.environ["XBENCH_FROZEN_GRADER"]) if os.environ.get("XBENCH_FROZEN_GRADER") else None

def verify_frozen_grader():
    """Refuse drift before importing or invoking the official scorer."""
    if frozen is None:
        return None
    if frozen.get("family") != "swe-bench-pro" or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", frozen.get("version", "")):
        raise RuntimeError("Frozen official grader source pin is invalid")
    images = frozen.get("images")
    if not isinstance(images, dict) or not images or any(
        not isinstance(uri, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}", uri)
        for uri in images.values()
    ):
        raise RuntimeError("Frozen grader requires immutable task image digests")
    manifest_hash = hashlib.sha256(json.dumps(images, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if manifest_hash != frozen.get("imageDigest"):
        raise RuntimeError("Frozen grader image manifest hash differs")
    if any(not isinstance(uid, str) or uid in (".", "..") or "/" in uid or "\\" in uid for uid in images):
        raise RuntimeError("Frozen grader task ids must be safe artifact basenames")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=EVAL_DIR, text=True).strip()
    if source != frozen["version"]:
        raise RuntimeError("Official grader source differs from its frozen commit")
    executable_paths = ["swe_bench_pro_eval.py", "helper_code", "run_scripts", "dockerfiles"]
    if subprocess.run(["git", "diff", "--quiet", "HEAD", "--"] + executable_paths, cwd=EVAL_DIR).returncode != 0:
        raise RuntimeError("Official grader executable sources differ from the frozen commit")
    untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "--"] + executable_paths, cwd=EVAL_DIR, text=True)
    if untracked.strip():
        raise RuntimeError("Official grader has untracked executable inputs")
    sample = os.environ.get("PAPERCUSP_SWEBENCH_CSV")
    if not sample:
        raise RuntimeError("Current grading requires the canonical PAPERCUSP_SWEBENCH_CSV")
    with open(sample, "rb") as stream:
        dataset_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    if dataset_hash != frozen.get("datasetSha256"):
        raise RuntimeError("Official grader CSV differs from its frozen dataset")
    return {"sourceCommit": source, "datasetSha256": dataset_hash, "imageDigest": manifest_hash, "images": images}

grader_receipt = verify_frozen_grader()

def submission_import_failure(uid, task_dir, verdict):
    """Recognize a measured Jest failure of selected tests to import app source.

    Upstream's Jest parser emits no individual tests for a suite startup failure.
    Keep its false verdict only with canonical test identity and diagnostic proof;
    missing logs, dependency failures and unexplained empty output are outages.
    """
    if verdict is not False:
        return None
    try:
        with open(os.path.join(task_dir, f"arm-{arm}_stdout.log"), "rb") as stream:
            raw_log = stream.read()
        log = raw_log.decode("utf-8")
        csv.field_size_limit(16 * 1024 * 1024)
        with open(os.environ["PAPERCUSP_SWEBENCH_CSV"]) as stream:
            row = next(row for row in csv.DictReader(stream) if row["instance_id"] == uid)
        selected = set(ast.literal_eval(row["selected_test_files_to_run"]))
        expected = {test.split(" | ", 1)[0] for test in ast.literal_eval(row["fail_to_pass"])}
    except (OSError, ValueError, KeyError, StopIteration, UnicodeError):
        return None
    if not re.search(r"^Tests:\s+0 total\s*$", log, re.MULTILINE):
        return None
    for match in re.finditer(
        r"^FAIL ([^\s]+)\s*\n\s+● Test suite failed to run\s*\n\s+Cannot find module '([^'\n]+)' from '([^'\n]+)'",
        log, re.MULTILINE,
    ):
        test_file, module, origin = match.groups()
        source = posixpath.normpath(posixpath.join(posixpath.dirname(origin), module))
        if test_file == origin and origin in selected and origin in expected and module.startswith(".") and source.startswith("src/"):
            return {"kind": "submission-import-failure", "testFile": origin,
                    "sourcePath": source, "stdoutSha256": hashlib.sha256(raw_log).hexdigest()}
    return None

with open(arm_json) as f:
    arm_data = json.load(f)

# Do not manufacture an official submission grade for empty or failed attempts.
# These rows have no conditional grade; the maintained TS readers retain them
# in the assigned-task primary denominator and distinguish missing measurement
# from budget/non-attempt outcomes. Keep this filter aligned with types.ts.
NON_SCORED_STOP_REASONS = {"error", "timeout", "infra-failed"}

preds = []
omitted_empty = 0
omitted_infra = 0
for t in arm_data["perTask"]:
    iid = t["instanceId"]
    dp = os.path.join(diffs_dir, f"{iid}.diff")
    patch = ""
    if os.path.exists(dp):
        with open(dp) as df:
            patch = df.read()
    stop_reason = t.get("stopReason")
    gen_error = t.get("generationError")
    if stop_reason in NON_SCORED_STOP_REASONS or gen_error:
        # No scoreable submission; preserve its assigned outcome in the TS store.
        omitted_infra += 1
        continue
    if not patch.strip():
        # No real submission; leave its conditional grade unmeasured.
        omitted_empty += 1
        continue
    preds.append({"instance_id": iid, "patch": patch, "prefix": f"arm-{arm}"})

preds_path = os.path.join(grade_out, "predictions.json")
with open(preds_path, "w") as f:
    json.dump(preds, f)

n_nonempty = sum(1 for p in preds if p["patch"].strip())
print(
    f"[grade] arm={arm} predictions={len(preds)} nonEmptyPatches={n_nonempty} "
    f"omitted(empty-diff={omitted_empty}, infra/transient={omitted_infra}) "
    f"[omitted rows have no conditional grade; assigned-task scoring retains their outcomes]"
)
print(f"[grade] running swe_bench_pro_eval.py over {len(preds)} instances (workers={WORKERS}) ...")

cmd = [
    PY, "swe_bench_pro_eval.py",
    f"--raw_sample_path={SAMPLE}",
    f"--patch_path={preds_path}",
    f"--output_dir={grade_out}/out",
    "--scripts_dir=run_scripts",
    f"--num_workers={WORKERS}",
    f"--dockerhub_username={DOCKERHUB_USER}",
    "--use_local_docker",
]
if frozen is not None:
    if any(p["instance_id"] not in frozen["images"] for p in preds):
        raise RuntimeError("A submitted task has no frozen official grader image")
    cmd[2] = f"--raw_sample_path={os.environ['PAPERCUSP_SWEBENCH_CSV']}"
    # Import the unchanged pinned official module; override only its image URI
    # resolver, so Docker pulls/runs digests instead of mutable registry tags.
    # Official patch application, test execution and scoring stay in that module.
    bootstrap = """import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('swe_bench_pro_eval', 'swe_bench_pro_eval.py')
module=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=module
spec.loader.exec_module(module)
images=json.loads(os.environ['XBENCH_FROZEN_GRADER'])['images']
used_images={}
def image_uri(uid,*args,**kwargs):
    used_images[uid]=images[uid]
    return images[uid]
module.get_dockerhub_image_uri=image_uri
sys.argv=['swe_bench_pro_eval.py']+sys.argv[1:]
module.main()
output_dir=next(arg.split('=',1)[1] for arg in sys.argv[1:] if arg.startswith('--output_dir='))
with open(os.path.join(output_dir,'pinned-image-usage.json'),'w') as stream: json.dump(used_images,stream,sort_keys=True)
"""
    cmd = [PY, "-c", bootstrap] + cmd[2:] + ["--redo"]
print("[grade] cmd:", " ".join(cmd))
if frozen is not None and not preds:
    os.makedirs(f"{grade_out}/out", exist_ok=True)
    with open(f"{grade_out}/out/eval_results.json", "w") as stream:
        json.dump({}, stream)
    proc = subprocess.CompletedProcess(cmd, 0, "No submitted patches; no official grader execution needed.", "")
else:
    proc = subprocess.run(cmd, cwd=EVAL_DIR, capture_output=True, text=True)
with open(os.path.join(grade_out, "official-stdout.log"), "w") as stream:
    stream.write(proc.stdout)
with open(os.path.join(grade_out, "official-stderr.log"), "w") as stream:
    stream.write(proc.stderr)
if frozen is not None and proc.returncode == 0:
    if verify_frozen_grader() != grader_receipt:
        raise RuntimeError("Official grader inputs changed during evaluation")
    if preds:
        with open(os.path.join(grade_out, "out", "pinned-image-usage.json")) as stream:
            used_images = json.load(stream)
        expected_images = {p["instance_id"]: frozen["images"][p["instance_id"]] for p in preds}
        if used_images != expected_images:
            raise RuntimeError("Official scorer did not use every frozen task image resolver")
    with open(os.path.join(grade_out, "out", "eval_results.json")) as stream:
        official_results = json.load(stream)
    if not isinstance(official_results, dict) or set(official_results) != {p["instance_id"] for p in preds} or any(
        not isinstance(verdict, bool) for verdict in official_results.values()
    ):
        raise RuntimeError("Official grader aggregate differs from the submitted task roster")
    # An absent per-task output is missing measurement. An empty parsed list can
    # also represent a submission-caused suite startup failure; require proof.
    outputs = {}
    measurements = {}
    for prediction in preds:
        uid = prediction["instance_id"]
        output_path = os.path.join(grade_out, "out", uid, f"arm-{arm}_output.json")
        try:
            with open(output_path, "rb") as stream:
                raw = stream.read()
        except OSError as error:
            raise RuntimeError(f"Official grader has no measured test output for {uid}") from error
        output = json.loads(raw)
        if not isinstance(output, dict) or not isinstance(output.get("tests"), list) or any(
            not isinstance(test, dict) or not isinstance(test.get("name"), str) or not test["name"] or test.get("status") not in ("PASSED", "FAILED", "SKIPPED", "ERROR")
            for test in output["tests"]
        ):
            raise RuntimeError(f"Official grader has no measured test output for {uid}")
        measurement = {"kind": "parsed-tests", "count": len(output["tests"])} if output["tests"] else submission_import_failure(
            uid, os.path.dirname(output_path), official_results[uid]
        )
        if measurement is None:
            raise RuntimeError(f"Official grader has no measured test output for {uid}")
        outputs[uid] = hashlib.sha256(raw).hexdigest()
        measurements[uid] = measurement
    grader_receipt["taskOutputSha256"] = outputs
    grader_receipt["taskMeasurements"] = measurements
    with open(f"{grade_out}/grader-receipt.json", "w") as stream:
        json.dump(grader_receipt, stream, sort_keys=True)
# Tail of stderr/stdout for diagnostics
print("[grade] eval exit:", proc.returncode)
sys.stdout.write(proc.stdout[-3000:])
if proc.returncode != 0:
    sys.stderr.write(proc.stderr[-3000:])
    sys.exit(proc.returncode)

results_path = os.path.join(grade_out, "out", "eval_results.json")
if os.path.exists(results_path):
    with open(results_path) as f:
        results = json.load(f)
    resolved = sum(1 for v in results.values() if v is True)
    pct = f"{resolved/len(results)*100:.1f}%" if results else "unmeasured"
    print(f"\n[grade] arm={arm} CONDITIONAL RESOLVED {resolved}/{len(results)} = {pct}")
    print(json.dumps(results, indent=2))
    # write a normalized summary
    with open(os.path.join(OUT_DIR, f"resolved-{arm}.json"), "w") as f:
        json.dump({"arm": arm, "resolved": resolved, "total": len(results), "perInstance": results}, f, indent=2)
else:
    print(f"\n[grade] NO eval_results.json at {results_path} — grading produced no verdict")
    sys.exit(2)
