// Regenerates every gallery image (and, with --hero, the README hero) from
// the source snippets under `docs/gallery/code/`, through the real,
// unmodified `bin/omacodesnap --fixture` path — no gallery-only rendering
// logic, only gallery-only *inputs* (the code, and for four languages with
// no Zed grammar, hand-tokenized spans via `./hand-tokenize.mjs`; see
// `SOURCES.md`'s "How the last four are coloured").
//
// Usage: node docs/gallery/render.mjs [--out-dir DIR]
//
// Requires the stock Omarchy themes this machine ships (kanagawa,
// ristretto, catppuccin, rose-pine, nord, everforest, retro-82) under
// ~/.local/share/omarchy/themes/. Osaka Jade is Keith's own theme with a
// bespoke Zed theme file, not vendored here (SOURCES.md explains why) — if
// ~/.config/omarchy/themes/osaka-jade/zed-theme.json isn't present, that
// one image still renders, just via the synthesized-from-colors.toml
// fallback every theme without a real Zed theme gets, not the exact
// original.
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { highlight } from "../../lib/highlight/zed.mjs";
import { readEditorFont } from "../../lib/fonts.mjs";
import { readTheme } from "../../lib/theme.mjs";
import { tokenizeText, keywordRule } from "./hand-tokenize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CODE_DIR = join(HERE, "code");

const args = process.argv.slice(2);
const outFlagIndex = args.indexOf("--out-dir");
const OUT_DIR = outFlagIndex !== -1 ? args[outFlagIndex + 1] : HERE;
mkdirSync(OUT_DIR, { recursive: true });

const HOME = process.env.HOME;
const STOCK = join(HOME, ".local/share/omarchy/themes");

// Osaka Jade has no bespoke Zed theme in the stock Omarchy theme set — only
// in Keith's own `~/.config/omarchy/themes/`. Merge it (colors.toml and
// backgrounds from stock, zed-theme.json from the personal copy if present)
// into a scratch dir so `readTheme`/`--theme-dir` see one complete theme,
// same as every other entry below.
const osakaJadeDir = (() => {
    const stockDir = join(STOCK, "osaka-jade");
    const personalZed = join(HOME, ".config/omarchy/themes/osaka-jade/zed-theme.json");
    if (!existsSync(personalZed)) return stockDir; // falls back to the synthesized theme
    const merged = join(tmpdir(), "omacodesnap-gallery-osaka-jade-merged");
    rmSync(merged, { recursive: true, force: true });
    cpSync(stockDir, merged, { recursive: true });
    cpSync(personalZed, join(merged, "zed-theme.json"));
    return merged;
})();

const THEME_DIRS = {
    kanagawa: join(STOCK, "kanagawa"),
    ristretto: join(STOCK, "ristretto"),
    catppuccin: join(STOCK, "catppuccin"),
    "rose-pine": join(STOCK, "rose-pine"),
    nord: join(STOCK, "nord"),
    everforest: join(STOCK, "everforest"),
    "osaka-jade": osakaJadeDir,
    "retro-82": join(STOCK, "retro-82"),
};

const WALLPAPERS = {
    kanagawa: "1-kanagawa.jpg",
    ristretto: "3-industrial-moon.jpg",
    catppuccin: "2-waves.png",
    "rose-pine": "3-omarchy-plants.png",
    nord: "1-city-view.png",
    everforest: "1-tree-tops.jpg",
    "osaka-jade": "1-glowing-city.jpg",
    "retro-82": "2-dusk-guardian.jpg",
};

function wallpaperFor(themeKey) {
    return join(STOCK, themeKey === "osaka-jade" ? "osaka-jade" : themeKey, "backgrounds", WALLPAPERS[themeKey]);
}

const zedFont = readEditorFont("zed");

function writeFixtureAndRender(name, fixture, themeKey) {
    const fixturePath = join(OUT_DIR, name + ".json");
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
    const outPath = join(OUT_DIR, name + ".png");
    const themeDir = THEME_DIRS[themeKey];
    const wallpaper = wallpaperFor(themeKey);
    console.error("rendering", name, "...");
    execFileSync("bin/omacodesnap", ["--fixture", fixturePath, "--out", outPath, "--theme-dir", themeDir, "--wallpaper", wallpaper], {
        cwd: ROOT,
        stdio: "inherit",
    });
}

// --- 1-4: real Zed grammars ---
{
    const text = readFileSync(join(CODE_DIR, "push_demo.rb"), "utf8").trimEnd();
    const theme = readTheme(THEME_DIRS.kanagawa);
    const { lines } = highlight({ text, language: "ruby", theme });
    writeFixtureAndRender("01-ruby-push-kanagawa", { filename: "push_demo.rb", language: "ruby", editor: "zed", font: zedFont, lines }, "kanagawa");
}
{
    const text = readFileSync(join(CODE_DIR, "worker_pool.go"), "utf8").trimEnd();
    const theme = readTheme(THEME_DIRS.ristretto);
    const { lines } = highlight({ text, language: "go", theme });
    writeFixtureAndRender("02-go-ristretto", { filename: "worker_pool.go", language: "go", editor: "zed", font: zedFont, lines }, "ristretto");
}
{
    const text = readFileSync(join(CODE_DIR, "activation.rs"), "utf8").trimEnd();
    const theme = readTheme(THEME_DIRS.catppuccin);
    const { lines } = highlight({ text, language: "rust", theme });
    writeFixtureAndRender("03-rust-catppuccin", { filename: "activation.rs", language: "rust", editor: "zed", font: zedFont, lines }, "catppuccin");
}
{
    const text = readFileSync(join(CODE_DIR, "ruby_quotes.txt"), "utf8").trimEnd();
    const theme = readTheme(THEME_DIRS["rose-pine"]);
    const { lines } = highlight({ text, language: null, theme });
    writeFixtureAndRender("04-ruby-quotes-rose-pine", { filename: null, language: null, editor: "other", font: zedFont, lines }, "rose-pine");
}

// --- 5-8: hand-tokenized (no Zed grammar exists for these) ---
const FORTRAN_RULES = [keywordRule(["PROGRAM", "REAL", "INTEGER", "DO", "CONTINUE", "STOP", "END", "PRINT", "FUNCTION", "RETURN"], "keyword")];
const PASCAL_RULES = [keywordRule(["type", "class", "private", "public", "procedure", "function", "begin", "end", "array", "of", "Integer", "Boolean"], "keyword")];
const VAX_RULES = [keywordRule(["TITLE", "ENTRY", "EXIT_S", "BLKW", "LONG", "ASCII", "END"], "keyword")];
const ASM_RULES = [keywordRule(["EQU", "ORG", "LDX", "LDB", "LDA", "STA", "DECB", "BNE", "JSR", "BRA", "RTS", "FCC", "FCB"], "keyword")];

function handRender(name, filename, language, codeFile, themeKey, rules, opts) {
    const text = readFileSync(join(CODE_DIR, codeFile), "utf8").trimEnd();
    const lines = tokenizeText(text, rules, opts);
    writeFixtureAndRender(name, { filename, language, editor: "other", font: zedFont, lines }, themeKey);
}

handRender("05-fortran77-nord", "trapezoid.f", "Fortran 77", "trapezoid.f", "nord", FORTRAN_RULES, { lineCommentStarts: ["C", "c"] });
handRender("06-delphi-everforest", "stack.pas", "Delphi", "stack.pas", "everforest", PASCAL_RULES, { lineCommentStarts: ["//"] });
handRender("07-vax-macro32-osaka-jade", "greet.mar", "VAX MACRO-32", "greet.mar", "osaka-jade", VAX_RULES, { lineCommentStarts: [";"] });
handRender("08-6809-asm-retro82", "clear_screen.asm", "6809 Assembly", "clear_screen.asm", "retro-82", ASM_RULES, { lineCommentStarts: ["*"] });

console.error("done");
