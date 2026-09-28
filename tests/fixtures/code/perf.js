// Sample fixture for the OmaCodeSnap highlight-path spike.
// Exercises comments, strings, template literals, regex, numbers, classes,
// decorators (as comments, since plain JS lacks them), keywords and builtins.

import { readFile } from "node:fs/promises";

const MAX_RETRIES = 3;
const PATTERN = /^[a-z0-9_-]+$/i;

/**
 * Represents a themed snippet ready for rendering.
 */
export class Snippet {
  #tokens = [];

  constructor(source, language = "javascript") {
    this.source = source;
    this.language = language;
  }

  static fromFile(path) {
    return new Snippet(path);
  }

  async tokenize() {
    const label = `tokenizing ${this.language}`;
    console.log(label);
    for (let i = 0; i < MAX_RETRIES; i++) {
      if (PATTERN.test(this.language)) {
        this.#tokens.push({ index: i, ok: true });
      } else {
        this.#tokens.push({ index: i, ok: false });
      }
    }
    return this.#tokens;
  }

  get tokenCount() {
    return this.#tokens.length;
  }
}

function greet(name) {
  return `Hello, ${name}! You have ${1 + 2} new messages.`;
}

async function main() {
  const contents = await readFile("./fixtures/sample.js", "utf8");
  const snippet = new Snippet(contents);
  await snippet.tokenize();
  console.log(greet("OmaCodeSnap"), snippet.tokenCount, contents.length > 0);
}

main().catch((err) => {
  console.error("failed:", err.message);
  process.exitCode = 1;
});
