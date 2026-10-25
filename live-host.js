(function () {
  const $ = selector => document.querySelector(selector);
  const questions = window.LIVE_QUESTIONS;
  const db = Live.client();
  let room = null;
  let hostToken = null;
  let hostRows = [];
  let pollTimer = null;
  let finalWinners = [];
  let choosingRepresentative = false;
  let selectedRepresentative = null;
  let showAllCorrect = false;

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
    if (room.phase === "revealed") {
      renderBars();
      renderLeaderboard();
      renderCorrectList();
    }
  }

  function participants() {
    const unique = new Map();
    hostRows.forEach(row => {
      if (!unique.has(row.device_id)) unique.set(row.device_id, { deviceId: row.device_id, nickname: row.nickname });
    });
    return [...unique.values()];
  }

  function currentResponses() {
    return hostRows.filter(row => row.question_index === room.current_question && row.answer !== null);
  }

  function renderCounts() {
    const joined = participants();
    $("#joinedCount").textContent = joined.length;
    $("#answeredCount").textContent = room.current_question >= 0 ? currentResponses().length : 0;
    $("#participantNames").innerHTML = joined.length
      ? joined.map(person => `<span class="participant-name">${Live.escapeHtml(person.nickname)}</span>`).join("")
      : `<span class="muted">等待參加者加入…</span>`;
  }

  function revealIndexes() {
    const value = room.reveal_answer;
    if (Array.isArray(value?.majority)) return value.majority;
    if (Array.isArray(value)) return value;
    return Number.isInteger(value) ? [value] : [];
  }

  function render() {
    if (!room) return;
    const hasQuestion = room.current_question >= 0 && room.current_question < questions.length;
    $("#joinLobby").classList.toggle("hidden", hasQuestion || room.phase === "ended");
    $("#waitingMessage").classList.toggle("hidden", hasQuestion);
    $("#questionContent").classList.toggle("hidden", !hasQuestion);
    $("#startQuestion").classList.toggle("hidden", hasQuestion || room.phase === "ended");
    $("#lockQuestion").disabled = room.phase !== "open";
    $("#revealQuestion").disabled = room.phase !== "locked" || choosingRepresentative;
    $("#nextQuestion").disabled = room.phase !== "revealed" || room.current_question >= questions.length - 1;
    $("#endRoom").textContent = room.phase === "ended" ? "再次顯示頒獎" : "結束活動";
    $("#revealColumns").classList.toggle("hidden", room.phase !== "revealed");
    $("#representativeAnswerPanel").classList.toggle("hidden", !choosingRepresentative || room.phase !== "locked");

    if (!hasQuestion) return renderCounts();
    const q = questions[room.current_question];
    $("#questionOptions").classList.toggle("hidden", choosingRepresentative && room.phase === "locked");
    $("#questionMeta").textContent = `第 ${room.current_question + 1} / ${questions.length} 題・${q.theme}`;
    $("#questionText").textContent = q.prompt;
    const revealed = room.phase === "revealed";
    const correct = revealIndexes();
    $("#questionOptions").innerHTML = q.options.map((option, index) =>
      `<div class="option ${revealed && correct.includes(index) ? "correct" : ""}">${Live.optionLabel(index, option)}</div>`
    ).join("");
    $("#resultBars").classList.toggle("hidden", !revealed);
    if (revealed) renderBars();
    if (revealed) renderLeaderboard();
    if (revealed) renderCorrectList();

    const dual = q.type === "predict_average" || q.type === "predict_majority";
    const hints = {
      open: dual ? "作答開放中：每人要回答自己，也要預測全場。" : "作答開放中；分布會在公布前保持隱藏。",
      locked: q.type === "guess" ? "作答已鎖定。按公布後，請選擇台上代表的答案。" : "作答已鎖定，可以公布結果。",
      revealed: room.current_question === questions.length - 1 ? `${questions.length} 題完成！可以結束活動。` : "結果已公布，可以進入下一題。",
      ended: "活動已結束。"
    };
    $("#hostHint").textContent = hints[room.phase] || "等待開始。";
    renderCounts();
  }

  function responseValue(answer, field = "self") {
    if (answer && typeof answer === "object" && !Array.isArray(answer)) return answer[field];
    return answer;
  }

  function optionCounts(q, field = "self") {
    const counts = q.options.map(() => 0);
    currentResponses().forEach(row => {
      const value = responseValue(row.answer, field);
      const indexes = Array.isArray(value) ? value : [value];
      indexes.forEach(index => {
        if (Number.isInteger(index) && counts[index] !== undefined) counts[index] += 1;
      });
    });
    return counts;
  }

  function barsHtml(q, counts, title) {
    const max = Math.max(1, ...counts);
    return `${title ? `<h3>${Live.escapeHtml(title)}</h3>` : ""}${counts.map((count, index) => `
      <div class="bar-row">
        <span>${Live.escapeHtml(q.options[index])}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${count / max * 100}%"></div></div>
        <strong>${count}</strong>
      </div>`).join("")}`;
  }

  function renderBars() {
    if (!room || room.current_question < 0) return;
    const q = questions[room.current_question];
    const ownCounts = optionCounts(q);
    let summary = "";
    let prediction = "";
    if (q.type === "predict_average" && Number.isFinite(room.reveal_answer?.average)) {
      summary = `<div class="status-card"><strong>全場實際平均 ${room.reveal_answer.average.toFixed(2)}</strong><span class="muted">猜測差距在 0.5 以內：${room.reveal_answer.closeCount} 人</span></div>`;
      prediction = barsHtml(q, optionCounts(q, "prediction"), "大家預測的全場平均");
    }
    if (q.type === "predict_majority" && Array.isArray(room.reveal_answer?.majority)) {
      const winners = room.reveal_answer.majority.map(index => q.options[index]).join("、") || "無";
      summary = `<div class="status-card"><strong>全場最多人選：${Live.escapeHtml(winners)}</strong><span class="muted">猜中最多選項：${room.reveal_answer.correctCount} 人</span></div>`;
      prediction = barsHtml(q, optionCounts(q, "prediction"), "大家預測的熱門答案");
    }
    $("#resultBars").innerHTML = `${summary}${barsHtml(q, ownCounts, q.type.startsWith("predict_") ? "全場自己的答案" : "")}${prediction}`;
  }

  function audienceReveal(q) {
    const answers = currentResponses().map(row => row.answer).filter(value => value && typeof value === "object" && !Array.isArray(value));
    if (q.type === "predict_average") {
      const own = answers.map(value => value.self).filter(Number.isInteger);
      const average = own.length ? own.reduce((sum, index) => sum + index + 1, 0) / own.length : null;
      const closeCount = average === null ? 0 : answers.filter(value => Number.isInteger(value.prediction) && Math.abs(value.prediction + 1 - average) <= .5).length;
      return { average, closeCount };
    }
    if (q.type === "predict_majority") {
      const counts = optionCounts(q);
      const max = Math.max(0, ...counts);
      const majority = max ? counts.flatMap((count, index) => count === max ? [index] : []) : [];
      const correctCount = answers.filter(value => majority.includes(value.prediction)).length;
      return { majority, correctCount };
    }
    return null;
  }

  function accuracyFactor(q, revealAnswer, answer) {
    if (q.type === "predict_average") {
      if (!Number.isFinite(revealAnswer?.average) || !Number.isInteger(answer?.prediction)) return 0;
      return Math.max(0, 1 - Math.abs(answer.prediction + 1 - revealAnswer.average) / 2);
    }
    if (q.type === "predict_majority") {
      return Array.isArray(revealAnswer?.majority) && revealAnswer.majority.includes(answer?.prediction) ? 1 : 0;
    }
    if (q.type === "guess") return answer === revealAnswer ? 1 : 0;
    if (q.type === "smart10") {
      const picked = new Set(Array.isArray(answer) ? answer : []);
      const correct = new Set(q.answer);
      const decisions = q.options.reduce((sum, _, index) => sum + (picked.has(index) === correct.has(index) ? 1 : 0), 0);
      return decisions / q.options.length;
    }
    return 0;
  }

  function isCorrectAnswer(q, revealAnswer, answer) {
    if (q.type === "predict_average") {
      return Number.isFinite(revealAnswer?.average)
        && Number.isInteger(answer?.prediction)
        && Math.abs(answer.prediction + 1 - revealAnswer.average) <= .5;
    }
    if (q.type === "predict_majority") {
      return Array.isArray(revealAnswer?.majority) && revealAnswer.majority.includes(answer?.prediction);
    }
    if (q.type === "guess") return answer === revealAnswer;
    if (q.type === "smart10") {
      const picked = [...new Set(Array.isArray(answer) ? answer : [])].sort((a, b) => a - b);
      const correct = [...q.answer].sort((a, b) => a - b);
      return picked.length === correct.length && picked.every((value, index) => value === correct[index]);
    }
    return false;
  }

  function renderCorrectList() {
    if (!room || room.phase !== "revealed") return;
    const q = questions[room.current_question];
    const correct = currentResponses().filter(row => isCorrectAnswer(q, room.reveal_answer, row.answer));
    const visible = showAllCorrect ? correct : correct.slice(0, 20);
    $("#correctCount").textContent = correct.length;
    $("#correctNames").innerHTML = visible.length
      ? visible.map(row => `<span class="correct-name">${Live.escapeHtml(row.nickname)}</span>`).join("")
      : `<span class="muted">本題還沒有人答對</span>`;
    $("#showMoreCorrect").classList.toggle("hidden", correct.length <= 20);
    $("#showMoreCorrect").textContent = showAllCorrect ? "收合名單" : `顯示更多…（還有 ${correct.length - 20} 人）`;
  }

  function calculateScores(q, revealAnswer) {
    return currentResponses().map(row => {
      const accuracy = accuracyFactor(q, revealAnswer, row.answer);
      const speed = Math.max(0, 1 - Math.max(0, Number(row.response_ms) || 0) / 60000);
      return {
        device_id: row.device_id,
        points: Math.round(accuracy * (1000 + 500 * speed))
      };
    });
  }

  async function saveScores(scores) {
    const { error } = await db.rpc("save_live_scores", {
      p_room_code: room.code,
      p_host_token: hostToken,
      p_question_index: room.current_question,
      p_scores: scores
    });
    if (error) throw error;
    const byDevice = new Map(scores.map(item => [item.device_id, item.points]));
    hostRows.forEach(row => {
      if (row.question_index === room.current_question && byDevice.has(row.device_id)) row.points = byDevice.get(row.device_id);
    });
  }

  function rankedParticipants() {
    const totals = new Map(participants().map(person => [person.deviceId, {
      nickname: person.nickname,
      points: 0,
      responseMs: 0
    }]));
    hostRows.forEach(row => {
      const total = totals.get(row.device_id);
      if (!total || row.question_index === null) return;
      total.points += Number(row.points) || 0;
      total.responseMs += Number(row.response_ms) || 0;
    });
    return [...totals.values()]
      .sort((a, b) => b.points - a.points || a.responseMs - b.responseMs || a.nickname.localeCompare(b.nickname, "zh-Hant"))
      .slice(0, 3);
  }

  function renderLeaderboard() {
    const top = rankedParticipants();
    $("#podium").innerHTML = top.length
      ? top.map((person, index) => `<div class="podium-card">
          <span class="podium-rank">第 ${index + 1} 名</span>
          <span class="podium-name">${Live.escapeHtml(person.nickname)}</span>
          <span class="podium-score">${person.points.toLocaleString()} 分</span>
        </div>`).join("")
      : `<p class="muted">本題尚無作答資料。</p>`;
  }

  function buildConfetti() {
    const colors = ["#ffd166", "#49a7ff", "#55d69e", "#ff6b7a", "#ffffff", "#b89cff"];
    $("#confetti").innerHTML = Array.from({ length: 72 }, (_, index) => {
      const x = (index * 37 + Math.random() * 11) % 100;
      const width = 6 + Math.random() * 8;
      const duration = 4.2 + Math.random() * 3.8;
      const delay = -Math.random() * duration;
      const drift = `${-80 + Math.random() * 160}px`;
      return `<i class="confetti-piece" style="--x:${x}%;--w:${width}px;--duration:${duration}s;--delay:${delay}s;--drift:${drift};--color:${colors[index % colors.length]}"></i>`;
    }).join("");
  }

  function showFinale(winners = finalWinners) {
    finalWinners = winners;
    const medals = ["🥇", "🥈", "🥉"];
    const ranked = winners.map((person, index) => ({ ...person, rank: index + 1 }));
    const display = ranked.length >= 2 ? [ranked[1], ranked[0], ...ranked.slice(2)] : ranked;
    $("#finalPodium").innerHTML = display.length
      ? display.map(person => `<article class="award-card rank-${person.rank}">
          <span class="award-medal">${medals[person.rank - 1]}</span>
          <span class="award-rank">第 ${person.rank} 名</span>
          <strong class="award-name">${Live.escapeHtml(person.nickname)}</strong>
          <span class="award-score">${person.points.toLocaleString()} 分</span>
        </article>`).join("")
      : `<div class="status-card"><strong>本場沒有作答紀錄</strong></div>`;
    buildConfetti();
    $("#finaleOverlay").classList.remove("hidden");
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
    if (error) {
      setError(error);
      return false;
    }
    room = { ...room, current_question: index, phase, reveal_answer: phase === "revealed" ? revealAnswer : null };
    if (phase === "open") {
      choosingRepresentative = false;
      selectedRepresentative = null;
      showAllCorrect = false;
    }
    render();
    await refreshResults();
    return true;
  }

  function renderRepresentativePicker(q) {
    $("#representativePrompt").textContent = `請選擇${q.representative || "台上代表"}的答案`;
    $("#representativeOptions").innerHTML = q.options.map((option, index) => `
      <button class="answer-btn ${selectedRepresentative === index ? "selected" : ""}" data-representative="${index}">
        ${Live.optionLabel(index, option)}
      </button>`).join("");
    $("#submitRepresentative").disabled = selectedRepresentative === null;
    $("#representativeAnswerPanel").classList.remove("hidden");
  }

  async function publishAnswer(q, answer) {
    try {
      await saveScores(calculateScores(q, answer));
      choosingRepresentative = false;
      await setState(room.current_question, "revealed", answer);
    } catch (error) {
      setError(error);
    }
  }

  $("#createRoom").addEventListener("click", createRoom);
  $("#startQuestion").addEventListener("click", () => setState(0, "open"));
  $("#lockQuestion").addEventListener("click", () => setState(room.current_question, "locked"));
  $("#nextQuestion").addEventListener("click", () => setState(room.current_question + 1, "open"));
  $("#revealQuestion").addEventListener("click", async () => {
    await refreshResults();
    const q = questions[room.current_question];
    let answer = null;
    if (q.type === "smart10") answer = q.answer;
    if (q.type === "guess") {
      choosingRepresentative = true;
      selectedRepresentative = null;
      render();
      renderRepresentativePicker(q);
      return;
    }
    if (q.type === "predict_average" || q.type === "predict_majority") answer = audienceReveal(q);
    await publishAnswer(q, answer);
  });
  $("#representativeOptions").addEventListener("click", event => {
    const button = event.target.closest("[data-representative]");
    if (!button) return;
    selectedRepresentative = Number(button.dataset.representative);
    renderRepresentativePicker(questions[room.current_question]);
  });
  $("#submitRepresentative").addEventListener("click", async () => {
    if (selectedRepresentative === null) return;
    await refreshResults();
    await publishAnswer(questions[room.current_question], selectedRepresentative);
  });
  $("#showMoreCorrect").addEventListener("click", () => {
    showAllCorrect = !showAllCorrect;
    renderCorrectList();
  });
  $("#endRoom").addEventListener("click", async () => {
    if (room.phase === "ended") return showFinale();
    if (confirm("確定要結束活動嗎？結束後參加者不能再作答。")) {
      await refreshResults();
      const winners = rankedParticipants();
      const ended = await setState(room.current_question, "ended");
      if (ended) {
        localStorage.removeItem("generation-live-host");
        showFinale(winners);
      }
    }
  });
  $("#replayFinale").addEventListener("click", () => {
    $("#finaleOverlay").classList.add("hidden");
    requestAnimationFrame(() => showFinale());
  });
  $("#closeFinale").addEventListener("click", () => $("#finaleOverlay").classList.add("hidden"));
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
