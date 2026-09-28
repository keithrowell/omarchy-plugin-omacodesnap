import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "Grab.js" as Grab

// The live preview window (ADR-0003). Reusable, host-agnostic component:
// every input arrives as a constructor property, never read from the
// environment — `app/Service.qml` creates one of these per snap (the
// persistent, marketplace-required path), passing the paths bin/omacodesnap's
// selection/highlight pipeline already wrote; `app/Main.qml`'s own
// `OMACODESNAP_MODE=preview` entry point creates one too, for standalone
// testing without the Omarchy shell, filling the same properties from
// `Quickshell.env(...)` itself.
//
// This component never calls `Qt.quit()` — that would end whichever
// process hosts it, which is catastrophic when the host is the shared
// Omarchy shell process. Every place the old standalone window used to
// quit instead calls `closeOverlay()`, which emits `overlayClosed` (a
// distinct signal from Window's own built-in `closed`, which still fires
// on a real WM-initiated close and is also wired to `closeOverlay()`
// below) and `destroy()`s this object; each host decides what
// "overlayClosed" means for it (the service clears its tracked reference,
// Main.qml's test entry point quits the process — see there).
//
// Every colour below comes from `input.theme.colors`; nothing is a literal
// (the `Qt.rgba(0, 0, 0, 1)` fallbacks below are the same "nothing has
// loaded yet" placeholder `app/Snap.qml` already uses, never a real theme
// colour). No `QtQuick.Controls` import: buttons and the language popup are
// plain `Rectangle` + `Text` + `MouseArea`.
FloatingWindow {
    id: previewWindow
    title: "OmaCodeSnap"

    signal overlayClosed()

    // Stay unmapped until the frame has its real, final size. `implicitWidth`
    // /`implicitHeight` below settle across several bindings re-evaluating as
    // the object tree finishes construction (snapItem starts at 0x0 before
    // its own `winWidth`/`winHeight` bindings resolve); a `FloatingWindow`
    // only takes implicitWidth/implicitHeight as a size *hint* at the moment
    // it is first shown to the compositor, not as a live binding thereafter.
    // Mapping while still 0x0-ish locks the real Wayland surface at that
    // early, too-small size, and the code never becomes fully visible even
    // though the QML-side properties go on to compute the right answer.
    // Deferring `visible` until content is truly settled means the window
    // is only ever mapped once, at its final size.
    visible: snapItem.ready

    // --- Named constants (every size/radius/opacity below is one of these) ---
    readonly property int margin: 16
    readonly property int barHeight: 56
    readonly property int buttonRadius: 8
    readonly property int buttonPaddingX: 14
    readonly property int buttonSpacing: 8
    readonly property int barPaddingX: 12
    readonly property real fitFraction: 0.8
    readonly property int minWindowWidth: 360
    readonly property int labelPixelSize: 13
    readonly property int smallPixelSize: 11
    readonly property int popupItemHeight: 30
    readonly property int popupMaxVisible: 8
    readonly property int popupWidth: 180
    readonly property int popupBorderWidth: 1
    // How long after Snap.ready to wait before an OMACODESNAP_AUTO action runs
    // or a Copy/Save grab fires, so the last frame (blur, SVG decode) has
    // settled — same reasoning as Main.qml's render mode.
    readonly property int settleDelayMs: 250

    // --- Inputs (set by whoever creates this: Service.qml or Main.qml's
    // standalone test entry point) ---
    property string inputPath: ""
    property string requestPath: ""
    property string rootDir: ""
    property string previewPngPath: ""
    property string autoMode: ""
    // Empty means "use the default path"; see `shotPath` below.
    property string shotPathOverride: ""
    // OMACODESNAP_AUTO="lang:<id>" (e.g. "lang:python", "lang:plain") drives the
    // language selector through the exact same code path a popup click
    // uses (selectLanguage), waits for the re-highlight to land, then takes
    // a shot-style picture and quits — so the popup's own re-highlight flow
    // is verifiable without a human click, the same way copy/save/shot are.
    readonly property string autoLangId: autoMode.indexOf("lang:") === 0 ? autoMode.slice("lang:".length) : ""
    // Where OMACODESNAP_AUTO=shot|lang:<id> saves a picture of this bar for
    // review; overridable so a reviewer/builder can point it anywhere.
    readonly property string shotPath: shotPathOverride !== "" ? shotPathOverride : (rootDir + "/docs/agentile/specs/0006-preview-and-capture/preview-shot.png")

    property var input: null
    property var request: null
    property bool languageBusy: false
    property bool popupOpen: false
    property bool autoStarted: false

    readonly property var theme: input ? input.theme : null
    readonly property var colors: theme ? theme.colors : null
    // `var`, not `string`: `input.snap.language` is JS `null` for "plain" —
    // a QML `string` property would coerce that to `""`, losing the value
    // the `=== null` checks below (and the popup's "plain" entry) rely on.
    readonly property var currentLanguage: input && input.snap ? input.snap.language : null
    readonly property var languageOptions: input && input.languages ? ["plain"].concat(input.languages) : ["plain"]
    readonly property string picturesDir: request && request.pictures ? request.pictures : ""

    // Same Hyprland-scale correction as Main.qml's render mode; see Grab.js.
    readonly property var monitor: Hyprland.monitors.values.find(m => previewWindow.screen && m.name === previewWindow.screen.name) ?? null
    readonly property real screenScale: monitor && monitor.scale > 0 ? monitor.scale : Screen.devicePixelRatio

    readonly property real maxContentWidth: (previewWindow.screen ? previewWindow.screen.width : 1280) * fitFraction
    readonly property real maxContentHeight: (previewWindow.screen ? previewWindow.screen.height : 800) * fitFraction

    // Fit-to-window scale for the code frame: never upscaled past 1, and
    // never so large the window would exceed fitFraction of the screen in
    // either dimension once the bar and margins are accounted for.
    readonly property real fit: {
        if (!snapItem || snapItem.width <= 0 || snapItem.height <= 0) return 1;
        const byWidth = (maxContentWidth - 2 * margin) / snapItem.width;
        const byHeight = (maxContentHeight - barHeight - 2 * margin) / snapItem.height;
        return Math.min(1, byWidth, byHeight);
    }

    implicitWidth: Math.max(minWindowWidth, Math.min(snapItem.width * fit + 2 * margin, maxContentWidth))
    implicitHeight: Math.min(snapItem.height * fit + barHeight + 2 * margin, maxContentHeight)

    color: colors ? colors.background : Qt.rgba(0, 0, 0, 1)

    // Emits `closed` and destroys this overlay. Every place that used to
    // call `Qt.quit()` calls this instead — see the header comment.
    function closeOverlay() {
        previewWindow.overlayClosed();
        previewWindow.destroy();
    }

    onClosed: previewWindow.closeOverlay()

    // --- Data ----------------------------------------------------------
    FileView {
        id: inputFile
        path: previewWindow.inputPath
        blockLoading: true
        watchChanges: false
        printErrors: false
        onLoaded: {
            try {
                previewWindow.input = JSON.parse(text());
            } catch (e) {
                console.error("preview: invalid input JSON at " + previewWindow.inputPath + ": " + e);
            }
            // Only once an OMACODESNAP_AUTO=lang:<id> run's own re-highlight
            // reload lands (autoStarted guards out this same handler firing
            // on the very first, ordinary load at startup) — give the frame
            // a moment to rebuild from the new input before grabbing it.
            if (previewWindow.autoStarted && previewWindow.autoLangId !== "") {
                autoLangShotTimer.restart();
            }
        }
        onLoadFailed: (error) => console.error("preview: could not read " + previewWindow.inputPath + ": " + error);
    }

    FileView {
        id: requestFile
        path: previewWindow.requestPath
        blockLoading: true
        printErrors: false
        onLoaded: {
            try {
                previewWindow.request = JSON.parse(text());
            } catch (e) {
                console.error("preview: invalid request JSON at " + previewWindow.requestPath + ": " + e);
            }
        }
        onLoadFailed: (error) => console.error("preview: could not read " + previewWindow.requestPath + ": " + error);
    }

    // Re-highlights with a different language (the language selector).
    Process {
        id: languageProcess
        stdinEnabled: false
        onExited: (exitCode, exitStatus) => {
            previewWindow.languageBusy = false;
            if (exitCode === 0) {
                inputFile.reload();
            } else {
                previewWindow.notify("OmaCodeSnap", "Re-highlight failed (see terminal)");
            }
        }
    }

    // `wl-copy`'s only shell use on the whole run path: it sees nothing but
    // this run's own rendered PNG path, never selection text.
    Process {
        id: copyProcess
        stdinEnabled: false
        onExited: (exitCode, exitStatus) => {
            if (exitCode === 0) {
                previewWindow.notify("OmaCodeSnap", "Copied to clipboard");
            } else {
                previewWindow.notify("OmaCodeSnap", "Copy failed: install wl-clipboard (sudo pacman -S wl-clipboard)");
            }
        }
    }

    Process {
        id: notifyProcess
        stdinEnabled: false
        onExited: (exitCode, exitStatus) => previewWindow.finishAutoIfDue()
    }

    function notify(summary, body) {
        notifyProcess.command = ["notify-send", summary, body];
        notifyProcess.running = true;
    }

    // Closes once the auto-triggered action's own notification has finished,
    // so `OMACODESNAP_AUTO=copy|save` is verifiable end to end (notification
    // text included) without a human, then closes — never left open.
    function finishAutoIfDue() {
        // Also covers a failed OMACODESNAP_AUTO=lang:<id> re-highlight (its
        // "Re-highlight failed" notification runs through here too, via
        // languageProcess.onExited) — the window must not sit open forever
        // just because the CLI call failed.
        if (previewWindow.autoMode === "copy" || previewWindow.autoMode === "save" || previewWindow.autoLangId !== "") {
            previewWindow.closeOverlay();
        }
    }

    function selectLanguage(lang) {
        previewWindow.popupOpen = false;
        if (lang === previewWindow.currentLanguage || (lang === "plain" && previewWindow.currentLanguage === null)) return;
        previewWindow.languageBusy = true;
        languageProcess.command = ["node", previewWindow.rootDir + "/lib/snap.mjs", "--request", previewWindow.requestPath, "--language", lang, "--out", previewWindow.inputPath];
        languageProcess.running = true;
    }

    function cycleLanguage(step) {
        const options = previewWindow.languageOptions;
        if (options.length === 0) return;
        const current = previewWindow.currentLanguage === null ? "plain" : previewWindow.currentLanguage;
        let index = options.indexOf(current);
        if (index === -1) index = 0;
        index = (index + step + options.length) % options.length;
        previewWindow.selectLanguage(options[index]);
    }

    function doCopy() {
        const size = Grab.exportSize(snapItem, snapItem.exportScale, previewWindow.screenScale);
        snapItem.grabToImage(function (result) {
            if (!result.saveToFile(previewWindow.previewPngPath)) {
                previewWindow.notify("OmaCodeSnap", "Copy failed: could not render the image");
                return;
            }
            copyProcess.command = ["sh", "-c", 'exec wl-copy --type image/png < "$1"', "omacodesnap", previewWindow.previewPngPath];
            copyProcess.running = true;
        }, Qt.size(size.width, size.height));
    }

    function doSave() {
        const size = Grab.exportSize(snapItem, snapItem.exportScale, previewWindow.screenScale);
        const dir = previewWindow.picturesDir !== "" ? previewWindow.picturesDir : (Quickshell.env("HOME") + "/Pictures");
        const path = dir + "/omacodesnap-" + Qt.formatDateTime(new Date(), "yyyy-MM-dd_HH-mm-ss") + ".png";
        snapItem.grabToImage(function (result) {
            if (result.saveToFile(path)) {
                previewWindow.notify("OmaCodeSnap", "Saved " + path);
            } else {
                previewWindow.notify("OmaCodeSnap", "Save failed");
            }
        }, Qt.size(size.width, size.height));
    }

    function doShot() {
        contentRoot.grabToImage(function (result) {
            result.saveToFile(previewWindow.shotPath);
            previewWindow.closeOverlay();
        });
    }

    function runAuto() {
        if (previewWindow.autoStarted || previewWindow.autoMode === "") return;
        previewWindow.autoStarted = true;
        if (previewWindow.autoMode === "copy") previewWindow.doCopy();
        else if (previewWindow.autoMode === "save") previewWindow.doSave();
        else if (previewWindow.autoMode === "shot") previewWindow.doShot();
        else if (previewWindow.autoLangId !== "") {
            // selectLanguage() no-ops (never starts languageProcess, never
            // reloads) when the requested language is already current —
            // going through it anyway for an already-current language would
            // leave nothing to ever trigger autoLangShotTimer, and the
            // window would sit open forever instead of closing.
            const current = previewWindow.currentLanguage === null ? "plain" : previewWindow.currentLanguage;
            if (previewWindow.autoLangId === current) previewWindow.doShot();
            else previewWindow.selectLanguage(previewWindow.autoLangId);
        } else previewWindow.closeOverlay(); // "none" (or an unrecognised value): just prove the window opened cleanly.
    }

    Timer {
        id: autoTimer
        interval: previewWindow.settleDelayMs
        onTriggered: previewWindow.runAuto()
    }

    // Fires once `inputFile`'s onLoaded sees the OMACODESNAP_AUTO=lang:<id>
    // re-highlight's own reload land (see there); doShot() saves and closes.
    Timer {
        id: autoLangShotTimer
        interval: previewWindow.settleDelayMs
        onTriggered: previewWindow.doShot()
    }

    // --- UI --------------------------------------------------------------
    Item {
        id: contentRoot
        anchors.fill: parent

        // The window's own `color` fills the real window surface, but a
        // grabToImage() of an *Item* (rather than the window) renders an
        // offscreen texture that starts transparent regardless — without an
        // explicit opaque backing rectangle here, OMACODESNAP_AUTO=shot's
        // grab of `contentRoot` showed the gap between the frame and the
        // bar as flattened white instead of the theme's background.
        Rectangle {
            anchors.fill: parent
            color: previewWindow.colors ? previewWindow.colors.background : Qt.rgba(0, 0, 0, 1)
        }

        FocusScope {
            id: keyScope
            anchors.fill: parent
            focus: true

            Keys.onPressed: (event) => {
                if (previewWindow.popupOpen) {
                    if (event.key === Qt.Key_Escape) {
                        previewWindow.popupOpen = false;
                        event.accepted = true;
                    }
                    return;
                }
                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    previewWindow.doCopy();
                    event.accepted = true;
                } else if (event.key === Qt.Key_S) {
                    previewWindow.doSave();
                    event.accepted = true;
                } else if (event.key === Qt.Key_Escape) {
                    previewWindow.closeOverlay();
                    event.accepted = true;
                } else if (event.key === Qt.Key_Left) {
                    previewWindow.cycleLanguage(-1);
                    event.accepted = true;
                } else if (event.key === Qt.Key_Right) {
                    previewWindow.cycleLanguage(1);
                    event.accepted = true;
                }
            }

            Item {
                id: stageArea
                x: previewWindow.margin
                y: previewWindow.margin
                width: Math.max(1, previewWindow.width - 2 * previewWindow.margin)
                height: Math.max(1, previewWindow.height - previewWindow.barHeight - 2 * previewWindow.margin)
                clip: true

                Snap {
                    id: snapItem
                    input: previewWindow.input
                    scale: previewWindow.fit
                    transformOrigin: Item.TopLeft

                    onReadyChanged: if (ready) autoTimer.start()
                }
            }

            // Closes the language popup on an outside click. Declared here —
            // after the code area, before the bar and its buttons — so
            // normal (z: 0) stacking order puts the bar's own buttons above
            // this and still clickable while the popup is open; the popup
            // itself (z: 10, below) is above both.
            MouseArea {
                anchors.fill: parent
                visible: previewWindow.popupOpen
                onClicked: previewWindow.popupOpen = false
            }

            // --- Bottom bar: [language selector] [warning] ... [Copy] [Save] [Close] ---
            Rectangle {
                id: bar
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: previewWindow.barHeight
                color: previewWindow.colors ? previewWindow.colors.lighter_background : Qt.rgba(0, 0, 0, 1)

                Rectangle {
                    id: languageButton
                    anchors.left: parent.left
                    anchors.leftMargin: previewWindow.barPaddingX
                    anchors.verticalCenter: parent.verticalCenter
                    height: previewWindow.barHeight - 2 * previewWindow.buttonSpacing
                    width: languageLabel.implicitWidth + 2 * previewWindow.buttonPaddingX
                    radius: previewWindow.buttonRadius
                    color: languageMouse.containsMouse || previewWindow.popupOpen
                        ? (previewWindow.colors ? previewWindow.colors.selection : Qt.rgba(0, 0, 0, 1))
                        : Qt.rgba(0, 0, 0, 0)

                    Text {
                        id: languageLabel
                        anchors.centerIn: parent
                        text: previewWindow.languageBusy ? "…" : (previewWindow.currentLanguage ?? "plain")
                        textFormat: Text.PlainText
                        color: previewWindow.colors ? previewWindow.colors.foreground : Qt.rgba(0, 0, 0, 1)
                        font.family: "monospace"
                        font.pixelSize: previewWindow.labelPixelSize
                    }

                    MouseArea {
                        id: languageMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        onClicked: previewWindow.popupOpen = !previewWindow.popupOpen
                    }
                }

                Text {
                    id: warningText
                    anchors.left: languageButton.right
                    anchors.leftMargin: previewWindow.buttonSpacing
                    anchors.right: actionRow.left
                    anchors.rightMargin: previewWindow.buttonSpacing
                    anchors.verticalCenter: parent.verticalCenter
                    visible: previewWindow.input && previewWindow.input.warnings && previewWindow.input.warnings.length > 0
                    text: previewWindow.input && previewWindow.input.warnings ? previewWindow.input.warnings.join(" · ") : ""
                    textFormat: Text.PlainText
                    color: previewWindow.colors ? previewWindow.colors.yellow : Qt.rgba(0, 0, 0, 1)
                    font.family: "monospace"
                    font.pixelSize: previewWindow.smallPixelSize
                    elide: Text.ElideRight
                }

                Row {
                    id: actionRow
                    anchors.right: parent.right
                    anchors.rightMargin: previewWindow.barPaddingX
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: previewWindow.buttonSpacing

                    Rectangle {
                        id: copyButton
                        height: previewWindow.barHeight - 2 * previewWindow.buttonSpacing
                        width: copyLabel.implicitWidth + 2 * previewWindow.buttonPaddingX
                        radius: previewWindow.buttonRadius
                        color: copyMouse.containsMouse
                            ? (previewWindow.colors ? previewWindow.colors.selection : Qt.rgba(0, 0, 0, 1))
                            : (previewWindow.colors ? previewWindow.colors.accent : Qt.rgba(0, 0, 0, 1))
                        Text {
                            id: copyLabel
                            anchors.centerIn: parent
                            text: "Copy ⏎"
                            textFormat: Text.PlainText
                            color: previewWindow.colors ? previewWindow.colors.background : Qt.rgba(0, 0, 0, 1)
                            font.family: "monospace"
                            font.pixelSize: previewWindow.labelPixelSize
                        }
                        MouseArea {
                            id: copyMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            onClicked: previewWindow.doCopy()
                        }
                    }

                    Rectangle {
                        id: saveButton
                        height: previewWindow.barHeight - 2 * previewWindow.buttonSpacing
                        width: saveLabel.implicitWidth + 2 * previewWindow.buttonPaddingX
                        radius: previewWindow.buttonRadius
                        color: saveMouse.containsMouse
                            ? (previewWindow.colors ? previewWindow.colors.selection : Qt.rgba(0, 0, 0, 1))
                            : (previewWindow.colors ? previewWindow.colors.lighter_background : Qt.rgba(0, 0, 0, 1))
                        Text {
                            id: saveLabel
                            anchors.centerIn: parent
                            text: "Save S"
                            textFormat: Text.PlainText
                            color: previewWindow.colors ? previewWindow.colors.foreground : Qt.rgba(0, 0, 0, 1)
                            font.family: "monospace"
                            font.pixelSize: previewWindow.labelPixelSize
                        }
                        MouseArea {
                            id: saveMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            onClicked: previewWindow.doSave()
                        }
                    }

                    Rectangle {
                        id: closeButton
                        height: previewWindow.barHeight - 2 * previewWindow.buttonSpacing
                        width: closeLabel.implicitWidth + 2 * previewWindow.buttonPaddingX
                        radius: previewWindow.buttonRadius
                        color: closeMouse.containsMouse
                            ? (previewWindow.colors ? previewWindow.colors.selection : Qt.rgba(0, 0, 0, 1))
                            : (previewWindow.colors ? previewWindow.colors.lighter_background : Qt.rgba(0, 0, 0, 1))
                        Text {
                            id: closeLabel
                            anchors.centerIn: parent
                            text: "Close Esc"
                            textFormat: Text.PlainText
                            color: previewWindow.colors ? previewWindow.colors.foreground : Qt.rgba(0, 0, 0, 1)
                            font.family: "monospace"
                            font.pixelSize: previewWindow.labelPixelSize
                        }
                        MouseArea {
                            id: closeMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            onClicked: previewWindow.closeOverlay()
                        }
                    }
                }
            }

            // --- Language popup: a plain themed list, opened above the language button ---
            Rectangle {
                id: languagePopup
                visible: previewWindow.popupOpen
                x: languageButton.x
                y: bar.y - height
                width: previewWindow.popupWidth
                height: Math.min(previewWindow.languageOptions.length, previewWindow.popupMaxVisible) * previewWindow.popupItemHeight
                color: previewWindow.colors ? previewWindow.colors.lighter_background : Qt.rgba(0, 0, 0, 1)
                border.width: previewWindow.popupBorderWidth
                border.color: previewWindow.colors ? previewWindow.colors.selection : Qt.rgba(0, 0, 0, 1)
                radius: previewWindow.buttonRadius
                z: 10

                ListView {
                    anchors.fill: parent
                    anchors.margins: previewWindow.popupBorderWidth
                    clip: true
                    model: previewWindow.languageOptions
                    delegate: Rectangle {
                        required property string modelData
                        width: ListView.view.width
                        height: previewWindow.popupItemHeight
                        color: itemMouse.containsMouse
                            ? (previewWindow.colors ? previewWindow.colors.selection : Qt.rgba(0, 0, 0, 1))
                            : Qt.rgba(0, 0, 0, 0)
                        Text {
                            anchors.left: parent.left
                            anchors.leftMargin: previewWindow.buttonPaddingX
                            anchors.verticalCenter: parent.verticalCenter
                            text: modelData
                            textFormat: Text.PlainText
                            color: previewWindow.colors ? previewWindow.colors.foreground : Qt.rgba(0, 0, 0, 1)
                            font.family: "monospace"
                            font.pixelSize: previewWindow.labelPixelSize
                        }
                        MouseArea {
                            id: itemMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            onClicked: previewWindow.selectLanguage(modelData)
                        }
                    }
                }
            }
        }
    }
}
