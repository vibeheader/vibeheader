/** Pointer and keyboard interaction for the temporary Header reorder view. */
export class HeaderReorder {
  constructor(container, move) {
    this.container = container;
    this.move = move;
    this.drag = null;
    container?.addEventListener('pointerdown', event => this.start(event));
    container?.addEventListener('pointermove', event => this.update(event));
    container?.addEventListener('pointerup', () => this.finish());
    container?.addEventListener('pointercancel', () => this.cancel());
    container?.addEventListener('lostpointercapture', () => this.cancel());
    container?.addEventListener('keydown', event => this.keydown(event));
    window.addEventListener('blur', () => this.cancel());
  }

  rows() {
    return [...(this.container?.querySelectorAll('.vh-header-row') || [])];
  }

  keydown(event) {
    const handle = event.target.closest('.vh-header-grip');
    if (!handle || handle.disabled) return;
    const row = handle.closest('.vh-header-row');
    const rows = this.rows();
    const index = rows.indexOf(row);
    const destinations = {
      ArrowUp: index - 1,
      ArrowDown: index + 1,
      Home: 0,
      End: rows.length - 1
    };
    if (!(event.key in destinations)) return;
    event.preventDefault();
    this.move(row.dataset.headerId, destinations[event.key]);
  }

  start(event) {
    const handle = event.target.closest('.vh-header-grip');
    if (!handle || handle.disabled || event.button !== 0) return;
    event.preventDefault();
    this.cancel();
    handle.focus();
    const row = handle.closest('.vh-header-row');
    this.drag = {
      handle, row, id: row.dataset.headerId,
      pointerId: event.pointerId,
      startY: event.clientY,
      clientY: event.clientY,
      rect: row.getBoundingClientRect(),
      ghost: null, target: null, before: true, scrollFrame: null
    };
    handle.setPointerCapture(event.pointerId);
  }

  update(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.clientY = event.clientY;
    if (!drag.ghost && Math.abs(event.clientY - drag.startY) < 4) return;
    if (!drag.ghost) {
      drag.ghost = drag.row.cloneNode(true);
      drag.ghost.classList.add('vh-drag-ghost');
      drag.ghost.removeAttribute('data-header-id');
      drag.ghost.setAttribute('aria-hidden', 'true');
      drag.ghost.querySelectorAll('input, button').forEach(control => {
        control.tabIndex = -1;
      });
      drag.ghost.style.width = `${drag.rect.width}px`;
      document.body.append(drag.ghost);
      drag.row.classList.add('is-dragging');
    }
    drag.ghost.style.left = `${drag.rect.left}px`;
    drag.ghost.style.top = `${drag.rect.top + event.clientY - drag.startY}px`;
    this.updateTarget();
    this.scrollNearEdge();
  }

  updateTarget() {
    const drag = this.drag;
    if (!drag?.ghost) return;
    const rows = this.rows().filter(row => row !== drag.row);
    rows.forEach(row => row.classList.remove('drop-before', 'drop-after'));
    const next = rows.find(row => {
      const rect = row.getBoundingClientRect();
      return drag.clientY < rect.top + rect.height / 2;
    });
    const target = next || rows[rows.length - 1];
    drag.target = target?.dataset.headerId;
    drag.before = !!next;
    target?.classList.add(next ? 'drop-before' : 'drop-after');
  }

  scrollNearEdge() {
    const drag = this.drag;
    if (!drag?.ghost || drag.scrollFrame !== null) return;
    drag.scrollFrame = requestAnimationFrame(() => {
      drag.scrollFrame = null;
      if (this.drag !== drag) return;
      const amount = drag.clientY < 36 ? -12
        : drag.clientY > window.innerHeight - 36 ? 12 : 0;
      if (!amount) return;
      const previous = window.scrollY;
      window.scrollBy(0, amount);
      if (window.scrollY === previous) return;
      this.updateTarget();
      this.scrollNearEdge();
    });
  }

  finish() {
    const drag = this.drag;
    this.cancel();
    if (!drag?.ghost || !drag.target) return;
    const others = this.rows().filter(row => row.dataset.headerId !== drag.id);
    const index = others.findIndex(row => row.dataset.headerId === drag.target);
    if (index >= 0) this.move(drag.id, index + (drag.before ? 0 : 1));
  }

  cancel() {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.scrollFrame !== null) cancelAnimationFrame(drag.scrollFrame);
    drag.ghost?.remove();
    drag.row.classList.remove('is-dragging');
    this.rows().forEach(row => row.classList.remove('drop-before', 'drop-after'));
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
  }
}
