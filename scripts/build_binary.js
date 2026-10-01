#!/usr/bin/env node
// 把 CLI 打成单文件可执行：esbuild 出一个 CJS bundle，再用 Node 自带的
// Single Executable Applications（SEA）把它注入一份 node 二进制。
//
// 以前用的是 vercel/pkg 5：只支持到 Node 18（已 EOL），项目本身也已停更。SEA 是 Node
// 官方能力，运行时就是构建时跑脚本的那份 node——CI 里由 actions/setup-node 决定
// （见 .github/workflows/release-binaries.yml 的 SHIPPED_NODE）。
//
//   node scripts/build_binary.js [--skip-install] [--skip-tests]
//
// CI 里依赖已装好、测试由单独的 job 跑过一次，所以两个 flag 都会带上。

const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const { runMcpSmokeTest } = require("./mcp_smoke_test");

// SEA 注入时用的固定哨兵，写死在 node 二进制里（Node 文档给出的值）。
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const SUPPORTED = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);

function run(cmd, args, opts = {}) {
  child_process.execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// 运行时代码（upgrade.js / daemon.js / main.js）靠 `process.pkg` 判断"我是不是发布出去的
// 单文件二进制"：是的话 execPath 就是 mail-use 本身，自升级、daemon 单元文件、MCP 配置
// 都按这个走。SEA 没有 process.pkg，不补的话二进制会把自己当成 `node script.js`，
// upgrade 拒绝升级、daemon install 写出 `"" <binary>` 这种起不来的单元。
// 这段 banner 在 SEA 里补一个同名标记，让现有判断照旧成立；源码改成直接问
// `require("node:sea").isSea()` 之后可以删掉。
const SEA_BANNER = [
  "try {",
  '  if (typeof process.pkg === "undefined" && require("node:sea").isSea()) {',
  '    Object.defineProperty(process, "pkg", { value: Object.freeze({ sea: true }), enumerable: false });',
  "  }",
  "} catch {}",
].join("\n");

function bundle(entry, root, outFile, nodeMajor) {
  const esbuild = require.resolve("esbuild/bin/esbuild", { paths: [root] });
  console.log(`Bundling with esbuild -> ${outFile}`);
  // esbuild 认 exports 映射、会把 ESM 转 CJS（#22：@modelcontextprotocol/sdk 是 ESM + 通配
  // exports）。SEA 的入口脚本里 require 只能加载内置模块，所以 bundle 必须完全自包含——
  // 这一点由下面的 smoke test 真正跑一遍来兜底。
  run(esbuild, [
    entry,
    "--bundle",
    "--platform=node",
    `--target=node${nodeMajor}`,
    "--format=cjs",
    `--banner:js=${SEA_BANNER}`,
    `--outfile=${outFile}`,
    "--log-level=warning",
  ]);
  if (!fs.existsSync(outFile)) throw new Error(`esbuild did not produce ${outFile}`);
}

async function buildSea({ bundleFile, outBin, workDir }) {
  const blob = path.join(workDir, "sea-prep.blob");
  const config = path.join(workDir, "sea-config.json");
  fs.writeFileSync(
    config,
    JSON.stringify(
      {
        main: bundleFile,
        output: blob,
        disableExperimentalSEAWarning: true,
        // 预编译的 V8 code cache：启动时省掉 13MB bundle 的解析/编译。
        // cache 与 node 版本、平台绑定——每个平台各自构建，正好满足。
        useCodeCache: true,
      },
      null,
      2,
    ),
  );
  run(process.execPath, ["--experimental-sea-config", config]);

  fs.rmSync(outBin, { force: true });
  fs.copyFileSync(process.execPath, outBin);
  fs.chmodSync(outBin, 0o755);

  const darwin = process.platform === "darwin";
  // macOS：官方 node 带签名，注入会让签名失效，先剥掉、注入后再 ad-hoc 签回去
  // （arm64 上没有有效签名的 Mach-O 会被内核直接 SIGKILL）。
  if (darwin) run("codesign", ["--remove-signature", outBin]);

  const { inject } = require("postject");
  await inject(outBin, "NODE_SEA_BLOB", fs.readFileSync(blob), {
    sentinelFuse: SEA_FUSE,
    ...(darwin ? { machoSegmentName: "NODE_SEA" } : {}),
  });

  if (darwin) run("codesign", ["--sign", "-", "--force", outBin]);
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const skipInstall = argv.has("--skip-install");
  const skipTests = argv.has("--skip-tests");

  const target = `${process.platform}-${process.arch}`;
  if (!SUPPORTED.has(target)) {
    console.error(`Unsupported platform for binary build: ${target}`);
    process.exit(1);
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) {
    console.error(`SEA build needs Node >= 22 (running ${process.version}); the binary embeds this node.`);
    process.exit(1);
  }

  const root = path.join(__dirname, "..");
  const entry = path.join(root, "packages", "cli", "bin", "mail-use.js");
  const outDir = path.join(root, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const outBin = path.join(outDir, "mail-use");
  const bundleFile = path.join(outDir, "mail-use.bundle.cjs");

  console.log(`Building mail-use binary: target=${target} node=${process.version} (SEA)`);
  if (!skipInstall) run("pnpm", ["-C", root, "install", "--frozen-lockfile"]);
  if (!skipTests) run("pnpm", ["-C", root, "test"]);

  bundle(entry, root, bundleFile, nodeMajor);
  await buildSea({ bundleFile, outBin, workDir: outDir });
  if (!fs.existsSync(outBin)) throw new Error(`SEA build did not produce ${outBin}`);

  // 真的把二进制跑起来，走一遍 MCP initialize + tools/list 再放行。
  // #22 那种 CI 全绿、发出去才发现起不来的事故，只有端到端启动一次才拦得住。
  const smoke = runMcpSmokeTest(outBin);
  console.log(`MCP smoke test passed: ${smoke.toolCount} tools`);

  // 发布走 GitHub Releases：CI 把 dist/mail-use 打成 tar.gz 挂到 Release 上，
  // install.sh 直接拉。没有 npm 这一环，也就没有 NPM_TOKEN 和 2FA。
  console.log(`Binary ready: ${outBin} (${(fs.statSync(outBin).size / 1048576).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
