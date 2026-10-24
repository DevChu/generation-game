(function () {
  const $ = selector => document.querySelector(selector);
  const questions = window.LIVE_QUESTIONS;
  const db = Live.client();
  const deviceId = Live.deviceId();
  let room = null;
  let nickname = "";
  let selected = [];
  let submittedQuestion = -1;

  const roomFromUrl = new URLSearchParams(location.search).get("room") || "";
  $("#roomInput").value = roomFromUrl.replace(/\D/g, "").slice(0, 4);
  $("#nicknameInput").value = localStorage.getItem("generation-live-name") || "";

  function setConnection(ok, text) {
    $("#connectionDot").classList.toggle("on", ok);
    $("#connectionText").textContent = text;
  }

  function showOnly(id) {
    ["waitingState", "answerState", "lockedState", "revealedState", "endedState"]
      .forEach(name => $("#" + name).classList.toggle("hidden", name !== id));
  }

  async function join(event) {
    event.preventDefault();
    const code = $("#roomInput").value.trim();
    nickname = $("#nicknameInput").value.trim();
    $("#joinError").textContent = "";
    if (!/^\d{4}$/.test(code)) return $("#joinError").textContent = "請輸入四位數房號。";
    if (!nickname) return $("#joinError").textContent = "請輸入暱稱。";

    const button = $("#joinForm button");
    button.disabled = true;
    try {
      const { error } = await db.rpc("join_live_room", {
        p_room_code: code,
        p_device_id: deviceId,
        p_nickname: nickname
      });
      if (error) throw error;
      localStorage.setItem("generation-live-name", nickname);
      const { data, error: roomError } = await db.from("rooms").select("*").eq("code", code).single();
      if (roomError) throw roomError;
      room = data;
      $("#joinPanel").classList.add("hidden");
      $("#gamePanel").classList.remove("hidden");
      $("#playerName").textContent = nickname;
      $("#playerRoom").textContent = code;
      history.replaceState(null, "", `?room=${code}`);
      subscribe();
      render();
    } catch (error) {
      $("#joinError").textContent = error.message.includes("room not found") ? "找不到房間，請確認房號。" : error.message;
      button.disabled = false;
    }
  }

  function subscribe() {
    db.channel(`player-room-${room.code}-${deviceId}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "rooms", filter: `code=eq.${room.code}`
      }, payload => {
        const changedQuestion = room.current_question !== payload.new.current_question;
        room = payload.new;
        if (changedQuestion) { selected = []; submittedQuestion = -1; }
        render();
      })
      .subscribe(status => setConnection(status === "SUBSCRIBED", status === "SUBSCRIBED" ? "連線正常" : "正在連線"));
  }

  function render() {
    if (!room || room.phase === "waiting" || room.current_question < 0) return showOnly("waitingState");
    if (room.phase === "ended") return showOnly("endedState");
    if (room.phase === "locked") return showOnly("lockedState");
    if (room.phase === "revealed") {
      showOnly("revealedState");
      return renderReveal();
    }

    showOnly("answerState");
    const q = questions[room.current_question];
    $("#playerMeta").textContent = `第 ${room.current_question + 1} / ${questions.length} 題・${q.theme}`;
    $("#playerQuestion").textContent = q.prompt;
    $("#answerHint").textContent = q.type === "smart10" ? "可選擇多個答案，再按送出。" : "點選一個答案後會立即送出，鎖定前可以修改。";
    $("#submitMulti").classList.toggle("hidden", q.type !== "smart10");
    $("#answerGrid").innerHTML = q.options.map((option, index) => `
      <button class="answer-btn ${selected.includes(index) ? "selected" : ""}" data-index="${index}">
        ${Live.optionLabel(index, option)}
      </button>`).join("");
  }

  async function submit(answer) {
    $("#answerError").textContent = "";
    const { error } = await db.rpc("submit_live_answer", {
      p_room_code: room.code,
      p_device_id: deviceId,
      p_question_index: room.current_question,
      p_answer: answer
    });
    if (error) {
      $("#answerError").textContent = error.message.includes("not open") ? "本題已停止作答。" : error.message;
      return false;
    }
    submittedQuestion = room.current_question;
    $("#answerHint").textContent = "✓ 已收到答案；主持人鎖定前仍可修改。";
    if (navigator.vibrate) navigator.vibrate(40);
    return true;
  }

  $("#answerGrid").addEventListener("click", async event => {
    const button = event.target.closest("[data-index]");
    if (!button || !room || room.phase !== "open") return;
    const index = Number(button.dataset.index);
    const q = questions[room.current_question];
    if (q.type === "smart10") {
      selected = selected.includes(index) ? selected.filter(value => value !== index) : [...selected, index].sort((a, b) => a - b);
      render();
    } else {
      selected = [index];
      render();
      await submit(index);
    }
  });

  $("#submitMulti").addEventListener("click", async () => {
    if (!selected.length) return $("#answerError").textContent = "請至少選擇一個答案。";
    await submit(selected);
  });

  function revealIndexes() {
    const value = room.reveal_answer;
    if (Array.isArray(value)) return value;
    return Number.isInteger(value) ? [value] : [];
  }

  function renderReveal() {
    const q = questions[room.current_question];
    const reveal = revealIndexes();
    let text = "請看大螢幕上的全場分布。";
    if (q.type === "guess" && reveal.length) text = `台上代表選擇：${Live.letters[reveal[0]]} ${q.options[reveal[0]]}`;
    if (q.type === "smart10") text = "綠色項目是本題正確答案。";
    $("#revealText").textContent = text;
    $("#revealOptions").innerHTML = q.options.map((option, index) =>
      `<div class="option ${reveal.includes(index) ? "correct" : ""}">${Live.optionLabel(index, option)}</div>`
    ).join("");
  }

  $("#joinForm").addEventListener("submit", join);
})();
