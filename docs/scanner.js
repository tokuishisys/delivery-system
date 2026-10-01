/**
 * カメラ映像からQRコードを連続で自動読み取りするスキャナー
 *  LiveScanner.open({ continuous: true/false, title, onScan(text), onPhoto() })
 *  - continuous=false: 1件読んだら自動で閉じる
 *  - continuous=true : 閉じるまで次々読み取る（同じQRは1回だけ）
 */
(function () {
  var qr = null, running = false, isOpen = false, opts = null;
  var seen = new Set(), count = 0, busy = false, lastDupAt = 0;
  var audioCtx = null, torchOn = false, historyPushed = false;

  var CSS = "" +
    "#liveScanModal{position:fixed;inset:0;z-index:3000;background:#000;display:none;flex-direction:column;}" +
    "#liveScanModal.open{display:flex;}" +
    "#liveScanModal .ls-top{display:flex;justify-content:space-between;align-items:center;color:#fff;" +
    "padding:calc(env(safe-area-inset-top,0px) + 10px) 14px 10px;font-weight:bold;font-size:16px;}" +
    "#liveQrReader{flex:1;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;border:none!important;}" +
    "#liveQrReader video{max-height:100%;}" +
    "#liveScanModal .ls-panel{background:#fff;border-radius:16px 16px 0 0;padding:14px 16px calc(env(safe-area-inset-bottom,0px) + 14px);}" +
    "#liveScanModal .ls-mode{font-size:13px;color:#6c757d;font-weight:bold;}" +
    "#liveScanModal .ls-status{font-size:15px;font-weight:bold;margin:4px 0;color:#212529;}" +
    "#liveScanModal .ls-status.err{color:#b02a37;}" +
    "#liveScanModal .ls-last{font-family:ui-monospace,monospace;font-size:14px;background:#f1f3f5;border-radius:8px;padding:8px 10px;min-height:38px;word-break:break-all;}" +
    "#liveScanModal .ls-last.hit{animation:lsHit .5s ease-out;}" +
    "@keyframes lsHit{from{background:#b6f0c8}to{background:#f1f3f5}}" +
    "@media (prefers-reduced-motion:reduce){#liveScanModal .ls-last.hit{animation:none;}}" +
    "#liveScanModal .ls-actions{display:flex;gap:10px;margin-top:12px;}" +
    "#liveScanModal .ls-btn{flex:1;border:none;border-radius:10px;padding:14px 10px;font-weight:bold;font-size:15px;}" +
    "#liveScanModal .ls-primary{background:#0d6efd;color:#fff;}" +
    "#liveScanModal .ls-ghost{background:#e9ecef;color:#212529;}" +
    "#liveScanModal .ls-top .ls-btn{flex:none;padding:6px 14px;font-size:13px;}" +
    "#liveScanModal .ls-top .ls-btn.on{background:#ffc107;}";

  function el(id) { return document.getElementById(id); }

  function ensureDom() {
    if (el("liveScanModal")) return;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    var m = document.createElement("div");
    m.id = "liveScanModal";
    m.className = "no-print";
    m.innerHTML =
      '<div class="ls-top"><span id="lsTitle">QR読み取り</span>' +
      '<button type="button" id="lsTorch" class="ls-btn ls-ghost" style="display:none">ライト</button></div>' +
      '<div id="liveQrReader"></div>' +
      '<div class="ls-panel">' +
      '  <div id="lsMode" class="ls-mode"></div>' +
      '  <div id="lsStatus" class="ls-status">カメラを起動しています…</div>' +
      '  <div id="lsLast" class="ls-last"></div>' +
      '  <div class="ls-actions">' +
      '    <button type="button" id="lsPhoto" class="ls-btn ls-ghost">写真で読み取る</button>' +
      '    <button type="button" id="lsClose" class="ls-btn ls-primary">閉じる</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(m);

    el("lsClose").onclick = function () { close(); };
    el("lsPhoto").onclick = function () {
      var o = opts;
      close().then(function () { if (o && o.onPhoto) o.onPhoto(); });
    };
    el("lsTorch").onclick = toggleTorch;
  }

  function setStatus(text, isErr) {
    var s = el("lsStatus");
    s.textContent = text;
    s.className = "ls-status" + (isErr ? " err" : "");
  }

  function setLast(text) {
    var l = el("lsLast");
    l.textContent = text;
    l.classList.remove("hit");
    void l.offsetWidth;
    l.classList.add("hit");
  }

  function feedback() {
    try { if (navigator.vibrate) navigator.vibrate(80); } catch (e) {}
    try {
      if (!audioCtx) return;
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "square"; o.frequency.value = 1400;
      g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.08);
    } catch (e) {}
  }

  function onDecode(text) {
    if (busy || !isOpen) return;
    text = String(text || "").trim();
    if (!text) return;

    if (opts.continuous) {
      if (seen.has(text)) {
        var now = Date.now();
        if (now - lastDupAt > 1500) { setStatus("読み取り済みのQRです。次のQRに向けてください"); lastDupAt = now; }
        return;
      }
      seen.add(text);
    }

    busy = true;
    feedback();

    if (!opts.continuous) {
      var cb = opts.onScan;
      close().then(function () { busy = false; if (cb) cb(text); });
      return;
    }

    count++;
    setLast(text);
    setStatus("読み取り " + count + "件 ／ 次のQRに向けてください");
    try { qr.pause(true); } catch (e) {}
    setTimeout(function () {
      try { if (opts && opts.onScan) opts.onScan(text); } catch (e) { console.error(e); }
      setTimeout(function () {
        try { if (running) qr.resume(); } catch (e) {}
        busy = false;
      }, 600);
    }, 0);
  }

  function setupTorch() {
    var btn = el("lsTorch");
    btn.style.display = "none";
    torchOn = false;
    btn.classList.remove("on");
    try {
      var caps = qr.getRunningTrackCapabilities();
      if (caps && caps.torch) btn.style.display = "inline-block";
    } catch (e) {}
  }

  function toggleTorch() {
    torchOn = !torchOn;
    qr.applyVideoConstraints({ advanced: [{ torch: torchOn }] })
      .then(function () { el("lsTorch").classList.toggle("on", torchOn); })
      .catch(function () { torchOn = !torchOn; });
  }

  async function open(options) {
    if (isOpen) await close();
    opts = options || {};
    seen = new Set(); count = 0; busy = false;
    ensureDom();

    el("lsTitle").textContent = opts.title || "QR読み取り";
    el("lsMode").textContent = opts.continuous ? "連続読み取り：閉じるまで次々に読み取ります" : "1件読み取ると自動で閉じます";
    el("lsClose").textContent = opts.continuous ? "読み取りを終了" : "キャンセル";
    el("lsLast").textContent = "";
    setStatus("カメラを起動しています…");
    el("liveScanModal").classList.add("open");
    isOpen = true;

    // Androidの「戻る」で閉じられるように
    try { history.pushState({ liveScanner: true }, ""); historyPushed = true; } catch (e) {}

    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {}

    if (typeof Html5Qrcode === "undefined") {
      setStatus("読み取り機能を読み込めませんでした。電波のある場所で開き直すか「写真で読み取る」を使ってください。", true);
      return;
    }
    if (!qr) {
      var cfg = { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } };
      if (window.Html5QrcodeSupportedFormats) cfg.formatsToSupport = [Html5QrcodeSupportedFormats.QR_CODE];
      qr = new Html5Qrcode("liveQrReader", cfg);
    }

    try {
      await qr.start(
        { facingMode: "environment" },
        {
          fps: 15,
          qrbox: function (w, h) { var s = Math.floor(Math.min(w, h) * 0.75); return { width: s, height: s }; }
        },
        onDecode,
        function () {}
      );
      running = true;
      if (!isOpen) { await stopCamera(); return; }
      setStatus("QRコードを枠の中に合わせてください");
      setupTorch();
    } catch (e) {
      running = false;
      setStatus("カメラを起動できません。Chromeの設定でカメラを「許可」にするか、「写真で読み取る」を使ってください。", true);
    }
  }

  async function stopCamera() {
    if (!qr || !running) return;
    running = false;
    try { await qr.stop(); } catch (e) {}
    try { qr.clear(); } catch (e) {}
  }

  async function close(fromPopState) {
    if (!isOpen) return;
    isOpen = false;
    el("liveScanModal").classList.remove("open");
    await stopCamera();
    if (historyPushed && !fromPopState) {
      historyPushed = false;
      try { history.back(); } catch (e) {}
    }
    historyPushed = false;
    if (opts && opts.onClose) { try { opts.onClose(count); } catch (e) {} }
  }

  window.addEventListener("popstate", function () { if (isOpen) close(true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && isOpen) close();
  });

  window.LiveScanner = { open: open, close: close };
})();
