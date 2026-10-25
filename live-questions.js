window.LIVE_QUESTIONS = [
  {
    type: "predict_average",
    theme: "科技生活",
    prompt: "手機剩 5% 電量，你有多焦慮？",
    options: ["1 完全沒差", "2 有點在意", "3 開始注意用量", "4 很焦慮", "5 世界末日"],
    selfPrompt: "你的答案",
    predictionPrompt: "你猜全場平均大約是多少？"
  },
  {
    type: "smart10",
    theme: "科技生活",
    prompt: "以下哪些產品／服務在第一代 iPhone（2007）以前就已經存在？（可複選）",
    options: ["YouTube", "Facebook", "MSN Messenger", "LINE", "Wikipedia", "Instagram", "Google Maps", "TikTok", "Skype", "Gmail"],
    answer: [0, 1, 2, 4, 6, 8, 9]
  },
  {
    type: "predict_majority",
    theme: "成長、世代與價值觀",
    prompt: "如果可以把現在的一項能力送給 15 歲的自己，你最想送哪一個？",
    options: ["勇氣", "耐心", "溝通能力", "判斷力", "自信"],
    selfPrompt: "你的答案",
    predictionPrompt: "你猜全場最多人會選哪一個？"
  },
  {
    type: "guess",
    theme: "成長、世代與價值觀",
    prompt: "突然多出三小時自由時間，「他／她」最想做什麼？",
    options: ["睡覺／休息", "找朋友", "玩遊戲／追劇", "做自己的興趣", "把事情處理完"],
    representative: "年輕代表"
  }
];
