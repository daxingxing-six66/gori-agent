"use strict";

if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s#?]+\/?$/.test(GITHUB_REPO_URL)) {
  document.querySelectorAll("[data-github]").forEach((button) => {
    const link = document.createElement("a");
    link.className = button.className;
    link.textContent = button.textContent;
    link.href = GITHUB_REPO_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    button.replaceWith(link);
  });
  document.querySelectorAll("[data-repo-note]").forEach((note) => { note.hidden = true; });
}
const dialog = document.querySelector("dialog");
const enlargedImage = dialog.querySelector("img");
const caption = dialog.querySelector(".lightbox-caption");
const closeButton = dialog.querySelector(".close");
let trigger = null;
document.querySelectorAll("[data-lightbox]").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (typeof dialog.showModal !== "function" || link.classList.contains("image-error")) return;
    event.preventDefault();
    trigger = link;
    enlargedImage.src = link.href;
    enlargedImage.alt = link.querySelector("img").alt;
    caption.textContent = link.closest("figure").querySelector("figcaption").textContent;
    dialog.showModal();
    document.body.classList.add("modal-open");
    closeButton.focus();
  });
  const img = link.querySelector("img");
  const showFailure = () => {
    if (link.classList.contains("image-error")) return;
    link.classList.add("image-error");
    link.removeAttribute("href");
    link.removeAttribute("aria-label");
    const message = document.createElement("span");
    message.textContent = "截图暂时无法加载";
    link.append(message);
  };
  img.addEventListener("error", showFailure, { once: true });
  if (img.complete && img.naturalWidth === 0) showFailure();
});
closeButton.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener("close", () => {
  document.body.classList.remove("modal-open");
  trigger?.focus({ preventScroll: true });
});
