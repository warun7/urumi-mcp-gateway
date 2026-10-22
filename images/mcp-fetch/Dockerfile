# Third-party upstream #2: a stdio MCP server (mcp-fetch-server) exposed over Streamable HTTP by supergateway.
# Both pinned and installed at build time: no `npx` downloads when the pod starts.
FROM node:24.18-alpine
RUN npm install -g --omit=dev supergateway@4.1.0 mcp-fetch-server@1.1.2 \
 && npm cache clean --force
USER 1000:1000
EXPOSE 8080
# --stateful: one child process per MCP session. Stateless mode spawns a fresh Node process for EVERY request, so the
# gateway's health ping alone cost ~0.4 CPU. The gateway holds one session per replica and re-initializes if it's lost.
ENTRYPOINT ["supergateway", "--outputTransport", "streamableHttp", "--port", "8080", "--logLevel", "info", "--stateful", "--sessionTimeout", "600000"]
CMD ["--stdio", "mcp-fetch-server"]
