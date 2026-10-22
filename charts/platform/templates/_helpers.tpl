{{- define "platform.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "platform.selector" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "platform.publicUrl" -}}
{{ .Values.publicScheme }}://{{ .Values.publicHost }}
{{- end }}

{{- define "platform.image" -}}
{{ .repository }}:{{ .tag }}
{{- end }}

{{/* Restricted Pod Security Standard: non-root, no privilege escalation, no capabilities, read-only root. */}}
{{- define "platform.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{- define "platform.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ .uid | default 1000 }}
runAsGroup: {{ .uid | default 1000 }}
{{- if .fsGroup }}
fsGroup: {{ .fsGroup }}
{{- end }}
seccompProfile: { type: RuntimeDefault }
{{- end }}

{{/*
Generate-or-keep a secret value (base64). The existing value wins, so upgrades never rotate keys
that encrypt data at rest (KEK), hash credentials (pepper) or unlock the database.
  include "platform.secretValue" (dict "ctx" . "secret" "gateway" "key" "token-pepper" "length" 48)
*/}}
{{- define "platform.secretValue" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- if and $existing (hasKey $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else if .value -}}
{{- .value | b64enc -}}
{{- else -}}
{{- randAlphaNum (int (default 32 .length)) | b64enc -}}
{{- end -}}
{{- end }}

{{/* A 256-bit AES key as "<kid>:<base64 of 32 random bytes>" for KEK_KEYS (rotation: docs/runbooks.md). */}}
{{- define "platform.kek" -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace "gateway" -}}
{{- if and $existing (hasKey $existing.data "kek-keys") -}}
{{- index $existing.data "kek-keys" -}}
{{- else -}}
{{- printf "k1:%s" (randBytes 32) | b64enc -}}
{{- end -}}
{{- end }}

{{/* Environment shared by the gateway container and its migration initContainer. */}}
{{- define "platform.gatewayEnv" }}
envFrom:
  - configMapRef: { name: gateway }
env:
  - name: PG_APP_PASSWORD
    valueFrom: { secretKeyRef: { name: postgres, key: app-password } }
  - name: DATABASE_URL
    value: "postgres://urumi_app:$(PG_APP_PASSWORD)@postgres:5432/urumi"
  - name: KEK_KEYS
    valueFrom: { secretKeyRef: { name: gateway, key: kek-keys } }
  - name: TOKEN_PEPPER
    valueFrom: { secretKeyRef: { name: gateway, key: token-pepper } }
  - name: INTERNAL_TOKEN
    valueFrom: { secretKeyRef: { name: gateway, key: internal-token } }
  - name: ADMIN_PASSWORD
    valueFrom: { secretKeyRef: { name: gateway, key: admin-password } }
  {{- if .Values.bootstrap.wooStore.enabled }}
  - name: WOO_DEFAULT_TOKEN
    valueFrom: { secretKeyRef: { name: bootstrap-upstreams, key: woo-token } }
  {{- end }}
{{- end }}

{{- define "platform.publicInternet" -}}
{{/* Any public address: everything except loopback, link-local (cloud metadata!), CGNAT and private
# ranges, which also excludes the k3s pod (10.42/16) and service (10.43/16) networks. */}}
- ipBlock:
    cidr: 0.0.0.0/0
    except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16, 127.0.0.0/8, 0.0.0.0/8]
{{- end }}

{{/* Egress rule to the Kubernetes API server (gateway with stores on, provisioner). */}}
{{- define "platform.kubeApiEgress" -}}
- to:
    {{- range .Values.networkPolicy.kubeApi.cidrs }}
    - ipBlock: { cidr: {{ . }} }
    {{- end }}
  ports:
    {{- range .Values.networkPolicy.kubeApi.ports }}
    - { port: {{ . }}, protocol: TCP }
    {{- end }}
{{- end }}
