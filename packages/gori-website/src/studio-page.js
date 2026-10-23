import markup from './studio.html?raw';
import { element } from './dom.js';

export function mountStudioPage() {
  const main = element('#main');
  const workbench = element('#playground');
  const approval = element('.approval-demo');
  const installation = element('.install-card');
  const questions = element('.faq-list');
  const designs = element('.design-picker');
  const template = document.createElement('template');
  template.innerHTML = markup;
  main.replaceChildren(template.content.cloneNode(true));
  element('[data-studio-workbench]').append(workbench);
  element('[data-studio-approval]').append(approval);
  element('[data-studio-install]').append(installation);
  element('[data-studio-faq]').append(questions);
  element('[data-studio-designs]').append(designs);
  document.documentElement.classList.add('studio-ready');

  const modalNode = element('#studio-workbench-modal');
  const menuNode = element('#studio-navigation-modal');
  if (!(modalNode instanceof HTMLDialogElement) || !(menuNode instanceof HTMLDialogElement)) return;
  const modal = modalNode;
  const menu = menuNode;
  /** @type {HTMLElement | null} */
  let modalTrigger = null;
  /** @type {HTMLElement | null} */
  let modalDestination = null;
  /** @type {HTMLElement | null} */
  let menuDestination = null;

  // Open before the shared demo's button handler selects the scenario and focuses
  // its panel. The same demo elements and listeners serve all three directions.
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-open-scenario]') : null;
    if (!(target instanceof HTMLElement)) return;
    modalTrigger = target;
    if (!modal.open) modal.showModal();
    document.body.classList.add('studio-dialog-open');
  }, { capture: true });
  element('#studio-workbench-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!link) return;
    modalDestination = document.getElementById((link.getAttribute('href') ?? '').slice(1));
    modal.close();
  });
  modal.addEventListener('close', () => {
    document.body.classList.remove('studio-dialog-open');
    if (modalDestination) {
      if (!modalDestination.hasAttribute('tabindex')) modalDestination.setAttribute('tabindex', '-1');
      modalDestination.focus({ preventScroll: true });
      modalDestination = null;
    } else modalTrigger?.focus({ preventScroll: true });
  });
  element('#signal-menu-open').addEventListener('click', () => {
    menu.showModal();
    document.body.classList.add('studio-dialog-open');
  });
  element('#signal-menu-close').addEventListener('click', () => menu.close());
  menu.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!link) return;
    menuDestination = document.getElementById((link.getAttribute('href') ?? '').slice(1));
    menu.close();
  });
  menu.addEventListener('close', () => {
    document.body.classList.remove('studio-dialog-open');
    if (menuDestination) {
      if (!menuDestination.hasAttribute('tabindex')) menuDestination.setAttribute('tabindex', '-1');
      menuDestination.focus({ preventScroll: true });
      menuDestination = null;
    } else element('#signal-menu-open').focus({ preventScroll: true });
  });

  document.querySelectorAll('.magnetic-control').forEach((control) => {
    if (!(control instanceof HTMLElement)) return;
    control.addEventListener('pointermove', (event) => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || event.pointerType !== 'mouse') return;
      const rect = control.getBoundingClientRect();
      control.style.setProperty('--magnet-x', `${(event.clientX - rect.left - rect.width / 2) * .11}px`);
      control.style.setProperty('--magnet-y', `${(event.clientY - rect.top - rect.height / 2) * .11}px`);
    });
    control.addEventListener('pointerleave', () => {
      control.style.setProperty('--magnet-x', '0px');
      control.style.setProperty('--magnet-y', '0px');
    });
  });
}
