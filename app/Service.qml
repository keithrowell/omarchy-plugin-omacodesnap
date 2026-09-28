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
//   omarchy-shell omacodesnap show <run-id>
//
// A second call while a preview is already open destroys the old one first
// — the direct replacement for the old design's `qs kill -p .../Main.qml`.
//
// The IPC carries one thing, the random suffix of the run directory
// `bin/omacodesnap` made with `mktemp -d` (ADR-0013). Everything else is
// derived here: the run directory from this process's own XDG_RUNTIME_DIR,
// the files inside it by fixed name, and the code root from this plugin's
// own manifest. Any same-user process can call this target, so it must not
// be able to name a file to read, write or delete, or a directory to run
// code from. The run directory is removed once the overlay closes (the
// launcher's own call returns long before that).
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

    // The one live Overlay instance, or null, and the run directory it was
    // given — tracked together so a second `show()` (replacing an open
    // preview) and a self-close (Esc, Close) both retire the same way.
    property var _overlay: null
    property var _overlayFiles: null

    // `mktemp -d run-XXXXXXXXXX` draws its ten characters from [A-Za-z0-9].
    readonly property var _runIdPattern: /^[A-Za-z0-9]{10}$/

    // This plugin's own directory: the shell's `manifest.__sourceDir` when
    // loaded as a plugin, else the directory above this file.
    function _rootDir() {
        const sourceDir = root.manifest && root.manifest.__sourceDir;
        if (sourceDir) return String(sourceDir).replace(/\/+$/, "");
        const url = String(Qt.resolvedUrl(".."));
        return decodeURIComponent(url.replace(/^file:\/\//, "")).replace(/\/+$/, "");
    }

    function _retire(overlay) {
        if (root._overlay !== overlay) return;
        root._overlay = null;
        if (root._overlayFiles !== null) {
            root._queueCleanup(root._overlayFiles.runDir);
        }
        root._overlayFiles = null;
        overlay.destroy();
    }

    function show(runId) {
        const id = String(runId);
        if (!root._runIdPattern.test(id)) {
            console.warn("omacodesnap: show() ignored: not a run id");
            return;
        }
        const runtime = Quickshell.env("XDG_RUNTIME_DIR") || "";
        if (runtime === "") {
            console.warn("omacodesnap: XDG_RUNTIME_DIR is not set; refusing to show a preview");
            return;
        }
        const runDir = runtime + "/omacodesnap/run-" + id;
        if (root._overlay !== null) {
            root._retire(root._overlay);
        }
        const component = Qt.createComponent(Qt.resolvedUrl("Overlay.qml"));
        if (component.status !== Component.Ready) {
            console.error("omacodesnap: failed to load Overlay.qml: " + component.errorString());
            return;
        }
        const overlay = component.createObject(root, {
            inputPath: runDir + "/input.json",
            requestPath: runDir + "/request.json",
            rootDir: root._rootDir(),
            previewPngPath: runDir + "/preview.png",
        });
        if (overlay === null) {
            console.error("omacodesnap: could not create the preview window");
            return;
        }
        overlay.overlayClosed.connect(function () { root._retire(overlay); });
        root._overlay = overlay;
        root._overlayFiles = { runDir: runDir };
    }

    // Removes one run directory: its known files by name, then the
    // directory itself (rmdir, so anything unexpected in it is left alone
    // rather than deleted). A constant script taking the directory as "$1".
    // Queued, because a second retire can arrive while the first `rm` is
    // still running on the one shared Process.
    property var _cleanupQueue: []

    function _queueCleanup(runDir) {
        root._cleanupQueue.push(runDir);
        root._runNextCleanup();
    }

    function _runNextCleanup() {
        if (root.cleanupProcess.running || root._cleanupQueue.length === 0) return;
        const runDir = root._cleanupQueue.shift();
        root.cleanupProcess.command = ["sh", "-c",
            'rm -f -- "$1/input.json" "$1/request.json" "$1/preview.png" "$1/selection.txt" "$1/window.json" "$1/ipc-error.txt"; rmdir -- "$1"',
            "omacodesnap", runDir];
        root.cleanupProcess.running = true;
    }

    // Same "no default property" reason as `ipc` below.
    property Process cleanupProcess: Process {
        stdinEnabled: false
        onExited: root._runNextCleanup()
    }

    // --- a read-only readiness check on load (ADR-0013) -------------------
    //
    // Loading the plugin changes nothing on disk: compiling the grammars,
    // writing the desktop file and linking the launcher are `bin/install`'s
    // job, run by the user (README). What happens here is only
    // `bin/build-grammars --check`, which compares mtimes and exits 1 when
    // anything is missing or stale; on that, one notification with a fixed
    // body says what to run. Its output is discarded, not collected.
    Component.onCompleted: root._checkSetup();

    function _checkSetup() {
        root.checkProcess.command = [root._rootDir() + "/bin/build-grammars", "--check"];
        root.checkProcess.running = true;
    }

    property Process checkProcess: Process {
        stdinEnabled: false
        onExited: function (exitCode, exitStatus) {
            if (exitCode === 0) return;
            root.notifyProcess.command = ["notify-send", "OmaCodeSnap",
                "Highlighting is not set up yet. Run bin/install in ~/.config/omarchy/plugins/com.keithrowell.omacodesnap"];
            root.notifyProcess.running = true;
        }
    }

    property Process notifyProcess: Process {
        stdinEnabled: false
    }

    // `QtObject` has no default property, unlike `Item`, so the handler
    // must be assigned explicitly rather than nested as a plain child.
    property IpcHandler ipc: IpcHandler {
        target: "omacodesnap"

        function show(runId: string): void {
            root.show(runId);
        }
    }
}
