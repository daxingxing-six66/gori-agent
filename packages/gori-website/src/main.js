import { initializeDemo } from './demo.js';
import { element } from './dom.js';
import { initializeDesign } from './designs.js';

initializeDesign();

const repositoryUrl = 'https://github.com/daxingxing-six66/gori-agent';
document.querySelectorAll('[data-repo], [data-repo-path]').forEach((link) => {
  if (!(link instanceof HTMLAnchorElement)) return;
  const path = link.getAttribute('data-repo-path');
  link.href = path ? `${repositoryUrl}/${path}` : repositoryUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
});

initializeDemo();

const menuButton = element('#menu-toggle');
const navigation = element('#nav-links');
menuButton.hidden = false;
/** @param {boolean} open */
function toggleMenu(open) {
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  navigation.classList.toggle('is-open', open);
}
menuButton.addEventListener('click', () => toggleMenu(menuButton.getAttribute('aria-expanded') !== 'true'));
navigation.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('a')) toggleMenu(false);
});
document.addEventListener('click', (event) => {
  if (event.target instanceof Element && !event.target.closest('.nav')) toggleMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
    toggleMenu(false);
    menuButton.focus();
  }
});

const approve = element('#approval-allow');
const reject = element('#approval-reject');
const reset = element('#approval-reset');
const badge = element('#approval-badge');
const feedback = element('#approval-feedback');
const approvalActions = element('.approval-actions');
approvalActions.hidden = false;

/** @param {boolean} allowed */
function decide(allowed) {
  badge.textContent = allowed ? '示例已批准' : '示例已拒绝';
  badge.className = `approval-badge ${allowed ? 'allowed' : 'rejected'}`;
  feedback.textContent = allowed ? '你批准了这个示例。真实使用中，授权仅用于对应的这次操作。' : '你拒绝了这个示例。这条操作没有获得执行授权。';
  approve.setAttribute('disabled', '');
  reject.setAttribute('disabled', '');
  reset.hidden = false;
  reset.focus({ preventScroll: true });
}
approve.addEventListener('click', () => decide(true));
reject.addEventListener('click', () => decide(false));
reset.addEventListener('click', () => {
  badge.textContent = '等待你的审批';
  badge.className = 'approval-badge';
  feedback.textContent = '试着做一个决定。这里不会执行真实命令。';
  approve.removeAttribute('disabled');
  reject.removeAttribute('disabled');
  reset.hidden = true;
  approve.focus({ preventScroll: true });
});

const copy = element('#copy-install');
copy.hidden = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimeout;
copy.addEventListener('click', async () => {
  const command = element('#install-command');
  const toast = element('#toast');
  try {
    await navigator.clipboard.writeText(command.textContent ?? '');
    toast.textContent = '安装命令已复制';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(command);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    toast.textContent = '浏览器未允许复制，命令已选中，请手动复制。';
  }
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 4200);
});
