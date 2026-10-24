#!/usr/bin/env bash
# 由 questions.csv 產生 questions.js（給 file:// 直接開啟時當題庫備援用）
set -e
cd "$(dirname "$0")/.."
node -e 'const fs=require("fs");const t=fs.readFileSync("questions.csv","utf8");fs.writeFileSync("questions.js","// 自動產生，請勿手動編輯；改 questions.csv 後執行 scripts/build-questions.sh\nwindow.QUESTIONS_CSV = "+JSON.stringify(t)+";\n")'
echo "questions.js 已更新（$(grep -c '' questions.csv) 行 CSV）"
