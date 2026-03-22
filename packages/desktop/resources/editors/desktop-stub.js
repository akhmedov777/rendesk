/**
 * Desktop API stub for running the OnlyOffice editor SDK in-browser without
 * the native C++ DesktopEditors shell. Emulates enough of the AscDesktopEditor
 * interface for basic document editing: open, render, save.
 *
 * KEY FUNCTION: LocalStartOpen()
 * The SDK calls LocalStartOpen() when it's ready to receive document data.
 * Our implementation retrieves the pre-fetched binary from window._currentDocumentBinary
 * and calls DesktopOfflineAppDocumentEndLoad() to load it into the SDK.
 */
(function () {
  "use strict";

  if (window.AscDesktopEditor) return;

  // Read params from either the page URL or the script src URL
  var pageParams = new URLSearchParams(window.location.search);
  var scriptParams = new URLSearchParams("");
  try {
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf("desktop-stub.js") !== -1) {
        scriptParams = new URLSearchParams(scripts[i].src.split("?")[1] || "");
        break;
      }
    }
  } catch (e) {}

  var filePath = pageParams.get("filePath") || scriptParams.get("filePath") || "";
  var serviceUrl = pageParams.get("serviceUrl") || scriptParams.get("serviceUrl") || window.location.origin;

  // Make service URL available for common.js font loading
  window._RENDESK_SERVICE_URL = serviceUrl;

  // sdk-all-min.js and sdk-all.js are both needed (not min vs full)
  window['AscNotLoadAllScript'] = false;

  var _editorApi = null;
  var _openedFiles = Object.create(null);
  var _didLocalStartOpen = false;
  var _localStartOpenRetries = 0;
  var _localStartOpenMaxRetries = 350;

  function toUint8Array(data) {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

  function getCurrentBinary() {
    var local = toUint8Array(window._currentDocumentBinary);
    if (local && local.length > 0) return local;

    try {
      if (window.parent && window.parent !== window) {
        var parentBinary = toUint8Array(window.parent._currentDocumentBinary);
        if (parentBinary && parentBinary.length > 0) return parentBinary;
      }
    } catch (e) {}

    try {
      if (window.top && window.top !== window) {
        var topBinary = toUint8Array(window.top._currentDocumentBinary);
        if (topBinary && topBinary.length > 0) return topBinary;
      }
    } catch (e) {}

    return null;
  }

  function toArrayBuffer(data) {
    if (!data) return null;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }

  function notifyError(message) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: "editor:error",
          data: {
            error: message,
            details: JSON.stringify({
              source: "desktop-stub",
              localStartOpenRetries: _localStartOpenRetries,
            }),
          },
        }, "*");
      }
    } catch (e) {}
  }

  function getEditorInstance() {
    try {
      if (window._rendeskEditorInstance) return window._rendeskEditorInstance;
      if (window.Asc && window.Asc.editor) return window.Asc.editor;
      if (window.editor) return window.editor;
    } catch (e) {}
    return null;
  }

  function isEditorReadyForLocalOpen() {
    var editor = getEditorInstance();
    if (!editor || typeof editor.openDocument !== "function") return false;

    // In desktop flow, DocInfo and modules must be loaded before opening local binary.
    // If DocInfo exists but is still empty, wait.
    if (Object.prototype.hasOwnProperty.call(editor, "DocInfo") && !editor.DocInfo) return false;
    return true;
  }

  function tryDirectOpen(binary) {
    var editor = getEditorInstance();
    if (!editor || !window.AscCommon) return { ok: false, reason: "editor/AscCommon unavailable" };
    if (typeof window.AscCommon.OpenFileResult !== "function") return { ok: false, reason: "OpenFileResult missing" };
    if (typeof window.AscCommon.checkStreamSignature !== "function") {
      return { ok: false, reason: "checkStreamSignature missing" };
    }

    try {
      var file = new window.AscCommon.OpenFileResult();
      file.data = binary;
      file.bSerFormat = window.AscCommon.checkStreamSignature(file.data, window.AscCommon.c_oSerFormat.Signature);
      file.url = "";

      if (window.AscCommon.g_oDocumentUrls) {
        window.AscCommon.g_oDocumentUrls.documentUrl = "";
      }
      if (typeof editor.setOpenedAt === "function") {
        editor.setOpenedAt(Date.now());
      }
      if (window.AscCommon.g_oIdCounter) {
        window.AscCommon.g_oIdCounter.m_sUserId = window.AscDesktopEditor.CheckUserId();
      }
      if (window.AscCommon.History) {
        window.AscCommon.History.UserSaveMode = true;
      }

      editor.openDocument(file);
      if (typeof editor.asc_SetFastCollaborative === "function") {
        editor.asc_SetFastCollaborative(false);
      }

      var name = filePath ? (filePath.split("/").pop() || filePath.split("\\").pop() || "document") : "document";
      editor.documentTitle = name;
      if (typeof editor.sendEvent === "function") {
        editor.sendEvent("asc_onDocumentName", name);
      }
      if (typeof window.DesktopAfterOpen === "function") {
        window.DesktopAfterOpen(editor);
      }

      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : String(error) };
    }
  }

  function scheduleLocalStartOpenRetry(reason) {
    if (_didLocalStartOpen) return;
    if (_localStartOpenRetries >= _localStartOpenMaxRetries) {
      notifyError("LocalStartOpen timed out: " + reason);
      return;
    }
    _localStartOpenRetries += 1;
    setTimeout(function () {
      if (window.AscDesktopEditor && typeof window.AscDesktopEditor.LocalStartOpen === "function") {
        window.AscDesktopEditor.LocalStartOpen();
      }
    }, 30);
  }

  window.AscDesktopEditor = {
    // --- Identity / capability queries ---
    IsLocalFile: function () { return true; },
    isSupportMacroses: function () { return false; },
    IsSignaturesSupport: function () { return false; },
    IsProtectionSupport: function () { return false; },
    CryptoMode: 0,

    // --- Font rendering ---
    GetFontThumbnailHeight: function () { return 0; },
    GetSupportedScaleValues: function () { return "50;75;100;125;150;175;200;300;400;500"; },

    // --- Dictionaries (spellcheck disabled) ---
    getDictionariesPath: function () { return ""; },
    SpellCheck: function () { return ""; },

    // --- Plugins (none) ---
    GetInstallPlugins: function () {
      return JSON.stringify([
        { url: "", pluginsData: [] },
        { url: "", pluginsData: [] }
      ]);
    },
    PluginInstall: function () {},
    PluginUninstall: function () {},

    // --- File dialogs (stubs) ---
    OpenFilenameDialog: function () { return ""; },

    // --- User identity ---
    CheckUserId: function () { return "rendesk-user-" + Date.now(); },

    // --- Name / state notifications ---
    SetDocumentName: function () {},
    LocalFileGetSourcePath: function () { return filePath; },
    onDocumentModifiedChanged: function (isModified) {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: "editor:state-change",
            data: { modified: !!isModified }
          }, "*");
        }
      } catch (e) {}
    },
    onDocumentContentReady: function () {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "editor:ready", data: {} }, "*");
        }
      } catch (e) {}
    },

    // --- CRITICAL: LocalStartOpen ---
    // Called by the SDK (via common.js onEndLoadFile patch) when ready for data.
    LocalStartOpen: function () {
      if (_didLocalStartOpen) return;

      var binary = getCurrentBinary();
      if (!binary || binary.length === 0) {
        scheduleLocalStartOpenRetry("binary payload is missing");
        return;
      }

      if (typeof window.DesktopOfflineAppDocumentEndLoad !== "function") {
        scheduleLocalStartOpenRetry("DesktopOfflineAppDocumentEndLoad is unavailable");
        return;
      }

      if (!isEditorReadyForLocalOpen()) {
        scheduleLocalStartOpenRetry("editor instance is not ready");
        return;
      }

      var directResult = tryDirectOpen(binary);
      if (directResult.ok) {
        _didLocalStartOpen = true;
        _localStartOpenRetries = 0;
        return;
      }

      var token = "binary_content://rendesk-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      _openedFiles[token] = binary;

      try {
        window.DesktopOfflineAppDocumentEndLoad(filePath || "", token, binary.length);
        _didLocalStartOpen = true;
        _localStartOpenRetries = 0;
      } catch (error) {
        scheduleLocalStartOpenRetry(
          "open failed (direct=" + directResult.reason + "): " + (error && error.message ? error.message : String(error)),
        );
      }
    },

    // --- File change tracking ---
    LocalFileSaveChanges: function (changes, deleteIndex, count) {
      // No-op: we save on explicit Ctrl+S via OnSave
    },
    SetLocalRestrictions: function () {},

    // --- Printing (no-op) ---
    Print_Start: function () { return false; },
    Print_Page: function () {},
    Print_End: function () {},
    Print: function () {},
    emulateCloudPrinting: function () { return false; },

    // --- Save ---
    OnSave: function () {
      if (!_editorApi) return;

      var data = null;
      try {
        if (typeof _editorApi.asc_nativeGetFile === "function") {
          data = _editorApi.asc_nativeGetFile();
        }
      } catch (e) {
        console.error("[desktop-stub] asc_nativeGetFile failed:", e);
      }

      if (!data) {
        try {
          if (typeof _editorApi.asc_Save === "function") {
            _editorApi.asc_Save(false);
          }
        } catch (e) {}
        return;
      }

      var body;
      if (data instanceof ArrayBuffer) {
        body = data;
      } else if (data instanceof Uint8Array) {
        body = data.buffer;
      } else if (typeof data === "string") {
        body = new TextEncoder().encode(data).buffer;
      } else {
        return;
      }

      fetch(serviceUrl + "/api/editor/save?filePath=" + encodeURIComponent(filePath), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: body,
      })
        .then(function (resp) {
          if (!resp.ok) throw new Error("Save returned " + resp.status);
          try {
            window.parent.postMessage({ type: "editor:saved", data: {} }, "*");
          } catch (e) {}
        })
        .catch(function (err) {
          console.error("[desktop-stub] save failed:", err);
          try {
            window.parent.postMessage({ type: "editor:save-error", data: { error: err.message } }, "*");
          } catch (e) {}
        });
    },
    SaveQuestion: function () {
      if (window.DesktopSaveQuestionReturn) {
        window.DesktopSaveQuestionReturn(false);
      }
    },

    // --- Crypto (stubs) ---
    buildCryptedStart: function () {},
    buildCryptedEnd: function () {},
    GetEncryptedHeader: function () { return ""; },
    CryptoDownloadAs: function () {},
    GetDefaultCertificate: function () { return ""; },
    SelectCertificate: function () {},
    ViewCertificate: function () {},
    Sign: function () {},
    RemoveSignature: function () {},
    RemoveAllSignatures: function () {},

    // --- External references ---
    openExternalReference: function () {},

    // --- File operations ---
    CompareDocumentFile: function () {},
    CompareDocumentUrl: function () {},
    MergeDocumentFile: function () {},
    MergeDocumentUrl: function () {},
    OpenFileCrypt: function () {},
    ResaveFile: function () {},
    RemoveFile: function () {},
    GetOpenedFile: function (path) {
      var binary = path ? _openedFiles[path] : null;
      if (!binary && typeof path === "string" && path.indexOf("binary_content://") === 0) {
        var keys = Object.keys(_openedFiles);
        if (keys.length > 0) binary = _openedFiles[keys[keys.length - 1]];
      }
      return toArrayBuffer(binary);
    },
    LocalFileGetImageUrl: function (path) { return path; },
    LocalFileGetImageUrlCorrect: function (path) { return path; },
    IsLocalFileExist: function () { return false; },
    IsImageFile: function () { return false; },
    GetDropFiles: function () { return []; },
    localSaveToDrawingFormat: function () {},
    NativeViewerOpen: function () {},
    SetAdvancedOptions: function () {},
    GetImageBase: function () { return ""; },
    GetImageFormat: function () { return ""; },
    GetImageOriginalSize: function () { return ""; },
    IsCachedPdfCloudPrintFileInfo: function () { return false; },
    SetPdfCloudPrintFileInfo: function () {},
    DownloadFiles: function () {},
    CallMediaPlayerCommand: function () {},
    sendSystemMessage: function () {},
    CallInAllWindows: function () {},
    startExternalConvertation: function () {},

    // --- Script loading ---
    LoadJS: function (url) {
      if (!url) return;
      var script = document.createElement("script");
      script.src = url;
      script.async = false;
      document.head.appendChild(script);
    },

    // --- Command dispatcher ---
    execCommand: function () {},

    __setCurrentBinary: function (data) {
      var normalized = toUint8Array(data);
      if (!normalized || normalized.length === 0) return;
      window._currentDocumentBinary = normalized;
      _didLocalStartOpen = false;
      _localStartOpenRetries = 0;
    },

    // --- Editor API factory (called by SDK) ---
    CreateEditorApi: function (editorApi) {
      _editorApi = editorApi;
      window.editorInstance = _editorApi;
    },
  };

  // Listen for Ctrl+S / Cmd+S
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      window.AscDesktopEditor.OnSave();
    }
  });
})();
