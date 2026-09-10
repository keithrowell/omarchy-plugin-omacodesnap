import QtQuick
import QtQuick.Effects
import Quickshell

// The frame: sharp-wallpaper backdrop -> window (Hyprland-style border and
// rounding, no shadow unless the desktop has one) -> header (filename/source,
// on the same background as the code) -> gutter -> code. Renders one `input`
// document — the JSON built by `lib/input.mjs` from a fixture (or, from spec
// 0006, a live selection) plus the current Omarchy theme and this desktop's
// live Hyprland "look" (border size, rounding, gaps, active-border colour,
// shadow — see `lib/hypr.mjs`) — set once by `Main.qml`'s render mode.
//
// Every colour below comes from `input.theme` or `input.look`; nothing is a
// literal (see the constants block). No icon or mark of any kind is drawn —
// ADR-0008 covers why the header carries no logo, Omarchy's own or
// otherwise.
//
// Sizing follows content (see `buildFrame()`): the window is as wide as its
// longest line, clamped to [minWidth, maxWidth] with over-width lines
// clipped to an ellipsis, and as tall as its header plus its line count (at
// least `minLines`). This item's own size is that window plus `outerMargin`
// on every side (Hyprland's own `gaps_out`, scaled up — a window sitting in
// the middle of a tiled desktop has more breathing room around it than the
// gap between two tiles), which is what `Main.qml` grabs to a PNG.
//
// Four optional fixture fields (ADR-0009; `centerContent` is ADR-0011),
// each defaulting to the above when absent: `subtitle` overrides the
// auto-built editor/language caption verbatim; `showGutter: false` drops
// the line-number column and its reserved width; `compact: true` drops the
// minWidth/minLines floors and the Hyprland-gap-derived margins in favour
// of small fixed ones, sizing the whole frame to its content instead of a
// desktop-window-sized canvas; `centerContent: true` centres each line's
// rendered content within the code column's available width instead of
// left-aligning it — independent of `showGutter`/`compact`.
//
// `frame` is a single plain property holding everything the visual tree
// below reads (colours, font, geometry): it is (re)built once, atomically,
// `onInputChanged`, from `input` directly — never from intermediate
// reactive properties like `input.snap`. Two reasons: `buildFrame` both
// reads and writes `charMetrics` (it measures each line by setting
// `charMetrics.text`), so evaluating it as a property *binding* creates a
// self-referential binding loop; and `onInputChanged` fires as soon as
// `input` changes, before any sibling *bindings* also depending on `input`
// are guaranteed to have refreshed, so a delegate reading (say)
// `input.snap.font.family` directly as a binding could transiently observe
// a stale/null value the moment it is first created and throw — which was
// observed in practice (every code and gutter `Text` threw once on first
// render, before recovering). Routing every delegate through the one
// `frame` object sidesteps this: a JS object is handed to listeners whole,
// so there is no "half-updated" state to observe.
//
// The plan called for `font.styleHint: Font.Monospace` on every code `Text`
// so an unavailable family substitutes to a monospace font; this
// Quickshell/Qt build's QML `font` grouped property does not expose
// `styleHint` at all (confirmed with a two-line repro against both `Text`
// and `TextMetrics`), so it is omitted everywhere below. The rendered
// evidence uses JetBrainsMono Nerd Font, which is installed, so this has no
// visible effect here.
Item {
    id: root

    property var input: null

    // --- Named constants (every size/radius/opacity below is one of these; nothing inline) ---
    readonly property int exportScale: 2
    // Outer margin (image edge -> window border) and inner padding (border
    // -> code) are both multiples of Hyprland's own `general:gaps_out`, so
    // a wider desktop gap setting widens this window's own margins too.
    readonly property real outerGapFactor: 3
    readonly property real innerPadFactor: 2
    // Floors under the two above: a Hyprland setup with a small or zero
    // `gaps_out` (confirmed live on this machine — 0) otherwise collapses
    // both to nothing, leaving the last code line hard against the card's
    // edge and no wallpaper margin to show at all. Scaled by the code
    // font's size (`S`, same basis as the header factors below) rather
    // than a flat pixel count, so they stay proportionate at any font
    // size; a generous `gaps_out` still grows past these unchanged.
    readonly property real minPaddingFactor: 14
    readonly property real minOuterMarginFactor: 24
    // Bottom padding gets extra room on top of the (floored) base padding —
    // a closing line sitting hard against the card's bottom edge reads as
    // more cramped than the same gap at the top, next to the header.
    readonly property real bottomPaddingExtraFactor: 8
    readonly property int minWidth: 480
    readonly property int maxWidth: 1600
    readonly property int minLines: 3
    // `compact: true` (see the fixture field, spec: OmaWordl share-fit)
    // drops the minWidth/minLines floors and the Hyprland-gap-derived
    // margins above in favour of these small, fixed factors — a tight
    // render sized to its own content rather than a full "window" sitting
    // on a desktop. Still scaled by `S` like every other size here, just
    // much smaller than the floors they replace.
    readonly property real compactPaddingFactor: 8
    readonly property real compactOuterMarginFactor: 12
    // A small safety margin added on top of the measured header-text width
    // (see `headerTextWidth` in `buildFrame()`): `TextMetrics` on a full
    // bold, letter-spaced string still measures a few px narrower than the
    // same string's actual rendered advance (the single-glyph ink-extent
    // gotcha documented at `charAdvance` below applies in miniature here
    // too), which without this silently re-introduced the "OmaWordl 1
    // 3…" title-truncation bug this measurement exists to prevent.
    readonly property real headerTextSafetyFactor: 5
    readonly property int gutterDigitsMin: 2
    readonly property string ellipsis: "…"
    // Only used when `look.shadowEnabled` (Hyprland's own default is off;
    // most Omarchy desktops never draw this at all).
    readonly property real shadowRange: 12
    readonly property real shadowOpacity: 0.5

    // --- Header constants (the shell's PanelHero + PanelSeparator pattern —
    // see /usr/share/omarchy/shell/Ui/{PanelHero,PanelSeparator}.qml, which
    // this mirrors on the code's own font size instead of the shell's —
    // minus PanelHero's icon slot: every stock user of that pattern (the
    // Tailscale panel, the Dropbox panel, the agents panel) puts *its own*
    // icon there, never the platform's; Omasnap has no icon of its own, so
    // ADR-0008 leaves the slot out rather than filling it with Omarchy's) ---
    readonly property real headerSpacingFactor: 2
    readonly property real headerTitleFactor: 1.167
    readonly property real headerCaptionFactor: 0.833
    readonly property real headerCaptionSpacing: 1.2
    readonly property real headerPaddingFactor: 18
    readonly property real separatorAlpha: 0.12
    readonly property real dimFactor: 1.4
    readonly property int baseFontSize: 12
    // The separator itself is a literal 1px rule (not scaled by S), same as
    // the shell's own `PanelSeparator`.
    readonly property int headerSeparatorHeight: 1

    // A safe, arbitrary size for the window before `frame` exists.
    readonly property int defaultHeaderHeight: 64
    readonly property int defaultOuterMargin: 30

    // Mirrors `lib/hypr.mjs`'s `OMARCHY_DEFAULTS` — QML cannot import that
    // module (it uses `node:child_process`), so these three are duplicated
    // here as named constants; `buildInput` always supplies a full `look`
    // in practice, so these only matter for a hand-built fixture that omits
    // it entirely.
    readonly property int lookDefaultBorderSize: 2
    readonly property int lookDefaultRounding: 0
    readonly property int lookDefaultGapsOut: 10

    // --- The one atomic snapshot the whole visual tree reads (see the header comment) ---
    property var frame: null
    onInputChanged: frame = input ? buildFrame(input) : null

    readonly property int winWidth: frame ? frame.winWidth : minWidth
    readonly property int winHeight: frame ? frame.winHeight : defaultHeaderHeight + minLines * 20
    readonly property int outerMargin: frame ? frame.outerMargin : defaultOuterMargin

    width: winWidth + 2 * outerMargin
    height: winHeight + 2 * outerMargin

    readonly property bool wallpaperSettled: !frame || !frame.wallpaper
        || wallpaperImage.status === Image.Ready || wallpaperImage.status === Image.Error
    readonly property bool ready: frame !== null && wallpaperSettled

    function clamp(value, lo, hi) {
        return Math.max(lo, Math.min(hi, value));
    }

    // Truncate `spans` to its first `count` characters, preserving each span's style.
    function clipSpans(spans, count) {
        const result = [];
        let remaining = count;
        for (const span of spans) {
            if (remaining <= 0) break;
            if (span.text.length <= remaining) {
                result.push(span);
                remaining -= span.text.length;
            } else {
                result.push({ text: span.text.slice(0, remaining), color: span.color, fontStyle: span.fontStyle, fontWeight: span.fontWeight });
                remaining = 0;
            }
        }
        return result;
    }

    // `bold`/`letterSpacing` default to the code font's own plain styling
    // (every existing caller); the header-width measurement below is the
    // only caller that passes them, to match `titleText`/`subtitleText`'s
    // actual `font.bold`/`font.letterSpacing` — every property is set on
    // every call (never left over from a previous one), since `charMetrics`
    // is one shared, imperatively-driven item.
    function measureWidth(text, family, pixelSize, bold, letterSpacing) {
        charMetrics.font.family = family;
        charMetrics.font.pixelSize = pixelSize;
        charMetrics.font.bold = bold === true;
        charMetrics.font.letterSpacing = letterSpacing || 0;
        charMetrics.text = text;
        return charMetrics.width;
    }

    // Build the one snapshot the visual tree renders from `inputData`
    // (`input`, passed explicitly — see the header comment for why not the
    // `input` property read some other way). Colours, font and geometry are
    // all resolved here, once, so every delegate below reads a single
    // already-complete object instead of reaching back into `input`.
    function buildFrame(inputData) {
        const snapData = inputData.snap;
        const colors = inputData.theme.colors;
        const editor = inputData.theme.editor;
        const look = inputData.look || {};
        const fontFamily = snapData.font.family;
        const fontSize = snapData.font.size;
        const headerFontFamily = inputData.headerFont || fontFamily;
        // Zed's "comfortable" line height, VS Code's default, a generic middle ground.
        const lineHeightFactor = snapData.editor === "zed" ? 1.618 : snapData.editor === "vscode" ? 1.35 : 1.5;
        const lineHeight = Math.round(fontSize * lineHeightFactor);
        // A block-tile span (OmaWordl's tile rows) renders as a square,
        // not a font-glyph-shaped rectangle -- its edge is the row's own
        // height, so width == height regardless of font metrics. Matches
        // the real board, where every tile is a fixed square (`main.py`'s
        // `width_request=54, height_request=54`) independent of its font.
        const tileEdge = lineHeight;

        // Hyprland's own chrome (see lib/hypr.mjs). `buildInput` always
        // supplies all six `look` fields (live or Omarchy's own defaults);
        // these per-key fallbacks only matter for a hand-built fixture that
        // omits `look` altogether.
        const borderSize = typeof look.borderSize === "number" ? look.borderSize : lookDefaultBorderSize;
        const rounding = typeof look.rounding === "number" ? look.rounding : lookDefaultRounding;
        const gapsOut = typeof look.gapsOut === "number" ? look.gapsOut : lookDefaultGapsOut;
        const activeBorder = look.activeBorder || colors.accent;
        const shadowEnabled = look.shadowEnabled === true;
        // Hyprland draws a window's content corner radius as
        // `rounding - border_size` (clamped at 0); the nested-rectangle
        // border below reproduces that exactly.
        const innerRounding = Math.max(0, rounding - borderSize);

        // `showGutter`/`compact` are optional fixture fields (normalized by
        // `lib/input.mjs`'s `buildInput` to `true`/`false` respectively when
        // absent), defended here the same way `look`'s fields are above, for
        // a hand-built fixture that skips `buildInput` entirely.
        const showGutter = snapData.showGutter !== false;
        const compact = snapData.compact === true;
        // `centerContent` is an optional fixture field (defended the same
        // way, for a hand-built fixture that skips `buildInput`), defaults
        // to `false` (today's exact left-aligned behaviour). Orthogonal to
        // `showGutter`/`compact`: it only changes each line's `x` offset
        // within the code column's available width, computed below from
        // that column's own width regardless of how `showGutter`/`compact`
        // arrived at it.
        const centerContent = snapData.centerContent === true;

        // --- Header geometry (see the constants block's comment) ---
        const S = fontSize / baseFontSize;

        const outerMargin = compact
            ? Math.round(compactOuterMarginFactor * S)
            : Math.max(Math.round(minOuterMarginFactor * S), Math.round(gapsOut * outerGapFactor));
        const padding = compact
            ? Math.round(compactPaddingFactor * S)
            : Math.max(Math.round(minPaddingFactor * S), Math.round(gapsOut * innerPadFactor));
        const bottomPadding = compact ? padding : padding + Math.round(bottomPaddingExtraFactor * S);

        const headerPadding = Math.round(headerPaddingFactor * S);
        const headerSpacing = Math.round(headerSpacingFactor * S);
        const titleSize = Math.round(fontSize * headerTitleFactor);
        const captionSize = Math.round(fontSize * headerCaptionFactor);
        // A text row's actual ink (ascent + descent) runs somewhat taller
        // than its nominal pixel size; 1.2x is a common typographic
        // approximation for a label's own line box — deliberately not the
        // code area's `lineHeightFactor` above, which is tuned for reading
        // code, not sizing a two-line header.
        const headerLineHeightRatio = 1.2;
        const titleLineHeight = Math.round(titleSize * headerLineHeightRatio);
        const captionLineHeight = Math.round(captionSize * headerLineHeightRatio);
        const heroHeight = titleLineHeight + headerSpacing + captionLineHeight;
        const headerHeight = 2 * headerPadding + heroHeight + headerSeparatorHeight;

        const title = snapData.filename || snapData.language || "snippet";
        // "ZED · JAVASCRIPT", "VS CODE · PYTHON", "NEOVIM · LUA", "PLAIN
        // TEXT" (source omitted for "other", language "PLAIN TEXT" when
        // null) — see the spec's amended header criterion for the exact
        // mapping. An explicit `subtitle` fixture field overrides this
        // entirely: used verbatim, no case transformation.
        const sourceLabel =
          snapData.editor === "zed" ? "ZED" : snapData.editor === "vscode" ? "VS CODE" : snapData.editor === "neovim" ? "NEOVIM" : null;
        const languageLabel = snapData.language ? String(snapData.language).toUpperCase() : "PLAIN TEXT";
        const subtitle = snapData.subtitle != null ? snapData.subtitle : [sourceLabel, languageLabel].filter(Boolean).join(" · ");

        const lineCount = snapData.lines.length;
        const renderedLineCount = compact ? lineCount : Math.max(lineCount, minLines);
        const digits = Math.max(gutterDigitsMin, String(renderedLineCount).length);
        // `TextMetrics.width` on a single "0" measures that glyph's own ink
        // extent, not the font's fixed per-character advance — for
        // JetBrainsMono Nerd Font at 13px this under-measured by roughly a
        // quarter (6px vs. the ~7.8px a `Text` actually advances per
        // character), so a long line's clip threshold came out *higher*
        // than its real character count and nothing got clipped at all
        // (confirmed: a 240-character fixture line rendered in full, well
        // past the window edge, instead of being truncated). Measuring many
        // repeated characters and dividing gives the true average advance.
        const charSampleCount = 64;
        const charAdvance = measureWidth("0".repeat(charSampleCount), fontFamily, fontSize) / charSampleCount;
        // `showGutter: false` drops the gutter's reserved width entirely —
        // the code area starts right after `padding`, not after
        // `padding + gutterWidth`.
        const gutterWidth = showGutter ? Math.ceil(digits * charAdvance + charAdvance) : 0;
        const maxCodeWidth = maxWidth - gutterWidth - 2 * padding;

        const outLines = [];
        // Each rendered line's own final (post-clip) width, in the same
        // order as `outLines` — reused by `centerContent` below (and only
        // then) to offset that line's `Row` within the code column's
        // available width, instead of re-measuring in QML.
        const lineWidths = [];
        let longest = 0;
        for (let i = 0; i < lineCount; i++) {
            const spans = snapData.lines[i];
            // A line made entirely of block-tile spans (OmaWordl's tile
            // rows) is measured and rendered as `tileEdge`-wide squares,
            // not by the text glyphs' own advance -- see the matching
            // `isBlockTile` branch in the per-span delegate below, which
            // this width must agree with pixel-for-pixel or centring and
            // canvas sizing drift from what's actually drawn. Never
            // clipped: a tile grid is always a handful of fixed-width
            // squares, nowhere near `maxCodeWidth`.
            const isBlockLine = spans.length > 0 && spans.every(s => /^█+$/.test(s.text));
            let width;
            let lineSpans = spans;
            if (isBlockLine) {
                width = spans.length * tileEdge;
            } else {
                const text = spans.map(s => s.text).join("");
                width = measureWidth(text, fontFamily, fontSize);
                if (width > maxCodeWidth && charAdvance > 0) {
                    const charsThatFit = Math.max(0, Math.floor(maxCodeWidth / charAdvance) - 1);
                    lineSpans = clipSpans(spans, charsThatFit).concat([{ text: ellipsis, color: colors.muted, fontStyle: null, fontWeight: null }]);
                    width = measureWidth(lineSpans.map(s => s.text).join(""), fontFamily, fontSize);
                }
            }
            outLines.push(lineSpans);
            lineWidths.push(width);
            if (width > longest) longest = width;
        }

        const codeWidth = Math.min(longest, maxCodeWidth);

        // In compact mode there is no `minWidth` floor to incidentally give
        // the header room (see below) — a short-content, long-title render
        // (OmaWordl's own case: a few lines of "██" under a real title like
        // "OmaWordl 1 3/6") would otherwise size the canvas to the code
        // alone and truncate the header text that is the whole point of the
        // custom `subtitle`. Measure the header's own text and let it set a
        // floor, uncapped by anything but `maxWidth`, same as the code path.
        const headerTextWidth = compact
            ? Math.ceil(Math.max(
                measureWidth(title, headerFontFamily, titleSize, true),
                measureWidth(subtitle, headerFontFamily, captionSize, true, headerCaptionSpacing),
              )) + 2 * headerPadding + Math.round(headerTextSafetyFactor * S)
            : 0;

        // `compact: true` drops the `minWidth`/`minLines` floors (this
        // clamp's lower bound, and `renderedLineCount` above) in favour of
        // `headerTextWidth` just above — content is still capped at
        // `maxWidth` either way, same as today.
        const contentWidth = compact
            ? Math.min(Math.max(gutterWidth + codeWidth + 2 * padding, headerTextWidth), maxWidth)
            : clamp(gutterWidth + codeWidth + 2 * padding, minWidth, maxWidth);
        const contentHeight = headerHeight + padding + bottomPadding + renderedLineCount * lineHeight;

        return {
            filename: snapData.filename,
            language: snapData.language,
            fontFamily: fontFamily,
            fontSize: fontSize,
            headerFontFamily: headerFontFamily,
            lineHeight: lineHeight,
            padding: padding,
            lines: outLines,
            lineWidths: lineWidths,
            centerContent: centerContent,
            renderedLineCount: renderedLineCount,
            gutterWidth: gutterWidth,
            showGutter: showGutter,
            charAdvance: charAdvance,
            tileEdge: tileEdge,
            borderSize: borderSize,
            rounding: rounding,
            innerRounding: innerRounding,
            activeBorder: activeBorder,
            shadowEnabled: shadowEnabled,
            outerMargin: outerMargin,
            contentWidth: contentWidth,
            contentHeight: contentHeight,
            winWidth: contentWidth + 2 * borderSize,
            winHeight: contentHeight + 2 * borderSize,
            headerPadding: headerPadding,
            headerSpacing: headerSpacing,
            titleSize: titleSize,
            captionSize: captionSize,
            titleLineHeight: titleLineHeight,
            captionLineHeight: captionLineHeight,
            heroHeight: heroHeight,
            headerHeight: headerHeight,
            title: title,
            subtitle: subtitle,
            colors: colors,
            editorBackground: editor.background,
            lineNumberColor: editor.lineNumber,
            wallpaper: inputData.theme.wallpaper,
        };
    }

    // Hidden text used only to measure glyph widths with the code font
    // (monospace, so one character's advance is every character's advance).
    // Its `font` is set imperatively by `measureWidth`, not bound, for the
    // same reason `buildFrame` takes `inputData` as a parameter above.
    TextMetrics {
        id: charMetrics
        text: "0"
    }

    // A real `color`-typed property so `Qt.darker`/`Qt.rgba` below operate
    // on an actual QColor (auto-coerced from the theme's hex string here)
    // rather than a plain JS string.
    QtObject {
        id: colorHelper
        property color foreground: frame ? frame.colors.foreground : Qt.rgba(0, 0, 0, 1)
    }

    // --- 1. Backdrop: the sharp wallpaper, no blur, no darkening overlay ---
    Rectangle {
        id: backdropBase
        anchors.fill: parent
        color: frame ? frame.colors.darker_background : Qt.rgba(0, 0, 0, 1)
    }

    Image {
        id: wallpaperImage
        anchors.fill: parent
        asynchronous: true
        source: frame && frame.wallpaper ? "file://" + frame.wallpaper : ""
        fillMode: Image.PreserveAspectCrop
    }

    // --- 2. Window: Hyprland's own border + rounding, shadow only if the desktop has one ---
    Loader {
        active: frame ? frame.shadowEnabled : false
        anchors.fill: win
        sourceComponent: Component {
            MultiEffect {
                // `parent` here is the `Loader` itself, already sized to
                // `win` by the outer `anchors.fill: win` above — `win` is
                // neither this item's parent nor a sibling (it's a
                // sibling of the *Loader*, one level up), so anchoring
                // straight to it logged "Cannot anchor to an item that
                // isn't a parent or sibling" on every shadow-enabled run.
                anchors.fill: parent
                source: win
                shadowEnabled: true
                shadowColor: frame ? frame.colors.darker_background : Qt.rgba(0, 0, 0, 1)
                // `shadowBlur` is a 0..1 fraction of `blurMax` (the blur
                // radius in px), not a radius itself — passing `shadowRange`
                // (12) straight into `shadowBlur` clamped to ~1.0 and drew
                // no visible shadow at all. `blurMax` is Hyprland's own
                // shadow range; `shadowBlur: 1.0` uses the full amount.
                blurMax: shadowRange
                shadowBlur: 1.0
                shadowOpacity: root.shadowOpacity
                autoPaddingEnabled: true
            }
        }
    }

    Item {
        id: win
        anchors.centerIn: parent
        width: winWidth
        height: winHeight

        // The border ring: Hyprland draws `border_size` px of `activeBorder`
        // outside the content at the configured `rounding`; a full-size
        // rectangle behind an inset content rectangle reproduces that
        // exactly, with no `border.width` anti-aliasing seam at rounding 0.
        Rectangle {
            id: windowBorder
            anchors.fill: parent
            radius: frame ? frame.rounding : 0
            color: frame ? frame.activeBorder : Qt.rgba(0, 0, 0, 1)
            antialiasing: true
        }

        Rectangle {
            id: windowContent
            x: frame ? frame.borderSize : 0
            y: frame ? frame.borderSize : 0
            width: frame ? frame.contentWidth : parent.width
            height: frame ? frame.contentHeight : parent.height
            radius: frame ? frame.innerRounding : 0
            color: frame ? frame.editorBackground : Qt.rgba(0, 0, 0, 1)
            antialiasing: true

            // --- Header: title/subtitle only — no icon slot, see ADR-0008 ---
            Column {
                id: headerColumn
                x: frame ? frame.headerPadding : 0
                y: frame ? frame.headerPadding + (frame.heroHeight - (frame.titleLineHeight + frame.headerSpacing + frame.captionLineHeight)) / 2 : 0
                width: frame ? Math.max(0, frame.contentWidth - 2 * frame.headerPadding) : 0
                spacing: frame ? frame.headerSpacing : 0

                Text {
                    id: titleText
                    width: headerColumn.width
                    height: frame ? frame.titleLineHeight : 0
                    verticalAlignment: Text.AlignVCenter
                    text: frame ? frame.title : ""
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: frame ? frame.colors.foreground : Qt.rgba(0, 0, 0, 1)
                    font.family: frame ? frame.headerFontFamily : "monospace"
                    font.pixelSize: frame ? frame.titleSize : 15
                    font.bold: true
                }

                Text {
                    id: subtitleText
                    width: headerColumn.width
                    height: frame ? frame.captionLineHeight : 0
                    verticalAlignment: Text.AlignVCenter
                    visible: text !== ""
                    text: frame ? frame.subtitle : ""
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: Qt.darker(colorHelper.foreground, dimFactor)
                    font.family: frame ? frame.headerFontFamily : "monospace"
                    font.pixelSize: frame ? frame.captionSize : 11
                    font.bold: true
                    font.letterSpacing: headerCaptionSpacing
                }
            }

            // 1px full-content-width divider between the header and the code.
            Rectangle {
                id: headerSeparator
                x: 0
                y: frame ? frame.headerPadding + frame.heroHeight + frame.headerPadding : 0
                width: frame ? frame.contentWidth : 0
                height: headerSeparatorHeight
                color: Qt.rgba(colorHelper.foreground.r, colorHelper.foreground.g, colorHelper.foreground.b, separatorAlpha)
            }

            // Gutter: right-aligned line numbers starting at 1, one per rendered
            // line (including the padded blank lines when lines < minLines).
            // `showGutter: false` (see the fixture field) hides this column
            // and reclaims its width entirely — `frame.gutterWidth` is
            // already 0 in that case, so `codeColumn` below starts right
            // after `padding`.
            Column {
                id: gutterColumn
                x: frame ? frame.padding : 0
                y: frame ? frame.headerHeight + frame.padding : 0
                width: frame ? Math.max(0, frame.gutterWidth - frame.charAdvance) : 0
                visible: frame ? frame.showGutter : true
                spacing: 0
                Repeater {
                    model: frame && frame.showGutter ? frame.renderedLineCount : 0
                    delegate: Text {
                        required property int index
                        width: gutterColumn.width
                        height: frame.lineHeight
                        horizontalAlignment: Text.AlignRight
                        verticalAlignment: Text.AlignVCenter
                        text: String(index + 1)
                        textFormat: Text.PlainText
                        color: frame.lineNumberColor
                        font.family: frame.fontFamily
                        font.pixelSize: frame.fontSize
                    }
                }
            }

            // Code: a column of rows, each a row of styled spans.
            Column {
                id: codeColumn
                x: frame ? frame.padding + frame.gutterWidth : 0
                y: frame ? frame.headerHeight + frame.padding : 0
                width: frame ? parent.width - 2 * frame.padding - frame.gutterWidth : 0
                spacing: 0
                Repeater {
                    model: frame ? frame.renderedLineCount : 0
                    // A plain `Item`, not a `Row`, as the per-line delegate: a
                    // `Row` whose only child `Text` has an empty string (a blank
                    // source line) collapses to zero height in the parent
                    // `Column` even with an explicit `height` set on the `Row`
                    // itself (confirmed with a five-line repro — every blank
                    // line vanished and the following lines shifted up to fill
                    // the gap). `Item` does not have that behaviour.
                    delegate: Item {
                        required property int index
                        width: codeColumn.width
                        height: frame.lineHeight
                        Row {
                            anchors.verticalCenter: parent.verticalCenter
                            // `centerContent: true` (fixture field) centres
                            // this line's actual rendered width within the
                            // available code-column width (`parent.width`,
                            // already net of gutter/padding regardless of
                            // `showGutter`/`compact`) instead of today's
                            // unconditional flush-left `x: 0`. Guarded by
                            // `index < frame.lineWidths.length` for the
                            // blank padded lines beyond the fixture's own
                            // content (non-compact `minLines` floor), which
                            // have no measured width and render nothing
                            // anyway.
                            x: frame && frame.centerContent && index < frame.lineWidths.length
                                ? Math.max(0, (parent.width - frame.lineWidths[index]) / 2)
                                : 0
                            Repeater {
                                model: index < frame.lines.length ? frame.lines[index] : []
                                // A span whose text is nothing but full-block
                                // glyphs (U+2588, as OmaWordl's tile spans
                                // use) renders as a solid `Rectangle`
                                // instead of a `Text` glyph. Two adjacent
                                // glyphs -- within one span, or across a
                                // tile boundary between two spans -- each
                                // get anti-aliased independently at their
                                // own (often non-integer) pixel position,
                                // leaving a hairline seam of background
                                // colour between them; a real filled
                                // rectangle has no glyph edges to seam.
                                // This also matches how tiles actually look
                                // on the OmaWordl board itself -- solid
                                // colour, not text.
                                delegate: Item {
                                    required property var modelData
                                    readonly property bool isBlockTile: /^█+$/.test(modelData.text)
                                    // A block-tile span is a square, its
                                    // edge `frame.tileEdge` (== the row's
                                    // own height) -- never the font glyphs'
                                    // own advance width, which is what
                                    // produced the too-tall/too-narrow
                                    // rectangles this replaces. Must match
                                    // `tileEdge`'s use in `buildFrame`'s
                                    // `lineWidths` measurement above
                                    // exactly, or centring/canvas sizing
                                    // drift from what's actually drawn.
                                    width: isBlockTile ? frame.tileEdge : glyphText.implicitWidth
                                    height: frame.lineHeight
                                    Rectangle {
                                        anchors.fill: parent
                                        // Inset on all four sides so tiles
                                        // read as separate squares both
                                        // across a row (adjacent columns)
                                        // and down the grid (adjacent rows)
                                        // instead of same-coloured
                                        // neighbours fusing into one block
                                        // -- the gap is the real board
                                        // grid's own 6px gap on its 54px
                                        // tiles (see `main.py`'s
                                        // `Gtk.Grid(row_spacing=6,
                                        // column_spacing=6)`), scaled to
                                        // this square tile's own edge so
                                        // the ratio matches regardless of
                                        // font size.
                                        anchors.margins: parent.isBlockTile ? Math.round(frame.tileEdge / 9) : 0
                                        visible: parent.isBlockTile
                                        color: parent.modelData.color
                                    }
                                    Text {
                                        id: glyphText
                                        visible: !parent.isBlockTile
                                        text: parent.modelData.text
                                        color: parent.modelData.color
                                        height: frame.lineHeight
                                        verticalAlignment: Text.AlignVCenter
                                        textFormat: Text.PlainText
                                        font.family: frame.fontFamily
                                        font.pixelSize: frame.fontSize
                                        font.italic: parent.modelData.fontStyle === "italic"
                                        font.weight: parent.modelData.fontWeight ? parent.modelData.fontWeight : Font.Normal
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
