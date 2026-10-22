{{/* Common labels */}}
{{- define "store.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
urumi.io/store: {{ .Values.store.name | quote }}
{{- end }}

{{/* Labels that never change across chart versions: for volumeClaimTemplates, which are immutable once created
(a helm.sh/chart label there made every chart version bump fail with "updates to statefulset spec ... are forbidden"). */}}
{{- define "store.stableLabels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/instance: {{ .Release.Name }}
urumi.io/store: {{ .Values.store.name | quote }}
{{- end }}

{{- define "store.selector" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "store.url" -}}
{{ .Values.store.scheme }}://{{ .Values.store.host }}
{{- end }}

{{- define "store.image" -}}
{{ .repository }}:{{ .tag }}
{{- end }}

{{/* Restricted-PSS compliant container security context */}}
{{- define "store.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/*
Generate-or-keep a secret value. Usage:
  {{ include "store.secretValue" (dict "ctx" . "secret" "mariadb" "key" "password" "length" 32) }}
Returns a base64 value: the existing one if the Secret already exists (so upgrades never
rotate DB passwords out from under the data directory), otherwise a fresh random one.
*/}}
{{- define "store.secretValue" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- if and $existing (hasKey $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else -}}
{{- $prefix := default "" .prefix -}}
{{- if .hex -}}
{{- printf "%s%s" $prefix (randAlphaNum 64 | sha1sum) | b64enc -}}
{{- else -}}
{{- printf "%s%s" $prefix (randAlphaNum (int (default 32 .length))) | b64enc -}}
{{- end -}}
{{- end -}}
{{- end }}

{{- define "store.wpEnv" -}}
- name: WORDPRESS_DB_HOST
  value: "mariadb:3306"
- name: WORDPRESS_DB_NAME
  value: wordpress
- name: WORDPRESS_DB_USER
  value: wordpress
- name: WORDPRESS_DB_PASSWORD
  valueFrom: { secretKeyRef: { name: mariadb, key: password } }
{{- range $k := list "AUTH_KEY" "SECURE_AUTH_KEY" "LOGGED_IN_KEY" "NONCE_KEY" "AUTH_SALT" "SECURE_AUTH_SALT" "LOGGED_IN_SALT" "NONCE_SALT" }}
- name: WORDPRESS_{{ $k }}
  valueFrom: { secretKeyRef: { name: wordpress, key: {{ $k | lower | replace "_" "-" }} } }
{{- end }}
- name: WP_HOME
  value: {{ include "store.url" . | quote }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', getenv('WP_HOME'));
    define('WP_SITEURL', getenv('WP_HOME'));
    // TLS terminates at Traefik: trust X-Forwarded-Proto so WordPress knows it is on https.
    if (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') { $_SERVER['HTTPS'] = 'on'; }
    // Code is immutable (baked into the image): no plugin/theme installs or edits at runtime.
    define('DISALLOW_FILE_MODS', true);
    define('AUTOMATIC_UPDATER_DISABLED', true);
    define('WP_AUTO_UPDATE_CORE', false);
    {{- if eq .Values.store.scheme "https" }}
    define('FORCE_SSL_ADMIN', true);
    {{- end }}
{{- end }}
