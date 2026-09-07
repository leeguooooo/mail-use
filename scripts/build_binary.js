#!/usr/bin/env node

const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const { runMcpSmokeTest } = require("./mcp_smoke_test");

function pkgTarget() {
  const platform = process.platform;
  const arch = process.arch;

  // pkg currently supports up to Node 18 targets.
  if (platform === "darwin" && arch === "arm64") return "node18-macos-arm64";
  if (platform === "darwin" && arch === "x64") return "node18-macos-x64";
  if (platform === "linux" && arch === "x64") return "node18-linux-x64";
  return null;
}

function run(cmd, args) {
  child_process.execFileSync(cmd, args, { stdio: "inherit" });
}

// #22：pkg 5 不实现 package.json 的 `exports` 字段。`@modelcontextprotocol/sdk` 正是
// "type": "module" + 通配 exports 的包——pkg 追不到它的文件，只打一句 **Warning** 就退出码 0，
// 于是 CI 全绿、release 照发，用户装上一跑 `mcp serve` 才发现二进制根本是坏的。
//
// 修法分两层：
//  1) 先用 esbuild 把 CLI 打成单文件 CJS。esbuild 认 exports 映射、也会把 ESM 转成 CJS，
//     pkg 拿到的就只是一个普通文件，再没有解析问题。
//  2) 仍然把 pkg 的 "Cannot find module" warning 当**硬失败**——那句话出现即代表运行时必然
//     MODULE_NOT_FOUND，绝不能再让它随退出码 0 溜过去。
function bundleForPkg(entry, root, outFile) {
  const esbuild = require.resolve("esbuild/bin/esbuild", { paths: [root] });
  console.log(`Bundling with esbuild -> ${outFile}`);
  run(esbuild, [
    entry,
    "--bundle",
    "--platform=node",
    "--target=node18",
    "--format=cjs",
    `--outfile=${outFile}`,
  ]);
  if (!fs.existsSync(outFile)) {
    console.error(`esbuild did not produce ${outFile}`);
    process.exit(1);
  }
}

function runPkgStrict(cmd, args) {
  const r = child_process.spawnSync(cmd, args, { encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  process.stdout.write(out);
  if (r.status !== 0) throw new Error(`pkg exited ${r.status}`);
  const missing = out.split("\n").filter((l) => /Warning Cannot find module/.test(l));
  if (missing.length > 0) {
    console.error(
      "\npkg 没能把下列模块打进 snapshot——发出去的二进制一运行到它们就是 MODULE_NOT_FOUND：",
    );
    for (const line of missing) console.error(`  ${line.trim()}`);
    console.error(
      "多半是该包用了 exports 映射（pkg 5 不支持）。改成 require 实际的 CJS 文件路径，" +
        "让 pkg 能静态追踪到。参见 packages/cli/src/mcp_server.js 的 loadSdk。",
    );
    throw new Error("pkg reported missing modules");
  }
}

function ensureBinary(entry, target, outBin, root) {
  const bundle = path.join(path.dirname(outBin), "mail-use.bundle.cjs");
  bundleForPkg(entry, root, bundle);
  runPkgStrict("pnpm", ["-C", root, "exec", "pkg", bundle, "--targets", target, "--output", outBin]);
  if (!fs.existsSync(outBin)) {
    console.warn(`pkg did not produce ${outBin}. Retrying once...`);
    runPkgStrict("pnpm", ["-C", root, "exec", "pkg", bundle, "--targets", target, "--output", outBin]);
  }
  if (!fs.existsSync(outBin)) {
    console.error(`pkg failed to produce ${outBin}`);
    try {
      const dir = path.dirname(outBin);
      if (fs.existsSync(dir)) {
        console.error(`dist contents: ${fs.readdirSync(dir).join(", ") || "(empty)"}`);
      }
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

function main() {
  const target = pkgTarget();
  if (!target) {
    console.error(`Unsupported platform for binary build: ${process.platform} ${process.arch}`);
    process.exit(1);
  }

  const entry = path.join(__dirname, "..", "packages", "cli", "bin", "mail-use.js");
  const outDir = path.join(__dirname, "..", "dist");
  fs.mkdirSync(outDir, { recursive: true });

  const outBin = path.join(outDir, "mail-use");
  console.log(`Building mail-use binary: target=${target}`);
  const root = path.join(__dirname, "..");
  run("pnpm", ["-C", root, "install"]);
  run("pnpm", ["-C", root, "test"]);
  ensureBinary(entry, target, outBin, root);

  // 真的把二进制跑起来，走一遍 MCP initialize + tools/list 再放行。
  // runPkgStrict 只能拦住 pkg 自己报出来的 "Cannot find module" 警告；
  // #22 那种发出去才发现起不来的事故，只有端到端启动一次才拦得住。
  const smoke = runMcpSmokeTest(outBin);
  console.log(`MCP smoke test passed: ${smoke.toolCount} tools`);

  // 发布走 GitHub Releases：CI 把 dist/mail-use 打成 tar.gz 挂到 Release 上，
  // install.sh 直接拉。没有 npm 这一环，也就没有 NPM_TOKEN 和 2FA。
  console.log(`Binary ready: ${outBin}`);
}

main();
