(function () {
  const $ = selector => document.querySelector(selector);
  const questions = window.LIVE_QUESTIONS;
  const db = Live.client();
  let room = null;
  let hostToken = null;
  let hostRows = [];
  let pollTimer = null;

  function setConnection(ok, text) {
    $("#connectionDot").classList.toggle("on", ok);
    $("#connectionText").textContent = text;
  }

  function setError(error) {
    const message = error?.message || String(error || "");
    $("#hostError").textContent = message;
    if (message) console.error(error);
  }

  function joinUrl(code) {
    const url = new URL("play.html", location.href);
    url.searchParams.set("room", code);
    return url.href;
  }

  function savedSession() {
    try { return JSON.parse(localStorage.getItem("generation-live-host") || "null"); }
    catch { return null; }
  }

  function saveSession() {
    localStorage.setItem("generation-live-host", JSON.stringify({ code: room.code, token: hostToken }));
  }

  async function createRoom() {
    $("#createRoom").disabled = true;
    $("#setupError").textContent = "";
    try {
      hostToken = crypto.randomUUID();
      const { data, error } = await db.rpc("create_live_room", {
        p_host_token: hostToken,
        p_question_count: questions.length
      });
      if (error) throw error;
      await loadRoom(data);
      saveSession();
    } catch (error) {
      $("#setupError").textContent = `${error.message}（請先在 Supabase SQL Editor 執行 supabase/schema.sql）`;
      $("#createRoom").disabled = false;
    }
  }

  async function loadRoom(code) {
    const { data, error } = await db.from("rooms").select("*").eq("code", code).single();
    if (error) throw error;
    room = data;
    $("#setupPanel").classList.add("hidden");
    $("#roomPanel").classList.remove("hidden");
    $("#roomCode").textContent = room.code;
    const url = joinUrl(room.code);
    $("#joinUrl").textContent = url;
    $("#qrCode").innerHTML = "";
    new QRCode($("#qrCode"), { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
    setConnection(true, "即時連線中");
    render();
    subscribe();
    await refreshResults();
    pollTimer = setInterval(refreshResults, 1500);
  }

  function subscribe() {
    db.channel(`room-${room.code}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "rooms", filter: `code=eq.${room.code}`
      }, payload => {
        room = payload.new;
        render();
      })
      .subscribe(status => setConnection(status === "SUBSCRIBED", status === "SUBSCRIBED" ? "即時連線中" : "正在連線"));
  }

  async function refreshResults() {
    if (!room) return;
    const { data, error } = await db.rpc("get_live_host_results", {
      p_room_code: room.code,
      p_host_token: hostToken
    });
    if (error) return setError(error);
    hostRows = data || [];
    renderCounts();
    if (room.phase === "revealed") renderBars();
  }

  function participants() {
    return new Set(hostRows.map(row => row.device_id));
  }

  function currentResponses() {
    return hostRows.filter(row => row.question_index === room.current_question && row.answer !== null);
  }

  function renderCounts() {
    $("#joinedCount").textContent = participants().size;
    $("#answeredCount").textContent = room.current_question >= 0 ? currentResponses().length : 0;
  }

  function revealIndexes() {
    const value = room.reveal_answer;
    if (Array.isArray(value)) return value;
    return Number.isInteger(value) ? [value] : [];
  }

  function render() {
    if (!room) return;
    const hasQuestion = room.current_question >= 0 && room.current_question < questions.length;
    $("#waitingMessage").classList.toggle("hidden", hasQuestion);
    $("#questionContent").classList.toggle("hidden", !hasQuestion);
    $("#startQuestion").classList.toggle("hidden", hasQuestion || room.phase === "ended");
    $("#lockQuestion").disabled = room.phase !== "open";
    $("#revealQuestion").disabled = room.phase !== "locked";
    $("#nextQuestion").disabled = room.phase !== "revealed" || room.current_question >= questions.length - 1;

    if (!hasQuestion) return renderCounts();
    const q = questions[room.current_question];
    $("#questionMeta").textContent = `第 ${room.current_question + 1} / ${questions.length} 題・${q.theme}`;
    $("#questionText").textContent = q.prompt;
    const revealed = room.phase === "revealed";
    const correct = revealIndexes();
    $("#questionOptions").innerHTML = q.options.map((option, index) =>
      `<div class="option ${revealed && correct.includes(index) ? "correct" : ""}">${Live.optionLabel(index, option)}</div>`
    ).join("");
    $("#resultBars").classList.toggle("hidden", !revealed);
    if (revealed) renderBars();

    const hints = {
      open: "作答開放中；分布會在公布前保持隱藏。",
      locked: q.type === "guess" ? "作答已鎖定。按公布後，請選擇台上代表的答案。" : "作答已鎖定，可以公布結果。",
      revealed: room.current_question === questions.length - 1 ? "5 題完成！可以結束活動。" : "結果已公布，可以進入下一題。",
      ended: "活動已結束。"
    };
    $("#hostHint").textContent = hints[room.phase] || "等待開始。";
    renderCounts();
  }

  function answerIndexes(answer) {
    return Array.isArray(answer) ? answer : [answer];
  }

  function renderBars() {
    if (!room || room.current_question < 0) return;
    const q = questions[room.current_question];
    const counts = q.options.map(() => 0);
    currentResponses().forEach(row => {
      answerIndexes(row.answer).forEach(index => {
        if (Number.isInteger(index) && counts[index] !== undefined) counts[index] += 1;
      });
    });
    const max = Math.max(1, ...counts);
    $("#resultBars").innerHTML = counts.map((count, index) => `
      <div class="bar-row">
        <span>${Live.escapeHtml(q.options[index])}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${count / max * 100}%"></div></div>
        <strong>${count}</strong>
      </div>`).join("");
  }

  async function setState(index, phase, revealAnswer = null) {
    setError("");
    const { error } = await db.rpc("set_live_room_state", {
      p_room_code: room.code,
      p_host_token: hostToken,
      p_question_index: index,
      p_phase: phase,
      p_reveal_answer: revealAnswer
    });
    if (error) return setError(error);
    room = { ...room, current_question: index, phase, reveal_answer: phase === "revealed" ? revealAnswer : null };
    render();
    await refreshResults();
  }

  function askRepresentative(q) {
    const raw = window.prompt(`台上代表選了哪一項？\n${q.options.map((v, i) => `${Live.letters[i]}：${v}`).join("\n")}\n\n請輸入 A～${Live.letters[q.options.length - 1]}`);
    if (!raw) return null;
    const index = Live.letters.indexOf(raw.trim().toUpperCase());
    return index >= 0 && index < q.options.length ? index : null;
  }

  $("#createRoom").addEventListener("click", createRoom);
  $("#startQuestion").addEventListener("click", () => setState(0, "open"));
  $("#lockQuestion").addEventListener("click", () => setState(room.current_question, "locked"));
  $("#nextQuestion").addEventListener("click", () => setState(room.current_question + 1, "open"));
  $("#revealQuestion").addEventListener("click", () => {
    const q = questions[room.current_question];
    let answer = null;
    if (q.type === "smart10") answer = q.answer;
    if (q.type === "guess") {
      answer = askRepresentative(q);
      if (answer === null) return setError("請輸入有效的代表答案（A～E）。");
    }
    setState(room.current_question, "revealed", answer);
  });
  $("#endRoom").addEventListener("click", () => {
    if (confirm("確定要結束活動嗎？結束後參加者不能再作答。")) {
      localStorage.removeItem("generation-live-host");
      setState(room.current_question, "ended");
    }
  });
  $("#fullscreen").addEventListener("click", () => document.documentElement.requestFullscreen?.());
  window.addEventListener("beforeunload", () => { if (pollTimer) clearInterval(pollTimer); });

  (async function restore() {
    const saved = savedSession();
    if (!saved) return;
    try {
      hostToken = saved.token;
      await loadRoom(saved.code);
    } catch {
      localStorage.removeItem("generation-live-host");
      hostToken = null;
    }
  })();
})();
