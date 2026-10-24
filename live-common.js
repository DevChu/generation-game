(function () {
  const letters = "ABCDEFGHIJ";

  function client() {
    const cfg = window.LIVE_CONFIG;
    if (!cfg || !cfg.supabaseUrl || !cfg.supabasePublishableKey) {
      throw new Error("尚未設定 Supabase 連線資訊");
    }
    return window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[char]);
  }

  function optionLabel(index, text) {
    return `<span class="letter">${letters[index]}</span>${escapeHtml(text)}`;
  }

  function deviceId() {
    let id = localStorage.getItem("generation-live-device");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("generation-live-device", id);
    }
    return id;
  }

  window.Live = { client, escapeHtml, optionLabel, deviceId, letters };
})();
