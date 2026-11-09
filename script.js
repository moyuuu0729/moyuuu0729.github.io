const startBtn = document.getElementById('startBtn');
const nicknameInput = document.getElementById('nicknameInput');
const gameSection = document.getElementById('gameSection');
const nicknameDisplay = document.getElementById('nicknameDisplay');
const balanceAmount = document.getElementById('balanceAmount');
const buyCardBtn = document.getElementById('buyCardBtn');
const scratchCanvas = document.getElementById('scratchCanvas');
const resultMsg = document.getElementById('resultMsg');
const resetBtn = document.getElementById('resetBtn');

let balance = 0;
let nickname = '';
let isScratching = false;
let ctx;

function loadData() {
  const savedNick = localStorage.getItem('nickname');
  const savedBalance = localStorage.getItem('balance');
  if (savedNick) nickname = savedNick;
  if (savedBalance) balance = parseInt(savedBalance);
}

function saveData() {
  localStorage.setItem('nickname', nickname);
  localStorage.setItem('balance', balance);
}

function initCanvas() {
  scratchCanvas.style.display = 'block';
  resultMsg.textContent = '';
  resetBtn.style.display = 'none';
  buyCardBtn.disabled = true;

  ctx = scratchCanvas.getContext('2d');
  ctx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);

  // 30%機率中50元獎金
  const prize = Math.random() < 0.3 ? 50 : 0;
  scratchCanvas.prize = prize;

  // 用深灰色遮罩遮住底下文字，等待刮開
  ctx.fillStyle = '#C0C0C0';
  ctx.fillRect(0, 0, scratchCanvas.width, scratchCanvas.height);

  // 底層顯示獎金文字
  ctx.font = '40px Arial';
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(prize > 0 ? `中獎 ${prize} 元` : '未中獎', scratchCanvas.width / 2, scratchCanvas.height / 2);
}

function scratch(e) {
  if (!isScratching) return;
  const rect = scratchCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(x, y, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  const pixels = ctx.getImageData(0, 0, scratchCanvas.width, scratchCanvas.height);
  let cleared = 0;
  for (let i = 3; i < pixels.data.length; i += 4) {
    if (pixels.data[i] === 0) cleared++;
  }
  if (cleared / (scratchCanvas.width * scratchCanvas.height) > 0.5) {
    finishScratch();
  }
}

function finishScratch() {
  isScratching = false;
  buyCardBtn.disabled = false;
  resetBtn.style.display = 'inline-block';

  const prize = scratchCanvas.prize;
  if (prize > 0) {
    balance += prize;
    balanceAmount.textContent = balance;
    resultMsg.textContent = `恭喜你中獎 ${prize} 元！已加入你的帳戶。`;
  } else {
    resultMsg.textContent = '很可惜，沒中獎，再試試吧！';
  }
  saveData();
}

startBtn.onclick = () => {
  const name = nicknameInput.value.trim();
  if (name === '') {
    alert('請輸入暱稱！');
    return;
  }
  nickname = name;
  if (!localStorage.getItem('balance')) {
    balance = 100; // 預設初始金額
  }
  saveData();
  nicknameDisplay.textContent = nickname;
  balanceAmount.textContent = balance;
  document.getElementById('inputSection').style.display = 'none';
  gameSection.style.display = 'block';
};

buyCardBtn.onclick = () => {
  if (balance < 10) {
    alert('餘額不足，無法購買刮刮樂！');
    return;
  }
  balance -= 10;
  balanceAmount.textContent = balance;
  saveData();
  initCanvas();
  isScratching = true;
  resultMsg.textContent = '';
};

resetBtn.onclick = () => {
  scratchCanvas.style.display = 'none';
  resetBtn.style.display = 'none';
  resultMsg.textContent = '';
};

scratchCanvas.addEventListener('mousedown', () => {
  if (isScratching) isScratching = true;
});
scratchCanvas.addEventListener('mouseup', () => {
  if (isScratching) isScratching = false;
});
scratchCanvas.addEventListener('mouseleave', () => {
  if (isScratching) isScratching = false;
});
scratchCanvas.addEventListener('mousemove', scratch);

window.onload = () => {
  loadData();
  if (nickname) {
    nicknameDisplay.textContent = nickname;
    balanceAmount.textContent = balance;
    document.getElementById('inputSection').style.display = 'none';
    gameSection.style.display = 'block';
  }
};
