import { createHash } from "node:crypto";

const styles = `
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #202820; background: #f6f8f3; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; padding: 32px 20px; }
main { width: 100%; max-width: 480px; padding: 36px; background: #fff; border: 1px solid #e0e6dc; border-radius: 24px; box-shadow: 0 16px 56px rgb(32 40 32 / 5%); }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 40px; font-size: 19px; font-weight: 650; letter-spacing: -.4px; }
.brand-mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: #397b5c; color: #fff; font-size: 20px; }
.check { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 24px; border: 1px solid #d9e8df; border-radius: 50%; background: #edf4f0; color: #397b5c; }
.check svg { width: 28px; height: 28px; }
.eyebrow { margin: 0 0 10px; color: #397b5c; font-size: 13px; font-weight: 600; }
h1 { margin: 0; font-size: 26px; line-height: 1.4; font-weight: 650; letter-spacing: -.6px; }
.description { margin: 16px 0 0; color: #49574b; font-size: 15px; line-height: 1.8; }
.english { margin: 12px 0 0; max-width: 340px; color: #6b776d; font-size: 13px; line-height: 1.7; }
footer { display: flex; align-items: center; gap: 8px; margin-top: 32px; padding-top: 20px; border-top: 1px solid #e4e8df; color: #6b776d; font-size: 12px; line-height: 1.7; }
.dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: #397b5c; }
@media (max-width: 420px) { main { padding: 28px 24px; border-radius: 20px; } .brand { margin-bottom: 32px; } h1 { font-size: 23px; } }
`;

/** Static confirmation only: never interpolate callback parameters or account credentials. */
export const chatGptCallbackSuccess = {
	body: `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT 授权完成 · Gori</title>
<style>${styles}</style>
</head>
<body>
<main aria-labelledby="title">
	<div class="brand"><span class="brand-mark" aria-hidden="true">G</span>Gori</div>
	<div class="check" aria-hidden="true">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4 10-10"/></svg>
	</div>
	<p class="eyebrow">ChatGPT 订阅</p>
	<h1 id="title">ChatGPT 授权已完成</h1>
	<p class="description">请返回 Gori 查看连接结果。</p>
	<p class="english" lang="en">Authorization received. Return to Gori to check your connection.</p>
	<footer><span class="dot" aria-hidden="true"></span>你可以关闭此页面，回到 Gori 继续操作。</footer>
</main>
</body>
</html>`,
	headers: {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"content-security-policy": `default-src 'none'; style-src 'sha256-${createHash("sha256").update(styles).digest("base64")}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
	},
};
