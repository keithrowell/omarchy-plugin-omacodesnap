import QtQuick
import Quickshell
import Quickshell.Io

// Marketplace entry point (ADR-0003): the Omarchy shell loads exactly one
// of these, once, for as long as this plugin is enabled
// (`omarchy plugin enable com.keithrowell.omacodesnap`), parented under its
// own non-visual `serviceHost` item — see `shell.qml`'s `ensureService()`.
// It owns no UI itself; it only exposes an IPC target so `bin/omacodesnap`
// (already running the selection/highlight pipeline as a plain script) can
// ask the *already-running* shell to show a preview, instead of spawning a
// fresh `qs` process per snap the way the old standalone design did.
//
//   qs ipc call omacodesnap show <input> <request> <root> <previewPng> <auto> <shotPath>
//   omarchy-shell omacodesnap show <input> <request> <root> <previewPng> <auto> <shotPath>
//
// A second call while a preview is already open destroys the old one first
// — the direct replacement for the old design's `qs kill -p .../Main.qml`.
//
// `inputPath`/`requestPath`/`previewPngPath` are per-run scratch files
// under `$XDG_RUNTIME_DIR/omacodesnap/`; the old standalone-process design let
// `bin/omacodesnap`'s own EXIT trap delete them once `qs` (which it ran
// synchronously) finished. Now that call returns immediately, long before
// the overlay it triggered is closed — the overlay reads `requestPath` and
// writes `previewPngPath` for as long as it stays open, potentially
// minutes later — so cleanup moves here, firing once the overlay this
// service created actually closes.
QtObject {
    id: root

    // Set by the host when present (see shell.qml's ensureService(), which
    // copies these onto the instance if the property exists) — none of
    // them are used here, but declaring them means the host's generic
    // property assignment is a no-op instead of a QML warning.
    property var shell
    property var manifest
    property var pluginRegistry
    property var barWidgetRegistry
    property string omarchyPath: ""

    // The one live Overlay instance, or null, and the scratch files it was
    // given — tracked together so a second `show()` (replacing an open
    // preview) and a self-close (Esc, Close, an OMACODESNAP_AUTO run finishing)
    // both retire the same way.
    property var _overlay: null
    property var _overlayFiles: null

    function _retire(overlay) {
        if (root._overlay !== overlay) return;
        root._overlay = null;
        if (root._overlayFiles !== null) {
            root.cleanupProcess.command = ["rm", "-f",
                root._overlayFiles.inputPath, root._overlayFiles.requestPath, root._overlayFiles.previewPngPath];
            root.cleanupProcess.running = true;
        }
        root._overlayFiles = null;
        overlay.destroy();
    }

    function show(inputPath, requestPath, rootDir, previewPngPath, auto, shotPath) {
        if (root._overlay !== null) {
            root._retire(root._overlay);
        }
        const component = Qt.createComponent(Qt.resolvedUrl("Overlay.qml"));
        if (component.status !== Component.Ready) {
            console.error("omacodesnap: failed to load Overlay.qml: " + component.errorString());
            return;
        }
        const overlay = component.createObject(root, {
            inputPath: inputPath,
            requestPath: requestPath,
            rootDir: rootDir,
            previewPngPath: previewPngPath,
            autoMode: auto,
            shotPathOverride: shotPath,
        });
        if (overlay === null) {
            console.error("omacodesnap: could not create the preview window");
            return;
        }
        overlay.overlayClosed.connect(function () { root._retire(overlay); });
        root._overlay = overlay;
        root._overlayFiles = { inputPath: inputPath, requestPath: requestPath, previewPngPath: previewPngPath };
    }

    // Same "no default property" reason as `ipc` above.
    property Process cleanupProcess: Process {
        stdinEnabled: false
    }

    // --- setup on load, in place of a plugin lifecycle hook Omarchy has no
    // equivalent of --------------------------------------------------------
    //
    // The manifest schema (`omarchy-plugin-validate`) has no `postInstall`/
    // `setup` field — deliberately, almost certainly: a plugin's own QML
    // already runs arbitrary code the moment it's enabled, so a second,
    // separate auto-run-a-script mechanism would just be another attack
    // surface for no real gain. A service's `Component.onCompleted`
    // shelling out for its own setup *is* the idiom this ecosystem already
    // uses instead — `com.keithrowell.doorman`'s `Service.qml` does exactly
    // this for its own state directories.
    //
    // `bin/install` already does everything a fresh install needs —
    // compiles the vendored tree-sitter grammars (the universal fallback
    // highlighter every snap that isn't "Zed/VS Code/Neovim successfully
    // colouring their own text" depends on; without them those snaps
    // degrade to plain, uncoloured text — see `lib/highlight/zed.mjs`),
    // writes the desktop file, and links the `~/.local/bin` launcher — and
    // every step is already idempotent (a no-op "unchanged" once done), so
    // running it here on every load is cheap and safe, not just on first
    // install. `manifest.__sourceDir` (set by the shell's own
    // `PluginRegistry.qml`) is this plugin's actual installed directory —
    // not `omarchyPath` (the shell's own path) and not any path baked in
    // here, since a user's dev-clone checkout can live anywhere.
    Component.onCompleted: root._runSetup();

    function _runSetup() {
        const sourceDir = root.manifest && root.manifest.__sourceDir;
        if (!sourceDir) return; // no manifest (a fixture/dev harness with no real plugin install) — nothing to set up
        root.setupProcess.command = [sourceDir + "/bin/install"];
        root.setupProcess.running = true;
    }

    // A notification only when there's something worth surfacing: grammars
    // actually got (re)compiled just now (first install, or a version
    // bump that changed the vendored sources), or `bin/install` itself
    // flagged a real problem (a missing package, a failed grammar build) —
    // that one's also `console.warn`ed, for whoever does go looking at
    // `journalctl`/the shell log, but a user hitting a missing dependency
    // deserves better than a log line nobody's watching. The common case —
    // everything already set up, nothing to do — stays silent, so this
    // doesn't nag on every shell restart.
    function _onSetupDone(output) {
        const lines = String(output).split("\n");
        const built = lines.some((line) => line.startsWith("grammar: built"));
        const problems = lines.filter((line) => /missing|failed/i.test(line));
        if (problems.length > 0) {
            console.warn("omacodesnap: bin/install reported a problem:\n" + problems.join("\n"));
            root.notifyProcess.command = ["notify-send", "OmaCodeSnap", "Setup found a problem:\n" + problems.join("\n")];
            root.notifyProcess.running = true;
        } else if (built) {
            root.notifyProcess.command = ["notify-send", "OmaCodeSnap", "Ready to snap — highlighting grammars just finished compiling."];
            root.notifyProcess.running = true;
        }
    }

    property Process setupProcess: Process {
        stdinEnabled: false
        stdout: StdioCollector {
            waitForEnd: true
            onStreamFinished: root._onSetupDone(text)
        }
    }

    property Process notifyProcess: Process {
        stdinEnabled: false
    }

    // `QtObject` has no default property, unlike `Item`, so the handler
    // must be assigned explicitly rather than nested as a plain child.
    property IpcHandler ipc: IpcHandler {
        target: "omacodesnap"

        function show(inputPath: string, requestPath: string, rootDir: string, previewPngPath: string, auto: string, shotPath: string): void {
            root.show(inputPath, requestPath, rootDir, previewPngPath, auto, shotPath);
        }
    }
}
