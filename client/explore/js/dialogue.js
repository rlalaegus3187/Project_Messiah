export const canvas = document.getElementById('game');
export const mapSelect = document.getElementById('mapSelect');
export const hintEl = document.getElementById('hint');
export const dlgBox = document.getElementById('dialogueBox');
export const dlgText = document.getElementById('dialogueText');
export const choicesEl = document.getElementById('choices');

const dialogState = {
  active: false,
  dialogueId: null,
  nodeId: null,
  lines: [],
  lineIndex: 0,
  choices: [],
  index: 0,
  lastHintStamp: null,
  _currentChoices: [],
};

let choiceEmitter = null;
export function setChoiceEmitter(fn) { choiceEmitter = fn; }

// ---------- Utils ----------
function normalizeLines(input) {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : [String(input)];
  return arr.map(s => String(s ?? ''))
    .map(s => s.replace(/\r\n/g, '\n').trim())
    .filter(s => s.length > 0);
}

// ---------- Hint ----------
export function showHint(msg, t = 1200) {
  if (!hintEl) return;
  hintEl.textContent = msg ?? '';
  const stamp = Symbol('hint');
  dialogState.lastHintStamp = stamp;
  setTimeout(() => {
    if (dialogState.lastHintStamp === stamp && hintEl.textContent === (msg ?? '')) {
      hintEl.textContent = '';
    }
  }, Math.max(0, t | 0));
}

export function isDlgOpen() { return !!dlgBox && dlgBox.style.display === 'block'; }
export function openDialogue(text = '') { setDialogueText(text); if (dlgBox) dlgBox.style.display = 'block'; }
export function closeDialogue() {
  if (dlgBox) dlgBox.style.display = 'none';
  clearChoices();
  dlgCleanupForClose();

  // 키워드 새로 불러오기
  fetch('/explore/ajax/get_keywords.php')
    .then(res => res.json())
    .then(data => {
      window.keywords = data;
    })
    .catch(err => console.error('Failed to reload keywords:', err));
}


export function setDialogueText(text) { if (dlgText) dlgText.textContent = text ?? ''; }

export function clearChoices() {
  dialogState.choices = [];
  dialogState.index = 0;
  if (choicesEl) choicesEl.innerHTML = '';
}

export function setChoices(choices = []) {
  clearChoices();
  if (!choicesEl) return dialogState.choices;
  choices.forEach(({ label, onClick }, idx) => {
    const btn = document.createElement('button');
    btn.className = 'choice';
    btn.textContent = label ?? '...';
    btn.addEventListener('click', async () => {
      selectChoice(idx);
      try { await onClick?.(); } catch (e) { console.error(e); }
    });
    choicesEl.appendChild(btn);
    dialogState.choices.push({ label, onClick, btn });
  });
  if (dialogState.choices.length) selectChoice(0);
  return dialogState.choices;
}

export function selectChoice(i) {
  if (!dialogState.choices.length) return;
  const len = dialogState.choices.length;
  dialogState.index = ((i % len) + len) % len;
  dialogState.choices.forEach((c, idx) => {
    c.btn.classList.toggle('selected', idx === dialogState.index);
  });
}

export function activateChoice(i = dialogState.index) {
  if (!dialogState.choices.length) return;
  const len = dialogState.choices.length;
  const idx = ((i % len) + len) % len;
  dialogState.choices[idx].btn.click();
}

// ---------- Line paging ----------
export function dlgHasMoreLines() {
  if (!dialogState.active) return false;
  return dialogState.lineIndex < dialogState.lines.length - 1;
}

export function dlgNextLine() {
  if (!dialogState.active) return;

  if (dlgHasMoreLines()) {
    dialogState.lineIndex++;
    setDialogueText(dialogState.lines[dialogState.lineIndex]);

    const isLast = dialogState.lineIndex === dialogState.lines.length - 1;
    if (isLast) {
      renderChoicesOrClose();
    } else {
      setChoices([{ label: '[Enter] 다음', onClick: dlgNextLine }]);
    }
  } else {
    renderChoicesOrClose();
  }
}

export function dlgCleanupForClose() {
  dialogState.active = false;
  dialogState.dialogueId = null;
  dialogState.nodeId = null;
  dialogState.lines = [];
  dialogState.lineIndex = 0;
  dialogState.index = 0;
  dialogState.choices = [];
  dialogState._currentChoices = [];
}

function renderChoicesOrClose() {
  const hasChoices = dialogState._currentChoices && dialogState._currentChoices.length > 0;
  if (hasChoices) {
    renderChoicesForCurrentNode();
  } else {
    setChoices([{ label: '[Enter] 닫기', onClick: closeDialogue }]);
  }
}

function renderServerNode({ id, nodeId, node }) {
  const lines = normalizeLines(node?.text);

  dialogState.active = true;
  dialogState.dialogueId = id || null;
  dialogState.nodeId = nodeId || null;
  dialogState.lines = lines;
  dialogState.lineIndex = 0;
  dialogState._currentChoices = Array.isArray(node?.choices) ? node.choices.slice(0, 9) : [];

  openDialogue(dialogState.lines[0] || '');

  if (dlgHasMoreLines()) {
    setChoices([{ label: '[Enter] 다음', onClick: dlgNextLine }]);
  } else {
    renderChoicesOrClose();
  }
}

function renderChoicesForCurrentNode() {
  const choices = dialogState._currentChoices || [];
  if (choices.length === 0) {
    setChoices([{ label: '[Enter] 닫기', onClick: closeDialogue }]);
    return;
  }
  const bound = choices.map((ch, i) => ({
    label: `[${i + 1}] ${ch.label || '...'}`,
    onClick: async () => {
      try {
        choiceEmitter && choiceEmitter(dialogState.nodeId, i);
      } catch (e) {
        console.error('choice emit failed', e);
      }
    },
  }));
  setChoices(bound);
}

export function handleInteractionStart({ dialogue }) {
  if (!dialogue) return;
  renderServerNode(dialogue);
}

export function handleInteractionUpdate({ dialogue }) {
  if (!dialogue) return;
  renderServerNode(dialogue);
}

export function handleInteractionEnd({ dialogue } = {}) {
  if (dialogue?.node) {
    renderServerNode(dialogue);
    setChoices([{ label: '[Enter] 닫기', onClick: closeDialogue }]);
  } else {
    closeDialogue();
  }
}

export function handleInteractionFail(e) {
  console.warn('interaction:fail', e);
  showHint('이벤트 발생 실패!', 1200);
}

export function nextChoice() { if (dialogState.choices.length) selectChoice(dialogState.index + 1); }
export function prevChoice() { if (dialogState.choices.length) selectChoice(dialogState.index - 1); }
export function activateCurrent() { activateChoice(dialogState.index); }
export function activateByNumber(n) {
  if (!dialogState.choices.length) return;
  if (n >= 1 && n <= dialogState.choices.length) activateChoice(n - 1);
}

