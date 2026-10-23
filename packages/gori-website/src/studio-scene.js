import { element } from './dom.js';
import { createTerminalFlow } from './studio-dataflow.js';

/** @param {number} value */
function clamp(value) { return Math.max(0, Math.min(1, value)); }

const intents = {
  inspect: { prompt: '帮我看看这台服务器的内存。', command: 'free -h', output: 'Mem: 7.8Gi  2.1Gi  5.2Gi\nSwap: 2.0Gi  0B', result: '当前可用内存 5.2 GiB，继续查看进程？', tool: 'remote_server_call' },
  deploy: { prompt: '把 my-app 的新版本部署上去。', command: 'build → upload → restart → verify', output: 'build       completed\nupload      completed\nrestart     approved\nhealth      HTTP 200', result: '部署步骤已完成，健康检查返回 HTTP 200。', tool: 'deployment_execute_next' },
  diagnose: { prompt: '帮我查查，为什么服务返回 502？', command: 'nginx -T && ss -lntp', output: 'Nginx upstream    :8080\nApplication       :8081\nconfiguration mismatch', result: '找到一条证据：上游与应用监听端口不一致。', tool: 'remote_server_call' },
};
const phaseLabels = ['意图已收到', '工具与命令', '通过 SSH 传输', '输出与观测'];
const phaseStates = ['INTENT RECEIVED', 'TOOL CALL', 'SSH TRANSMISSION', 'OBSERVATION'];

export function initializeStudioScene() {
  const node = element('#studio-canvas');
  if (!(node instanceof HTMLCanvasElement)) return;
  const canvas = node;
  const stage = element('#signal-stage');
  const journey = element('#signal-journey');
  const rail = element('#features');
  const track = element('#studio-capability-track');
  const manifesto = element('#studio-manifesto-title');
  const motion = element('#studio-motion');
  const cursor = element('.studio-cursor');
  const chapters = [...document.querySelectorAll('[data-signal-chapter]')].filter((item) => item instanceof HTMLElement);
  const chapterButtons = [...document.querySelectorAll('.signal-chapter-nav [data-signal-go]')].filter((item) => item instanceof HTMLElement);
  const railButtons = [...document.querySelectorAll('[data-capability-go]')];
  const panels = [...document.querySelectorAll('.studio-capability-panel')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const narrow = matchMedia('(max-width: 760px)');
  const events = new AbortController();
  const listener = { signal: events.signal };
  const renderer = createTerminalFlow(canvas);
  if (canvas.getContext('2d')) stage.classList.add('flow-ready');
  /** @type {keyof typeof intents} */
  let intent = 'inspect';
  let phase = -1;
  let paused = reduced.matches;
  let animationId = 0;
  let lastTime = 0;
  let flowTime = 0;
  let pulse = 0;
  let packets = 0;
  let pointerX = 0;
  let pointerY = 0;
  let sceneProgress = 0;
  let visible = true;
  let disposed = false;
  let dirty = true;
  let journeyTop = 0;
  let journeyRange = 1;
  let railTop = 0;
  let railRange = 1;
  let railDistance = 0;

  function measure() {
    journeyTop = journey.getBoundingClientRect().top + scrollY;
    journeyRange = Math.max(1, journey.offsetHeight - innerHeight);
    railTop = rail.getBoundingClientRect().top + scrollY;
    railRange = Math.max(1, rail.offsetHeight - innerHeight);
    railDistance = Math.max(0, track.scrollWidth - innerWidth);
    renderer.resize();
    schedule();
  }

  function updateHUD() {
    const selected = intents[intent];
    const text = [
      { label: 'YOUR WORDS', prompt: selected.prompt, code: '> awaiting intent_', route: 'YOU → GORI' },
      { label: 'AGENT / EXAMPLE', prompt: '把目标转成可见的操作步骤。', code: `${selected.tool}\n${intent === 'deploy' ? '' : '$ '}${selected.command}`, route: 'INTENT → TOOL CALL' },
      { label: 'SSH / EXAMPLE', prompt: intent === 'deploy' ? '构建在本机、上传经 SFTP；SSH 负责重启与验证。' : '本机后端接上你配置的服务器。', code: intent === 'deploy' ? 'SSH / restart (approved example)\n$ systemctl restart my-app\nHTTP health check → 200' : `gori@my-linux\n$ ${selected.command}\ntransmitting...`, route: intent === 'deploy' ? 'BUILD → SFTP → SSH → VERIFY' : 'LOCAL → SSH → LINUX' },
      { label: 'OBSERVATION / EXAMPLE', prompt: selected.result, code: selected.output, route: 'STDOUT → CONTEXT' },
    ][Math.max(0, phase)];
    element('#signal-hud-label').textContent = text.label;
    element('#signal-hud-prompt').textContent = text.prompt;
    element('#signal-hud-code').textContent = text.code;
    element('#signal-hud-route').textContent = text.route;
    element('#signal-hud-state').textContent = phaseStates[Math.max(0, phase)];
    element('#signal-tool-name').textContent = selected.tool;
    element('#signal-open-result').setAttribute('data-open-scenario', intent);
  }

  /** @param {number} next */
  function setPhase(next) {
    if (next === phase) return;
    const focusedChapter = document.activeElement?.closest('[data-signal-chapter]');
    phase = next;
    chapters.forEach((chapter, index) => {
      const active = index === phase;
      chapter.classList.toggle('is-active', active);
      chapter.setAttribute('aria-hidden', String(!active));
      chapter.inert = !active;
    });
    chapterButtons.forEach((button, index) => {
      if (index === phase) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    if (focusedChapter && focusedChapter !== chapters[phase]) chapterButtons[phase]?.focus({ preventScroll: true });
    element('#signal-phase-status').textContent = `0${phase} / ${phaseLabels[phase]}`;
    updateHUD();
  }

  function updateScroll() {
    const progress = clamp((scrollY - journeyTop) / journeyRange);
    stage.style.setProperty('--flow-progress', String(progress));
    setPhase(Math.round(progress * 3));
    const railProgress = clamp((scrollY - railTop) / railRange);
    const vertical = narrow.matches || reduced.matches;
    track.style.transform = vertical ? '' : `translate3d(${-railProgress * railDistance}px,0,0)`;
    track.style.setProperty('--rail-progress', String(railProgress));
    let currentPanel = Math.round(railProgress * 3);
    if (vertical) {
      let closest = Infinity;
      panels.forEach((panel, index) => {
        const distance = Math.abs(panel.getBoundingClientRect().top - innerHeight * .25);
        if (distance < closest) { closest = distance; currentPanel = index; }
      });
    }
    element('#studio-capability-count').textContent = `0${currentPanel + 1} / 04`;
    railButtons.forEach((button, index) => {
      if (index === currentPanel) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    const bounds = manifesto.getBoundingClientRect();
    const reading = clamp((innerHeight * .8 - bounds.top) / Math.max(1, bounds.height * .9));
    manifesto.querySelectorAll('span').forEach((line, index) => {
      if (line instanceof HTMLElement) line.style.opacity = String(reduced.matches ? 1 : .2 + .8 * clamp(reading * 4 - index + .8));
    });
    return progress;
  }

  function canAnimate() {
    return !paused && visible && !document.hidden && !document.body.classList.contains('studio-dialog-open');
  }
  /** @param {number} now */
  function render(now) {
    animationId = 0;
    if (disposed || document.hidden) return;
    const elapsed = Math.min((now - lastTime) / 1000, .07);
    if (dirty || now - lastTime >= 32) {
      if (dirty) sceneProgress = updateScroll();
      if (canAnimate()) {
        flowTime += elapsed;
        pulse = Math.max(0, pulse - elapsed * .6);
      }
      const sample = intent === 'inspect'
        ? { command: '$ free -h', result: 'exit 0  ✓', detail: 'available 5.2 GiB / observation saved', lines: ['$ free -h', 'Mem: 7.8Gi  2.1Gi  5.2Gi', 'exit 0'], labels: ['MEMORY','5.2 GiB','STDOUT','EXIT 0','SESSION','OBSERVED','SSH','LOGS','COMPLETE'] }
        : intent === 'deploy'
          ? { command: 'my-app / deploy', result: 'HTTP 200  ✓', detail: 'build · upload · restart · verify', lines: ['local build → completed', 'SFTP upload → completed', 'SSH restart → approved example', 'health check → HTTP 200'], labels: ['BUILD','UPLOAD','SFTP','RESTART','SSH','VERIFY','HTTP 200','LOGS','COMPLETE'] }
          : { command: 'trace / 502', result: 'port mismatch', detail: 'upstream :8080 / application :8081', lines: ['Nginx upstream → :8080', 'ss -lntp → app :8081', 'configuration mismatch', 'record → diagnose_update'], labels: ['NGINX',':8080','STDOUT',':8081','APP','EVIDENCE','SSH','LOGS','CONFIRMED'] };
      if (visible) renderer.draw({ time: flowTime, progress: sceneProgress, pointerX: reduced.matches ? 0 : pointerX, pointerY: reduced.matches ? 0 : pointerY, pulse, sample });
      dirty = false;
      lastTime = now;
    }
    if (canAnimate()) animationId = requestAnimationFrame(render);
  }
  function schedule() {
    dirty = true;
    if (!animationId && !disposed && !document.hidden) animationId = requestAnimationFrame(render);
  }
  /** @param {number} index */
  function goToChapter(index) {
    scrollTo({ top: journeyTop + journeyRange * index / 3, behavior: reduced.matches ? 'instant' : 'smooth' });
  }
  document.querySelectorAll('[data-signal-go]').forEach((button) => button.addEventListener('click', () => goToChapter(Number(button.getAttribute('data-signal-go'))), listener));
  element('.signal-chapter-nav').addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = chapterButtons.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (Math.max(0, current) + (event.key === 'ArrowDown' ? 1 : 3)) % 4;
    chapterButtons[next]?.focus({ preventScroll: true });
    goToChapter(next);
  }, listener);
  document.querySelectorAll('[data-signal-intent]').forEach((button) => button.addEventListener('click', () => {
    const next = button.getAttribute('data-signal-intent');
    if (next !== 'inspect' && next !== 'deploy' && next !== 'diagnose') return;
    intent = next;
    document.querySelectorAll('[data-signal-intent]').forEach((choice) => choice.setAttribute('aria-pressed', String(choice === button)));
    updateHUD();
    pulse = 1;
    schedule();
  }, listener));
  element('#signal-send').addEventListener('click', () => { pulse = 1; goToChapter(1); schedule(); }, listener);
  element('#signal-pulse').addEventListener('click', () => {
    pulse = 1;
    packets += 1;
    element('#signal-packet-note').textContent = `数据包 ${String(packets).padStart(2, '0')} 已发出 · 视觉演示`;
    schedule();
  }, listener);
  railButtons.forEach((button, index) => button.addEventListener('click', () => {
    if (narrow.matches || reduced.matches) panels[index].scrollIntoView({ behavior: 'instant', block: 'center' });
    else scrollTo({ top: railTop + railRange * index / 3, behavior: 'smooth' });
  }, listener));
  // Keep keyboard focus visible when tabbing into a panel outside the horizontal frame.
  track.addEventListener('focusin', (event) => {
    const panel = event.target instanceof Element ? event.target.closest('.studio-capability-panel') : null;
    const index = panels.indexOf(/** @type {Element} */ (panel));
    const bounds = event.target instanceof Element ? event.target.getBoundingClientRect() : null;
    if (index >= 0 && bounds && (bounds.left < 0 || bounds.right > innerWidth) && !narrow.matches && !reduced.matches) {
      scrollTo({ top: railTop + railRange * index / 3, behavior: 'instant' });
    }
  }, listener);

  function motionLabel() {
    motion.setAttribute('aria-pressed', String(paused));
    motion.textContent = paused ? '播放流动 ▷' : '暂停流动 Ⅱ';
  }
  motion.addEventListener('click', () => { paused = !paused; motionLabel(); schedule(); }, listener);
  reduced.addEventListener('change', () => { paused = reduced.matches; motionLabel(); measure(); }, listener);
  narrow.addEventListener('change', measure, listener);
  stage.addEventListener('pointermove', (event) => {
    if (paused || reduced.matches || event.pointerType !== 'mouse') return;
    const bounds = stage.getBoundingClientRect();
    pointerX = (event.clientX - bounds.left) / bounds.width * 2 - 1;
    pointerY = (event.clientY - bounds.top) / bounds.height * 2 - 1;
  }, listener);
  stage.addEventListener('pointerleave', () => { pointerX = 0; pointerY = 0; }, listener);
  document.addEventListener('pointermove', (event) => {
    cursor.style.transform = `translate3d(${event.clientX}px,${event.clientY}px,0)`;
    const target = event.target instanceof Element ? event.target : null;
    const active = !reduced.matches && event.pointerType === 'mouse' && !!target?.closest('.signal-stage,.studio-capabilities') && !target?.closest('a,button') && !document.body.classList.contains('studio-dialog-open');
    cursor.classList.toggle('is-visible', active);

  }, listener);
  window.addEventListener('scroll', schedule, { ...listener, passive: true });
  window.addEventListener('resize', measure, listener);
  document.addEventListener('visibilitychange', schedule, listener);
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('close', schedule, listener));
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule(); });
  observer.observe(stage);
  const resize = new ResizeObserver(measure);
  resize.observe(stage);
  window.addEventListener('pageshow', schedule, listener);
  window.addEventListener('pagehide', (event) => {
    cancelAnimationFrame(animationId);
    animationId = 0;
    if (event.persisted) return;
    disposed = true;
    events.abort();
    observer.disconnect();
    resize.disconnect();
    renderer.dispose();
  }, listener);
  motionLabel();
  measure();
}
