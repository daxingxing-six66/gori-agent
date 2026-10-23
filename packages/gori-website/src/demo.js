import { element } from './dom.js';
import { configPreview, scenarios } from './scenarios.js';

export function initializeDemo() {
  let selected = 'inspect';
  // Begin with a populated example. Replay returns to the intent before execution.
  let stepIndex = 1;
  const tabs = Array.from(document.querySelectorAll('[data-scenario]'));
  const result = element('#demo-result-body');
  const progress = element('#demo-progress');
  const next = element('#demo-next');
  const panel = element('#demo-panel');

  function render() {
    const scenario = scenarios[selected];
    const step = scenario.steps[stepIndex];
    tabs.forEach((tab) => {
      const active = tab.getAttribute('data-scenario') === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
    });
    panel.setAttribute('aria-labelledby', `tab-${selected}`);
    element('#demo-session').textContent = scenario.title;
    element('#conversation-title').textContent = scenario.title;
    element('#demo-prompt').textContent = scenario.prompt;
    element('#demo-response').textContent = step.response;
    element('#result-title').textContent = scenario.panel;
    element('#result-caption').textContent = scenario.caption;
    const iconUse = document.querySelector('#result-icon use');
    iconUse?.setAttribute('href', `#i-${scenario.icon}`);
    result.innerHTML = step.result;
    // These strings all come from the fixed, reviewed scenario catalogue above.
    element('#demo-activity').innerHTML = `<div class="tool-call"><span class="tool-icon">↳</span><div><strong>${step.tool}</strong><span>${step.detail}</span></div><span class="tool-check">${stepIndex === 0 ? '·' : '✓'}</span></div>`;
    element('#demo-status').textContent = step.status;
    element('#demo-step').textContent = `${String(stepIndex + 1).padStart(2, '0')} / ${String(scenario.steps.length).padStart(2, '0')} · ${step.title}`;
    next.innerHTML = `${step.action}<svg class="icon small" aria-hidden="true"><use href="#i-arrow" /></svg>`;
    progress.innerHTML = scenario.steps.map((item, index) => `<button class="progress-dot ${index <= stepIndex ? 'is-complete' : ''}" data-step="${index}" aria-label="查看第 ${index + 1} 步：${item.title}" ${index === stepIndex ? 'aria-current="step"' : ''}></button>`).join('');
    result.scrollTop = 0;
  }

  /** @param {string} name */
  function select(name) {
    if (!(name in scenarios)) return;
    selected = name;
    stepIndex = 0;
    render();
  }

  next.addEventListener('click', () => {
    stepIndex = (stepIndex + 1) % scenarios[selected].steps.length;
    render();
  });
  element('#demo-reset').addEventListener('click', () => { stepIndex = 0; render(); });
  progress.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-step]') : null;
    if (!button) return;
    const index = Number(button.getAttribute('data-step'));
    if (!Number.isInteger(index) || index < 0 || index >= scenarios[selected].steps.length) return;
    stepIndex = index;
    render();
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab.getAttribute('data-scenario') ?? 'inspect'));
    tab.addEventListener('keydown', (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      let target = index;
      if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = tabs.length - 1;
      else return;
      event.preventDefault();
      const targetTab = tabs[target];
      select(targetTab.getAttribute('data-scenario') ?? 'inspect');
      if (targetTab instanceof HTMLElement) targetTab.focus();
    });
  });
  document.querySelectorAll('[data-open-scenario]').forEach((button) => {
    if (button instanceof HTMLElement) button.hidden = false;
    button.addEventListener('click', () => {
      select(button.getAttribute('data-open-scenario') ?? 'inspect');
      element('#playground').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      panel.focus({ preventScroll: true });
    });
  });
  result.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-file-action]') : null;
    if (!button || selected !== 'files') return;
    const action = button.getAttribute('data-file-action');
    if (action === 'config') {
      result.innerHTML = configPreview;
      element('#demo-status').textContent = '配置文件 · 示例内容';
      return;
    }
    stepIndex = action === 'parent' ? 0 : action === 'logs' ? 1 : 2;
    render();
  });
  const themeButton = element('#demo-theme');
  themeButton.hidden = false;
  themeButton.addEventListener('click', () => {
    const light = panel.classList.toggle('light-workspace');
    themeButton.setAttribute('aria-pressed', String(light));
    themeButton.setAttribute('aria-label', light ? '切换演示工作区为深色主题' : '切换演示工作区为浅色主题');
    themeButton.innerHTML = `<svg class="icon small" aria-hidden="true"><use href="#i-${light ? 'moon' : 'sun'}" /></svg>`;
  });
  element('.demo-controls').hidden = false;
  render();
}
