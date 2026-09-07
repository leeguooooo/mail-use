const { spawnSync } = require("child_process");

function smokeTestInput() {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mail-use-release-smoke-test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map((request) => JSON.stringify(request)).join("\n") + "\n";
}

function parseMcpResponses(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const response = JSON.parse(line);
        return response && typeof response === "object" && response.id != null ? [response] : [];
      } catch {
        return [];
      }
    });
}

function runMcpSmokeTest(binaryPath, { timeoutMs = 30_000 } = {}) {
  if (!binaryPath) throw new Error("MCP smoke test requires a binary path");

  const child = spawnSync(binaryPath, ["mcp", "serve"], {
    input: smokeTestInput(),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (child.error) {
    throw new Error(`MCP smoke test could not start ${binaryPath}: ${child.error.message}`);
  }
  if (child.status !== 0) {
    const stderr = String(child.stderr || "").trim();
    throw new Error(`MCP smoke test exited with code ${child.status}${stderr ? `: ${stderr.slice(-4000)}` : ""}`);
  }

  const responses = parseMcpResponses(child.stdout);
  const initialized = responses.find((response) => response.id === 1);
  if (!initialized || initialized.error || initialized.result?.serverInfo?.name !== "mail-use") {
    throw new Error("MCP smoke test did not receive a valid initialize response");
  }

  const tools = responses.find((response) => response.id === 2);
  if (!tools || tools.error || !Array.isArray(tools.result?.tools) || tools.result.tools.length === 0) {
    throw new Error("MCP smoke test did not receive a non-empty tools/list response");
  }

  return { toolCount: tools.result.tools.length };
}

module.exports = { parseMcpResponses, runMcpSmokeTest };

if (require.main === module) {
  try {
    const result = runMcpSmokeTest(process.argv[2]);
    process.stdout.write(`MCP smoke test passed: ${result.toolCount} tools\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
