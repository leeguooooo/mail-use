// mcp serve / config

const { _out } = require("../cli/render");

function register(program, ctx) {
  const mcpCmd = program.command("mcp").description("Model Context Protocol server (for Claude Desktop / Code / Cursor / etc.)");
  mcpCmd
    .command("serve")
    .description("Run the MCP server over stdio. Configure your AI client to spawn this command.")
    .action(async () => {
      const { startStdioServer } = require("../mcp_server");
      try {
        await startStdioServer();
        // Stdio transport keeps reading from stdin; we have to block here so
        // the Node process doesn't exit and tear down the transport.
        await new Promise((resolve) => {
          process.stdin.on("end", resolve);
          process.stdin.on("close", resolve);
          process.on("SIGINT", resolve);
          process.on("SIGTERM", resolve);
        });
        process.exit(0);
      } catch (e) {
        process.stderr.write(`mcp server failed: ${e && e.message}\n`);
        process.exit(1);
      }
    });
  mcpCmd
    .command("config")
    .description("Print a sample MCP client config snippet for Claude Desktop / Code")
    .action(() => {
      // #22：装机版是单文件二进制（现为 Node SEA，早期是 pkg），process.argv[1] 不是磁盘上
      // 真实存在的脚本（pkg 时代是 /snapshot/... 虚拟路径）——照着它配的客户端一定起不来。
      // 二进制里 execPath 就是 `mail-use` 自己，直接带子命令即可。
      const packaged = require("../packaged").isPackagedBinary();
      const cfg = {
        mcpServers: {
          "mail-use": {
            command: process.execPath,
            args: packaged ? ["mcp", "serve"] : [process.argv[1] || "mail-use", "mcp", "serve"],
          },
        },
      };
      const result = { success: true, config: cfg, hint: "Add the mcpServers entry to your client's config (e.g. ~/Library/Application Support/Claude/claude_desktop_config.json on macOS)" };
      ctx.respond(result, () => _out(JSON.stringify(cfg, null, 2) + "\n"));
    });
}

module.exports = { register };
