import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "Grab.js" as Grab

// Entry point for the standalone invocations of `qs -p app/Main.qml` (via
// bin/omacodesnap's fixture/benchmark modes, or by hand for testing). The real
// interactive path no longer runs through here at all — see ADR-0003:
// `bin/omacodesnap` triggers the persistent `app/Service.qml`, loaded by the
// Omarchy shell, over IPC instead. Three modes, chosen by environment
// variables (`qs` forwards no CLI arguments to QML):
//
// - `OMACODESNAP_MODE=preview`: a standalone `Overlay.qml` for testing the
//   live preview UI without a running Omarchy shell or an enabled plugin
//   — reads `OMACODESNAP_INPUT`/`OMACODESNAP_REQUEST`/etc. itself and quits the
//   process when the overlay closes (see the component below).
// - `OMACODESNAP_INPUT` set (and not preview mode): render mode. Load the JSON
//   at that path (built by `lib/input.mjs` from a fixture and the current
//   theme), show it in `Snap`, and once it settles, grab it to a PNG at
//   `OMACODESNAP_OUT` and quit.
// - Otherwise: the placeholder window from spec 0001.
ShellRoot {
    id: root

    readonly property string mode: Quickshell.env("OMACODESNAP_MODE") || ""
    readonly property string inputPath: Quickshell.env("OMACODESNAP_INPUT") || ""
    readonly property string outPath: Quickshell.env("OMACODESNAP_OUT") || ""

    // How long after `Snap.ready` becomes true to wait before grabbing, so
    // the last frame (blur, SVG decode) has settled.
    readonly property int settleDelayMs: 250
    // How long to wait for a render before giving up and quitting anyway.
    readonly property int renderTimeoutMs: 5000

    Loader {
        active: root.mode === "preview"
        sourceComponent: previewWindow
    }
    Loader {
        active: root.mode !== "preview" && root.inputPath !== ""
        sourceComponent: renderWindow
    }
    Loader {
        active: root.mode !== "preview" && root.inputPath === ""
        sourceComponent: placeholderWindow
    }

    // Standalone test entry point for `Overlay.qml` (ADR-0003): the real,
    // marketplace-required path is `app/Service.qml`, loaded by the Omarchy
    // shell and triggered over IPC — this one exists so the same UI can
    // still be exercised with a bare `qs -p app/Main.qml`, no running shell
    // or enabled plugin required, the way it always could. It fills the
    // same properties Service.qml passes as IPC arguments, from the same
    // environment variables `bin/omacodesnap` used to set before ADR-0003.
    // Overlay.qml never calls `Qt.quit()` itself (see its header comment),
    // so this wrapper quits the process when the overlay reports closed.
    Component {
        id: previewWindow

        Overlay {
            inputPath: Quickshell.env("OMACODESNAP_INPUT") || ""
            requestPath: Quickshell.env("OMACODESNAP_REQUEST") || ""
            rootDir: Quickshell.env("OMACODESNAP_ROOT") || ""
            previewPngPath: Quickshell.env("OMACODESNAP_PREVIEW_PNG") || ""
            autoMode: Quickshell.env("OMACODESNAP_AUTO") || ""
            shotPathOverride: Quickshell.env("OMACODESNAP_SHOT_PATH") || ""

            Component.onCompleted: overlayClosed.connect(Qt.quit)
        }
    }

    Component {
        id: renderWindow

        FloatingWindow {
            id: renderFloating
            title: "OmaCodeSnap"
            implicitWidth: snapItem.width > 0 ? snapItem.width : 640
            implicitHeight: snapItem.height > 0 ? snapItem.height : 360

            property var parsedInput: null
            property bool grabbed: false

            // `grabToImage`'s `targetSize` is scaled again by the window's
            // actual on-screen (Hyprland) scale before rasterising — Qt's own
            // `Screen.devicePixelRatio` under-reports it (rounds 1.6 up to
            // 2), so a plain `width * exportScale` target came out at
            // `exportScale * 1.6`, not `exportScale`, on this monitor (see
            // the plan's environment facts; that mismatch was found here, in
            // the render itself, not at plan time). Dividing the target by
            // Hyprland's own reported scale for this screen cancels it out.
            readonly property var monitor: Hyprland.monitors.values.find(m => renderFloating.screen && m.name === renderFloating.screen.name) ?? null
            readonly property real screenScale: monitor && monitor.scale > 0 ? monitor.scale : Screen.devicePixelRatio

            function fail(message) {
                console.error("render: " + message);
                Qt.quit();
            }

            function grab() {
                if (renderFloating.grabbed) return;
                renderFloating.grabbed = true;
                const size = Grab.exportSize(snapItem, snapItem.exportScale, renderFloating.screenScale);
                snapItem.grabToImage(function (result) {
                    const ok = result.saveToFile(root.outPath);
                    console.info("render: " + (ok ? "wrote " : "FAILED to write ") + root.outPath
                        + " (" + snapItem.width + "x" + snapItem.height + " logical, "
                        + Math.round(size.width) + "x" + Math.round(size.height) + " px requested, screen scale "
                        + renderFloating.screenScale + ")");
                    Qt.quit();
                }, Qt.size(size.width, size.height));
            }

            FileView {
                id: inputFile
                path: root.inputPath
                blockLoading: true
                printErrors: false
                onLoaded: {
                    try {
                        renderFloating.parsedInput = JSON.parse(text());
                    } catch (e) {
                        renderFloating.fail("invalid input JSON at " + root.inputPath + ": " + e);
                    }
                }
                onLoadFailed: (error) => renderFloating.fail("could not read " + root.inputPath + ": " + error);
            }

            Snap {
                id: snapItem
                input: renderFloating.parsedInput
                visible: input !== null

                onReadyChanged: if (ready) settleTimer.start()
            }

            Timer {
                id: settleTimer
                interval: root.settleDelayMs
                onTriggered: renderFloating.grab()
            }

            Timer {
                id: guardTimer
                interval: root.renderTimeoutMs
                running: true
                onTriggered: renderFloating.fail("timed out after " + root.renderTimeoutMs + "ms")
            }

            onClosed: Qt.quit()
        }
    }

    // Placeholder window for spec 0001 (packaging): proves the launcher, the
    // plugin symlink and a themed window all work end to end before any
    // snapping behaviour exists.
    //
    // Colours come from ~/.local/state/omarchy/current/theme/colors.toml,
    // read live through a FileView (no restart needed on a theme switch).
    // Until the file loads, or a key is missing, this falls back to Qt's
    // system palette — never to a literal colour. Spec 0003 replaces this
    // inline reading with lib/theme.mjs and a Theme singleton; this stays
    // small on purpose so that swap is a deletion.
    Component {
        id: placeholderWindow

        FloatingWindow {
            id: window
            title: "OmaCodeSnap"
            implicitWidth: 640
            implicitHeight: 360

            readonly property string colorsPath: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"

            // Empty string means "not loaded (yet)"; readColor only ever
            // returns a value it found in the file, so a missing key falls
            // through too.
            property string themeBackground: ""
            property string themeForeground: ""

            // Pulls one `key = "#rrggbb"`-shaped line out of colors.toml's
            // text. Theme-parsing code: the hex pattern here is a regex, not
            // a literal.
            function readColor(text, key) {
                const re = new RegExp("^\\s*" + key + "\\s*=\\s*\"(#[0-9a-fA-F]{3,8})\"", "m");
                const match = re.exec(text);
                return match ? match[1] : "";
            }

            color: themeBackground !== "" ? themeBackground : systemPalette.window

            SystemPalette {
                id: systemPalette
            }

            FileView {
                id: colorsFile
                path: window.colorsPath
                watchChanges: true
                printErrors: false
                onLoaded: {
                    const contents = text();
                    window.themeBackground = window.readColor(contents, "background");
                    window.themeForeground = window.readColor(contents, "foreground");
                }
                onLoadFailed: {
                    window.themeBackground = "";
                    window.themeForeground = "";
                }
                onFileChanged: reload()
            }

            FocusScope {
                id: input
                anchors.fill: parent
                focus: true
                Keys.onEscapePressed: Qt.quit()

                Column {
                    anchors.centerIn: parent
                    spacing: 12

                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: "OmaCodeSnap"
                        textFormat: Text.PlainText
                        color: window.themeForeground !== "" ? window.themeForeground : systemPalette.windowText
                        font.family: "monospace"
                        font.pixelSize: 32
                    }

                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: "Select code, press the binding."
                        textFormat: Text.PlainText
                        color: window.themeForeground !== "" ? window.themeForeground : systemPalette.windowText
                        font.family: "monospace"
                        font.pixelSize: 16
                    }
                }
            }

            onClosed: Qt.quit()
        }
    }
}
