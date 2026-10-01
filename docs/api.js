/**
 * google.script.run の置き換え
 * 既存の画面コード（google.script.run.withSuccessHandler(...).関数名(...)）を
 * そのまま使えるように、GASのAPI(doPost)へ fetch で送る仕組みです。
 */
(function () {
  var SESSION_KEY = "app_session";

  function getSession() { return localStorage.getItem(SESSION_KEY) || ""; }

  async function rpc(fn, args) {
    var cfg = window.APP_CONFIG || {};
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, cfg.API_TIMEOUT_MS || 60000);
    var res;
    try {
      // text/plain で送るとCORSの事前確認が発生しない（GASはこれに対応できないため）
      res = await fetch(cfg.API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "rpc", fn: fn, args: args, session: getSession() }),
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal
      });
    } catch (e) {
      throw new Error(navigator.onLine
        ? "通信できませんでした。電波の良い場所でもう一度操作してください。"
        : "オフラインです。電波のある場所で操作してください。");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error("サーバーエラー（" + res.status + "）");

    var json;
    try { json = await res.json(); }
    catch (e) { throw new Error("サーバーの応答を読み取れません。GASのデプロイ設定（アクセス：全員）を確認してください。"); }

    if (json.authError) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem("app_user_name");
      alert(json.message);
      location.reload();
      var authErr = new Error(json.message);
      authErr.auth = true;
      throw authErr;
    }
    if (!json.ok) throw new Error(json.message || "エラーが発生しました");
    if (json.session) localStorage.setItem(SESSION_KEY, json.session);
    return json.result;
  }

  function defaultFailure(err) {
    if (typeof setLoading === "function") setLoading(false);
    alert("❌ " + (err && err.message ? err.message : err));
  }

  function runner(onSuccess, onFailure) {
    return new Proxy({}, {
      get: function (_, prop) {
        if (prop === "withSuccessHandler") return function (fn) { return runner(fn, onFailure); };
        if (prop === "withFailureHandler") return function (fn) { return runner(onSuccess, fn); };
        if (prop === "withUserObject") return function () { return runner(onSuccess, onFailure); };
        if (typeof prop !== "string" || prop === "then") return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          rpc(prop, args).then(
            function (result) { if (onSuccess) onSuccess(result); },
            function (err) {
              if (err && err.auth) return;
              if (onFailure) onFailure(err); else defaultFailure(err);
            }
          );
        };
      }
    });
  }

  window.google = { script: { run: runner(null, null) } };
  window.AppAPI = {
    rpc: rpc,
    hasSession: function () { return !!getSession(); },
    clearSession: function () { localStorage.removeItem(SESSION_KEY); }
  };

  // オフライン表示
  function updateOfflineBar() {
    var bar = document.getElementById("offlineBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "offlineBar";
      bar.className = "no-print";
      bar.textContent = "オフラインです。電波のある場所で操作してください。";
      bar.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2500;background:#b02a37;color:#fff;" +
        "text-align:center;font-weight:bold;font-size:14px;padding:calc(env(safe-area-inset-top,0px) + 6px) 8px 6px;display:none;";
      document.body.appendChild(bar);
    }
    bar.style.display = navigator.onLine ? "none" : "block";
  }
  window.addEventListener("online", updateOfflineBar);
  window.addEventListener("offline", updateOfflineBar);
  document.addEventListener("DOMContentLoaded", updateOfflineBar);

  // Service Worker（ホーム画面アプリ化・起動の高速化）
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function (e) { console.warn("SW登録失敗", e); });
    });
  }
})();
