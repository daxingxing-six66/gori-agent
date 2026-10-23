/**
 * Curated product stories, using fictional data only. Nothing in this package
 * calls Gori, SSH, a model provider, or a remote file system.
 * @typedef {{ title: string, response: string, tool: string, detail: string,
 * status: string, result: string, action: string }} DemoStep
 * @typedef {{ title: string, prompt: string, panel: string, icon: string,
 * caption: string, steps: DemoStep[] }} DemoScenario
 */

/** @param {string} command @param {string} output */
function terminal(command, output) {
  return `<pre class="terminal-output"><code><span class="terminal-prompt">gori@my-linux</span> <span class="terminal-path">~</span>\n<span class="terminal-dollar">$</span> ${command}\n\n${output}</code></pre>`;
}

const memoryOutput = `               total    used    free   available
Mem:           7.8Gi   2.1Gi   4.8Gi       5.2Gi
Swap:          2.0Gi      0B   2.0Gi

<span class="terminal-success">✓ Command completed</span> <span class="terminal-dim">· exit 0</span>`;

/** @type {Record<string, DemoScenario>} */
export const scenarios = {
  inspect: {
    title: '服务器状态检查',
    prompt: '帮我看看这台服务器的内存使用情况。',
    panel: 'Terminal', icon: 'terminal', caption: '命令与结果，清楚可见',
    steps: [
      { title: '理解目标', response: '先用 free -h 读取内存信息，再根据 available 和 Swap 判断当前余量。', tool: 'remote_server_call', detail: 'free -h', status: '等待运行示例', action: '运行示例', result: terminal('free -h', '<span class="terminal-dim"># 点击「运行示例」读取示例输出\n# 本演示不会连接远程服务器。</span>\n\n<span class="terminal-cursor">_</span>') },
      { title: '查看执行', response: '内存信息已经返回。命令和完整输出都在右侧，可以随时对照。', tool: 'remote_server_call', detail: 'free -h · 已完成', status: '命令完成 · 示例数据', action: '看看 Gori 的解读', result: terminal('free -h', memoryOutput) + '<div class="memory-visual"><div><span>内存使用</span><b>2.1 <small>/ 7.8 GiB</small></b></div><div class="memory-track"><i></i></div><p><span class="status-dot"></span>可用内存 5.2 GiB <span>Swap 未使用</span></p></div>' },
      { title: '读懂结果', response: '这份示例里，可用内存约 5.2 GiB，Swap 尚未使用，暂未看到明显的内存压力。若还想排查占用，可以继续查看进程。', tool: '结果解读', detail: '依据 free -h 的 available 与 Swap 字段', status: '示例结束 · 可以继续切换其他场景', action: '再演示一次', result: terminal('free -h', memoryOutput) + '<div class="terminal-summary"><span>OBSERVATION</span><p>从原始输出，到可以理解的结论。</p><small>同一会话中继续提问，保留操作上下文。</small></div>' },
    ],
  },
  deploy: {
    title: '发布 my-app 服务', prompt: '帮我把 my-app 部署到服务器，先给我看看计划。',
    panel: 'Deploy', icon: 'box', caption: '先看计划，再分阶段执行',
    steps: [
      { title: '审阅计划', response: '我整理了这次发布的四个阶段。先确认计划，再开始构建；命令需要的权限仍会单独审批。', tool: 'deployment_propose_plan', detail: 'my-app · 计划待确认', status: '待确认演示计划', action: '确认演示计划', result: '<div class="plan-preview"><p class="panel-kicker">DEPLOYMENT PLAN</p><h3>my-app <span>待确认</span></h3><ol class="plan-stages"><li><b>01</b><div>本地构建<code>npm run build</code></div></li><li><b>02</b><div>上传产物<code>dist/app.js → /srv/my-app/app.js</code></div></li><li><b>03</b><div>重启服务<code>systemctl restart my-app</code></div></li><li><b>04</b><div>健康验证<code>curl localhost:8080/health</code></div></li></ol><p class="panel-fine-print">此处为交互示意。真实计划取决于项目与部署配置。</p></div>' },
      { title: '构建', response: '演示计划已确认。第一阶段在本机构建项目，并检查产物。', tool: 'deployment_execute_next', detail: 'build · 本地构建完成', status: '1 / 4 · 构建完成', action: '继续看上传', result: pipeline(0) + terminal('npm run build', '<span class="terminal-dim"># 本地构建 · 示例日志</span>\n\nBuilding my-app…\nBundling source files…\nOutput: dist/app.js\n\n<span class="terminal-success">✓ Build completed</span>') },
      { title: '上传', response: '构建产物通过 SFTP 上传到部署配置允许的目录，传输进度可以直接查看。', tool: 'deployment_execute_next', detail: 'upload · 产物上传完成', status: '2 / 4 · 上传完成', action: '继续看重启', result: pipeline(1) + '<div class="transfer-preview"><span class="transfer-icon">↑</span><h3>app.js</h3><p>dist/app.js → /srv/my-app/app.js</p><div class="transfer-track"><i></i></div><div class="transfer-meta"><span>128 KiB / 128 KiB</span><b>100%</b></div><p class="terminal-success">✓ SFTP 上传完成 · 示例</p></div>' },
      { title: '重启', response: '产物上传完成。这份示例假定重启命令已获得所需审批，再由远端执行服务重启。', tool: 'deployment_execute_next', detail: 'restart · 已完成（示例已审批）', status: '3 / 4 · 重启完成', action: '继续看验证', result: pipeline(2) + terminal('systemctl restart my-app', '<span class="terminal-dim"># 已完成所需审批 · 示例日志</span>\n\n<span class="terminal-success">✓ Service restarted</span>\n\n<span class="terminal-dim">下一步：检查服务健康状态。</span>') },
      { title: '验证', response: '这份示例的健康检查返回正常。必要阶段完成后，由 Agent 明确结束部署，执行日志仍可回看。', tool: 'deployment_finish', detail: 'my-app · 示例部署成功结束', status: '4 / 4 · 示例部署已结束', action: '再演示一次', result: pipeline(3) + terminal('curl localhost:8080/health', '{\n  <span class="terminal-success">"status": "UP"</span>\n}\n\n<span class="terminal-success">✓ Health check passed</span>\n<span class="terminal-dim">部署已明确结束 · 示例</span>') },
    ],
  },
  diagnose: {
    title: '排查服务 502', prompt: '/diagnose 我的服务突然返回 502，帮我排查一下。',
    panel: 'Diagnose', icon: 'search', caption: '记录证据，再形成结论',
    steps: [
      { title: '建立方向', response: '先确认反向代理与上游服务状态，再看错误日志。每个诊断方向分别记录，避免把猜测当成结论。', tool: 'diagnose_update', detail: '当前方向：确认 502 来自哪里', status: '诊断中 · 示例', action: '检查服务与日志', result: diagnosis(0) },
      { title: '读取日志', response: '示例日志显示 Nginx 连接 8080 端口被拒绝。这个证据只能说明连接失败，暂时还不能确定原因。', tool: 'remote_server_call', detail: '读取服务状态与错误日志 · 已完成', status: '发现线索 · 尚未确定根因', action: '核对上游配置', result: diagnosis(1) + '<pre class="diagnose-code"><code><span class="terminal-dim"># 示例 Nginx 错误日志</span>\nconnect() failed (111: Connection refused)\nupstream: "http://127.0.0.1:8080/"</code></pre>' },
      { title: '核对证据', response: '这份示例中，应用监听 8081，而代理指向 8080，两处配置不一致。现在可以把端口不匹配记录为已确认事实。', tool: 'diagnose_update', detail: '端口配置不匹配 · 已确认', status: '已确认示例中的配置不一致', action: '查看诊断结论', result: diagnosis(2) + '<div class="port-comparison"><div><span>NGINX UPSTREAM</span><b>:8080</b></div><span>≠</span><div><span>APPLICATION</span><b>:8081</b></div></div>' },
      { title: '保存结论', response: '示例结论已保存：代理与应用端口不一致。建议统一端口并重新验证。实际排障会区分已确认事实与仍需验证的方向。', tool: 'diagnose_finish', detail: '结论已保存 · 可独立阅读', status: '示例诊断结束', action: '再演示一次', result: '<article class="diagnosis-report"><p class="panel-kicker">DIAGNOSIS REPORT / 示例</p><h3>服务 502 排查结论</h3><span class="report-tag">已确认</span><h4>上游端口配置不一致</h4><p>Nginx 指向 8080，应用监听 8081。连接被拒绝与此配置差异一致。</p><h4>下一步建议</h4><p>检查目标配置，将端口统一后，再验证代理连通性与接口响应。</p><div class="report-note">结论保存为独立报告，诊断记录可回看。</div></article>' },
    ],
  },
  files: {
    title: '浏览远程文件', prompt: '打开 my-app 的日志，我想看看最近发生了什么。',
    panel: 'Files', icon: 'folder', caption: '从远程目录，到文件内容',
    steps: [
      { title: '浏览目录', response: '可以通过 SFTP 浏览远程目录。试着打开 logs，或者先看看 config 里的示例配置。', tool: 'SFTP 文件浏览', detail: '/srv/my-app · 远程目录', status: '选择一个示例目录', action: '打开日志目录', result: fileListing('/srv/my-app', [{ name: 'logs', type: '目录', action: 'logs' }, { name: 'config', type: '目录', action: 'config' }, { name: 'app.js', type: '128 KiB' }]) },
      { title: '查看文件', response: 'logs 目录中有一份应用日志。打开它，查看下载到本地后的文本预览示例。', tool: 'SFTP 文件浏览', detail: '/srv/my-app/logs', status: '日志目录 · 示例', action: '预览应用日志', result: fileListing('/srv/my-app/logs', [{ name: '..', type: '返回上级', action: 'parent' }, { name: 'application.log', type: '24 KiB', action: 'preview' }]) },
      { title: '阅读日志', response: '下载后的日志可以在阅读器查看，不用在终端与文件工具之间反复切换。这里展示的是预设的示例文本。', tool: 'sftp_download → 文件阅读器', detail: 'application.log · 示例预览', status: '文件预览 · 示例内容', action: '再演示一次', result: '<div class="file-preview-title"><span>▤ application.log</span><span>UTF-8 · 示例</span></div><pre class="file-content"><code><span class="line-number">1</span> 10:00:01 <span class="terminal-success">INFO</span>  Starting my-app\n<span class="line-number">2</span> 10:00:02 <span class="terminal-success">INFO</span>  Listening on :8081\n<span class="line-number">3</span> 10:00:02 <span class="terminal-success">INFO</span>  Health endpoint ready\n<span class="line-number">4</span> 10:01:15 <span class="terminal-success">INFO</span>  GET /health 200\n<span class="line-number">5</span> 10:02:08 <span class="terminal-success">INFO</span>  Request completed</code></pre><div class="file-preview-note">浏览目录、传输文件、阅读文本，留在同一个工作区。</div>' },
    ],
  },
};

/** @param {number} completed */
function pipeline(completed) {
  return `<div class="demo-pipeline">${['构建', '上传', '重启', '验证'].map((label, index) => `<span class="${index <= completed ? 'is-complete' : ''}"><b>${index <= completed ? '✓' : index + 1}</b>${label}</span>`).join('')}</div>`;
}

/** @param {number} phase */
function diagnosis(phase) {
  return `<div class="diagnosis-nodes"><p class="panel-kicker">DIAGNOSIS RECORDS</p>${['确认代理返回 502', '读取上游连接错误', '核对应用监听端口'].map((label, index) => `<div class="diagnosis-node ${index <= phase ? 'is-current' : ''}"><b>${index < phase || phase === 2 ? '✓' : index + 1}</b><span>${label}<small>${index < phase || phase === 2 ? '已确认' : index === phase ? '诊断中' : '待排查'}</small></span></div>`).join('')}</div>`;
}

/** @param {string} path @param {{ name: string, type: string, action?: string }[]} entries */
function fileListing(path, entries) {
  return `<div class="file-browser"><div class="file-breadcrumb">SFTP <span>/</span> ${path}</div><div class="file-table-head"><span>名称</span><span>大小 / 类型</span></div>${entries.map((entry) => `<div class="file-row"><span class="file-row-icon">${entry.action === 'logs' || entry.action === 'config' ? '▱' : '▤'}</span>${entry.action ? `<button data-file-action="${entry.action}">${entry.name}<span>↗</span></button>` : `<span>${entry.name}</span>`}<small>${entry.type}</small></div>`).join('')}<div class="file-browser-note">点按目录或文件名，探索示例内容。</div></div>`;
}

export const configPreview = '<div class="file-preview-title"><button data-file-action="parent">← 返回目录</button><span>config / app.yml</span></div><pre class="file-content"><code><span class="line-number">1</span> <span class="terminal-success">server:</span>\n<span class="line-number">2</span>   port: 8081\n<span class="line-number">3</span> <span class="terminal-success">logging:</span>\n<span class="line-number">4</span>   level: info\n<span class="line-number">5</span>   file: logs/application.log</code></pre><div class="file-preview-note">示例配置。实际文件需先通过 SFTP 下载，再打开阅读器。</div>';
