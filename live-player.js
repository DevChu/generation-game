(function () {
  const $ = selector => document.querySelector(selector);
  const questions = window.LIVE_QUESTIONS;
  const db = Live.client();
  const deviceId = Live.deviceId();
  let room = null;
  let nickname = "";
  let selected = { self: null, prediction: null, multi: [] };
  let submittedQuestion = -1;
  const playerResults = new Map();
  const resultRequests = new Set();

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
      $("#joinError").textContent = error.message.includes("room not found")
        ? "找不到房間，請確認房號。"
        : error.message.includes("already started")
          ? "活動已經開始，現在不能再加入。"
          : error.message;
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
        if (changedQuestion) {
          selected = { self: null, prediction: null, multi: [] };
          submittedQuestion = -1;
        }
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
    const dual = q.type === "predict_average" || q.type === "predict_majority";
    $("#playerMeta").textContent = `第 ${room.current_question + 1} / ${questions.length} 題・${q.theme}`;
    $("#playerQuestion").textContent = q.prompt;
    const optionButtons = (field, active) => q.options.map((option, index) => `
      <button class="answer-btn ${active(index) ? "selected" : ""}" data-field="${field}" data-index="${index}">
        ${Live.optionLabel(index, option)}
      </button>`).join("");
    if (dual) {
      $("#answerGrid").innerHTML = `
        <h3>${Live.escapeHtml(q.selfPrompt)}</h3>
        ${optionButtons("self", index => selected.self === index)}
        <h3 style="margin-top:18px">${Live.escapeHtml(q.predictionPrompt)}</h3>
        ${optionButtons("prediction", index => selected.prediction === index)}`;
    } else {
      $("#answerGrid").innerHTML = optionButtons(q.type === "smart10" ? "multi" : "self", index =>
        q.type === "smart10" ? selected.multi.includes(index) : selected.self === index
      );
    }
    $("#submitAnswer").classList.toggle("hidden", q.type !== "smart10" && !dual);
    $("#answerHint").textContent = submittedQuestion === room.current_question
      ? "✓ 已收到答案；主持人鎖定前仍可修改。"
      : q.type === "smart10"
        ? "可選擇多個答案，再按送出。"
        : dual
          ? "完成兩個選擇後，再按送出。"
          : "點選一個答案後會立即送出，鎖定前可以修改。";
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
    const field = button.dataset.field;
    if (field === "multi") {
      selected.multi = selected.multi.includes(index)
        ? selected.multi.filter(value => value !== index)
        : [...selected.multi, index].sort((a, b) => a - b);
      render();
    } else if (q.type === "predict_average" || q.type === "predict_majority") {
      selected[field] = index;
      render();
    } else {
      selected.self = index;
      render();
      await submit(index);
    }
  });

  $("#submitAnswer").addEventListener("click", async () => {
    const q = questions[room.current_question];
    if (q.type === "smart10") {
      if (!selected.multi.length) return $("#answerError").textContent = "請至少選擇一個答案。";
      return submit(selected.multi);
    }
    if (selected.self === null || selected.prediction === null) {
      return $("#answerError").textContent = "請完成自己的答案與全場預測。";
    }
    await submit({ self: selected.self, prediction: selected.prediction });
  });

  function revealIndexes() {
    const value = room.reveal_answer;
    if (Array.isArray(value?.majority)) return value.majority;
    if (Array.isArray(value)) return value;
    return Number.isInteger(value) ? [value] : [];
  }

  function formatOption(q, index) {
    return Number.isInteger(index) && q.options[index]
      ? `${Live.letters[index]} ${q.options[index]}`
      : "未選擇";
  }

  function exactMultiAnswer(answer, correct) {
    const picked = [...new Set(Array.isArray(answer) ? answer : [])].sort((a, b) => a - b);
    const truth = [...correct].sort((a, b) => a - b);
    return picked.length === truth.length && picked.every((value, index) => value === truth[index]);
  }

  function personalVerdict(q, answer) {
    if (q.type === "predict_average") {
      return Number.isFinite(room.reveal_answer?.average)
        && Number.isInteger(answer?.prediction)
        && Math.abs(answer.prediction + 1 - room.reveal_answer.average) <= .5;
    }
    if (q.type === "predict_majority") {
      return Array.isArray(room.reveal_answer?.majority) && room.reveal_answer.majority.includes(answer?.prediction);
    }
    if (q.type === "smart10") return exactMultiAnswer(answer, q.answer);
    if (q.type === "guess") return answer === room.reveal_answer;
    return false;
  }

  function renderPersonalResult(q, result) {
    if (!result) {
      $("#personalResult").className = "personal-result incorrect";
      $("#personalResult").innerHTML = `<div class="result-verdict">本題未作答</div>`;
      return;
    }
    const answer = result.answer;
    const correct = personalVerdict(q, answer);
    let myAnswer = "";
    let official = "";
    if (q.type === "predict_average") {
      myAnswer = `<div><b>你的選擇：</b>${Live.escapeHtml(formatOption(q, answer.self))}</div>
        <div><b>你的全場預測：</b>${Live.escapeHtml(formatOption(q, answer.prediction))}</div>`;
      official = `全場實際平均 ${room.reveal_answer.average.toFixed(2)}（差距 ±0.5 內算答對）`;
    } else if (q.type === "predict_majority") {
      myAnswer = `<div><b>你的選擇：</b>${Live.escapeHtml(formatOption(q, answer.self))}</div>
        <div><b>你的熱門預測：</b>${Live.escapeHtml(formatOption(q, answer.prediction))}</div>`;
      official = room.reveal_answer.majority.map(index => formatOption(q, index)).join("、");
    } else if (q.type === "smart10") {
      myAnswer = `<div><b>你的答案：</b>${Live.escapeHtml((answer || []).map(index => formatOption(q, index)).join("、") || "未選擇")}</div>`;
      official = q.answer.map(index => formatOption(q, index)).join("、");
    } else {
      myAnswer = `<div><b>你的答案：</b>${Live.escapeHtml(formatOption(q, answer))}</div>`;
      official = formatOption(q, room.reveal_answer);
    }
    $("#personalResult").className = `personal-result ${correct ? "correct" : "incorrect"}`;
    $("#personalResult").innerHTML = `
      <div class="result-verdict">${correct ? "✓ 答對了" : "✕ 答錯了"}</div>
      <div class="result-lines">
        ${myAnswer}
        <div><b>正確答案：</b>${Live.escapeHtml(official)}</div>
        <div><b>本題得分：</b>${Number(result.points || 0).toLocaleString()} 分</div>
      </div>`;
  }

  async function loadPersonalResult(questionIndex) {
    if (playerResults.has(questionIndex) || resultRequests.has(questionIndex)) {
      if (playerResults.has(questionIndex)) renderPersonalResult(questions[questionIndex], playerResults.get(questionIndex));
      return;
    }
    resultRequests.add(questionIndex);
    const { data, error } = await db.rpc("get_live_player_result", {
      p_room_code: room.code,
      p_device_id: deviceId,
      p_question_index: questionIndex
    });
    resultRequests.delete(questionIndex);
    if (error) {
      $("#personalResult").className = "personal-result incorrect";
      $("#personalResult").innerHTML = `<div class="result-verdict">無法讀取作答結果</div><div class="muted">${Live.escapeHtml(error.message)}</div>`;
      return;
    }
    playerResults.set(questionIndex, data?.[0] || null);
    if (room.current_question === questionIndex && room.phase === "revealed") {
      renderPersonalResult(questions[questionIndex], playerResults.get(questionIndex));
    }
  }

  function renderReveal() {
    const q = questions[room.current_question];
    const reveal = revealIndexes();
    let text = "請看大螢幕上的全場分布。";
    if (q.type === "guess" && reveal.length) text = `台上代表選擇：${Live.letters[reveal[0]]} ${q.options[reveal[0]]}`;
    if (q.type === "smart10") text = "綠色項目是本題正確答案。";
    if (q.type === "predict_average" && Number.isFinite(room.reveal_answer?.average)) {
      text = `全場實際平均：${room.reveal_answer.average.toFixed(2)}`;
    }
    if (q.type === "predict_majority" && Array.isArray(room.reveal_answer?.majority)) {
      text = `全場最多人選：${room.reveal_answer.majority.map(index => q.options[index]).join("、")}`;
    }
    $("#revealText").textContent = text;
    $("#revealOptions").innerHTML = q.options.map((option, index) =>
      `<div class="option ${reveal.includes(index) ? "correct" : ""}">${Live.optionLabel(index, option)}</div>`
    ).join("");
    $("#personalResult").className = "personal-result";
    $("#personalResult").innerHTML = `<div class="result-loading">正在讀取你的作答結果…</div>`;
    loadPersonalResult(room.current_question);
  }

  $("#joinForm").addEventListener("submit", join);
})();
