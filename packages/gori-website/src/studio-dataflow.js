/**
 * An original terminal field, projected from a small three-dimensional world.
 * This is visual storytelling with fixed example text; there is no connection
 * to a shell, model, file system, or server.
 *
 * @typedef {{command: string, result: string, detail: string, lines: string[], labels: string[]}} FlowSample
 * @typedef {{time: number, progress: number, pointerX: number, pointerY: number, pulse: number, sample?: FlowSample}} FlowFrame
 * @typedef {{x: number, y: number, z: number}} WorldPoint
 * @typedef {{x: number, y: number, scale: number, depth: number}} ScreenPoint
 */

const TAU = Math.PI * 2;
const FONT = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';
const TEXT = [
  'ssh', 'sudo', 'free -h', 'stdout', '0x01', '0101', 'PTY', 'SFTP',
  'read()', 'exit 0', 'grep', 'tail -n', 'stream', '>|', '::', '/srv',
  'await', 'return', 'EXEC', 'agent', 'pid', 'chmod', 'cat', '00',
  '::1', 'input', 'output', '1024', 'sys', 'ps aux', 'sh', 'ls -la',
];
const EXAMPLE_LINES = [
  '$ ssh workspace',
  'connection established',
  '$ free -h',
  'Mem: 7.8Gi  2.1Gi  5.2Gi',
  'exit 0',
];

/** @param {number} value */
function clamp(value) { return Math.max(0, Math.min(1, value)); }
/** @param {number} from @param {number} to @param {number} amount */
function mix(from, to, amount) { return from + (to - from) * amount; }
/** @param {number} from @param {number} to @param {number} value */
function smooth(from, to, value) {
  const t = clamp((value - from) / (to - from));
  return t * t * (3 - 2 * t);
}
/** @param {number} value */
function seed(value) {
  const raw = Math.sin(value * 127.1 + 311.7) * 43758.5453123;
  return raw - Math.floor(raw);
}

/**
 * The owner supplies timing, scroll progress, pointer state, and lifecycle.
 * This renderer deliberately owns no RAF, observers, or input listeners.
 * @param {HTMLCanvasElement} canvas
 * @returns {{draw: (frame: FlowFrame) => void, resize: () => void, dispose: () => void}}
 */
export function createTerminalFlow(canvas) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return { draw() {}, resize() {}, dispose() {} };
  const ctx = context;
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  let disposed = false;
  let mobile = false;

  const points = Array.from({ length: 640 }, (_, index) => ({
    index,
    lane: index % 24,
    offset: seed(index + 1),
    radius: 2.6 + seed(index + 17) * 2.1,
    speed: 0.4 + seed(index + 31) * 0.7,
    text: TEXT[Math.floor(seed(index + 79) * TEXT.length)],
    tone: seed(index + 111),
  }));
  const fonts = Array.from({ length: 33 }, (_, size) => `${Math.max(5, size)}px ${FONT}`);

  /** @type {FlowFrame} */
  let current = { time: 0, progress: 0, pointerX: 0, pointerY: 0, pulse: 0 };
  let centreX = 0;
  let centreY = 0;
  let unit = 1;
  let yaw = 0;
  let pitch = 0;
  let bank = 0;

  function resize() {
    if (disposed) return;
    const bounds = canvas.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    mobile = width < 700;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.45, 1600 / width);
    const targetWidth = Math.max(1, Math.round(width * pixelRatio));
    const targetHeight = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  /** @param {WorldPoint} point @returns {ScreenPoint} */
  function project(point) {
    const x = point.x * Math.cos(yaw) + point.z * Math.sin(yaw);
    const z = point.z * Math.cos(yaw) - point.x * Math.sin(yaw);
    const y = point.y * Math.cos(pitch) - z * Math.sin(pitch);
    const depth = Math.max(0.7, z * Math.cos(pitch) + point.y * Math.sin(pitch) + 5.4);
    const scale = 5.4 / depth;
    const bx = x * Math.cos(bank) - y * Math.sin(bank);
    const by = x * Math.sin(bank) + y * Math.cos(bank);
    return { x: centreX + bx * unit * scale, y: centreY + by * unit * scale, scale, depth };
  }

  /** @param {WorldPoint[]} vertices @param {string} color @param {number} lineWidth */
  function path(vertices, color, lineWidth = 1) {
    if (vertices.length === 0) return;
    ctx.beginPath();
    vertices.forEach((vertex, index) => {
      const p = project(vertex);
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  /** @param {number} depth @param {number} halfWidth @param {number} halfHeight @param {string} color */
  function frame(depth, halfWidth, halfHeight, color) {
    path([
      { x: -halfWidth, y: -halfHeight, z: depth },
      { x: halfWidth, y: -halfHeight, z: depth },
      { x: halfWidth, y: halfHeight, z: depth },
      { x: -halfWidth, y: halfHeight, z: depth },
      { x: -halfWidth, y: -halfHeight, z: depth },
    ], color);
  }

  function background() {
    ctx.fillStyle = '#07090e';
    ctx.fillRect(0, 0, width, height);
    const halo = ctx.createRadialGradient(centreX, centreY, 0, centreX, centreY, Math.max(width, height) * .68);
    halo.addColorStop(0, 'rgba(28, 43, 79, 0.36)');
    halo.addColorStop(.43, 'rgba(13, 20, 38, 0.18)');
    halo.addColorStop(1, 'rgba(7, 9, 14, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, height);

    // A quiet display texture rather than a full-screen scanline effect.
    ctx.fillStyle = 'rgba(186, 202, 230, 0.016)';
    for (let y = 0; y < height; y += 6) ctx.fillRect(0, y, width, 1);
  }

  function corridor() {
    const progress = clamp(current.progress);
    const travel = current.time * (0.30 + smooth(.4, .7, progress) * .65) + progress * 12;
    const tunnel = smooth(.31, .6, progress) * (1 - smooth(.8, 1, progress));
    const emphasis = 0.22 + tunnel * .65;
    const halfWidth = mix(3.3, 4.8, tunnel);
    const halfHeight = mix(2.05, 2.7, tunnel);

    for (let index = 0; index < 17; index += 1) {
      const z = ((index * 1.5 - travel % 1.5) + 25.5) % 25.5;
      const alpha = (1 - z / 27) * .17 * emphasis;
      frame(z, halfWidth, halfHeight, `rgba(109, 139, 210, ${alpha})`);
    }
    for (let index = 0; index < 8; index += 1) {
      const side = index % 2 ? -1 : 1;
      const offset = Math.floor(index / 2) / 3;
      const start = { x: side * halfWidth, y: mix(-halfHeight, halfHeight, offset), z: -.2 };
      path([start, { ...start, z: 27 }], `rgba(128, 160, 229, ${.045 + tunnel * .07})`);
    }

    // Data packets travel on projected rails. Their luminance briefly increases
    // when the visitor sends the example intent in the surrounding page.
    for (let index = 0; index < 13; index += 1) {
      const s = seed(index + 901);
      const z = 24 - ((current.time * (1.1 + s) + index * 1.7 + progress * 15) % 24);
      const side = index % 2 ? -1 : 1;
      const start = { x: side * halfWidth, y: (s * 2 - 1) * halfHeight, z };
      const end = { ...start, z: z + .7 + current.pulse * 1.6 };
      path([start, end], index % 5 === 0 ? 'rgba(235, 183, 120, .65)' : 'rgba(143, 175, 251, .65)', 1.2 + current.pulse);
    }
  }

  function glyphs() {
    const progress = clamp(current.progress);
    const commandPlane = smooth(.1, .32, progress) * (1 - smooth(.38, .57, progress));
    const output = smooth(.72, 1, progress);
    const time = current.time;
    const count = mobile ? 320 : points.length;
    const projected = points.slice(0, count).map((point) => {
      const depth = ((point.offset * 24 - time * point.speed * (.32 + smooth(.4, .65, progress) * 1.1)) % 24 + 24) % 24;
      const angle = point.lane / 24 * TAU + depth * .14 + time * .035;
      const wobble = Math.sin(depth * .4 + point.lane) * .2;
      let x = Math.cos(angle) * (point.radius + wobble);
      let y = Math.sin(angle) * (point.radius * .62 + wobble);
      let z = depth;

      // The field assembles into a tilted command plane, travels through a
      // corridor, then settles into an orderly output constellation.
      const column = point.index % 32;
      const row = Math.floor(point.index / 32);
      x = mix(x, (column - 15.5) * .29, commandPlane);
      y = mix(y, (row - 9.5) * .22, commandPlane);
      z = mix(z, 3.6 + Math.sin(column * .4) * .18, commandPlane);
      const outputAngle = point.index * 2.399963;
      const outputRadius = Math.sqrt(point.offset) * 4.4;
      x = mix(x, Math.cos(outputAngle) * outputRadius, output);
      y = mix(y, Math.sin(outputAngle) * outputRadius * .65, output);
      z = mix(z, 4 + seed(point.index + 411) * 5, output);

      const projectedPoint = project({ x, y, z });
      return { ...point, ...projectedPoint, z };
    });
    projected.sort((a, b) => b.depth - a.depth);

    projected.forEach((point) => {
      if (point.x < -80 || point.x > width + 80 || point.y < -30 || point.y > height + 30) return;
      const leftClearance = mobile ? .7 : .18 + smooth(width * .23, width * .48, point.x) * .82;
      const near = clamp((24 - point.z) / 24);
      const opacity = clamp((.11 + near * .68) * leftClearance + current.pulse * .18);
      const size = Math.round(Math.max(6, Math.min(27, (mobile ? 15 : 18) * point.scale)));
      ctx.font = fonts[size];
      ctx.fillStyle = point.tone > .95 ? `rgba(237, 185, 126, ${opacity})` : point.tone > .68 ? `rgba(100, 142, 255, ${opacity * .9})` : `rgba(210, 222, 242, ${opacity})`;
      ctx.fillText(point.text, point.x, point.y);

      if (near > .7 && point.index % 29 === 0) {
        ctx.fillStyle = `rgba(127, 163, 247, ${opacity * .28})`;
        ctx.fillRect(point.x - 5, point.y - size - 5, Math.min(160, point.text.length * size * .7 + 15), size + 12);
      }
    });
  }

  function command() {
    const progress = clamp(current.progress);
    const visibility = .45 + smooth(.09, .3, progress) * .55;
    const shift = smooth(.43, .64, progress);
    const finish = smooth(.75, 1, progress);
    const anchor = project({ x: -.18, y: -.1, z: .2 + shift * 1.5 });
    const fontSize = mobile ? 22 : Math.min(42, width * .031);
    const lineHeight = fontSize * 1.55;
    const startX = anchor.x - (mobile ? 125 : 180);
    const startY = anchor.y - lineHeight * .7;

    // Readable intent / command / result fragments float in the stream; they
    // have no rounded card boundary, keeping the scene continuous with scroll.
    ctx.font = `10px ${FONT}`;
    ctx.fillStyle = `rgba(153, 171, 206, ${visibility * .8})`;
    ctx.fillText(finish > .5 ? 'OUTPUT / EXAMPLE' : shift > .5 ? 'SSH CHANNEL / EXAMPLE' : 'INTENT → COMMAND', startX, startY - 34);
    ctx.font = `${fontSize}px ${FONT}`;
    ctx.fillStyle = `rgba(235, 242, 255, ${visibility})`;
    const line = finish > .5 ? (current.sample?.result ?? 'exit 0  ✓') : shift > .5 ? 'stdout →' : (current.sample?.command ?? '$ free -h');
    ctx.fillText(line, startX, startY);
    const lineWidth = ctx.measureText(line).width;
    ctx.fillStyle = `rgba(145, 173, 255, ${.52 + current.pulse * .4})`;
    ctx.fillRect(startX + lineWidth + 10, startY - fontSize * .78, Math.max(2, fontSize * .42), fontSize * .9);
    ctx.font = `${mobile ? 9 : 11}px ${FONT}`;
    ctx.fillStyle = `rgba(147, 168, 207, ${visibility * .7})`;
    const details = finish > .5 ? (current.sample?.detail ?? 'available 5.2 GiB / observation saved') : shift > .5 ? 'read · inspect · return the facts' : 'understand · prepare · await your decision';
    ctx.fillText(details, startX, startY + 29);

    const logsOpacity = smooth(.2, .34, progress) * (1 - smooth(.44, .58, progress)) + finish * .65;
    if (logsOpacity > .01) {
      const x = anchor.x - (mobile ? 125 : 180);
      const y = startY + 73;
      ctx.font = `${mobile ? 9 : 11}px ${FONT}`;
      (current.sample?.lines ?? EXAMPLE_LINES).forEach((text, index) => {
        ctx.fillStyle = index === 2 ? `rgba(204, 220, 255, ${logsOpacity})` : `rgba(128, 151, 193, ${logsOpacity * .7})`;
        ctx.fillText(text, x + index * 3, y + index * 21);
      });
    }
  }

  function outputLinks() {
    const amount = smooth(.69, 1, current.progress);
    if (amount < .01) return;
    const nodes = Array.from({ length: 9 }, (_, index) => {
      const angle = index / 9 * TAU + .2;
      return { x: Math.cos(angle) * 3.55, y: Math.sin(angle) * 2.1, z: 3 + Math.sin(angle) * .8 };
    });
    const labels = current.sample?.labels ?? ['MEMORY', '5.2 GiB', 'STDOUT', 'EXIT 0', 'SESSION', 'OBSERVED', 'SSH', 'LOGS', 'COMPLETE'];
    nodes.forEach((node, index) => {
      const p = project(node);
      const next = nodes[(index + 1) % nodes.length];
      path([node, next], `rgba(100, 139, 225, ${amount * .23})`);
      if (index % 3 === 0) path([node, nodes[(index + 4) % nodes.length]], `rgba(145, 170, 233, ${amount * .09})`);
      ctx.fillStyle = `rgba(196, 216, 255, ${amount * .75})`;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      ctx.font = `8px ${FONT}`;
      ctx.fillStyle = `rgba(150, 174, 223, ${amount * .8})`;
      ctx.fillText(labels[index], p.x + 10, p.y + 3);
    });
  }

  function vignette() {
    // Reserve a quiet reading zone on the left for the page's narrative.
    const shade = ctx.createLinearGradient(0, 0, width, 0);
    shade.addColorStop(0, 'rgba(7, 9, 14, .89)');
    shade.addColorStop(mobile ? .12 : .24, 'rgba(7, 9, 14, .63)');
    shade.addColorStop(mobile ? .65 : .5, 'rgba(7, 9, 14, 0)');
    shade.addColorStop(1, 'rgba(7, 9, 14, .03)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
    const edge = ctx.createLinearGradient(0, 0, 0, height);
    edge.addColorStop(0, 'rgba(7, 9, 14, .48)');
    edge.addColorStop(.22, 'rgba(7, 9, 14, 0)');
    edge.addColorStop(.76, 'rgba(7, 9, 14, 0)');
    edge.addColorStop(1, 'rgba(7, 9, 14, .7)');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, width, height);
  }

  /** @param {FlowFrame} value */
  function draw(value) {
    if (disposed) return;
    current = {
      time: Number.isFinite(value.time) ? value.time : 0,
      progress: clamp(value.progress),
      pointerX: Math.max(-1, Math.min(1, value.pointerX)),
      pointerY: Math.max(-1, Math.min(1, value.pointerY)),
      pulse: clamp(value.pulse),
      sample: value.sample,
    };
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    centreX = width * (mobile ? .55 : .68) + current.pointerX * (mobile ? 8 : 24);
    centreY = height * (mobile ? .43 : .49) + current.pointerY * 15;
    unit = Math.min(width * .26, height * .32);
    yaw = current.pointerX * .035 + Math.sin(current.progress * Math.PI * 2) * .055;
    pitch = -.035 + current.pointerY * .025;
    bank = Math.sin(current.time * .03) * .017 + current.pointerX * .01;
    ctx.textBaseline = 'alphabetic';
    background();
    corridor();
    glyphs();
    outputLinks();
    command();
    vignette();
  }

  function dispose() {
    disposed = true;
    ctx.clearRect(0, 0, width, height);
  }

  resize();
  return { draw, resize, dispose };
}
