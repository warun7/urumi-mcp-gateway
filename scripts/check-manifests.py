#!/usr/bin/env python3
"""Policy check over rendered Helm output (CI runs it on every chart x values file):
  - every container, init container and Job container has CPU and memory requests and limits;
  - every long-running container (Deployment, StatefulSet, DaemonSet) has readiness and liveness probes;
  - pods run as non-root, without privilege escalation, on a read-only root filesystem;
  - images are pinned (no ':latest', no missing tag);
  - with --no-secrets (production values): the chart renders no Secret objects, since they're created outside Helm.
Usage: helm template ... | scripts/check-manifests.py <label> [--no-secrets]
"""
import sys
import yaml

label = sys.argv[1] if len(sys.argv) > 1 else "manifests"
no_secrets = "--no-secrets" in sys.argv
docs = [d for d in yaml.safe_load_all(sys.stdin) if d]
problems = []


def pod_spec(obj):
    kind = obj.get("kind")
    spec = obj.get("spec", {})
    if kind in ("Deployment", "StatefulSet", "DaemonSet", "Job"):
        return spec.get("template", {}).get("spec")
    if kind == "CronJob":
        return spec.get("jobTemplate", {}).get("spec", {}).get("template", {}).get("spec")
    if kind == "Pod":
        return spec
    return None


workloads = 0
for obj in docs:
    kind, name = obj.get("kind"), obj.get("metadata", {}).get("name")
    where = f"{kind}/{name}"
    if no_secrets and kind == "Secret":
        problems.append(f"{where}: production values must not render Secrets (secrets.existingSecrets)")
    spec = pod_spec(obj)
    if spec is None:
        continue
    workloads += 1
    long_running = kind in ("Deployment", "StatefulSet", "DaemonSet")
    pod_sc = spec.get("securityContext", {}) or {}
    for group in ("initContainers", "containers"):
        for c in spec.get(group, []) or []:
            cw = f"{where} {group[:-1]} {c.get('name')}"
            res = c.get("resources", {}) or {}
            for part in ("requests", "limits"):
                for r in ("cpu", "memory"):
                    if r not in (res.get(part) or {}):
                        problems.append(f"{cw}: no {r} {part[:-1]}")
            if long_running and group == "containers":
                for probe in ("readinessProbe", "livenessProbe"):
                    if probe not in c:
                        problems.append(f"{cw}: no {probe}")
            image = str(c.get("image", ""))
            tag = image.rsplit("/", 1)[-1]
            if "@" not in tag and (":" not in tag or tag.endswith(":latest")):
                problems.append(f"{cw}: image '{image}' is not pinned")
            sc = c.get("securityContext", {}) or {}
            if not (sc.get("runAsNonRoot") or pod_sc.get("runAsNonRoot")):
                problems.append(f"{cw}: runAsNonRoot not set")
            if sc.get("allowPrivilegeEscalation") is not False:
                problems.append(f"{cw}: allowPrivilegeEscalation is not false")
            if sc.get("readOnlyRootFilesystem") is not True:
                problems.append(f"{cw}: readOnlyRootFilesystem is not true")

if problems:
    print(f"✘ {label}: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)
print(f"✔ {label}: {workloads} workloads, {len(docs)} objects pass")
