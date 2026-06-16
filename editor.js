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

  const selectedSet = new Set();
  let selected = null;
  let bgDataUrl = null;
  let bgRatio = '16 / 9';
  let zoom = 1;
  let clipboard = null;
  let history = [];
  let historyIdx = -1;
  let isRestoring = false;
  let panX = 0, panY = 0;
  let spaceHeld = false;
  let isPanning = false;
  const BASE_WIDTH = 1280;
  function applyPan() {
    canvas.style.transform = (panX || panY) ? `translate(${panX}px, ${panY}px)` : '';
  }

  const nodeMap = new Map();
  const ROOT_ID = 'root';
  let nextId = 1;
  let imageCounter = 0;
  let groupCounter = 0;

  function initTree() {
    nodeMap.clear();
    nodeMap.set(ROOT_ID, {
      id: ROOT_ID, type: 'group', name: 'root', parentId: null,
      children: [], expanded: true, displayMode: 'free'
    });
  }
  initTree();

  function newId(p) { return p + '-' + (nextId++); }
  function getNode(id) { return nodeMap.get(id); }
  function isRealGroup(n) { return n && n.type === 'group' && n.displayMode !== 'free' && n.id !== ROOT_ID; }

  function flattenItems() {
    const out = [];
    function walk(id) {
      const n = getNode(id);
      if (!n) return;
      if (n.type === 'item') out.push(n);
      else n.children.forEach(walk);
    }
    getNode(ROOT_ID).children.forEach(walk);
    return out;
  }
  function getDescendantItems(id) {
    const out = [];
    function walk(nid) {
      const n = getNode(nid);
      if (!n) return;
      if (n.type === 'item') out.push(n);
      else n.children.forEach(walk);
    }
    walk(id);
    return out;
  }
  function getDescendantNodes(id) {
    const out = [];
    function walk(nid) {
      const n = getNode(nid);
      if (!n) return;
      out.push(n);
      if (n.type === 'group') n.children.forEach(walk);
    }
    walk(id);
    return out;
  }
  function isAncestor(ancId, descId) {
    let cur = getNode(descId);
    while (cur && cur.parentId) {
      if (cur.parentId === ancId) return true;
      cur = getNode(cur.parentId);
    }
    return false;
  }
  function ancestorRealGroup(id) {
    let cur = getNode(id);
    while (cur && cur.parentId) {
      const p = getNode(cur.parentId);
      if (!p) return null;
      if (isRealGroup(p)) return p;
      cur = p;
    }
    return null;
  }

  // === DOM helpers ===
  function createItemDom(src) {
    const item = document.createElement('div');
    item.className = 'item';
    const img = document.createElement('img');
    img.src = src;
    img.draggable = false;
    item.appendChild(img);
    ['nw', 'ne', 'sw', 'se'].forEach(dir => {
      const h = document.createElement('div');
      h.className = 'handle ' + dir;
      h.dataset.dir = dir;
      item.appendChild(h);
    });
    return item;
  }
  function createGroupDom(group) {
    const div = document.createElement('div');
    div.className = 'group-container';
    div.dataset.id = group.id;
    div.style.position = 'absolute';
    if (group.left) div.style.left = group.left;
    if (group.top) div.style.top = group.top;
    if (group.width) div.style.width = group.width;
    if (group.height) div.style.height = group.height;
    ['nw', 'ne', 'sw', 'se'].forEach(dir => {
      const h = document.createElement('div');
      h.className = 'handle ' + dir;
      h.dataset.dir = dir;
      div.appendChild(h);
    });
    return div;
  }
  function applyGroupStyles(group) {
    if (!group.dom) return;
    const d = group.dom;
    d.dataset.mode = group.displayMode || 'free';
    const gap = group.gap != null ? group.gap : 16;
    const pad = group.padding != null ? group.padding : 0;
    const jc = group.justifyContent || 'flex-start';
    const ai = group.alignItems || 'flex-start';
    if (group.displayMode === 'flex-row' || group.displayMode === 'flex-col') {
      d.style.display = 'flex';
      d.style.flexDirection = group.displayMode === 'flex-row' ? 'row' : 'column';
      d.style.gridTemplateColumns = '';
      d.style.gap = gap + 'px';
      d.style.padding = pad + 'px';
      d.style.justifyContent = jc;
      d.style.alignItems = ai;
    } else if (group.displayMode === 'grid') {
      d.style.display = 'grid';
      d.style.flexDirection = '';
      d.style.gridTemplateColumns = 'repeat(' + (group.columns || 2) + ', 1fr)';
      d.style.gap = gap + 'px';
      d.style.padding = pad + 'px';
      d.style.justifyContent = '';
      d.style.alignItems = '';
    }
    // refresh overlay after styles applied
    if (typeof updateFlexOverlay === 'function') updateFlexOverlay(group);
  }

  // === Flex overlay (斜紋條狀區域，只畫在 padding 與 gap) ===
  function updateFlexOverlay(group) {
    if (!group || !group.dom) return;
    // remove existing overlay
    Array.from(group.dom.children).forEach(c => {
      if (c.classList && c.classList.contains('flex-overlay')) c.remove();
    });
    if (!selectedSet.has(group.dom)) return;
    if (group.displayMode !== 'flex-row' && group.displayMode !== 'flex-col' && group.displayMode !== 'grid') return;

    const overlay = document.createElement('div');
    overlay.className = 'flex-overlay';

    const groupRect = group.dom.getBoundingClientRect();
    if (groupRect.width <= 0 || groupRect.height <= 0) return;
    const pad = group.padding != null ? group.padding : 0;
    const gap = group.gap != null ? group.gap : 0;
    const padX = (pad / groupRect.width) * 100;
    const padY = (pad / groupRect.height) * 100;
    const gapX = (gap / groupRect.width) * 100;
    const gapY = (gap / groupRect.height) * 100;

    function strip(left, top, width, height, kind) {
      const s = document.createElement('div');
      s.className = 'flex-overlay-strip';
      if (kind === 'padding') s.classList.add('flex-overlay-padding');
      s.style.left = left + '%';
      s.style.top = top + '%';
      s.style.width = width + '%';
      s.style.height = height + '%';
      if (kind !== 'padding') {
        // 外框線：碰到群組四邊的那一邊不畫；用較短的 dashed
        const eps = 0.05;
        const bd = '1px dashed #ff4f97';
        if (left > eps) s.style.borderLeft = bd;
        if (top > eps) s.style.borderTop = bd;
        if (left + width < 100 - eps) s.style.borderRight = bd;
        if (top + height < 100 - eps) s.style.borderBottom = bd;
      }
      overlay.appendChild(s);
    }

    // Padding 四邊（水藍色 0.4 填滿）
    if (pad > 0) {
      strip(0, 0, 100, padY, 'padding');                 // top
      strip(0, 100 - padY, 100, padY, 'padding');        // bottom
      strip(0, padY, padX, 100 - 2 * padY, 'padding');   // left (避免和上下重疊)
      strip(100 - padX, padY, padX, 100 - 2 * padY, 'padding'); // right
    }

    // 主軸方向「空白條」：把 padding 內凡是沒有圖片覆蓋的主軸區段都畫上斜紋
    // (這樣 justify-content / 中間 gap / 前後 free space 都會自動有條紋)
    // 斜紋的交叉軸長度貼齊群組邊界 (符合群組寬/高)。
    const items = Array.from(group.dom.children).filter(c =>
      c.classList && (c.classList.contains('item') || c.classList.contains('group-container'))
    );
    if (items.length > 0 && (group.displayMode === 'flex-row' || group.displayMode === 'flex-col')) {
      const isRow = group.displayMode === 'flex-row';
      // 計算主軸方向被圖片佔據的範圍 (排序後做掃描)
      const ranges = items.map(it => {
        const r = it.getBoundingClientRect();
        return isRow
          ? { a: r.left - groupRect.left, b: r.right - groupRect.left }
          : { a: r.top - groupRect.top, b: r.bottom - groupRect.top };
      }).sort((x, y) => x.a - y.a);
      const mainSize = isRow ? groupRect.width : groupRect.height;
      const contentA = pad;
      const contentB = mainSize - pad;

      let cursor = contentA;
      ranges.forEach(rg => {
        if (rg.a > cursor) {
          const a = (cursor / mainSize) * 100;
          const len = ((rg.a - cursor) / mainSize) * 100;
          if (isRow) strip(a, 0, len, 100);
          else strip(0, a, 100, len);
        }
        if (rg.b > cursor) cursor = rg.b;
      });
      if (cursor < contentB) {
        const a = (cursor / mainSize) * 100;
        const len = ((contentB - cursor) / mainSize) * 100;
        if (isRow) strip(a, 0, len, 100);
        else strip(0, a, 100, len);
      }
    } else if (group.displayMode === 'grid' && gap > 0) {
      const cols = group.columns || 2;
      const rowCount = Math.ceil(items.length / cols);
      const firstRowCount = Math.min(items.length, cols);
      for (let c = 0; c < firstRowCount - 1; c++) {
        const r = items[c].getBoundingClientRect();
        const leftPx = r.right - groupRect.left;
        strip((leftPx / groupRect.width) * 100, padY, gapX, Math.max(0, 100 - 2 * padY));
      }
      for (let row = 0; row < rowCount - 1; row++) {
        const rowItems = items.slice(row * cols, (row + 1) * cols);
        if (rowItems.length === 0) continue;
        let maxBottom = -Infinity;
        rowItems.forEach(it => {
          const r = it.getBoundingClientRect();
          if (r.bottom > maxBottom) maxBottom = r.bottom;
        });
        const topPx = maxBottom - groupRect.top;
        strip(padX, (topPx / groupRect.height) * 100, Math.max(0, 100 - 2 * padX), gapY);
      }
    }

    group.dom.appendChild(overlay);
  }

  function updateAllOverlays() {
    for (const [id, n] of nodeMap.entries()) {
      if (n.type === 'group' && n.dom && isRealGroup(n)) updateFlexOverlay(n);
    }
  }

  // === Reflow: rebuild DOM hierarchy from tree ===
  function reflowCanvas() {
    // Walk tree; for real groups append container then children inside it.
    // For free groups, items appended to canvas directly.
    // DOM order:
    //   Within canvas (root): bottom of layer panel = first DOM child (z-order)
    //     so iterate root.children REVERSED
    //   Within real group: first DOM child = first in flex/grid flow
    //     so iterate group.children in normal order
    function place(nodeId, parentDom, inFlex) {
      const n = getNode(nodeId);
      if (!n) return;
      if (n.type === 'item') {
        parentDom.appendChild(n.dom);
      } else {
        if (isRealGroup(n)) {
          parentDom.appendChild(n.dom);
          applyGroupStyles(n);
          // Inside real group: children appended in tree order (top = first flex item)
          n.children.forEach(cid => place(cid, n.dom, true));
        } else {
          // Free group: children placed in current parentDom, in same z convention
          const order = inFlex ? n.children : n.children.slice().reverse();
          order.forEach(cid => place(cid, parentDom, inFlex));
        }
      }
    }
    // Root children: top of panel = top z = last DOM => reverse
    const root = getNode(ROOT_ID);
    root.children.slice().reverse().forEach(cid => place(cid, canvas, false));
    // Keep bg first
    const bg = canvas.querySelector('.bg');
    if (bg) canvas.insertBefore(bg, canvas.firstChild);
    updateAllOverlays();
  }

  // === Helpers ===
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
  function rectsIntersect(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  // === Zoom ===
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
        hint.style.display = 'none';
        pushHistory();
      };
      tmp.src = src;
    });
  }

  // === Add / delete items ===
  function addItem(src, xPct, yPct, wPct, name, parentId) {
    parentId = parentId || ROOT_ID;
    const id = newId('item');
    const dom = createItemDom(src);
    dom.dataset.id = id;
    dom.style.left = xPct + '%';
    dom.style.top = yPct + '%';
    dom.style.width = wPct + '%';
    canvas.appendChild(dom);
    attachItemHandlers(dom);
    const finalName = (name && name.trim()) || ('Image ' + (++imageCounter));
    const node = { id, type: 'item', name: finalName, parentId, dom };
    nodeMap.set(id, node);
    getNode(parentId).children.unshift(id);
    reflowCanvas();
    rebuildLayerPanel();
    replaceSelection(dom);
    pushHistory();
    return dom;
  }

  function deleteSelected() {
    if (selectedSet.size === 0) return;
    selectedSet.forEach(dom => {
      const id = dom.dataset.id;
      const node = getNode(id);
      if (!node) return;
      // Remove descendants from nodeMap and DOM if group
      getDescendantNodes(id).forEach(d => {
        if (d.type === 'item' && d.dom) d.dom.remove();
        nodeMap.delete(d.id);
      });
      // Remove from parent
      const parent = getNode(node.parentId);
      if (parent) parent.children = parent.children.filter(c => c !== id);
      if (node.type === 'group' && node.dom) node.dom.remove();
      else if (node.type === 'item') dom.remove();
      nodeMap.delete(id);
    });
    selectedSet.clear();
    selected = null;
    cleanEmptyGroups();
    rebuildLayerPanel();
    rebuildProperties();
    pushHistory();
  }

  function cleanEmptyGroups() {
    let removed = true;
    while (removed) {
      removed = false;
      for (const [id, node] of Array.from(nodeMap.entries())) {
        if (id === ROOT_ID) continue;
        if (node.type === 'group' && node.children.length === 0) {
          if (node.dom) node.dom.remove();
          const parent = getNode(node.parentId);
          if (parent) parent.children = parent.children.filter(c => c !== id);
          nodeMap.delete(id);
          removed = true;
        }
      }
    }
  }

  // === Selection ===
  function updateLayerSelection() {
    layerList.querySelectorAll('.layer-row').forEach(row => {
      const nid = row.dataset.nodeId;
      if (!nid) return;
      const node = getNode(nid);
      if (!node) return;
      let sel = false;
      if (node.type === 'item') sel = selectedSet.has(node.dom);
      else if (isRealGroup(node) && node.dom) sel = selectedSet.has(node.dom);
      else sel = isGroupFullySelected(nid);
      row.classList.toggle('selected', sel);
    });
    updateAllOverlays();
  }
  function clearSelection() {
    selectedSet.forEach(s => { s.classList.remove('selected'); s.classList.remove('primary'); });
    selectedSet.clear();
    selected = null;
    updateLayerSelection();
    rebuildProperties();
  }
  function addToSelection(dom, makePrimary) {
    if (!selectedSet.has(dom)) {
      selectedSet.add(dom);
      dom.classList.add('selected');
    }
    if (makePrimary || !selected) setPrimary(dom);
    updateLayerSelection();
    rebuildProperties();
  }
  function removeFromSelection(dom) {
    if (!selectedSet.has(dom)) return;
    selectedSet.delete(dom);
    dom.classList.remove('selected');
    dom.classList.remove('primary');
    if (dom === selected) {
      const next = selectedSet.values().next().value;
      selected = null;
      if (next) setPrimary(next);
    }
    updateLayerSelection();
    rebuildProperties();
  }
  function replaceSelection(dom) {
    selectedSet.forEach(s => { s.classList.remove('selected'); s.classList.remove('primary'); });
    selectedSet.clear();
    selectedSet.add(dom);
    dom.classList.add('selected');
    selected = dom;
    dom.classList.add('primary');
    updateLayerSelection();
    rebuildProperties();
  }
  function setPrimary(dom) {
    if (selected) selected.classList.remove('primary');
    selected = dom;
    if (dom) dom.classList.add('primary');
  }
  function toggleSelection(dom) {
    if (selectedSet.has(dom)) removeFromSelection(dom);
    else addToSelection(dom, true);
  }
  function selectGroupDescendants(groupId, mode) {
    const descendants = getDescendantItems(groupId);
    if (descendants.length === 0) return;
    if (mode === 'replace') {
      selectedSet.forEach(s => { s.classList.remove('selected'); s.classList.remove('primary'); });
      selectedSet.clear();
      selected = null;
    }
    descendants.forEach(n => {
      selectedSet.add(n.dom);
      n.dom.classList.add('selected');
    });
    if (descendants.length > 0) setPrimary(descendants[0].dom);
    updateLayerSelection();
    rebuildProperties();
  }
  function selectRealGroup(groupId, mode) {
    const g = getNode(groupId);
    if (!g || !g.dom) return;
    if (mode === 'replace') replaceSelection(g.dom);
    else toggleSelection(g.dom);
  }

  // === Group mode toggle ===
  function setGroupMode(group, newMode) {
    if (!group || group.id === ROOT_ID) return;
    if (group.displayMode === newMode) return;
    const wasReal = isRealGroup(group);
    const willReal = newMode !== 'free';

    if (group.gap == null) group.gap = 16;
    if (group.columns == null) group.columns = 2;
    if (group.padding == null) group.padding = 0;

    if (!wasReal && willReal) {
      // Free → real: size container to fit items + gaps, keep item visual sizes via px width
      const items = getDescendantItems(group.id);
      const cr = canvas.getBoundingClientRect();
      const gap = group.gap;
      const pad = group.padding;
      if (items.length > 0) {
        const rects = items.map(n => n.dom.getBoundingClientRect());
        const minX = Math.min.apply(null, rects.map(r => r.left));
        const minY = Math.min.apply(null, rects.map(r => r.top));
        let groupPxW, groupPxH;
        if (newMode === 'flex-row') {
          groupPxW = rects.reduce((s, r) => s + r.width, 0) + gap * (rects.length - 1) + pad * 2;
          groupPxH = Math.max.apply(null, rects.map(r => r.height)) + pad * 2;
        } else if (newMode === 'flex-col') {
          groupPxW = Math.max.apply(null, rects.map(r => r.width)) + pad * 2;
          groupPxH = rects.reduce((s, r) => s + r.height, 0) + gap * (rects.length - 1) + pad * 2;
        } else { // grid
          const cols = group.columns;
          const colW = Math.max.apply(null, rects.map(r => r.width));
          const rowH = Math.max.apply(null, rects.map(r => r.height));
          const rows = Math.ceil(rects.length / cols);
          groupPxW = colW * cols + gap * (cols - 1) + pad * 2;
          groupPxH = rowH * rows + gap * (rows - 1) + pad * 2;
        }
        group.left = ((minX - pad - cr.left) / cr.width * 100) + '%';
        group.top = ((minY - pad - cr.top) / cr.height * 100) + '%';
        group.width = (groupPxW / cr.width * 100) + '%';
        group.height = (groupPxH / cr.height * 100) + '%';

        const contentW = groupPxW - 2 * pad;
        items.forEach((n, i) => {
          n.dom.style.position = 'relative';
          n.dom.style.left = '';
          n.dom.style.top = '';
          if (newMode === 'grid') {
            n.dom.style.width = '';
          } else {
            n.dom.style.width = (rects[i].width / contentW * 100) + '%';
          }
          n.dom.style.flexShrink = '0';
        });
      } else {
        group.left = '20%'; group.top = '20%'; group.width = '40%'; group.height = '30%';
      }
      group.dom = createGroupDom(group);
      attachGroupHandlers(group.dom);
      group.displayMode = newMode;
    } else if (wasReal && !willReal) {
      // Real → free: capture rendered positions/sizes, restore as absolute %
      const items = getDescendantItems(group.id);
      const cr = canvas.getBoundingClientRect();
      items.forEach(n => {
        const r = n.dom.getBoundingClientRect();
        n.dom.style.position = '';
        n.dom.style.left = ((r.left - cr.left) / cr.width * 100) + '%';
        n.dom.style.top = ((r.top - cr.top) / cr.height * 100) + '%';
        n.dom.style.width = (r.width / cr.width * 100) + '%';
        n.dom.style.flexShrink = '';
      });
      if (group.dom) { group.dom.remove(); delete group.dom; }
      group.displayMode = 'free';
    } else if (wasReal && willReal) {
      // Between real modes: adjust item widths if going to/from grid
      const items = getDescendantItems(group.id);
      if (newMode === 'grid') {
        items.forEach(n => { n.dom.style.width = ''; });
      } else {
        // going to flex: convert any non-% widths to % of group content area
        const groupRect = group.dom.getBoundingClientRect();
        const contentW = groupRect.width - 2 * (group.padding || 0);
        items.forEach(n => {
          const w = n.dom.style.width;
          if (!w || w === '' || w.endsWith('px')) {
            n.dom.style.width = (n.dom.getBoundingClientRect().width / contentW * 100) + '%';
          }
        });
      }
      group.displayMode = newMode;
      applyGroupStyles(group);
    }
    reflowCanvas();
    rebuildLayerPanel();
    rebuildProperties();
    pushHistory();
  }

  // === Item handlers ===
  function attachItemHandlers(item) {
    item.addEventListener('mousedown', e => {
      if (e.target.classList.contains('handle')) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey) {
        if (selectedSet.has(item)) { removeFromSelection(item); return; }
        addToSelection(item, true);
      } else {
        if (!selectedSet.has(item)) replaceSelection(item);
        else setPrimary(item);
      }

      // If item is inside a real group anywhere up the chain, no free-drag
      const node = getNode(item.dataset.id);
      if (node && ancestorRealGroup(node.id)) return;

      const canvasRect = canvas.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const dragInfos = Array.from(selectedSet)
        .filter(it => it.classList.contains('item') && !ancestorRealGroup(it.dataset.id))
        .map(it => ({
          item: it,
          startLeft: parseFloat(it.style.left),
          startTop: parseFloat(it.style.top)
        }));
      // include selected group containers in drag too
      const groupInfos = Array.from(selectedSet)
        .filter(it => it.classList.contains('group-container'))
        .map(it => ({
          item: it,
          startLeft: parseFloat(it.style.left),
          startTop: parseFloat(it.style.top)
        }));
      const primaryInfo = dragInfos.find(d => d.item === selected) || groupInfos.find(d => d.item === selected);
      if (!primaryInfo) return;
      const primaryRect = selected.getBoundingClientRect();
      const wPct = (primaryRect.width / canvasRect.width) * 100;
      const hPct = (primaryRect.height / canvasRect.height) * 100;

      let moved = false;
      const move = ev => {
        const dx = ((ev.clientX - startX) / canvasRect.width) * 100;
        const dy = ((ev.clientY - startY) / canvasRect.height) * 100;
        if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) moved = true;
        const desiredL = primaryInfo.startLeft + dx;
        const desiredT = primaryInfo.startTop + dy;
        const snap = computeSnap(selectedSet, desiredL, desiredT, wPct, hPct);
        const fdx = snap.left - primaryInfo.startLeft;
        const fdy = snap.top - primaryInfo.startTop;
        dragInfos.concat(groupInfos).forEach(d => {
          d.item.style.left = (d.startLeft + fdx) + '%';
          d.item.style.top = (d.startTop + fdy) + '%';
        });
        drawGuides(snap.guides);
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        clearGuides();
        if (moved) {
          // sync group node positions
          groupInfos.forEach(d => {
            const n = getNode(d.item.dataset.id);
            if (n) { n.left = d.item.style.left; n.top = d.item.style.top; }
          });
          pushHistory();
        }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    item.querySelectorAll('.handle').forEach(handle => {
      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        replaceSelection(item);
        const dir = handle.dataset.dir;
        const canvasRect = canvas.getBoundingClientRect();
        const ir = item.getBoundingClientRect();
        const sW = ir.width, sH = ir.height;
        const sL = ir.left, sT = ir.top, sR = ir.right, sB = ir.bottom;
        const ratio = sH / sW;
        const inReal = ancestorRealGroup(item.dataset.id);
        let changed = false;
        const move = ev => {
          changed = true;
          let nl = sL, nt = sT, nw = sW;
          const mx = ev.clientX, my = ev.clientY;
          if (dir === 'se') nw = Math.max(20, Math.max(mx - sL, (my - sT) / ratio));
          else if (dir === 'ne') { nw = Math.max(20, Math.max(mx - sL, (sB - my) / ratio)); nt = sB - nw * ratio; }
          else if (dir === 'sw') { nw = Math.max(20, Math.max(sR - mx, (my - sT) / ratio)); nl = sR - nw; }
          else if (dir === 'nw') { nw = Math.max(20, Math.max(sR - mx, (sB - my) / ratio)); nl = sR - nw; nt = sB - nw * ratio; }
          if (inReal) {
            // Items in real groups: convert to % of parent content area so resize is proportional
            const parentDom = item.parentElement;
            const parentNode = getNode(parentDom.dataset.id);
            const padPx = (parentNode && parentNode.padding ? parentNode.padding : 0);
            const pr = parentDom.getBoundingClientRect();
            const contentW = Math.max(1, pr.width - padPx * 2);
            if (parentNode && parentNode.displayMode === 'grid') {
              item.style.width = nw + 'px';
            } else {
              item.style.width = (nw / contentW * 100) + '%';
            }
            if (parentNode) updateFlexOverlay(parentNode);
          } else {
            item.style.left = ((nl - canvasRect.left) / canvasRect.width * 100) + '%';
            item.style.top = ((nt - canvasRect.top) / canvasRect.height * 100) + '%';
            item.style.width = (nw / canvasRect.width * 100) + '%';
          }
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          if (changed) pushHistory();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
  }

  // === Group container handlers ===
  function attachGroupHandlers(groupDom) {
    groupDom.addEventListener('mousedown', e => {
      if (e.target !== groupDom) return; // ignore clicks on children/handles
      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey) {
        if (selectedSet.has(groupDom)) { removeFromSelection(groupDom); return; }
        addToSelection(groupDom, true);
      } else {
        if (!selectedSet.has(groupDom)) replaceSelection(groupDom);
        else setPrimary(groupDom);
      }

      const canvasRect = canvas.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const dragInfos = Array.from(selectedSet).map(it => ({
        item: it,
        startLeft: parseFloat(it.style.left) || 0,
        startTop: parseFloat(it.style.top) || 0
      }));
      const primaryInfo = dragInfos.find(d => d.item === selected);
      if (!primaryInfo) return;
      const primaryRect = selected.getBoundingClientRect();
      const wPct = (primaryRect.width / canvasRect.width) * 100;
      const hPct = (primaryRect.height / canvasRect.height) * 100;
      let moved = false;
      const move = ev => {
        const dx = ((ev.clientX - startX) / canvasRect.width) * 100;
        const dy = ((ev.clientY - startY) / canvasRect.height) * 100;
        if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) moved = true;
        const desiredL = primaryInfo.startLeft + dx;
        const desiredT = primaryInfo.startTop + dy;
        const snap = computeSnap(selectedSet, desiredL, desiredT, wPct, hPct);
        const fdx = snap.left - primaryInfo.startLeft;
        const fdy = snap.top - primaryInfo.startTop;
        dragInfos.forEach(d => {
          d.item.style.left = (d.startLeft + fdx) + '%';
          d.item.style.top = (d.startTop + fdy) + '%';
        });
        drawGuides(snap.guides);
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        clearGuides();
        if (moved) {
          dragInfos.forEach(d => {
            const n = getNode(d.item.dataset.id);
            if (n) { n.left = d.item.style.left; n.top = d.item.style.top; }
          });
          pushHistory();
        }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    groupDom.querySelectorAll('.handle').forEach(handle => {
      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        replaceSelection(groupDom);
        const dir = handle.dataset.dir;
        const canvasRect = canvas.getBoundingClientRect();
        const gr = groupDom.getBoundingClientRect();
        const sL = gr.left, sT = gr.top, sR = gr.right, sB = gr.bottom;
        let changed = false;
        const move = ev => {
          changed = true;
          let nl = sL, nt = sT, nr = sR, nb = sB;
          const mx = ev.clientX, my = ev.clientY;
          if (dir === 'se') { nr = Math.max(sL + 20, mx); nb = Math.max(sT + 20, my); }
          else if (dir === 'ne') { nr = Math.max(sL + 20, mx); nt = Math.min(sB - 20, my); }
          else if (dir === 'sw') { nl = Math.min(sR - 20, mx); nb = Math.max(sT + 20, my); }
          else if (dir === 'nw') { nl = Math.min(sR - 20, mx); nt = Math.min(sB - 20, my); }
          groupDom.style.left = ((nl - canvasRect.left) / canvasRect.width * 100) + '%';
          groupDom.style.top = ((nt - canvasRect.top) / canvasRect.height * 100) + '%';
          groupDom.style.width = ((nr - nl) / canvasRect.width * 100) + '%';
          groupDom.style.height = ((nb - nt) / canvasRect.height * 100) + '%';
          const n = getNode(groupDom.dataset.id);
          if (n) updateFlexOverlay(n);
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          if (changed) {
            const n = getNode(groupDom.dataset.id);
            if (n) {
              n.left = groupDom.style.left; n.top = groupDom.style.top;
              n.width = groupDom.style.width; n.height = groupDom.style.height;
            }
            pushHistory();
          }
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
  }

  // === Snap ===
  function computeSnap(draggedSet, newLeft, newTop, w, h) {
    const threshold = 0.7;
    const guides = [];
    const xT = [0, 50, 100], yT = [0, 50, 100];
    const cR = canvas.getBoundingClientRect();
    canvas.querySelectorAll('.item, .group-container').forEach(o => {
      if (draggedSet.has(o)) return;
      // Use bounding rect for compatibility
      const oR = o.getBoundingClientRect();
      const oL = (oR.left - cR.left) / cR.width * 100;
      const oT = (oR.top - cR.top) / cR.height * 100;
      const oW = oR.width / cR.width * 100;
      const oH = oR.height / cR.height * 100;
      xT.push(oL, oL + oW / 2, oL + oW);
      yT.push(oT, oT + oH / 2, oT + oH);
    });
    let bX = null;
    [{ v: newLeft, o: 0 }, { v: newLeft + w / 2, o: -w / 2 }, { v: newLeft + w, o: -w }].forEach(p => {
      xT.forEach(c => {
        const d = Math.abs(p.v - c);
        if (d < threshold && (!bX || d < bX.d)) bX = { d, t: c, o: p.o };
      });
    });
    if (bX) { newLeft = bX.t + bX.o; guides.push({ axis: 'x', pct: bX.t }); }
    let bY = null;
    [{ v: newTop, o: 0 }, { v: newTop + h / 2, o: -h / 2 }, { v: newTop + h, o: -h }].forEach(p => {
      yT.forEach(c => {
        const d = Math.abs(p.v - c);
        if (d < threshold && (!bY || d < bY.d)) bY = { d, t: c, o: p.o };
      });
    });
    if (bY) { newTop = bY.t + bY.o; guides.push({ axis: 'y', pct: bY.t }); }
    return { left: newLeft, top: newTop, guides };
  }
  function drawGuides(guides) {
    clearGuides();
    guides.forEach(g => {
      const el = document.createElement('div');
      el.className = 'guide guide-' + g.axis;
      if (g.axis === 'x') el.style.left = g.pct + '%';
      else el.style.top = g.pct + '%';
      canvas.appendChild(el);
    });
  }
  function clearGuides() { canvas.querySelectorAll('.guide').forEach(g => g.remove()); }

  // === Layer order ===
  function moveInParent(nodeId, dir) {
    const node = getNode(nodeId);
    if (!node) return false;
    const parent = getNode(node.parentId);
    const idx = parent.children.indexOf(nodeId);
    if (dir === 'forward' && idx > 0) {
      [parent.children[idx - 1], parent.children[idx]] = [parent.children[idx], parent.children[idx - 1]];
      return true;
    }
    if (dir === 'backward' && idx < parent.children.length - 1) {
      [parent.children[idx + 1], parent.children[idx]] = [parent.children[idx], parent.children[idx + 1]];
      return true;
    }
    if (dir === 'front' && idx > 0) {
      parent.children.splice(idx, 1); parent.children.unshift(nodeId); return true;
    }
    if (dir === 'back' && idx < parent.children.length - 1) {
      parent.children.splice(idx, 1); parent.children.push(nodeId); return true;
    }
    return false;
  }
  function bringForward() {
    if (!selected) return;
    if (moveInParent(selected.dataset.id, 'forward')) { reflowCanvas(); rebuildLayerPanel(); pushHistory(); }
  }
  function sendBackward() {
    if (!selected) return;
    if (moveInParent(selected.dataset.id, 'backward')) { reflowCanvas(); rebuildLayerPanel(); pushHistory(); }
  }
  function bringToFront() {
    if (!selected) return;
    if (moveInParent(selected.dataset.id, 'front')) { reflowCanvas(); rebuildLayerPanel(); pushHistory(); }
  }
  function sendToBack() {
    if (!selected) return;
    if (moveInParent(selected.dataset.id, 'back')) { reflowCanvas(); rebuildLayerPanel(); pushHistory(); }
  }

  // === Group / ungroup ===
  function groupSelected() {
    if (selectedSet.size < 1) return;
    const members = Array.from(selectedSet).filter(d => d.classList.contains('item'));
    if (members.length === 0) return;
    const flat = flattenItems();
    const ordered = members.slice().sort((a, b) => {
      const ai = flat.findIndex(n => n.dom === a);
      const bi = flat.findIndex(n => n.dom === b);
      return ai - bi;
    });
    const firstNode = getNode(ordered[0].dataset.id);
    const targetParent = getNode(firstNode.parentId);
    const insertIdx = targetParent.children.indexOf(firstNode.id);
    const gid = newId('group');
    const group = {
      id: gid, type: 'group', name: 'Group ' + (++groupCounter),
      parentId: targetParent.id, children: [], expanded: true,
      displayMode: 'free'
    };
    nodeMap.set(gid, group);
    members.forEach(dom => {
      const inode = getNode(dom.dataset.id);
      const op = getNode(inode.parentId);
      op.children = op.children.filter(c => c !== inode.id);
      inode.parentId = gid;
    });
    group.children = ordered.map(dom => dom.dataset.id);
    targetParent.children.splice(insertIdx, 0, gid);
    cleanEmptyGroups();
    reflowCanvas();
    rebuildLayerPanel();
    pushHistory();
  }
  function ungroupSelected() {
    if (selectedSet.size === 0) return;
    const toDissolve = new Set();
    selectedSet.forEach(dom => {
      const n = getNode(dom.dataset.id);
      if (!n) return;
      if (n.type === 'group' && n.id !== ROOT_ID) toDissolve.add(n.id);
      else if (n.type === 'item' && n.parentId && n.parentId !== ROOT_ID) toDissolve.add(n.parentId);
    });
    if (toDissolve.size === 0) return;
    toDissolve.forEach(gid => {
      const g = getNode(gid);
      if (!g || g.type !== 'group') return;
      // If real, first revert to free (restores positions)
      if (isRealGroup(g)) setGroupMode(g, 'free');
      const gp = getNode(g.parentId);
      const gpIdx = gp.children.indexOf(gid);
      g.children.forEach(cid => { const cn = getNode(cid); if (cn) cn.parentId = gp.id; });
      gp.children.splice(gpIdx, 1, ...g.children);
      nodeMap.delete(gid);
    });
    reflowCanvas();
    rebuildLayerPanel();
    rebuildProperties();
    pushHistory();
  }

  // === Layer panel ===
  function rebuildLayerPanel() {
    layerList.innerHTML = '';
    const root = getNode(ROOT_ID);
    if (root.children.length === 0) {
      const e = document.createElement('div');
      e.className = 'layer-empty'; e.textContent = '尚無圖片';
      layerList.appendChild(e);
      return;
    }
    root.children.forEach(id => renderLayerNode(id, 0));
  }
  function isGroupFullySelected(groupId) {
    const desc = getDescendantItems(groupId);
    if (desc.length === 0) return false;
    return desc.every(n => selectedSet.has(n.dom));
  }
  function groupIconFor(node) {
    if (node.displayMode === 'flex-row') return '⇢';
    if (node.displayMode === 'flex-col') return '⇣';
    if (node.displayMode === 'grid') return '⊞';
    return node.expanded ? '📂' : '📁';
  }
  function makeNameEditable(span, node, row) {
    span.addEventListener('dblclick', e => {
      e.stopPropagation();
      e.preventDefault();
      if (row) row.draggable = false;
      const oldName = node.name;
      const input = document.createElement('input');
      input.value = oldName;
      input.className = 'layer-name-input';
      input.addEventListener('mousedown', ev => ev.stopPropagation());
      input.addEventListener('click', ev => ev.stopPropagation());
      span.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const commit = (cancel) => {
        if (done) return;
        done = true;
        if (row) row.draggable = true;
        if (!cancel) {
          const newName = input.value.trim();
          if (newName && newName !== oldName) {
            node.name = newName;
            pushHistory();
          }
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
  function renderLayerNode(id, depth) {
    const node = getNode(id);
    if (!node) return;
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.dataset.nodeId = id;
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    row.draggable = true;

    if (node.type === 'group') {
      const arrow = document.createElement('span');
      arrow.className = 'layer-arrow';
      arrow.textContent = node.expanded ? '▾' : '▸';
      arrow.addEventListener('click', e => {
        e.stopPropagation();
        node.expanded = !node.expanded;
        rebuildLayerPanel();
      });
      row.appendChild(arrow);

      const icon = document.createElement('span');
      icon.className = 'layer-icon';
      icon.textContent = groupIconFor(node);
      row.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = node.name + ' (' + getDescendantItems(id).length + ')';
      row.appendChild(name);
      makeNameEditable(name, node, row);

      const real = isRealGroup(node);
      if (real && node.dom && selectedSet.has(node.dom)) row.classList.add('selected');
      else if (!real && isGroupFullySelected(id)) row.classList.add('selected');

      row.addEventListener('click', e => {
        e.stopPropagation();
        if (isRealGroup(node)) {
          selectRealGroup(id, e.shiftKey ? 'toggle' : 'replace');
        } else {
          selectGroupDescendants(id, e.shiftKey ? 'add' : 'replace');
        }
      });
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'layer-arrow';
      row.appendChild(spacer);
      const thumb = document.createElement('img');
      thumb.className = 'layer-thumb';
      thumb.src = node.dom.querySelector('img').src;
      row.appendChild(thumb);
      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = node.name;
      row.appendChild(name);
      makeNameEditable(name, node, row);
      if (selectedSet.has(node.dom)) row.classList.add('selected');
      row.addEventListener('click', e => {
        e.stopPropagation();
        if (e.shiftKey) toggleSelection(node.dom);
        else replaceSelection(node.dom);
      });
    }

    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      layerList.querySelectorAll('.drop-above,.drop-below,.drop-into').forEach(r => {
        r.classList.remove('drop-above', 'drop-below', 'drop-into');
      });
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      layerList.querySelectorAll('.drop-above,.drop-below,.drop-into').forEach(r => {
        r.classList.remove('drop-above', 'drop-below', 'drop-into');
      });
      if (node.type === 'group') {
        if (offset < rect.height * 0.3) row.classList.add('drop-above');
        else if (offset > rect.height * 0.7) row.classList.add('drop-below');
        else row.classList.add('drop-into');
      } else {
        if (offset < rect.height / 2) row.classList.add('drop-above');
        else row.classList.add('drop-below');
      }
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      const fromId = e.dataTransfer.getData('text/plain');
      if (!fromId || fromId === id || isAncestor(fromId, id)) return;
      const src = getNode(fromId);
      if (!src) return;
      const isAbove = row.classList.contains('drop-above');
      const isInto = row.classList.contains('drop-into');
      const op = getNode(src.parentId);
      op.children = op.children.filter(c => c !== fromId);
      if (isInto && node.type === 'group') {
        src.parentId = id;
        node.children.unshift(fromId);
      } else {
        const tp = getNode(node.parentId);
        const tIdx = tp.children.indexOf(id);
        src.parentId = tp.id;
        if (isAbove) tp.children.splice(tIdx, 0, fromId);
        else tp.children.splice(tIdx + 1, 0, fromId);
      }
      cleanEmptyGroups();
      reflowCanvas();
      rebuildLayerPanel();
      pushHistory();
    });

    layerList.appendChild(row);
    if (node.type === 'group' && node.expanded) {
      node.children.forEach(cid => renderLayerNode(cid, depth + 1));
    }
  }

  // === Properties panel ===
  function getSelectedSingleGroup() {
    if (selectedSet.size !== 1) {
      // also handle "all items in one free group selected"
      if (selectedSet.size > 0) {
        const first = selectedSet.values().next().value;
        const n = getNode(first.dataset.id);
        if (n && n.type === 'item' && n.parentId && n.parentId !== ROOT_ID) {
          const parent = getNode(n.parentId);
          if (parent && parent.id !== ROOT_ID) {
            const allDesc = getDescendantItems(parent.id);
            if (allDesc.length === selectedSet.size && allDesc.every(d => selectedSet.has(d.dom))) {
              return parent;
            }
          }
        }
      }
      return null;
    }
    const dom = selectedSet.values().next().value;
    const n = getNode(dom.dataset.id);
    if (n && n.type === 'group') return n;
    return null;
  }

  function getSelectedSingleItem() {
    if (selectedSet.size !== 1) return null;
    const dom = selectedSet.values().next().value;
    if (!dom.classList.contains('item')) return null;
    return getNode(dom.dataset.id);
  }

  function rebuildProperties() {
    const group = getSelectedSingleGroup();
    const item = !group && getSelectedSingleItem();
    if (!group && !item) {
      propertiesPanel.style.display = 'none';
      return;
    }
    propertiesPanel.style.display = 'block';
    propertiesBody.innerHTML = '';

    if (item) {
      const propTitle = propertiesPanel.querySelector('.properties-header');
      if (propTitle) propTitle.textContent = '圖片屬性';
      const parent = getNode(item.parentId);
      const inReal = parent && isRealGroup(parent);
      const inGrid = parent && parent.displayMode === 'grid';

      const wRow = document.createElement('div');
      wRow.className = 'prop-row';
      const wLabel = document.createElement('div');
      wLabel.className = 'prop-label';
      wLabel.textContent = inReal
        ? (inGrid ? '寬度 (cell %)' : '寬度 (% of 群組)')
        : '寬度 (% of 畫布)';
      wRow.appendChild(wLabel);
      const wWrap = document.createElement('div');
      wWrap.className = 'prop-inline';
      const wInput = document.createElement('input');
      wInput.type = 'number';
      wInput.className = 'prop-input';
      wInput.step = '0.1';
      wInput.min = '1';
      const styleW = item.dom.style.width || '';
      const isPxW = styleW.endsWith('px');
      const numW = parseFloat(styleW) || 20;
      wInput.value = numW.toFixed(2).replace(/\.?0+$/, '');
      wInput.addEventListener('input', () => {
        const v = Math.max(1, parseFloat(wInput.value) || 0);
        item.dom.style.width = isPxW ? (v + 'px') : (v + '%');
        const parent = getNode(item.parentId);
        if (parent && isRealGroup(parent)) updateFlexOverlay(parent);
      });
      wInput.addEventListener('change', () => pushHistory());
      wWrap.appendChild(wInput);
      const wSuf = document.createElement('span');
      wSuf.className = 'prop-suffix';
      wSuf.textContent = isPxW ? 'px' : '%';
      wWrap.appendChild(wSuf);
      wRow.appendChild(wWrap);
      propertiesBody.appendChild(wRow);
      return;
    }

    const propTitle = propertiesPanel.querySelector('.properties-header');
    if (propTitle) propTitle.textContent = '群組屬性';

    // Mode selector
    const modeRow = document.createElement('div');
    modeRow.className = 'prop-row';
    const modeLabel = document.createElement('div');
    modeLabel.className = 'prop-label';
    modeLabel.textContent = '顯示模式';
    modeRow.appendChild(modeLabel);
    const modes = document.createElement('div');
    modes.className = 'prop-modes';
    const modeOpts = [
      { v: 'free', l: 'Free' },
      { v: 'flex-row', l: 'Flex →' },
      { v: 'flex-col', l: 'Flex ↓' },
      { v: 'grid', l: 'Grid ⊞' }
    ];
    modeOpts.forEach(opt => {
      const b = document.createElement('button');
      b.className = 'prop-mode-btn';
      if ((group.displayMode || 'free') === opt.v) b.classList.add('active');
      b.textContent = opt.l;
      b.addEventListener('click', () => setGroupMode(group, opt.v));
      modes.appendChild(b);
    });
    modeRow.appendChild(modes);
    propertiesBody.appendChild(modeRow);

    if (isRealGroup(group)) {
      // Gap
      const gapRow = document.createElement('div');
      gapRow.className = 'prop-row';
      const gapLabel = document.createElement('div');
      gapLabel.className = 'prop-label';
      gapLabel.textContent = '間距 gap';
      gapRow.appendChild(gapLabel);
      const gapWrap = document.createElement('div');
      gapWrap.className = 'prop-inline';
      const gapInput = document.createElement('input');
      gapInput.type = 'number';
      gapInput.className = 'prop-input';
      gapInput.value = group.gap != null ? group.gap : 16;
      gapInput.min = 0;
      gapInput.addEventListener('input', () => {
        group.gap = Math.max(0, parseFloat(gapInput.value) || 0);
        applyGroupStyles(group);
      });
      gapInput.addEventListener('change', () => pushHistory());
      gapWrap.appendChild(gapInput);
      const suf = document.createElement('span');
      suf.className = 'prop-suffix'; suf.textContent = 'px';
      gapWrap.appendChild(suf);
      gapRow.appendChild(gapWrap);
      propertiesBody.appendChild(gapRow);

      // Padding
      const padRow = document.createElement('div');
      padRow.className = 'prop-row';
      const padLabel = document.createElement('div');
      padLabel.className = 'prop-label';
      padLabel.textContent = '內距 padding';
      padRow.appendChild(padLabel);
      const padWrap = document.createElement('div');
      padWrap.className = 'prop-inline';
      const padInput = document.createElement('input');
      padInput.type = 'number';
      padInput.className = 'prop-input';
      padInput.value = group.padding != null ? group.padding : 0;
      padInput.min = 0;
      padInput.addEventListener('input', () => {
        group.padding = Math.max(0, parseFloat(padInput.value) || 0);
        applyGroupStyles(group);
      });
      padInput.addEventListener('change', () => pushHistory());
      padWrap.appendChild(padInput);
      const psuf = document.createElement('span');
      psuf.className = 'prop-suffix'; psuf.textContent = 'px';
      padWrap.appendChild(psuf);
      padRow.appendChild(padWrap);
      propertiesBody.appendChild(padRow);

      if (group.displayMode === 'flex-row' || group.displayMode === 'flex-col') {
        // justify-content
        const jcRow = document.createElement('div');
        jcRow.className = 'prop-row';
        const jcLabel = document.createElement('div');
        jcLabel.className = 'prop-label';
        jcLabel.textContent = '主軸 justify-content';
        jcRow.appendChild(jcLabel);
        const jcSel = document.createElement('select');
        jcSel.className = 'prop-input';
        ['flex-start','center','flex-end','space-between','space-around','space-evenly'].forEach(v => {
          const opt = document.createElement('option');
          opt.value = v; opt.textContent = v;
          jcSel.appendChild(opt);
        });
        jcSel.value = group.justifyContent || 'flex-start';
        jcSel.addEventListener('change', () => {
          group.justifyContent = jcSel.value;
          applyGroupStyles(group);
          pushHistory();
        });
        jcRow.appendChild(jcSel);
        propertiesBody.appendChild(jcRow);

        // align-items
        const aiRow = document.createElement('div');
        aiRow.className = 'prop-row';
        const aiLabel = document.createElement('div');
        aiLabel.className = 'prop-label';
        aiLabel.textContent = '交叉軸 align-items';
        aiRow.appendChild(aiLabel);
        const aiSel = document.createElement('select');
        aiSel.className = 'prop-input';
        ['flex-start','center','flex-end','stretch','baseline'].forEach(v => {
          const opt = document.createElement('option');
          opt.value = v; opt.textContent = v;
          aiSel.appendChild(opt);
        });
        aiSel.value = group.alignItems || 'flex-start';
        aiSel.addEventListener('change', () => {
          group.alignItems = aiSel.value;
          applyGroupStyles(group);
          pushHistory();
        });
        aiRow.appendChild(aiSel);
        propertiesBody.appendChild(aiRow);
      }

      if (group.displayMode === 'grid') {
        const colRow = document.createElement('div');
        colRow.className = 'prop-row';
        const colLabel = document.createElement('div');
        colLabel.className = 'prop-label';
        colLabel.textContent = '欄數 columns';
        colRow.appendChild(colLabel);
        const colInput = document.createElement('input');
        colInput.type = 'number';
        colInput.className = 'prop-input';
        colInput.value = group.columns || 2;
        colInput.min = 1;
        colInput.addEventListener('input', () => {
          group.columns = Math.max(1, parseInt(colInput.value, 10) || 1);
          applyGroupStyles(group);
        });
        colInput.addEventListener('change', () => pushHistory());
        colRow.appendChild(colInput);
        propertiesBody.appendChild(colRow);
      }
    }
  }

  // === Clipboard ===
  function copyItems() {
    if (selectedSet.size === 0) return;
    clipboard = Array.from(selectedSet)
      .filter(d => d.classList.contains('item'))
      .map(item => {
        const n = getNode(item.dataset.id);
        return {
          src: item.querySelector('img').src,
          left: parseFloat(item.style.left) || 0,
          top: parseFloat(item.style.top) || 0,
          width: parseFloat(item.style.width) || 20,
          name: n ? n.name : null
        };
      });
  }
  function pasteItems() {
    if (!clipboard || clipboard.length === 0) return;
    selectedSet.forEach(s => { s.classList.remove('selected'); s.classList.remove('primary'); });
    selectedSet.clear();
    selected = null;
    clipboard.forEach(c => {
      const id = newId('item');
      const dom = createItemDom(c.src);
      dom.dataset.id = id;
      dom.style.left = (c.left + 3) + '%';
      dom.style.top = (c.top + 3) + '%';
      dom.style.width = c.width + '%';
      canvas.appendChild(dom);
      attachItemHandlers(dom);
      const finalName = c.name || ('Image ' + (++imageCounter));
      const node = { id, type: 'item', name: finalName, parentId: ROOT_ID, dom };
      nodeMap.set(id, node);
      getNode(ROOT_ID).children.unshift(id);
      selectedSet.add(dom);
      dom.classList.add('selected');
      setPrimary(dom);
    });
    reflowCanvas();
    rebuildLayerPanel();
    rebuildProperties();
    pushHistory();
  }

  // === History ===
  function snapshot() {
    const nodes = [];
    function visit(id) {
      const n = getNode(id);
      if (!n) return;
      if (id === ROOT_ID) {
        nodes.push({ id: ROOT_ID, type: 'group', children: n.children.slice() });
        n.children.forEach(visit);
      } else if (n.type === 'item') {
        nodes.push({
          id: n.id, type: 'item', name: n.name, parentId: n.parentId,
          src: n.dom.querySelector('img').src,
          left: n.dom.style.left, top: n.dom.style.top, width: n.dom.style.width,
          position: n.dom.style.position
        });
      } else {
        nodes.push({
          id: n.id, type: 'group', name: n.name, parentId: n.parentId,
          children: n.children.slice(), expanded: n.expanded,
          displayMode: n.displayMode || 'free',
          left: n.left, top: n.top, width: n.width, height: n.height,
          gap: n.gap, columns: n.columns, padding: n.padding,
          justifyContent: n.justifyContent, alignItems: n.alignItems
        });
        n.children.forEach(visit);
      }
    }
    visit(ROOT_ID);
    return { bgDataUrl, bgRatio, nextId, imageCounter, groupCounter, nodes };
  }
  function pushHistory() {
    if (isRestoring) return;
    history.length = historyIdx + 1;
    history.push(snapshot());
    if (history.length > 60) history.shift();
    historyIdx = history.length - 1;
    updateAllOverlays();
  }
  function undo() {
    if (historyIdx <= 0) return;
    historyIdx--;
    restoreSnapshot(history[historyIdx]);
  }
  function restoreSnapshot(snap) {
    isRestoring = true;
    canvas.querySelectorAll('.item, .group-container').forEach(i => i.remove());
    selectedSet.clear();
    selected = null;
    clearGuides();
    initTree();
    nextId = snap.nextId;
    imageCounter = snap.imageCounter || 0;
    groupCounter = snap.groupCounter || 0;

    if (snap.bgDataUrl) {
      bgDataUrl = snap.bgDataUrl;
      bgRatio = snap.bgRatio;
      canvas.style.aspectRatio = bgRatio;
      let bg = canvas.querySelector('.bg');
      if (!bg) {
        bg = document.createElement('img');
        bg.className = 'bg';
        canvas.insertBefore(bg, canvas.firstChild);
      }
      bg.src = snap.bgDataUrl;
      hint.style.display = 'none';
    } else {
      bgDataUrl = null;
      bgRatio = '16 / 9';
      canvas.style.aspectRatio = bgRatio;
      const bg = canvas.querySelector('.bg');
      if (bg) bg.remove();
      hint.style.display = '';
    }

    snap.nodes.forEach(s => {
      if (s.id === ROOT_ID) {
        getNode(ROOT_ID).children = s.children.slice();
        return;
      }
      if (s.type === 'item') {
        const dom = createItemDom(s.src);
        dom.dataset.id = s.id;
        dom.style.left = s.left; dom.style.top = s.top; dom.style.width = s.width;
        if (s.position) dom.style.position = s.position;
        canvas.appendChild(dom);
        attachItemHandlers(dom);
        nodeMap.set(s.id, { id: s.id, type: 'item', name: s.name, parentId: s.parentId, dom });
      } else {
        const group = {
          id: s.id, type: 'group', name: s.name, parentId: s.parentId,
          children: s.children.slice(), expanded: s.expanded,
          displayMode: s.displayMode || 'free',
          left: s.left, top: s.top, width: s.width, height: s.height,
          gap: s.gap, columns: s.columns, padding: s.padding,
          justifyContent: s.justifyContent, alignItems: s.alignItems
        };
        if (isRealGroup(group)) {
          group.dom = createGroupDom(group);
          attachGroupHandlers(group.dom);
        }
        nodeMap.set(s.id, group);
      }
    });
    reflowCanvas();
    rebuildLayerPanel();
    rebuildProperties();
    isRestoring = false;
  }

  // === Buttons ===
  document.getElementById('bgBtn').addEventListener('click', () => { bgInput.value = ''; bgInput.click(); });
  document.getElementById('addBtn').addEventListener('click', () => { addInput.value = ''; addInput.click(); });
  document.getElementById('delBtn').addEventListener('click', deleteSelected);
  document.getElementById('groupBtn').addEventListener('click', groupSelected);
  document.getElementById('ungroupBtn').addEventListener('click', ungroupSelected);
  document.getElementById('forwardBtn').addEventListener('click', bringForward);
  document.getElementById('backwardBtn').addEventListener('click', sendBackward);
  document.getElementById('frontBtn').addEventListener('click', bringToFront);
  document.getElementById('backBtn').addEventListener('click', sendToBack);
  document.getElementById('zoomInBtn').addEventListener('click', () => setZoom(zoom * 1.25));
  document.getElementById('zoomOutBtn').addEventListener('click', () => setZoom(zoom / 1.25));
  document.getElementById('fitBtn').addEventListener('click', fitZoom);
  document.getElementById('undoBtn').addEventListener('click', undo);
  bgInput.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (file) setBackground(file);
  });
  addInput.addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    files.forEach((file, i) => {
      if (!file.type.startsWith('image/')) return;
      const baseName = fileBaseName(file);
      readImage(file, src => addItem(src, 30 + i * 3, 30 + i * 3, 20, baseName));
    });
  });

  canvas.addEventListener('mousedown', e => {
    if (e.target !== canvas) return;
    const shift = e.shiftKey;
    if (!shift) clearSelection();
    const canvasRect = canvas.getBoundingClientRect();
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
        rubber.style.left = ((x1 - canvasRect.left) / canvasRect.width * 100) + '%';
        rubber.style.top = ((y1 - canvasRect.top) / canvasRect.height * 100) + '%';
        rubber.style.width = ((x2 - x1) / canvasRect.width * 100) + '%';
        rubber.style.height = ((y2 - y1) / canvasRect.height * 100) + '%';
      }
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (rubber) {
        const rR = rubber.getBoundingClientRect();
        canvas.querySelectorAll('.item, .group-container').forEach(it => {
          if (rectsIntersect(rR, it.getBoundingClientRect())) addToSelection(it, true);
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
    const rect = canvas.getBoundingClientRect();
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top) / rect.height) * 100;
    const files = Array.from(e.dataTransfer.files || []);
    files.forEach((file, i) => {
      if (!file.type.startsWith('image/')) return;
      if (!bgDataUrl && i === 0) setBackground(file);
      else {
        const baseName = fileBaseName(file);
        readImage(file, src => addItem(src, xPct, yPct, 20, baseName));
      }
    });
  });

  stage.addEventListener('wheel', e => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
    } else {
      // 一般滾輪 = 平移畫布 (取代原本的捲軸滾動)
      e.preventDefault();
      panX -= e.deltaX;
      panY -= e.deltaY;
      applyPan();
    }
  }, { passive: false });

  // === Space + drag 平移畫布 (用 transform 不會干擾畫布尺寸/置中) ===
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
    e.preventDefault();
    e.stopPropagation();
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

  document.addEventListener('keydown', e => {
    const cmd = e.metaKey || e.ctrlKey;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedSet.size > 0) {
      e.preventDefault(); deleteSelected();
    } else if (cmd && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault(); ungroupSelected();
    } else if (cmd && !e.shiftKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault(); groupSelected();
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
      clearSelection();
      canvas.querySelectorAll('.item, .group-container').forEach(it => addToSelection(it, true));
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
    } else if (e.key === 'Escape') {
      clearSelection();
    }
  });

  // === Export ===
  function exportNodeHTML(id, indent) {
    const n = getNode(id);
    if (!n) return '';
    const ind = '  '.repeat(indent);
    if (n.type === 'item') {
      const img = n.dom.querySelector('img');
      const styleParts = [];
      if (n.dom.style.left) styleParts.push('left:' + n.dom.style.left);
      if (n.dom.style.top) styleParts.push('top:' + n.dom.style.top);
      if (n.dom.style.width) styleParts.push('width:' + n.dom.style.width);
      if (n.dom.style.position === 'relative') styleParts.push('position:relative');
      return ind + '<div class="item" style="' + styleParts.join(';') + '"><img src="' + img.src + '"></div>';
    }
    if (n.id === ROOT_ID) {
      return n.children.slice().reverse().map(cid => exportNodeHTML(cid, indent)).join('\n');
    }
    if (isRealGroup(n)) {
      const styles = [];
      styles.push('position:absolute');
      if (n.left) styles.push('left:' + n.left);
      if (n.top) styles.push('top:' + n.top);
      if (n.width) styles.push('width:' + n.width);
      if (n.height) styles.push('height:' + n.height);
      if (n.displayMode === 'flex-row' || n.displayMode === 'flex-col') {
        styles.push('display:flex',
          'flex-direction:' + (n.displayMode === 'flex-row' ? 'row' : 'column'),
          'gap:' + (n.gap || 0) + 'px');
        if (n.justifyContent && n.justifyContent !== 'flex-start') styles.push('justify-content:' + n.justifyContent);
        if (n.alignItems && n.alignItems !== 'flex-start') styles.push('align-items:' + n.alignItems);
      } else if (n.displayMode === 'grid') {
        styles.push('display:grid',
          'grid-template-columns:repeat(' + (n.columns || 2) + ',1fr)',
          'gap:' + (n.gap || 0) + 'px');
      }
      if (n.padding) styles.push('padding:' + n.padding + 'px');
      const inner = n.children.map(cid => exportNodeHTML(cid, indent + 1)).join('\n');
      return ind + '<div class="group" style="' + styles.join(';') + '">\n' + inner + '\n' + ind + '</div>';
    }
    // free group: emit children with z-order (reverse)
    return n.children.slice().reverse().map(cid => exportNodeHTML(cid, indent)).join('\n');
  }

  document.getElementById('exportBtn').addEventListener('click', () => {
    if (!bgDataUrl) { alert('請先設定底圖'); return; }
    const inner = exportNodeHTML(ROOT_ID, 1);
    const lines = [
      '<!DOCTYPE html>', '<html lang="zh-TW">', '<head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>My Page</title>', '<style>',
      '  body { margin: 0; }',
      '  .canvas { position: relative; width: 100%; aspect-ratio: ' + bgRatio + '; overflow: hidden; }',
      '  .canvas .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }',
      '  .canvas .item { position: absolute; }',
      '  .canvas .item img { width: 100%; height: auto; display: block; }',
      '<\/style>', '<\/head>', '<body>', '<div class="canvas">',
      '  <img class="bg" src="' + bgDataUrl + '">',
      inner,
      '<\/div>', '<\/body>', '<\/html>'
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'export.html';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  applyZoom();
  pushHistory();
  console.log('Layout Studio ready');
})();
