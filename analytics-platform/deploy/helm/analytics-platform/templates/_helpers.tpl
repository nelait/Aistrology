{{- define "ap.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ap.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "ap.cloud" -}}
{{- $c := .Values.cloud | default "" -}}
{{- if not (has $c (list "gcp" "aws" "local")) -}}
{{- fail (printf "values.cloud must be one of gcp, aws, local (got %q)" $c) -}}
{{- end -}}
{{- $c -}}
{{- end }}

{{- define "ap.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "ap.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: analytics-platform
{{- end }}

{{/* Selector labels; pass (dict "ctx" $ "component" "api") */}}
{{- define "ap.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ap.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "ap.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ap.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "ap.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* Env sources shared by api and worker. */}}
{{- define "ap.envFrom" -}}
- configMapRef:
    name: {{ include "ap.fullname" . }}-env
{{- with .Values.secretEnv.existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- end }}

{{- define "ap.volumeMounts" -}}
- name: tmp
  mountPath: /tmp
- name: data
  mountPath: /data
{{- end }}

{{- define "ap.volumes" -}}
- name: tmp
  emptyDir:
    sizeLimit: {{ .Values.volumes.tmp.sizeLimit }}
- name: data
  emptyDir:
    sizeLimit: {{ .Values.volumes.data.sizeLimit }}
{{- end }}

{{/* pass (dict "ctx" $ "component" "api") */}}
{{- define "ap.topologySpread" -}}
{{- if .ctx.Values.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: {{ .ctx.Values.topologySpread.maxSkew }}
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: {{ .ctx.Values.topologySpread.whenUnsatisfiable }}
    labelSelector:
      matchLabels:
        {{- include "ap.selectorLabels" . | nindent 8 }}
  - maxSkew: {{ .ctx.Values.topologySpread.maxSkew }}
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "ap.selectorLabels" . | nindent 8 }}
{{- end }}
{{- end }}
