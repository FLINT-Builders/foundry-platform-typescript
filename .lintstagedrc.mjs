// @ts-check

import micromatch from "micromatch";

const CSPELL_CMD = "cspell --quiet --no-must-find-files";

/**
 * lint-staged splits commands returned from function tasks with string-argv,
 * which has no escape syntax and only strips quotes from a token wrapped
 * entirely in one quote style. Each path is wrapped in a quote character it
 * does not contain so it stays a single argument; paths that cannot be
 * represented that way, or that would parse as an option, are refused.
 *
 * @param {readonly string[]} files
 * @returns {string}
 */
function quoteFiles(files) {
  return files.map((file) => {
    if (file.startsWith("-")) {
      throw new Error(
        `Refusing to lint staged path that starts with "-": ${
          JSON.stringify(file)
        }`,
      );
    }
    if (!file.includes("\"")) return `"${file}"`;
    if (!file.includes("'")) return `'${file}'`;
    throw new Error(
      `Refusing to lint staged path containing both ' and ": ${
        JSON.stringify(file)
      }`,
    );
  }).join(" ");
}

/*
 * Overview:
 *  - Fixes lint rules and formatting for code
 *  - Fixes formatting for md, json, yml, yaml, excluding a few things
 */

/**
 * @type {import("lint-staged").Config}
 */
export default {
  "packages/monorepo.*/**/*.{js,jsx,ts,tsx,mjs,cjs}": [
    "dprint fmt",
    CSPELL_CMD,
  ],
  "*.md": [CSPELL_CMD],
  "packages/**/*.{js,jsx,ts,tsx,mjs,cjs}": (
    files,
  ) => {
    const match = micromatch.not(
      files,
      [
        "**/templates/**/*",
        "**/generatedNoCheck/**/*",
        "**/generatedNoCheck2/**/*",
        "**/examples/**/*",
      ],
    );
    if (match.length === 0) return [];
    const quoted = quoteFiles(match);
    return [
      `dprint fmt ${quoted}`,
      `eslint --fix ${quoted}`,
      `${CSPELL_CMD} ${quoted}`,
    ];
  },
  "(.lintstagedrc.mjs|.monorepolint.config.mjs)": [
    "dprint fmt",
    CSPELL_CMD,
  ],
  "*": (files) => {
    const mrlFiles = micromatch(files, [
      "package.json",
      // "**/package.json",
      "tsconfig.json",
      "**/tsconfig.json",
    ], {});

    const mrlCommands = mrlFiles.length > 0
      ? ["monorepolint check --verbose", `dprint fmt ${quoteFiles(mrlFiles)}`]
      : [];

    return [...mrlCommands];
  },
};
