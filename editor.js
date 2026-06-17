(function () {
  const canvas = document.getElementById('canvas');
  const stage = document.getElementById('stage');
  const hint = document.getElementById('hint');
  const bgInput = document.getElementById('bgInput');
  const addInput = document.getElementById('addInput');
  const zoomLabel = document.getElementById('zoomLabel');
  const layerList = document.getElementById('layerList');
  const propertiesPanel = document.getElementById('properties');
  const propertiesBody = document.getElementById('propertiesBody');
  const addVLineBtn = document.getElementById('addVLineBtn');
  const addHLineBtn = document.getElementById('addHLineBtn');

  // === State ===
  let bgDataUrl = null;
  let bgRatio = '16 / 9';
  let zoom = 1, panX = 0, panY = 0;
  let spaceHeld = false, isPanning = false;
  const BASE_WIDTH = 1280;

  let vLines = []; // sorted ascending, fractions in (0, 1)
  let hLines = [];
  // items[0] = top of layer panel = visually on top. Each: {id, src, name, col:[s,e], row:[s,e], dom}
  let items = [];

  const selectedItems = new Set();
  let primaryItem = null;
  let selectedLine = null; // {axis:'v'|'h', index}

  let addLineMode = null; // 'v' | 'h' | null
  let clipboard = null;
  let history = [], historyIdx = -1, isRestoring = false;
  let nextId = 1;
  let imageCounter = 0;

  function applyPan() {
    canvas.style.transform = (panX || panY) ? `translate(${panX}px, ${panY}px)` : '';
  }

  // === IndexedDB 自動儲存 ===
  const DB_NAME = 'LayoutStudioDB';
  const DB_STORE = 'state';
  const DB_KEY = 'grid-current';
  let _saveTimer = null;
  function _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  }
  async function saveStateToDB(snap) {
    try {
      const db = await _openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(snap, DB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
      });
      db.close();
    } catch (err) {
      console.warn('自動儲存失敗:', err);
    }
  }
  async function loadStateFromDB() {
    try {
      const db = await _openDB();
      const result = await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(DB_KEY);
        req.onsuccess = () => resolve(req.result);
        req.onerror = e => reject(e.target.error);
      });
      db.close();
      return result;
    } catch (err) {
      console.warn('讀取本機儲存失敗:', err);
      return null;
    }
  }
  async function clearStateFromDB() {
    try {
      const db = await _openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(DB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
      });
      db.close();
    } catch (err) {
      console.warn('清除儲存失敗:', err);
    }
  }
  function debouncedSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => saveStateToDB(snapshot()), 500);
  }

  // === Grid tracks ===
  function trackWidths(lines) {
    const pts = [0, ...lines, 1];
    const out = [];
    for (let i = 1; i < pts.length; i++) out.push(pts[i] - pts[i - 1]);
    return out;
  }
  function applyGridTracks() {
    const cols = trackWidths(vLines).map(w => Math.max(0.0001, w).toFixed(4) + 'fr').join(' ');
    const rows = trackWidths(hLines).map(h => Math.max(0.0001, h).toFixed(4) + 'fr').join(' ');
    canvas.style.gridTemplateColumns = cols;
    canvas.style.gridTemplateRows = rows;
  }

  // === Item DOM ===
  function createItemDom(item) {
    const div = document.createElement('div');
    div.className = 'item';
    div.dataset.id = item.id;
    const img = document.createElement('img');
    img.src = item.src;
    img.draggable = false;
    div.appendChild(img);
    ['nw', 'ne', 'sw', 'se'].forEach(d => {
      const h = document.createElement('div');
      h.className = 'handle ' + d;
      h.dataset.dir = d;
      div.appendChild(h);
    });
    attachItemHandlers(div, item);
    return div;
  }
  function applyItemStyle(item) {
    if (!item.dom) return;
    item.dom.style.gridColumn = item.col[0] + ' / ' + item.col[1];
    item.dom.style.gridRow = item.row[0] + ' / ' + item.row[1];
  }
  function reflowCanvas() {
    canvas.querySelectorAll('.item').forEach(el => el.remove());
    // items[0] = top of panel = visually on top, so append in REVERSE so it ends up last in DOM
    items.slice().reverse().forEach(item => {
      if (!item.dom) item.dom = createItemDom(item);
      applyItemStyle(item);
      item.dom.classList.toggle('selected', selectedItems.has(item));
      item.dom.classList.toggle('primary', item === primaryItem);
      canvas.appendChild(item.dom);
    });
    renderLines();
    updateHintVisibility();
  }
  function updateHintVisibility() {
    hint.style.display = (bgDataUrl || items.length > 0) ? 'none' : '';
  }

  // === Lines ===
  function renderLines() {
    canvas.querySelectorAll('.grid-line').forEach(el => el.remove());
    vLines.forEach((x, i) => {
      const el = document.createElement('div');
      el.className = 'grid-line v';
      el.style.left = (x * 100) + '%';
      el.dataset.axis = 'v';
      el.dataset.index = i;
      if (selectedLine && selectedLine.axis === 'v' && selectedLine.index === i) el.classList.add('selected');
      attachLineHandlers(el);
      canvas.appendChild(el);
    });
    hLines.forEach((y, i) => {
      const el = document.createElement('div');
      el.className = 'grid-line h';
      el.style.top = (y * 100) + '%';
      el.dataset.axis = 'h';
      el.dataset.index = i;
      if (selectedLine && selectedLine.axis === 'h' && selectedLine.index === i) el.classList.add('selected');
      attachLineHandlers(el);
      canvas.appendChild(el);
    });
  }

  function addLine(axis, frac) {
    const lines = axis === 'v' ? vLines : hLines;
    frac = Math.max(0.01, Math.min(0.99, frac));
    if (lines.some(v => Math.abs(v - frac) < 0.005)) return;
    let pos = lines.findIndex(v => v > frac);
    if (pos === -1) pos = lines.length;
    lines.splice(pos, 0, frac);
    // New grid line index = pos + 2 (1-indexed). Bump any item col/row that's >= that.
    const newIdx = pos + 2;
    items.forEach(item => {
      const k = axis === 'v' ? 'col' : 'row';
      if (item[k][0] >= newIdx) item[k][0]++;
      if (item[k][1] >= newIdx) item[k][1]++;
    });
    applyGridTracks();
    reflowCanvas();
    pushHistory();
  }

  function removeLine(axis, idx) {
    const lines = axis === 'v' ? vLines : hLines;
    if (idx < 0 || idx >= lines.length) return;
    lines.splice(idx, 1);
    const removed = idx + 2;
    items.forEach(item => {
      const k = axis === 'v' ? 'col' : 'row';
      [0, 1].forEach(side => {
        const v = item[k][side];
        if (v > removed) item[k][side] = v - 1;
        else if (v === removed) item[k][side] = removed - 1;
      });
      if (item[k][0] >= item[k][1]) item[k][1] = item[k][0] + 1;
    });
    selectedLine = null;
    applyGridTracks();
    reflowCanvas();
    rebuildProperties();
    pushHistory();
  }

  function attachLineHandlers(el) {
    const axis = el.dataset.axis;
    const index = +el.dataset.index;
    el.addEventListener('mousedown', e => {
      if (spaceHeld || addLineMode) return;
      e.preventDefault();
      e.stopPropagation();
      selectLine(axis, index);

      const lines = axis === 'v' ? vLines : hLines;
      const cr = canvas.getBoundingClientRect();
      const startVal = lines[index];
      const prev = index > 0 ? lines[index - 1] : 0;
      const next = index < lines.length - 1 ? lines[index + 1] : 1;
      const eps = 0.005;
      let moved = false;
      const move = ev => {
        const frac = axis === 'v'
          ? (ev.clientX - cr.left) / cr.width
          : (ev.clientY - cr.top) / cr.height;
        const clamped = Math.max(prev + eps, Math.min(next - eps, frac));
        if (Math.abs(clamped - startVal) > 0.001) moved = true;
        lines[index] = clamped;
        if (axis === 'v') el.style.left = (clamped * 100) + '%';
        else el.style.top = (clamped * 100) + '%';
        applyGridTracks();
        rebuildProperties();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (moved) pushHistory();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function selectLine(axis, index) {
    selectedLine = { axis, index };
    clearItemSelection(false);
    canvas.querySelectorAll('.grid-line').forEach(el => {
      el.classList.toggle('selected', el.dataset.axis === axis && +el.dataset.index === index);
    });
    rebuildLayerPanel();
    rebuildProperties();
  }
  function clearLineSelection() {
    selectedLine = null;
    canvas.querySelectorAll('.grid-line').forEach(el => el.classList.remove('selected'));
  }

  // === Items: selection ===
  function clearItemSelection(refresh) {
    selectedItems.forEach(item => {
      if (item.dom) {
        item.dom.classList.remove('selected');
        item.dom.classList.remove('primary');
      }
    });
    selectedItems.clear();
    primaryItem = null;
    if (refresh !== false) { rebuildLayerPanel(); rebuildProperties(); }
  }
  function addItemSelection(item, makePrimary) {
    if (!selectedItems.has(item)) {
      selectedItems.add(item);
      if (item.dom) item.dom.classList.add('selected');
    }
    if (makePrimary || !primaryItem) setPrimaryItem(item);
    rebuildLayerPanel();
    rebuildProperties();
  }
  function removeItemSelection(item) {
    if (!selectedItems.has(item)) return;
    selectedItems.delete(item);
    if (item.dom) { item.dom.classList.remove('selected'); item.dom.classList.remove('primary'); }
    if (item === primaryItem) {
      primaryItem = null;
      const next = selectedItems.values().next().value;
      if (next) setPrimaryItem(next);
    }
    rebuildLayerPanel();
    rebuildProperties();
  }
  function replaceItemSelection(item) {
    clearItemSelection(false);
    clearLineSelection();
    selectedItems.add(item);
    if (item.dom) item.dom.classList.add('selected');
    setPrimaryItem(item);
    rebuildLayerPanel();
    rebuildProperties();
  }
  function setPrimaryItem(item) {
    if (primaryItem && primaryItem.dom) primaryItem.dom.classList.remove('primary');
    primaryItem = item;
    if (item && item.dom) item.dom.classList.add('primary');
  }
  function toggleItemSelection(item) {
    if (selectedItems.has(item)) removeItemSelection(item);
    else addItemSelection(item, true);
  }

  // === Cell math ===
  function cellFromPoint(x, y) {
    // x,y in canvas-local fractions [0,1]. Returns 1-indexed (col, row).
    const xs = [0, ...vLines, 1];
    const ys = [0, ...hLines, 1];
    let col = xs.length - 1, row = ys.length - 1;
    for (let i = 1; i < xs.length; i++) {
      if (x < xs[i]) { col = i; break; }
    }
    for (let i = 1; i < ys.length; i++) {
      if (y < ys[i]) { row = i; break; }
    }
    return { col, row };
  }

  // === Items: drag/move/resize ===
  function attachItemHandlers(dom, item) {
    dom.addEventListener('mousedown', e => {
      if (e.target.classList.contains('handle')) return;
      if (spaceHeld || addLineMode) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey) {
        if (selectedItems.has(item)) { removeItemSelection(item); return; }
        addItemSelection(item, true);
      } else {
        if (!selectedItems.has(item)) replaceItemSelection(item);
        else setPrimaryItem(item);
      }

      const cr = canvas.getBoundingClientRect();
      const startMouse = cellFromPoint(
        (e.clientX - cr.left) / cr.width,
        (e.clientY - cr.top) / cr.height
      );
      const dragSet = Array.from(selectedItems).map(it => ({
        item: it,
        startCol: it.col.slice(),
        startRow: it.row.slice()
      }));
      const maxCol = vLines.length + 2;
      const maxRow = hLines.length + 2;
      let moved = false;
      const move = ev => {
        const mouseCell = cellFromPoint(
          (ev.clientX - cr.left) / cr.width,
          (ev.clientY - cr.top) / cr.height
        );
        const dc = mouseCell.col - startMouse.col;
        const dr = mouseCell.row - startMouse.row;
        if (dc !== 0 || dr !== 0) moved = true;
        dragSet.forEach(d => {
          let nc0 = d.startCol[0] + dc;
          let nc1 = d.startCol[1] + dc;
          if (nc0 < 1) { nc1 += (1 - nc0); nc0 = 1; }
          if (nc1 > maxCol) { nc0 -= (nc1 - maxCol); nc1 = maxCol; }
          if (nc0 < 1) nc0 = 1;
          let nr0 = d.startRow[0] + dr;
          let nr1 = d.startRow[1] + dr;
          if (nr0 < 1) { nr1 += (1 - nr0); nr0 = 1; }
          if (nr1 > maxRow) { nr0 -= (nr1 - maxRow); nr1 = maxRow; }
          if (nr0 < 1) nr0 = 1;
          d.item.col = [nc0, nc1];
          d.item.row = [nr0, nr1];
          applyItemStyle(d.item);
        });
        if (moved) rebuildProperties();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (moved) pushHistory();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    dom.querySelectorAll('.handle').forEach(handle => {
      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        replaceItemSelection(item);
        const dir = handle.dataset.dir;
        const cr = canvas.getBoundingClientRect();
        const sCol = item.col.slice(), sRow = item.row.slice();
        const maxCol = vLines.length + 2;
        const maxRow = hLines.length + 2;
        let moved = false;
        const move = ev => {
          const mouseCell = cellFromPoint(
            (ev.clientX - cr.left) / cr.width,
            (ev.clientY - cr.top) / cr.height
          );
          let c0 = sCol[0], c1 = sCol[1], r0 = sRow[0], r1 = sRow[1];
          if (dir === 'se' || dir === 'ne') c1 = Math.max(c0 + 1, Math.min(maxCol, mouseCell.col + 1));
          if (dir === 'sw' || dir === 'nw') c0 = Math.min(c1 - 1, Math.max(1, mouseCell.col));
          if (dir === 'sw' || dir === 'se') r1 = Math.max(r0 + 1, Math.min(maxRow, mouseCell.row + 1));
          if (dir === 'nw' || dir === 'ne') r0 = Math.min(r1 - 1, Math.max(1, mouseCell.row));
          if (c0 !== sCol[0] || c1 !== sCol[1] || r0 !== sRow[0] || r1 !== sRow[1]) moved = true;
          item.col = [c0, c1]; item.row = [r0, r1];
          applyItemStyle(item);
          if (moved) rebuildProperties();
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          if (moved) pushHistory();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
  }

  // === Add / delete items ===
  function addItem(src, name, cell) {
    const id = 'item-' + (nextId++);
    cell = cell || { col: 1, row: 1 };
    const item = {
      id, src,
      name: (name && name.trim()) || ('Image ' + (++imageCounter)),
      col: [cell.col, cell.col + 1],
      row: [cell.row, cell.row + 1]
    };
    items.unshift(item);
    item.dom = createItemDom(item);
    reflowCanvas();
    replaceItemSelection(item);
    pushHistory();
    return item;
  }

  function deleteSelected() {
    if (selectedItems.size === 0) return;
    items = items.filter(it => {
      if (selectedItems.has(it)) {
        if (it.dom) it.dom.remove();
        return false;
      }
      return true;
    });
    selectedItems.clear();
    primaryItem = null;
    rebuildLayerPanel();
    rebuildProperties();
    updateHintVisibility();
    pushHistory();
  }

  // === Layer panel ===
  function rebuildLayerPanel() {
    layerList.innerHTML = '';
    if (items.length === 0) {
      const e = document.createElement('div');
      e.className = 'layer-empty';
      e.textContent = '尚無圖片';
      layerList.appendChild(e);
      return;
    }
    items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'layer-row';
      row.dataset.idx = idx;
      row.draggable = true;

      const spacer = document.createElement('span');
      spacer.className = 'layer-arrow';
      row.appendChild(spacer);

      const thumb = document.createElement('img');
      thumb.className = 'layer-thumb';
      thumb.src = item.src;
      row.appendChild(thumb);

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = item.name;
      row.appendChild(name);
      makeNameEditable(name, item, row);

      if (selectedItems.has(item)) row.classList.add('selected');

      row.addEventListener('click', e => {
        e.stopPropagation();
        if (e.shiftKey) toggleItemSelection(item);
        else replaceItemSelection(item);
      });

      row.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', String(idx));
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        layerList.querySelectorAll('.drop-above,.drop-below').forEach(r => {
          r.classList.remove('drop-above', 'drop-below');
        });
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const offset = e.clientY - rect.top;
        layerList.querySelectorAll('.drop-above,.drop-below').forEach(r => {
          r.classList.remove('drop-above', 'drop-below');
        });
        if (offset < rect.height / 2) row.classList.add('drop-above');
        else row.classList.add('drop-below');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (isNaN(fromIdx) || fromIdx === idx) return;
        const isAbove = row.classList.contains('drop-above');
        const moved = items.splice(fromIdx, 1)[0];
        let target = idx;
        if (fromIdx < idx) target--;
        if (!isAbove) target++;
        items.splice(target, 0, moved);
        reflowCanvas();
        rebuildLayerPanel();
        pushHistory();
      });

      layerList.appendChild(row);
    });
  }

  function makeNameEditable(span, item, row) {
    span.addEventListener('dblclick', e => {
      e.stopPropagation();
      e.preventDefault();
      if (row) row.draggable = false;
      const oldName = item.name;
      const input = document.createElement('input');
      input.value = oldName;
      input.className = 'layer-name-input';
      input.addEventListener('mousedown', ev => ev.stopPropagation());
      input.addEventListener('click', ev => ev.stopPropagation());
      span.replaceWith(input);
      input.focus(); input.select();
      let done = false;
      const commit = (cancel) => {
        if (done) return;
        done = true;
        if (row) row.draggable = true;
        if (!cancel) {
          const newName = input.value.trim();
          if (newName && newName !== oldName) { item.name = newName; pushHistory(); }
        }
        rebuildLayerPanel();
      };
      input.addEventListener('blur', () => commit(false));
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(false); }
        else if (ev.key === 'Escape') { ev.preventDefault(); commit(true); }
      });
    });
  }

  // === Properties ===
  function rebuildProperties() {
    propertiesBody.innerHTML = '';
    const header = propertiesPanel.querySelector('.properties-header');

    if (selectedLine) {
      const lines = selectedLine.axis === 'v' ? vLines : hLines;
      const idx = selectedLine.index;
      const cur = lines[idx];
      if (cur == null) { propertiesPanel.style.display = 'none'; return; }
      propertiesPanel.style.display = 'block';
      if (header) header.textContent = selectedLine.axis === 'v' ? '垂直線屬性' : '水平線屬性';

      const posRow = document.createElement('div');
      posRow.className = 'prop-row';
      const lbl = document.createElement('div');
      lbl.className = 'prop-label';
      lbl.textContent = '位置 (% of canvas)';
      posRow.appendChild(lbl);
      const wrap = document.createElement('div');
      wrap.className = 'prop-inline';
      const input = document.createElement('input');
      input.type = 'number'; input.className = 'prop-input';
      input.step = '0.5'; input.min = '1'; input.max = '99';
      input.value = (cur * 100).toFixed(2).replace(/\.?0+$/, '');
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (isNaN(v)) return;
        const prev = idx > 0 ? lines[idx - 1] : 0;
        const next = idx < lines.length - 1 ? lines[idx + 1] : 1;
        const eps = 0.005;
        lines[idx] = Math.max(prev + eps, Math.min(next - eps, v / 100));
        applyGridTracks();
        renderLines();
      });
      input.addEventListener('change', () => pushHistory());
      wrap.appendChild(input);
      const suf = document.createElement('span');
      suf.className = 'prop-suffix'; suf.textContent = '%';
      wrap.appendChild(suf);
      posRow.appendChild(wrap);
      propertiesBody.appendChild(posRow);

      const delRow = document.createElement('div');
      delRow.className = 'prop-row';
      const delBtn = document.createElement('button');
      delBtn.textContent = '刪除此線';
      delBtn.className = 'prop-btn-danger';
      delBtn.addEventListener('click', () => removeLine(selectedLine.axis, selectedLine.index));
      delRow.appendChild(delBtn);
      propertiesBody.appendChild(delRow);
      return;
    }

    if (selectedItems.size === 1 && primaryItem) {
      const it = primaryItem;
      propertiesPanel.style.display = 'block';
      if (header) header.textContent = '圖片屬性';

      const maxCol = vLines.length + 2;
      const maxRow = hLines.length + 2;
      propertiesBody.appendChild(spanRow('欄 (col start / end)', it.col[0], it.col[1], maxCol, (a, b) => {
        it.col = [a, b]; applyItemStyle(it);
      }));
      propertiesBody.appendChild(spanRow('列 (row start / end)', it.row[0], it.row[1], maxRow, (a, b) => {
        it.row = [a, b]; applyItemStyle(it);
      }));
      return;
    }

    propertiesPanel.style.display = 'none';
  }

  function spanRow(label, valStart, valEnd, max, onChange) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lbl = document.createElement('div');
    lbl.className = 'prop-label';
    lbl.textContent = label + '   (max ' + max + ')';
    row.appendChild(lbl);
    const inline = document.createElement('div');
    inline.className = 'prop-inline';
    const s = document.createElement('input');
    s.type = 'number'; s.className = 'prop-input'; s.style.width = '70px';
    s.min = 1; s.max = max - 1; s.value = valStart;
    const arrow = document.createElement('span');
    arrow.textContent = '→'; arrow.className = 'prop-suffix';
    const e2 = document.createElement('input');
    e2.type = 'number'; e2.className = 'prop-input'; e2.style.width = '70px';
    e2.min = 2; e2.max = max; e2.value = valEnd;
    inline.appendChild(s); inline.appendChild(arrow); inline.appendChild(e2);
    row.appendChild(inline);
    const handler = () => {
      let a = Math.max(1, Math.min(max - 1, parseInt(s.value, 10) || 1));
      let b = Math.max(a + 1, Math.min(max, parseInt(e2.value, 10) || (a + 1)));
      onChange(a, b);
    };
    s.addEventListener('input', handler);
    e2.addEventListener('input', handler);
    s.addEventListener('change', () => pushHistory());
    e2.addEventListener('change', () => pushHistory());
    return row;
  }

  // === Background ===
  function setBackground(file) {
    if (!file || !file.type.startsWith('image/')) return;
    readImage(file, src => {
      const tmp = new Image();
      tmp.onload = () => {
        bgRatio = tmp.width + ' / ' + tmp.height;
        canvas.style.aspectRatio = bgRatio;
        bgDataUrl = src;
        let bg = canvas.querySelector('.bg');
        if (!bg) {
          bg = document.createElement('img');
          bg.className = 'bg';
          canvas.insertBefore(bg, canvas.firstChild);
        }
        bg.src = src;
        updateHintVisibility();
        pushHistory();
      };
      tmp.src = src;
    });
  }
  function readImage(file, cb) {
    const r = new FileReader();
    r.onload = ev => cb(ev.target.result);
    r.onerror = err => console.error('FileReader error:', err);
    r.readAsDataURL(file);
  }
  function fileBaseName(file) {
    const n = (file && file.name) || '';
    const idx = n.lastIndexOf('.');
    return idx > 0 ? n.substring(0, idx) : n;
  }

  // === Z-order (layer panel reorder) ===
  function moveSelectedInList(dir) {
    if (!primaryItem) return false;
    const idx = items.indexOf(primaryItem);
    if (idx < 0) return false;
    if (dir === 'forward' && idx > 0) {
      [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]]; return true;
    }
    if (dir === 'backward' && idx < items.length - 1) {
      [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]]; return true;
    }
    if (dir === 'front' && idx > 0) {
      items.splice(idx, 1); items.unshift(primaryItem); return true;
    }
    if (dir === 'back' && idx < items.length - 1) {
      items.splice(idx, 1); items.push(primaryItem); return true;
    }
    return false;
  }
  function bringForward() { if (moveSelectedInList('forward')) { reflowCanvas(); rebuildLayerPanel(); pushHistory(); } }
  function sendBackward() { if (moveSelectedInList('backward')) { reflowCanvas(); rebuildLayerPanel(); pushHistory(); } }
  function bringToFront() { if (moveSelectedInList('front')) { reflowCanvas(); rebuildLayerPanel(); pushHistory(); } }
  function sendToBack() { if (moveSelectedInList('back')) { reflowCanvas(); rebuildLayerPanel(); pushHistory(); } }

  // === Zoom & pan ===
  function applyZoom() {
    canvas.style.width = (BASE_WIDTH * zoom) + 'px';
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
  }
  function setZoom(z) { zoom = Math.max(0.1, Math.min(4, z)); applyZoom(); }
  function fitZoom() {
    const sW = stage.clientWidth - 64, sH = stage.clientHeight - 64;
    const p = bgRatio.split('/').map(s => parseFloat(s));
    const cH = BASE_WIDTH * (p[1] / p[0]);
    setZoom(Math.min(sW / BASE_WIDTH, sH / cH));
    panX = 0; panY = 0; applyPan();
  }

  // === Clipboard ===
  function copyItems() {
    if (selectedItems.size === 0) return;
    clipboard = Array.from(selectedItems).map(it => ({
      src: it.src, name: it.name,
      col: it.col.slice(), row: it.row.slice()
    }));
  }
  function pasteItems() {
    if (!clipboard || clipboard.length === 0) return;
    clearItemSelection(false);
    clearLineSelection();
    clipboard.forEach(c => {
      const id = 'item-' + (nextId++);
      const item = {
        id, src: c.src,
        name: c.name || ('Image ' + (++imageCounter)),
        col: c.col.slice(), row: c.row.slice()
      };
      items.unshift(item);
      item.dom = createItemDom(item);
      selectedItems.add(item);
      if (!primaryItem) setPrimaryItem(item);
    });
    reflowCanvas();
    rebuildLayerPanel();
    rebuildProperties();
    pushHistory();
  }

  // === History & persistence ===
  function snapshot() {
    return {
      schema: 'grid-v1',
      bgDataUrl, bgRatio,
      vLines: vLines.slice(),
      hLines: hLines.slice(),
      items: items.map(it => ({
        id: it.id, src: it.src, name: it.name,
        col: it.col.slice(), row: it.row.slice()
      })),
      nextId, imageCounter
    };
  }
  function pushHistory() {
    if (isRestoring) return;
    history.length = historyIdx + 1;
    history.push(snapshot());
    if (history.length > 60) history.shift();
    historyIdx = history.length - 1;
    debouncedSave();
  }
  function undo() {
    if (historyIdx <= 0) return;
    historyIdx--;
    restoreSnapshot(history[historyIdx]);
  }
  function restoreSnapshot(snap) {
    if (!snap || snap.schema !== 'grid-v1') return;
    isRestoring = true;
    canvas.querySelectorAll('.item, .grid-line').forEach(el => el.remove());
    items = [];
    selectedItems.clear();
    primaryItem = null;
    selectedLine = null;

    vLines = (snap.vLines || []).slice();
    hLines = (snap.hLines || []).slice();
    nextId = snap.nextId || 1;
    imageCounter = snap.imageCounter || 0;

    if (snap.bgDataUrl) {
      bgDataUrl = snap.bgDataUrl;
      bgRatio = snap.bgRatio || '16 / 9';
      canvas.style.aspectRatio = bgRatio;
      let bg = canvas.querySelector('.bg');
      if (!bg) {
        bg = document.createElement('img');
        bg.className = 'bg';
        canvas.insertBefore(bg, canvas.firstChild);
      }
      bg.src = snap.bgDataUrl;
    } else {
      bgDataUrl = null;
      bgRatio = '16 / 9';
      canvas.style.aspectRatio = bgRatio;
      const bg = canvas.querySelector('.bg'); if (bg) bg.remove();
    }

    items = (snap.items || []).map(s => ({
      id: s.id, src: s.src, name: s.name,
      col: s.col.slice(), row: s.row.slice()
    }));
    items.forEach(it => { it.dom = createItemDom(it); });

    applyGridTracks();
    reflowCanvas();
    rebuildLayerPanel();
    rebuildProperties();
    isRestoring = false;
  }

  // === Add-line mode ===
  function enterAddLineMode(axis) {
    addLineMode = axis;
    document.body.classList.add('add-line-mode');
    addVLineBtn.classList.toggle('active', axis === 'v');
    addHLineBtn.classList.toggle('active', axis === 'h');
  }
  function exitAddLineMode() {
    addLineMode = null;
    document.body.classList.remove('add-line-mode');
    addVLineBtn.classList.remove('active');
    addHLineBtn.classList.remove('active');
  }

  // === Button wiring ===
  document.getElementById('bgBtn').addEventListener('click', () => { bgInput.value = ''; bgInput.click(); });
  document.getElementById('addBtn').addEventListener('click', () => { addInput.value = ''; addInput.click(); });
  addVLineBtn.addEventListener('click', () => {
    if (addLineMode === 'v') exitAddLineMode();
    else enterAddLineMode('v');
  });
  addHLineBtn.addEventListener('click', () => {
    if (addLineMode === 'h') exitAddLineMode();
    else enterAddLineMode('h');
  });
  document.getElementById('delBtn').addEventListener('click', () => {
    if (selectedLine) removeLine(selectedLine.axis, selectedLine.index);
    else deleteSelected();
  });
  document.getElementById('forwardBtn').addEventListener('click', bringForward);
  document.getElementById('backwardBtn').addEventListener('click', sendBackward);
  document.getElementById('frontBtn').addEventListener('click', bringToFront);
  document.getElementById('backBtn').addEventListener('click', sendToBack);
  document.getElementById('zoomInBtn').addEventListener('click', () => setZoom(zoom * 1.25));
  document.getElementById('zoomOutBtn').addEventListener('click', () => setZoom(zoom / 1.25));
  document.getElementById('fitBtn').addEventListener('click', fitZoom);
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('newBtn').addEventListener('click', async () => {
    if (!confirm('確定要清空畫布並刪除本機儲存嗎？')) return;
    isRestoring = true;
    canvas.querySelectorAll('.item, .grid-line').forEach(el => el.remove());
    items = []; vLines = []; hLines = [];
    selectedItems.clear(); primaryItem = null; selectedLine = null;
    bgDataUrl = null; bgRatio = '16 / 9';
    canvas.style.aspectRatio = bgRatio;
    const bg = canvas.querySelector('.bg'); if (bg) bg.remove();
    history = []; historyIdx = -1;
    imageCounter = 0; nextId = 1;
    applyGridTracks();
    rebuildLayerPanel();
    rebuildProperties();
    updateHintVisibility();
    isRestoring = false;
    await clearStateFromDB();
    pushHistory();
  });

  bgInput.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (file) setBackground(file);
  });
  addInput.addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const baseName = fileBaseName(file);
      readImage(file, src => addItem(src, baseName, { col: 1, row: 1 }));
    });
  });

  // === Canvas interactions ===
  function rectsIntersect(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  canvas.addEventListener('mousedown', e => {
    if (e.target !== canvas) return;
    if (spaceHeld) return;
    const cr = canvas.getBoundingClientRect();

    if (addLineMode) {
      e.preventDefault();
      const fx = (e.clientX - cr.left) / cr.width;
      const fy = (e.clientY - cr.top) / cr.height;
      if (addLineMode === 'v') addLine('v', fx);
      else addLine('h', fy);
      exitAddLineMode();
      return;
    }

    if (!e.shiftKey) {
      clearItemSelection(false);
      clearLineSelection();
      rebuildLayerPanel();
      rebuildProperties();
    }

    // Rubber-band selection
    const startX = e.clientX, startY = e.clientY;
    let rubber = null;
    const move = ev => {
      const dxA = Math.abs(ev.clientX - startX), dyA = Math.abs(ev.clientY - startY);
      if (!rubber && (dxA > 3 || dyA > 3)) {
        rubber = document.createElement('div');
        rubber.className = 'rubber-band';
        canvas.appendChild(rubber);
      }
      if (rubber) {
        const x1 = Math.min(startX, ev.clientX), x2 = Math.max(startX, ev.clientX);
        const y1 = Math.min(startY, ev.clientY), y2 = Math.max(startY, ev.clientY);
        rubber.style.left = ((x1 - cr.left) / cr.width * 100) + '%';
        rubber.style.top = ((y1 - cr.top) / cr.height * 100) + '%';
        rubber.style.width = ((x2 - x1) / cr.width * 100) + '%';
        rubber.style.height = ((y2 - y1) / cr.height * 100) + '%';
      }
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (rubber) {
        const rR = rubber.getBoundingClientRect();
        items.forEach(it => {
          if (it.dom && rectsIntersect(rR, it.dom.getBoundingClientRect())) {
            addItemSelection(it, true);
          }
        });
        rubber.remove();
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  canvas.addEventListener('dragover', e => e.preventDefault());
  canvas.addEventListener('drop', e => {
    e.preventDefault();
    const cr = canvas.getBoundingClientRect();
    const fx = (e.clientX - cr.left) / cr.width;
    const fy = (e.clientY - cr.top) / cr.height;
    const cell = cellFromPoint(fx, fy);
    const files = Array.from(e.dataTransfer.files || []);
    files.forEach((file, i) => {
      if (!file.type.startsWith('image/')) return;
      if (!bgDataUrl && i === 0) setBackground(file);
      else {
        const baseName = fileBaseName(file);
        readImage(file, src => addItem(src, baseName, cell));
      }
    });
  });

  // === Wheel / zoom / pan ===
  stage.addEventListener('wheel', e => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
    } else {
      e.preventDefault();
      panX -= e.deltaX;
      panY -= e.deltaY;
      applyPan();
    }
  }, { passive: false });

  // === Space + drag pan ===
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || spaceHeld) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
    spaceHeld = true;
    document.body.classList.add('space-held');
    e.preventDefault();
  });
  document.addEventListener('keyup', e => {
    if (e.code !== 'Space') return;
    spaceHeld = false;
    if (!isPanning) document.body.classList.remove('space-held');
  });
  stage.addEventListener('mousedown', e => {
    if (!spaceHeld) return;
    e.preventDefault(); e.stopPropagation();
    isPanning = true;
    document.body.classList.add('space-panning');
    const startX = e.clientX, startY = e.clientY;
    const startPX = panX, startPY = panY;
    const move = ev => {
      panX = startPX + (ev.clientX - startX);
      panY = startPY + (ev.clientY - startY);
      applyPan();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      isPanning = false;
      document.body.classList.remove('space-panning');
      if (!spaceHeld) document.body.classList.remove('space-held');
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }, true);

  // === Keyboard ===
  document.addEventListener('keydown', e => {
    const cmd = e.metaKey || e.ctrlKey;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;

    if (e.key === 'Escape') {
      if (addLineMode) { exitAddLineMode(); return; }
      clearItemSelection(false);
      clearLineSelection();
      rebuildLayerPanel();
      rebuildProperties();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedItems.size > 0 || selectedLine)) {
      e.preventDefault();
      if (selectedLine) removeLine(selectedLine.axis, selectedLine.index);
      else deleteSelected();
    } else if (cmd && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault(); undo();
    } else if (cmd && (e.key === 'c' || e.key === 'C')) {
      copyItems();
    } else if (cmd && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault(); pasteItems();
    } else if (cmd && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault(); copyItems(); pasteItems();
    } else if (cmd && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      clearItemSelection(false);
      clearLineSelection();
      items.forEach(it => addItemSelection(it, true));
    } else if (cmd && (e.key === '=' || e.key === '+')) {
      e.preventDefault(); setZoom(zoom * 1.25);
    } else if (cmd && e.key === '-') {
      e.preventDefault(); setZoom(zoom / 1.25);
    } else if (cmd && e.key === '0') {
      e.preventDefault(); setZoom(1);
    } else if (cmd && e.key === '1') {
      e.preventDefault(); fitZoom();
    } else if (cmd && e.shiftKey && e.key === ']') {
      e.preventDefault(); bringToFront();
    } else if (cmd && e.shiftKey && e.key === '[') {
      e.preventDefault(); sendToBack();
    } else if (e.key === ']' && !cmd) {
      bringForward();
    } else if (e.key === '[' && !cmd) {
      sendBackward();
    }
  });

  // === Export ===
  function exportHTML() {
    const cols = trackWidths(vLines).map(w => Math.max(0.0001, w).toFixed(4) + 'fr').join(' ') || '1fr';
    const rows = trackWidths(hLines).map(h => Math.max(0.0001, h).toFixed(4) + 'fr').join(' ') || '1fr';
    const itemHtml = items.slice().reverse().map(it => {
      const gc = it.col[0] + ' / ' + it.col[1];
      const gr = it.row[0] + ' / ' + it.row[1];
      return '  <div class="item" style="grid-column:' + gc + ';grid-row:' + gr + ';"><img src="' + it.src + '"></div>';
    }).join('\n');
    const bgLine = bgDataUrl ? '  <img class="bg" src="' + bgDataUrl + '">\n' : '';
    const lines = [
      '<!DOCTYPE html>', '<html lang="zh-TW">', '<head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>My Page</title>', '<style>',
      '  body { margin: 0; }',
      '  .canvas { position: relative; width: 100%; aspect-ratio: ' + bgRatio + '; display: grid;',
      '    grid-template-columns: ' + cols + ';',
      '    grid-template-rows: ' + rows + '; }',
      '  .canvas .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; }',
      '  .canvas .item { position: relative; z-index: 1; min-width: 0; min-height: 0; }',
      '  .canvas .item img { width: 100%; height: 100%; display: block; object-fit: contain; }',
      '<\/style>', '<\/head>', '<body>', '<div class="canvas">',
      bgLine + itemHtml,
      '<\/div>', '<\/body>', '<\/html>'
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'export.html';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  document.getElementById('exportBtn').addEventListener('click', exportHTML);

  // === Init ===
  applyZoom();
  applyGridTracks();
  updateHintVisibility();
  loadStateFromDB().then(saved => {
    if (saved && saved.schema === 'grid-v1' && (saved.bgDataUrl || (saved.items && saved.items.length))) {
      restoreSnapshot(saved);
      console.log('已恢復上次的編輯狀態');
    }
    pushHistory();
    console.log('Layout Studio (Grid mode) ready');
  });
})();
