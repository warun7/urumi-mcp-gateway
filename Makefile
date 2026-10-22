# Urumi: local k3d environment. `make up` builds everything and deploys it from scratch.
# Requirements: docker, k3d, kubectl, helm (4.x), pnpm, node 24.
SHELL := /bin/bash
CLUSTER   ?= urumi
TAG       ?= dev
NODE_APPS := woo-mcp gateway agent testkit
IMAGES    := $(addprefix urumi/,$(addsuffix :$(TAG),$(NODE_APPS) provisioner dashboard wordpress mcp-fetch))
HELM_WAIT := --rollback-on-failure --wait --timeout 10m
BASE_URL  ?= http://app.127.0.0.1.nip.io
E2E_ENV   = ADMIN_EMAIL=admin@urumi.test ADMIN_PASSWORD="$$(kubectl -n platform get secret gateway -o jsonpath='{.data.admin-password}' | base64 -d)"

.DEFAULT_GOAL := help
.PHONY: help up cluster images import namespaces store platform test-servers register-test-servers status admin-password dod e2e eval eval-offline test typecheck down clean-cluster push prod-up tls-local rotate-kek chat-llm chat-scripted isolation charts-check lint-sh build vps-kubeconfig vps-images

help: ## Show targets
	@grep -hE '^[a-zA-Z0-9_%-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

up: cluster images import namespaces store platform test-servers register-test-servers ## Create the cluster, build images, deploy everything
	@echo; echo "Ready: $(BASE_URL)  (admin password: make admin-password)"

cluster: ## Create the k3d cluster (idempotent)
	@k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create --config deploy/k3d/cluster.yaml

images: $(addprefix image-,$(NODE_APPS)) image-provisioner image-dashboard image-wordpress image-mcp-fetch ## Build all images

image-%:
	docker build -f images/node-app/Dockerfile --build-arg APP=$* -t urumi/$*:$(TAG) .

image-provisioner:
	docker build -f images/provisioner/Dockerfile -t urumi/provisioner:$(TAG) .

image-dashboard:
	docker build -f images/dashboard/Dockerfile -t urumi/dashboard:$(TAG) .

image-wordpress:
	docker build -t urumi/wordpress:$(TAG) images/wordpress

image-mcp-fetch:
	docker build -t urumi/mcp-fetch:$(TAG) images/mcp-fetch

import: ## Load the images into the k3d cluster, and check that every one arrived
	scripts/import-images.sh $(CLUSTER) $(IMAGES)

namespaces: ## Namespaces with Pod Security + NetworkPolicy labels
	kubectl apply -f deploy/namespaces.yaml

store: ## Install/upgrade the default WooCommerce store
	helm upgrade --install store-default charts/store -n store-default -f charts/store/values-local.yaml $(HELM_WAIT)

# .dev/values-llm.yaml (gitignored, written by `make chat-llm`) holds the real-model settings, never the key.
LLM_VALUES = $(if $(wildcard .dev/values-llm.yaml),-f .dev/values-llm.yaml)

platform: ## Install/upgrade the platform (gateway, agent, dashboard, postgres, fetch, provisioner)
	helm upgrade --install platform charts/platform -n platform -f charts/platform/values-local.yaml $(LLM_VALUES) $(HELM_WAIT)

LLM_BASE_URL ?= https://api.openai.com/v1
LLM_MODEL    ?= gpt-4.1-mini
chat-llm: ## Switch the chat agent to a real model (any OpenAI-compatible API; prompts for the key): make chat-llm LLM_MODEL=...
	@read -rsp "API key for $(LLM_BASE_URL): " k; echo; [ -n "$$k" ] || { echo "no key given"; exit 1; }; \
	  printf %s "$$k" | kubectl -n platform create secret generic agent-llm --from-file=LLM_API_KEY=/dev/stdin \
	    --dry-run=client -o yaml | kubectl apply -f - >/dev/null && echo "secret platform/agent-llm saved"
	@mkdir -p .dev && printf 'agent:\n  llm:\n    provider: openai\n    baseUrl: %s\n    model: %s\n    existingSecret: agent-llm\n' \
	  "$(LLM_BASE_URL)" "$(LLM_MODEL)" > .dev/values-llm.yaml
	$(MAKE) platform
	kubectl -n platform rollout restart deploy/agent && kubectl -n platform rollout status deploy/agent

chat-scripted: ## Back to the deterministic scripted model (no API key)
	rm -f .dev/values-llm.yaml && $(MAKE) platform

# On the VPS: MCP_SERVER_ARGS="--set image.repository=local/urumi-testkit --set image.tag=0.1.0"
MCP_SERVER_ARGS ?=
test-servers: ## Deploy the test MCP servers (chaos, collide, evil, toolfarm) into mcp-servers
	@kubectl -n mcp-servers get secret chaos-auth >/dev/null 2>&1 || \
	  kubectl -n mcp-servers create secret generic chaos-auth --from-literal=token="$$(openssl rand -hex 24)"
	helm upgrade --install testkit-chaos charts/mcp-server -n mcp-servers --set mode=chaos \
	  --set auth.header=x-api-key --set auth.existingSecret=chaos-auth $(MCP_SERVER_ARGS) $(HELM_WAIT)
	@for m in collide evil toolfarm; do \
	  helm upgrade --install testkit-$$m charts/mcp-server -n mcp-servers --set mode=$$m $(MCP_SERVER_ARGS) $(HELM_WAIT) || exit 1; \
	done

register-test-servers: ## Register the test servers with the gateway (admin API)
	cd e2e && BASE_URL=$(BASE_URL) $(E2E_ENV) \
	  CHAOS_TOKEN="$$(kubectl -n mcp-servers get secret chaos-auth -o jsonpath='{.data.token}' | base64 -d)" \
	  pnpm exec tsx scripts/register-test-servers.ts

restart-%: ## Rebuild one node app and roll it, e.g. make restart-gateway
	$(MAKE) image-$* && scripts/import-images.sh $(CLUSTER) urumi/$*:$(TAG) && kubectl -n platform rollout restart deploy/$* && kubectl -n platform rollout status deploy/$*

rotate-kek: ## Rotate the gateway's credential-encryption key (3 rolling restarts, no downtime)
	scripts/rotate-kek.sh

status: ## Pods and releases
	@kubectl get pods -A -l app.kubernetes.io/part-of=urumi -o wide; echo; helm list -A

admin-password: ## Print the admin password
	@kubectl -n platform get secret gateway -o jsonpath='{.data.admin-password}' | base64 -d; echo

dod: ## Walk the assignment's definition of done (two users) against the cluster
	cd e2e && BASE_URL=$(BASE_URL) $(E2E_ENV) pnpm exec tsx scripts/dod-flow.ts

# A fresh port-forward to the chaos server's admin API per suite: dod-flow kills that pod, which ends any forward to it.
e2e: ## Run the end-to-end suites against the cluster
	@cd e2e && export BASE_URL=$(BASE_URL) $(E2E_ENV) CHAOS_ADMIN_URL=http://127.0.0.1:18191; rc=0; \
	for s in dod-flow gateway-flow oauth-flow resilience-flow chat-flow store-flow; do echo "=== $$s"; \
	  kubectl -n mcp-servers port-forward svc/testkit-chaos 18191:8080 >/dev/null 2>&1 & PF=$$!; \
	  for i in $$(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:18191/healthz && break; sleep 0.5; done; \
	  pnpm exec tsx scripts/$$s.ts || rc=1; kill $$PF 2>/dev/null; wait $$PF 2>/dev/null; \
	done; exit $$rc

isolation: ## Prove the NetworkPolicies: what each workload can and can't reach (TCP probes from inside the pods)
	scripts/isolation-proof.sh

eval: ## Tool-search evaluation against the live gateway (writes eval/RESULTS.md, refreshes the snapshot)
	cd e2e && BASE_URL=$(BASE_URL) $(E2E_ENV) pnpm exec tsx ../eval/run.ts

eval-offline: ## Tool-search evaluation against eval/catalog.snapshot.json (no cluster needed)
	cd e2e && pnpm exec tsx ../eval/offline.ts

# CI runs these same targets (.github/workflows/ci.yml), so a red check reproduces locally.
RENDER := .dev/render
charts-check: ## Lint and render every chart x values file; policy-check (probes, limits, non-root, pinned images) and schema-check them
	@rm -rf $(RENDER) && mkdir -p $(RENDER)
	@for c in platform store; do for v in local prod; do \
	  helm lint --quiet charts/$$c -f charts/$$c/values-$$v.yaml >/dev/null || exit 1; \
	  helm template t charts/$$c -n $$c -f charts/$$c/values-$$v.yaml > $(RENDER)/$$c-$$v.yaml || exit 1; \
	  python3 scripts/check-manifests.py $$c/$$v $$([ $$v = prod ] && echo --no-secrets) < $(RENDER)/$$c-$$v.yaml || exit 1; \
	done; done
	@helm lint --quiet charts/mcp-server >/dev/null && helm template t charts/mcp-server -n mcp-servers --set mode=chaos > $(RENDER)/mcp-server.yaml \
	  && python3 scripts/check-manifests.py mcp-server < $(RENDER)/mcp-server.yaml
	docker run --rm -v "$(CURDIR)/$(RENDER):/r:ro" ghcr.io/yannh/kubeconform:v0.7.0 -strict -summary -kubernetes-version 1.35.0 -ignore-missing-schemas /r

lint-sh: ## shellcheck every shell script
	docker run --rm -v "$(CURDIR):/mnt:ro" -w /mnt koalaman/shellcheck:v0.11.0 -S warning scripts/*.sh deploy/vps/*.sh

build: ## Build every package (esbuild bundles, the dashboard)
	pnpm -r run --if-present build

test: ## Unit tests
	pnpm -r --filter './apps/*' run --if-present test

typecheck: ## Typecheck every package
	pnpm -r run --if-present typecheck

# ------------------------------------------------------------------ VPS (k3s), see deploy/vps/ and the README
REGISTRY    ?= ghcr.io/OWNER
DOMAIN      ?= urumi.example.com
ISSUER      ?= letsencrypt-staging
ADMIN_EMAIL ?= admin@$(DOMAIN)
PLATFORMS   ?= linux/amd64,linux/arm64
BUILDX      := docker buildx build --platform $(PLATFORMS) --push
img = --set images.$(1).repository=$(REGISTRY)/urumi-$(2) --set images.$(1).tag=$(TAG)
# The provisioner and gateway talk to the API server; narrow their egress to its real address.
KUBE_API_IP = $$(kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes -o jsonpath='{.items[0].endpoints[0].addresses[0]}')

push: ## Build multi-arch production images and push them: make push REGISTRY=ghcr.io/you TAG=0.1.0
	@[ "$(TAG)" != dev ] || { echo "set TAG (e.g. TAG=0.1.0)"; exit 1; }
	@for a in woo-mcp gateway agent; do \
	  $(BUILDX) -f images/node-app/Dockerfile --build-arg APP=$$a -t $(REGISTRY)/urumi-$$a:$(TAG) . || exit 1; done
	$(BUILDX) -f images/provisioner/Dockerfile -t $(REGISTRY)/urumi-provisioner:$(TAG) .
	$(BUILDX) -f images/dashboard/Dockerfile -t $(REGISTRY)/urumi-dashboard:$(TAG) .
	$(BUILDX) -t $(REGISTRY)/urumi-wordpress:$(TAG) images/wordpress
	$(BUILDX) -t $(REGISTRY)/urumi-mcp-fetch:$(TAG) images/mcp-fetch

# TLS=off: plain HTTP with no cert-manager, for a server without a domain yet (DOMAIN=<ip>.sslip.io).
TLS ?= on
ifeq ($(TLS),off)
STORE_TLS    := --set store.scheme=http --set ingress.tls.enabled=false
PLATFORM_TLS := --set publicScheme=http --set ingress.tls.enabled=false \
                --set stores.scheme=http --set stores.storeValues.ingress.tls.enabled=false
else
STORE_TLS    := --set ingress.tls.clusterIssuer=$(ISSUER)
PLATFORM_TLS := --set ingress.tls.clusterIssuer=$(ISSUER) --set stores.storeValues.ingress.tls.clusterIssuer=$(ISSUER)
endif
# No platform/agent-llm Secret (no LLM_API_KEY given to create-secrets.sh) -> the free scripted chat model.
LLM_FALLBACK = $$(kubectl -n platform get secret agent-llm >/dev/null 2>&1 || echo --set agent.llm.provider=scripted)

prod-up: ## Deploy to the VPS cluster (after deploy/vps/setup-cluster.sh): make prod-up DOMAIN=example.com REGISTRY=ghcr.io/you TAG=0.1.0 [TLS=off]
	@[ "$(TAG)" != dev ] || { echo "set TAG to the pushed version (e.g. TAG=0.1.0)"; exit 1; }
	helm upgrade --install store-default charts/store -n store-default -f charts/store/values-prod.yaml \
	  --set store.host=shop.$(DOMAIN) --set store.adminEmail=$(ADMIN_EMAIL) $(STORE_TLS) \
	  $(call img,wordpress,wordpress) $(call img,wooMcp,woo-mcp) $(HELM_WAIT)
	helm upgrade --install platform charts/platform -n platform -f charts/platform/values-prod.yaml \
	  --set publicHost=app.$(DOMAIN) --set admin.email=$(ADMIN_EMAIL) $(PLATFORM_TLS) $(LLM_FALLBACK) \
	  --set stores.domain=shop.$(DOMAIN) \
	  --set stores.storeValues.images.wordpress.repository=$(REGISTRY)/urumi-wordpress --set stores.storeValues.images.wordpress.tag=$(TAG) \
	  --set stores.storeValues.images.wooMcp.repository=$(REGISTRY)/urumi-woo-mcp --set stores.storeValues.images.wooMcp.tag=$(TAG) \
	  --set "networkPolicy.kubeApi.cidrs={$(KUBE_API_IP)/32}" \
	  $(call img,gateway,gateway) $(call img,agent,agent) $(call img,dashboard,dashboard) \
	  $(call img,fetch,mcp-fetch) $(call img,provisioner,provisioner) $(HELM_WAIT)
	@echo; [ "$(TLS)" = off ] || kubectl get certificates -A; echo
	@echo "$(if $(filter off,$(TLS)),http,https)://app.$(DOMAIN)  (admin: $(ADMIN_EMAIL), password: make admin-password)"

# ------------------------------------------------------------------ VPS without a registry (deploy/vps/README in the main README)
# The API server stays closed to the internet (bootstrap-node.sh opens 6443 only to ADMIN_CIDR): kubectl and
# helm reach it through an SSH tunnel, with the kubeconfig in .dev/ (gitignored).
VPS            ?=
VPS_KUBECONFIG := $(CURDIR)/.dev/kubeconfig-vps
vps-kubeconfig: ## Fetch the server's kubeconfig and open an SSH tunnel to its API: make vps-kubeconfig VPS=root@<ip>
	@[ -n "$(VPS)" ] || { echo "set VPS=root@<server ip>"; exit 1; }
	@mkdir -p .dev && umask 077 && ssh $(VPS) cat /etc/rancher/k3s/k3s.yaml \
	  | sed 's#https://127.0.0.1:6443#https://127.0.0.1:16443#' > $(VPS_KUBECONFIG)
	@pgrep -f -- '-L 16443:127.0.0.1:6443 $(VPS)' >/dev/null || \
	  ssh -fN -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 16443:127.0.0.1:6443 $(VPS)
	@KUBECONFIG=$(VPS_KUBECONFIG) kubectl get nodes
	@echo "Now: export KUBECONFIG=$(VPS_KUBECONFIG)"

# Builds the production images for the server's CPU and streams them into its k3s (docker save | k3s ctr import):
# no registry and no pull secrets, since every chart uses pullPolicy IfNotPresent. REGISTRY is then just a name prefix.
VPS_PLATFORM ?= linux/amd64
VPS_IMAGES   := woo-mcp gateway agent testkit provisioner dashboard wordpress mcp-fetch
VPS_BUILD    := docker buildx build --platform $(VPS_PLATFORM) --load
vps-images: ## Build images for the server and copy them in over SSH: make vps-images VPS=root@<ip> REGISTRY=local TAG=0.1.0
	@[ -n "$(VPS)" ] || { echo "set VPS=root@<server ip>"; exit 1; }
	@[ "$(TAG)" != dev ] || { echo "set TAG (e.g. TAG=0.1.0)"; exit 1; }
	@for a in woo-mcp gateway agent testkit; do \
	  $(VPS_BUILD) -f images/node-app/Dockerfile --build-arg APP=$$a -t $(REGISTRY)/urumi-$$a:$(TAG) . || exit 1; done
	$(VPS_BUILD) -f images/provisioner/Dockerfile -t $(REGISTRY)/urumi-provisioner:$(TAG) .
	$(VPS_BUILD) -f images/dashboard/Dockerfile -t $(REGISTRY)/urumi-dashboard:$(TAG) .
	$(VPS_BUILD) -t $(REGISTRY)/urumi-wordpress:$(TAG) images/wordpress
	$(VPS_BUILD) -t $(REGISTRY)/urumi-mcp-fetch:$(TAG) images/mcp-fetch
	docker save $(foreach i,$(VPS_IMAGES),$(REGISTRY)/urumi-$(i):$(TAG)) | gzip -1 \
	  | ssh $(VPS) 'gunzip | k3s ctr -n k8s.io images import -'

tls-local: ## Rehearse the VPS TLS path on k3d: cert-manager + a local CA instead of Let's Encrypt, platform on https
	ACME_EMAIL=rehearsal@urumi.test deploy/vps/setup-cluster.sh
	kubectl apply -f deploy/k3d/local-ca.yaml
	kubectl -n cert-manager wait certificate/urumi-local-ca --for=condition=Ready --timeout=90s
	helm upgrade --install platform charts/platform -n platform -f charts/platform/values-local.yaml \
	  --set publicScheme=https --set ingress.tls.enabled=true --set ingress.tls.clusterIssuer=local-ca $(HELM_WAIT)
	kubectl -n platform wait certificate/platform-tls --for=condition=Ready --timeout=120s
	@mkdir -p .dev && kubectl -n cert-manager get secret urumi-local-ca -o jsonpath='{.data.ca\.crt}' | base64 -d > .dev/local-ca.crt
	curl -sf --cacert .dev/local-ca.crt -o /dev/null -w 'TLS ok: %{url_effective}\n' https://app.127.0.0.1.nip.io/.well-known/oauth-authorization-server
	@echo "e2e over TLS: NODE_EXTRA_CA_CERTS=$$PWD/.dev/local-ca.crt make e2e BASE_URL=https://app.127.0.0.1.nip.io   (back to http: make platform)"

down: ## Uninstall releases (keeps the cluster and PVC data)
	-helm uninstall platform -n platform
	-helm uninstall store-default -n store-default

clean-cluster: ## Delete the whole k3d cluster
	k3d cluster delete $(CLUSTER)
