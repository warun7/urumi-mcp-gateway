#!/usr/bin/env bash
# Restores a store's database from one of the dumps the store chart takes before every `helm upgrade`
# (pre-upgrade hook, 5 newest kept on the MariaDB volume). `helm rollback` reverts code and config, not data:
# if a WooCommerce upgrade migrated the schema, roll the release back AND restore the dump taken just before it.
#   scripts/restore-store.sh [namespace]                 list the dumps
#   scripts/restore-store.sh [namespace] <dump-file>     restore one (WordPress is stopped meanwhile)
set -euo pipefail
NS="${1:-store-default}"
FILE="${2:-}"
IMAGE="$(kubectl -n "$NS" get sts mariadb -o jsonpath='{.spec.template.spec.containers[0].image}')"
POD="store-restore-$(date +%s)"

if [ -n "$FILE" ]; then
  [[ "$FILE" =~ ^wordpress-[0-9TZ]+\.sql\.gz$ ]] || { echo "expected a dump name like wordpress-20261010T120000Z.sql.gz" >&2; exit 1; }
  SCRIPT="set -eu; f=/backups/$FILE; [ -f \"\$f\" ] || { echo \"no such dump: \$f\"; exit 1; }
    zcat \"\$f\" | tail -n 1 | grep -q '^-- Dump completed' || { echo \"\$f is incomplete; not restoring it\"; exit 1; }
    for i in \$(seq 1 30); do mariadb -h mariadb -u root -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 2; done  # new pod: wait for its NetworkPolicy rules
    echo \"restoring \$f\"; zcat \"\$f\" | mariadb -h mariadb -u root; echo restored"
else
  SCRIPT='ls -1t /backups/*.sql.gz 2>/dev/null | while read -r f; do
    ok=complete; zcat "$f" | tail -n 1 | grep -q "^-- Dump completed" || ok=INCOMPLETE
    echo "$(basename "$f")  $(du -h "$f" | cut -f1)  $ok"; done'
fi

run() {
  # Labelled as the backup Job, so the store's NetworkPolicies let it reach MariaDB (and nothing else).
  # Restricted Pod Security, like everything else in the namespace; RWO volume, so it joins MariaDB's node.
  kubectl -n "$NS" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $POD
  labels: { app.kubernetes.io/name: store-backup, app.kubernetes.io/part-of: urumi }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector: { matchLabels: { app.kubernetes.io/name: mariadb } }
          topologyKey: kubernetes.io/hostname
  securityContext: { runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, fsGroup: 999, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: restore
      image: $IMAGE
      command: ["sh", "-c", $(printf '%s' "$SCRIPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')]
      env:
        - name: MYSQL_PWD
          valueFrom: { secretKeyRef: { name: mariadb, key: root-password } }
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: "1", memory: 512Mi } }
      volumeMounts:
        - { name: data, mountPath: /backups, subPath: backups, readOnly: true }
        - { name: tmp, mountPath: /tmp }
  volumes:
    - { name: data, persistentVolumeClaim: { claimName: data-mariadb-0 } }
    - { name: tmp, emptyDir: {} }
EOF
  trap 'kubectl -n "$NS" delete pod "$POD" --ignore-not-found >/dev/null' RETURN
  local phase=''
  for _ in $(seq 1 150); do
    phase="$(kubectl -n "$NS" get pod "$POD" -o jsonpath='{.status.phase}')"
    [ "$phase" = Succeeded ] || [ "$phase" = Failed ] && break
    sleep 2
  done
  kubectl -n "$NS" logs "$POD" || true
  [ "$phase" = Succeeded ] || { echo "restore pod ended as '${phase:-unknown}'" >&2; return 1; }
}

if [ -z "$FILE" ]; then
  echo "Dumps in $NS (newest first):"; run; exit 0
fi

replicas="$(kubectl -n "$NS" get deploy wordpress -o jsonpath='{.spec.replicas}')"
echo "Stopping WordPress in $NS (no writes during the restore)"
kubectl -n "$NS" scale deploy/wordpress --replicas=0 >/dev/null
kubectl -n "$NS" wait pod -l app.kubernetes.io/name=wordpress --for=delete --timeout=120s >/dev/null || true
status=0
run || status=$?
echo "Starting WordPress"
kubectl -n "$NS" scale deploy/wordpress --replicas="${replicas:-1}" >/dev/null
kubectl -n "$NS" rollout status deploy/wordpress --timeout=180s
exit $status
