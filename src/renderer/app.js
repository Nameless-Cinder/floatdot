const dotButton = document.querySelector('#dot');
const badge = document.querySelector('#badge');
const phone = document.querySelector('#phone');
const statusText = document.querySelector('#status');
const titlebar = document.querySelector('#titlebar');
const toolbar = document.querySelector('.toolbar');
let lastAvatar = null;
const preview = document.querySelector('#preview');
let motion = null;

function clearMotion() {
  if (motion) for (const animation of motion.animations) animation.cancel();
  motion = null;
  delete document.body.dataset.motion;
  phone.removeAttribute('style');
  dotButton.removeAttribute('style');
  preview.hidden = true;
  preview.removeAttribute('src');
}

window.dot.onMotionPrepare(async data => {
  clearMotion();
  const current = { id: data.id, opening: data.opening, duration: data.duration, animations: [] };
  motion = current;
  document.body.dataset.motion = 'preparing';
  for (const [element, bounds] of [[phone, data.phone], [dotButton, data.dot]]) {
    element.hidden = false;
    Object.assign(element.style, { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
  }
  document.documentElement.style.setProperty('--phone-width', `${data.phone.width}px`);
  if (data.preview) {
    preview.src = data.preview;
    try { await preview.decode(); } catch { /* Show the shell if no frame is available. */ }
    if (motion !== current) return;
    preview.hidden = false;
  }
  const scale = Math.min(data.dot.width / data.phone.width, data.dot.height / data.phone.height);
  const dx = data.dot.x + (data.dot.width - data.phone.width * scale) / 2 - data.phone.x;
  const dy = data.dot.y + (data.dot.height - data.phone.height * scale) / 2 - data.phone.y;
  const timing = { duration: data.duration, easing: 'cubic-bezier(.22,.75,.2,1)', fill: 'both' };
  const phoneAnimation = phone.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
    { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
  ], timing);
  const dotAnimation = dotButton.animate([
    { transform: 'scale(1)', opacity: 1, offset: 0 },
    { transform: 'scale(.7)', opacity: 0, offset: .18 },
    { transform: 'scale(.7)', opacity: 0, offset: 1 },
  ], timing);
  current.animations = [phoneAnimation, dotAnimation];
  for (const animation of current.animations) {
    animation.pause();
    animation.currentTime = data.opening ? 0 : data.duration;
  }
  phoneAnimation.onfinish = () => {
    const atDestination = current.opening ? phoneAnimation.currentTime >= current.duration : phoneAnimation.currentTime <= 0;
    if (motion === current && atDestination) window.dot.motionFinished(current.id, current.opening);
  };
  // Paint the start pose before making the resized native surface visible.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (motion === current) window.dot.motionReady(current.id);
  }));
});

window.dot.onMotionPlay(data => {
  if (motion?.id !== data.id) return;
  motion.opening = data.opening;
  document.body.dataset.motion = data.opening ? 'opening' : 'closing';
  const position = motion.animations[0].currentTime;
  if (data.opening ? position >= motion.duration : position <= 0) {
    window.dot.motionFinished(motion.id, data.opening);
    return;
  }
  for (const animation of motion.animations) {
    animation.updatePlaybackRate(data.opening ? 1 : -1.25);
    animation.play();
  }
});

function matchAppearance(dataUrl) {
  if (!dataUrl || dataUrl === lastAvatar) return;
  lastAvatar = dataUrl;
  const picture = new Image();
  picture.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(picture, 0, 0, 40, 40);
    const { data } = context.getImageData(0, 0, 40, 40);
    const ring = [[], [], []], center = [[], [], []];
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const radius = Math.hypot(x - 19.5, y - 19.5) / 40;
      const target = radius > 0.29 && radius < 0.42 ? ring : radius < 0.1 ? center : null;
      const offset = (y * 40 + x) * 4;
      if (!target || data[offset + 3] < 240) continue;
      for (let channel = 0; channel < 3; channel++) target[channel].push(data[offset + channel]);
    }
    if (ring[0].length < 20 || center[0].length < 10) return;
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const ringColor = ring.map(median), centerColor = center.map(median);
    // Ignore loading placeholders: a rendered ring differs from its center.
    if (ringColor.every((value, index) => Math.abs(value - centerColor[index]) < 25)) return;
    document.documentElement.style.setProperty('--dot-color', `rgb(${ringColor.join(',')})`);
    document.documentElement.style.setProperty('--dot-center', `rgb(${centerColor.join(',')})`);
    document.documentElement.dataset.appearanceMatched = 'true';
  };
  picture.src = dataUrl;
}

function render(state) {
  if (!state) return;
  if (!state.motion) {
    clearMotion();
    dotButton.hidden = state.expanded;
    phone.hidden = !state.expanded;
  }
  document.documentElement.style.setProperty('--phone-width', `${state.phoneSize.width}px`);
  document.documentElement.style.setProperty('--bar-height', `${state.barHeight}px`);
  toolbar.hidden = state.saved;
  badge.hidden = state.unread === 0;
  badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
  dotButton.setAttribute('aria-label', state.unread ? `Open FloatDot, ${state.unread} unread` : 'Open FloatDot');
  statusText.textContent = state.status || (state.selected ? 'My Dot' : '');
  statusText.title = state.status || '';
  titlebar.title = [state.status, 'Click to collapse · Drag to move · Right-click for menu'].filter(Boolean).join('\n');
  matchAppearance(state.avatar);
}
window.dot.onState(render);
window.dot.getState().then(render);
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
window.dot.setReducedMotion(motionPreference.matches);
motionPreference.addEventListener('change', event => window.dot.setReducedMotion(event.matches));

function draggable(element) {
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    element.setPointerCapture(event.pointerId);
    window.dot.startDrag({ x: event.screenX, y: event.screenY });
  });
  element.addEventListener('pointerup', (event) => {
    if (event.button !== 0 || !element.hasPointerCapture(event.pointerId)) return;
    window.dot.endDrag(false);
    element.releasePointerCapture(event.pointerId);
  });
  element.addEventListener('pointercancel', () => window.dot.endDrag(true));
  element.addEventListener('lostpointercapture', () => window.dot.endDrag(true));
}
draggable(dotButton);
draggable(titlebar);
// Keyboard activation does not have a pointerdown/up pair.
dotButton.addEventListener('click', (event) => { if (event.detail === 0) window.dot.toggle(); });
dotButton.addEventListener('contextmenu', (event) => { event.preventDefault(); window.dot.menu(); });
titlebar.addEventListener('click', (event) => { if (event.detail === 0) window.dot.collapse(); });
titlebar.addEventListener('contextmenu', (event) => { event.preventDefault(); window.dot.menu(); });
document.querySelector('#save').addEventListener('click', () => window.dot.saveCurrent());
