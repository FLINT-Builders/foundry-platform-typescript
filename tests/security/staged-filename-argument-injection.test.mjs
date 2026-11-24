/**
 * Spec for the pre-commit lint command lines built in .lintstagedrc.mjs.
 *
 * These tests fail while staged paths are joined with spaces and then split
 * by lint-staged. They pass once every path reaches dprint, eslint, and
 * cspell as a single argument.
 *
 * Run:
 *   node --test tests/security/staged-filename-argument-injection.test.mjs
 *
 * Requires the versions pinned in pnpm-lock.yaml to be installed at the
 * repo root: lint-staged@15.2.10, micromatch@4.0.8, dprint@0.47.2,
 * eslint@9.24.0, cspell@8.12.1, and @monorepolint/cli@0.5.0-beta.10.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const configPath = path.join(repoRoot, ".lintstagedrc.mjs");
const binDir = path.join(repoRoot, "node_modules", ".bin");

// Published dprint-plugin-exec 0.9.0 manifest. The hash is the manifest
// checksum dprint 0.47.2 requires before it will run a process plugin.
const EXEC_PLUGIN =
  "https://plugins.dprint.dev/exec-0.9.0.json@939c28cce4022e2676ac9596585448c16abee12b8ccb0320a9eb9596ade1c219";

const DPRINT_EXEC_CONFIG = {
  exec: {
    commands: [
      {
        command: "bash {{file_path}}",
        exts: ["js"],
        stdin: false,
      },
    ],
  },
  plugins: [EXEC_PLUGIN],
};

process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

function assertTool(name) {
  const executable = path.join(binDir, name);
  return fs.access(executable).catch(() => {
    throw new Error(
      `Missing ${executable}. Install the pinned lint tools at the repo root before running this test.`,
    );
  });
}

function shSingle(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

async function initRepo(prefix) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "repro@example.com"]);
  await git(cwd, ["config", "user.name", "Repro"]);
  await fs.writeFile(path.join(cwd, "README.md"), "initial\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "init"]);
  return cwd;
}

async function writeEvilFormatter(cwd, scriptBody) {
  await fs.mkdir(path.join(cwd, "packages"), { recursive: true });
  await fs.writeFile(path.join(cwd, "packages", "a.js"), scriptBody);
  await fs.writeFile(
    path.join(cwd, "packages", "evil.json"),
    `${JSON.stringify(DPRINT_EXEC_CONFIG, null, 2)}\n`,
  );
}

/**
 * Directory plus final file, so the absolute path is
 * `{repo}/packages/a.js --config=packages/evil.json {tail}`.
 * Space-splitting that string yields the real script, a --config flag, and tail.
 */
async function writeSplitJsPath(cwd, tail) {
  const directory = path.join(cwd, "packages", "a.js --config=packages");
  await fs.mkdir(directory, { recursive: true });
  const relativeTail = tail.split("/");
  const filename = relativeTail.pop();
  const nested = path.join(directory, ...relativeTail);
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, filename), "x\n");
  return path.join("packages", `a.js --config=packages/${tail}`);
}

async function runLintStaged(cwd) {
  const lines = [];
  const logger = {
    log: (...args) => lines.push(args.map(String).join(" ")),
    error: (...args) => lines.push(args.map(String).join(" ")),
    warn: (...args) => lines.push(args.map(String).join(" ")),
  };
  const lintStaged = (await import("lint-staged")).default;
  const passed = await lintStaged(
    {
      cwd,
      configPath,
    },
    logger,
  );
  return { passed, output: lines.join("\n") };
}

test("packages JavaScript task does not turn a staged name into a dprint config or an eslint pattern", async () => {
  await assertTool("dprint");
  await assertTool("eslint");
  const marker = path.join(os.tmpdir(), `dprint-marker-${process.pid}-${Date.now()}`);
  const cwd = await initRepo("lint-staged-js-");
  try {
    await writeEvilFormatter(
      cwd,
      `touch ${shSingle(marker)}\ncat "$0"\n`,
    );
    await writeSplitJsPath(cwd, "evil.json x.js");
    await git(cwd, ["add", "packages"]);
    const { output } = await runLintStaged(cwd);

    assert.equal(
      await fs.access(marker).then(() => true, () => false),
      false,
      `dprint executed the staged script via an injected --config.\n${output}`,
    );
    assert.doesNotMatch(
      output,
      /No files matching the pattern "x\.js"/,
      `eslint received x.js as its own pattern.\n${output}`,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(marker, { force: true });
  }
});

test("cspell task does not receive a staged name as extra file arguments", async () => {
  await assertTool("dprint");
  await assertTool("eslint");
  await assertTool("cspell");
  const cwd = await initRepo("lint-staged-cspell-");
  try {
    await fs.mkdir(path.join(cwd, "packages"), { recursive: true });
    await fs.writeFile(path.join(cwd, "packages", "a.js"), "const value = 1;\n");
    await fs.writeFile(
      path.join(cwd, "packages", "a.js splchkcanaryfile.js"),
      "x\n",
    );
    await fs.writeFile(
      path.join(cwd, "splchkcanaryfile.js"),
      "splchkcanarytoken\n",
    );
    await fs.writeFile(
      path.join(cwd, "dprint.json"),
      `${JSON.stringify({
        exec: { commands: [{ command: "cat", exts: ["js"] }] },
        plugins: [EXEC_PLUGIN],
      }, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(cwd, "eslint.config.mjs"),
      "export default [{ ignores: ['**/*'] }];\n",
    );
    await git(cwd, ["add", "packages", "dprint.json", "eslint.config.mjs"]);
    const { output } = await runLintStaged(cwd);

    assert.doesNotMatch(
      output,
      /Unknown word \(splchkcanarytoken\)/,
      `cspell opened a file that was only an extra argument from a split path.\n${output}`,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("package.json and tsconfig task does not turn a staged name into a dprint config", async () => {
  await assertTool("dprint");
  await assertTool("monorepolint");
  const cliEntry = await fs.realpath(path.join(binDir, "monorepolint"));
  const marker = path.join(os.tmpdir(), `dprint-tsconfig-marker-${process.pid}-${Date.now()}`);
  const cwd = await initRepo("lint-staged-tsconfig-");
  try {
    await writeEvilFormatter(cwd, `touch ${shSingle(marker)}\ncat "$0"\n`);
    const relative = await writeSplitJsPath(cwd, "evil.json x/tsconfig.json");
    await fs.writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify({ name: "repro", private: true })}\n`,
    );
    await fs.writeFile(path.join(cwd, "pnpm-workspace.yaml"), "packages:\n");
    await fs.writeFile(
      path.join(cwd, ".monorepolint.config.mjs"),
      [
        "export default {",
        "  rules: [{",
        "    id: 'noop',",
        "    name: 'noop',",
        "    validateOptions() {},",
        "    check() {},",
        "    ruleEntry: { includeWorkspaceRoot: true },",
        "  }],",
        "};",
        "",
      ].join("\n"),
    );
    // This environment's /usr/bin/env rejects the published bin shebang
    // (`node --enable-source-maps`). Launch that same file with node so the
    // real CLI still runs ahead of dprint, as lint-staged sequences it.
    const launcherDir = path.join(cwd, "node_modules", ".bin");
    await fs.mkdir(launcherDir, { recursive: true });
    await fs.writeFile(
      path.join(launcherDir, "monorepolint"),
      `#!/bin/sh\nexec node ${shSingle(cliEntry)} "$@"\n`,
    );
    await fs.chmod(path.join(launcherDir, "monorepolint"), 0o755);
    await git(cwd, ["add", "--", relative]);
    const { output } = await runLintStaged(cwd);

    assert.equal(
      await fs.access(marker).then(() => true, () => false),
      false,
      `dprint executed the staged script from the tsconfig task.\n${output}`,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(marker, { force: true });
  }
});

test("string-form markdown task keeps a staged name with spaces as one cspell argument", async () => {
  await assertTool("cspell");
  const cwd = await initRepo("lint-staged-md-");
  try {
    await fs.writeFile(path.join(cwd, "notes splchkmdcanaryfile.md"), "hello\n");
    await fs.writeFile(path.join(cwd, "splchkmdcanaryfile.md"), "splchkmdcanarytoken\n");
    await git(cwd, ["add", "notes splchkmdcanaryfile.md"]);
    const { output } = await runLintStaged(cwd);

    assert.doesNotMatch(
      output,
      /Unknown word \(splchkmdcanarytoken\)/,
      `the string-form cspell task opened a file created only by splitting a staged name.\n${output}`,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
