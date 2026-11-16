// The sky around the globe: the Yale Bright Star Catalog's stars (src/stars.json,
// from scripts/stars.mjs) and a faint Milky Way, where they are in the sky
// behind the camera's view of the Earth at the moment. The camera looks at
// the Earth with a bearing and pitch from above the map's centre; its
// direction, turned by Greenwich sidereal time from the Earth's frame into
// the stars', picks the patch of sky the canvas shows, which drifts as the
// globe turns. It draws on a canvas under the map's, which is transparent
// outside the sphere.
type Vector = [number, number, number];

export type StarfieldMap = {
  getContainer(): HTMLElement;
  getCanvasContainer(): HTMLElement;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  getVerticalFieldOfView(): number;
  on(type: 'move' | 'resize', listener: () => void): unknown;
};

export type Camera = { lng: number; lat: number; bearing: number; pitch: number };

// Past this zoom the globe or the sky fills the view.
const MAX_ZOOM = 8;
const RAD = Math.PI / 180;
// Finer than this the dots look no different, and the canvas takes memory.
const MAX_PIXEL_RATIO = 2;
// The Milky Way's glow is a blur, drawn at this fraction of the size and
// stretched, which saves most of the work of its many wide blobs.
const GLOW_SCALE = 1 / 4;

// Whether the globe covers the whole view, so no sky shows: looking straight
// down, its disc, MapLibre's globe radius (the Mercator world size over 2π,
// widened at the centre's latitude) seen from the camera's distance, reaches
// past the corners.
export function globeCoversView(camera: Camera, zoom: number, view: { width: number; height: number; fov: number }) {
  if (camera.pitch > 5) return false;
  const radius = (512 * 2 ** zoom) / (2 * Math.PI) / Math.cos(camera.lat * RAD);
  const focal = view.height / 2 / Math.tan((view.fov * RAD) / 2);
  const distance = radius + focal;
  const disc = (focal * radius) / Math.sqrt(distance ** 2 - radius ** 2);
  return disc > Math.hypot(view.width, view.height) / 2 + 2;
}

// Greenwich mean sidereal time, in degrees.
export function siderealDegrees(time: number) {
  const days = time / 86_400_000 + 2_440_587.5 - 2_451_545;
  return (((280.46061837 + 360.98564736629 * days) % 360) + 360) % 360;
}

function unit(longitude: number, latitude: number): Vector {
  const cos = Math.cos(latitude * RAD);
  return [cos * Math.cos(longitude * RAD), cos * Math.sin(longitude * RAD), Math.sin(latitude * RAD)];
}

const add = (a: Vector, b: Vector, sa: number, sb: number): Vector => [
  a[0] * sa + b[0] * sb,
  a[1] * sa + b[1] * sb,
  a[2] * sa + b[2] * sb,
];

// The camera's look, right and up directions among the stars (equatorial,
// J2000): above the centre (up U), looking down and tilted by the pitch
// toward the bearing (forward F); the Earth's longitudes are right ascensions
// turned back by the sidereal time.
export function cameraBasis(camera: Camera, time: number) {
  const lng = camera.lng + siderealDegrees(time);
  const up = unit(lng, camera.lat);
  const east = unit(lng + 90, 0);
  const north = unit(lng + 180, 90 - camera.lat);
  const bearing = camera.bearing * RAD;
  const pitch = camera.pitch * RAD;
  const forward = add(north, east, Math.cos(bearing), Math.sin(bearing));
  return {
    look: add(up, forward, -Math.cos(pitch), Math.sin(pitch)),
    right: add(east, north, Math.cos(bearing), -Math.sin(bearing)),
    up: add(up, forward, Math.sin(pitch), Math.cos(pitch)),
  };
}

// Points of light sharing a look, drawn with one path.
type Group = { style: string; radius: number; points: Float32Array; soft?: boolean };

// A star's color from its temperature, paled toward white as the eye sees them.
function starColor(kelvin: number) {
  const t = kelvin / 100;
  const red = t <= 66 ? 255 : 329.7 * (t - 60) ** -0.1332;
  const green = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * (t - 60) ** -0.0755;
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  const pale = (value: number) => Math.round(255 - (255 - Math.min(255, Math.max(0, value))) * 0.45);
  return [pale(red), pale(green), pale(blue)];
}

// Stars by half magnitude and by color, brighter ones larger and more opaque.
export function starGroups(stars: ArrayLike<number>): Group[] {
  const groups = new Map<string, { style: string; radius: number; points: number[] }>();
  for (let index = 0; index < stars.length; index += 4) {
    const magnitude = Math.round(stars[index + 2] * 2) / 2;
    const kelvin = Math.round(stars[index + 3] / 10) * 1000;
    const key = `${magnitude}|${kelvin}`;
    let group = groups.get(key);
    if (!group) {
      const [red, green, blue] = starColor(kelvin);
      const alpha = Math.min(1, Math.max(0.25, (7 - magnitude) / 4.5));
      const radius = Math.min(2.6, Math.max(0.45, 0.45 + (6.5 - magnitude) * 0.3));
      group = { style: `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(2)})`, radius, points: [] };
      groups.set(key, group);
    }
    group.points.push(...unit(stars[index], stars[index + 1]));
  }
  // Faint first, so the bright ones draw over them.
  return [...groups.values()]
    .sort((a, b) => a.radius - b.radius)
    .map((group) => ({ ...group, points: Float32Array.from(group.points) }));
}

// The galactic plane in equatorial coordinates (J2000).
const NORTH_GALACTIC_POLE = { ra: 192.85948, dec: 27.12825, l: 122.93192 };

function galacticToEquatorial(l: number, b: number): Vector {
  const pole = NORTH_GALACTIC_POLE;
  const sinDec =
    Math.sin(b * RAD) * Math.sin(pole.dec * RAD) +
    Math.cos(b * RAD) * Math.cos(pole.dec * RAD) * Math.cos((pole.l - l) * RAD);
  const ra =
    pole.ra +
    Math.atan2(
      Math.cos(b * RAD) * Math.sin((pole.l - l) * RAD),
      Math.sin(b * RAD) * Math.cos(pole.dec * RAD) -
        Math.cos(b * RAD) * Math.sin(pole.dec * RAD) * Math.cos((pole.l - l) * RAD),
    ) /
      RAD;
  return unit(ra, Math.asin(sinDec) / RAD);
}

// The Milky Way along the galactic plane, densest and widest toward the
// galactic centre in Sagittarius, from a fixed seed so it looks the same
// every time: a glow of soft blobs that add up where the band is dense, and
// a grain of faint specks.
export function milkyWay(count = 9000): Group[] {
  let seed = 7;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const gaussian = () => Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
  const point = () => {
    for (;;) {
      const l = random() * 360;
      const core = Math.exp(-((Math.min(l, 360 - l) / 45) ** 2));
      if (random() > 0.25 + 0.75 * core) continue;
      return galacticToEquatorial(l, gaussian() * (3.5 + 6 * core));
    }
  };
  const points = (n: number) => Float32Array.from(Array.from({ length: n }, point).flat());
  return [
    { style: 'rgba(170, 185, 225, 0.03)', radius: 20, points: points((count * 2) / 3), soft: true },
    { style: 'rgba(210, 218, 240, 0.16)', radius: 0.6, points: points(count / 2) },
    { style: 'rgba(210, 218, 240, 0.28)', radius: 0.6, points: points(count / 2) },
  ];
}

// A soft white blob, fading out from its centre, for the Milky Way's glow.
let blob: HTMLCanvasElement | null = null;
function softBlob() {
  if (blob) return blob;
  blob = document.createElement('canvas');
  blob.width = blob.height = 64;
  const context = blob.getContext('2d');
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.45)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return blob;
}

// A blob tinted as the group's style, its opacity kept for drawing.
function tintedBlob(style: string) {
  const [, red, green, blue, alpha] = style.match(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/).map(Number);
  const tinted = document.createElement('canvas');
  tinted.width = tinted.height = 64;
  const context = tinted.getContext('2d');
  context.drawImage(softBlob(), 0, 0);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
  context.fillRect(0, 0, 64, 64);
  return { image: tinted, alpha };
}
const blobs = new Map<string, { image: HTMLCanvasElement; alpha: number }>();

// Draws the groups onto a context whose transform maps the view's CSS pixels.
export function drawSky(
  context: CanvasRenderingContext2D,
  groups: Group[],
  camera: Camera,
  time: number,
  view: { width: number; height: number; fov: number },
) {
  const { width, height } = view;
  context.clearRect(0, 0, width, height);
  const { look, right, up } = cameraBasis(camera, time);
  const focal = height / 2 / Math.tan((view.fov * RAD) / 2);
  const cx = width / 2;
  const cy = height / 2;
  for (const { style, radius, points, soft } of groups) {
    // Soft blobs are drawn one by one, so they add up; points share a path.
    if (soft && !blobs.has(style)) blobs.set(style, tintedBlob(style));
    const image = soft ? blobs.get(style) : null;
    context.globalAlpha = image ? image.alpha : 1;
    context.fillStyle = style;
    context.beginPath();
    for (let index = 0; index < points.length; index += 3) {
      const x = points[index];
      const y = points[index + 1];
      const z = points[index + 2];
      const depth = x * look[0] + y * look[1] + z * look[2];
      if (depth <= 0.05) continue;
      const sx = cx + (focal * (x * right[0] + y * right[1] + z * right[2])) / depth;
      const sy = cy - (focal * (x * up[0] + y * up[1] + z * up[2])) / depth;
      if (sx < -radius || sy < -radius || sx > width + radius || sy > height + radius) continue;
      if (image) {
        context.drawImage(image.image, sx - radius, sy - radius, radius * 2, radius * 2);
      } else {
        context.moveTo(sx + radius, sy);
        context.arc(sx, sy, radius, 0, 2 * Math.PI);
      }
    }
    if (!image) context.fill();
  }
  context.globalAlpha = 1;
}

// A canvas under the map's, sized to the view at `scale` canvas pixels per
// CSS pixel and stretched back over it by CSS (style.css).
function skyLayer(map: StarfieldMap, className: string) {
  const canvas = document.createElement('canvas');
  canvas.className = `starfield ${className}`;
  canvas.setAttribute('aria-hidden', 'true');
  map.getContainer().insertBefore(canvas, map.getCanvasContainer());
  const context = canvas.getContext('2d');
  return {
    context,
    // Clears it and sets its size, if that changed; zero lets go of its pixels.
    fit(width: number, height: number, scale: number) {
      const pixelWidth = Math.round(width * scale);
      const pixelHeight = Math.round(height * scale);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
    },
  };
}

export function installStarfield(map: StarfieldMap, now: () => number = Date.now) {
  // The Milky Way's glow on a small canvas the browser stretches, the stars
  // over it at the screen's resolution.
  const glowLayer = skyLayer(map, 'starfield-glow');
  const starLayer = skyLayer(map, 'starfield-stars');
  if (!glowLayer.context || !starLayer.context) return;
  const haze = milkyWay();
  const glow = haze.filter((group) => group.soft);
  let stars = haze.filter((group) => !group.soft);
  let frame = 0;

  const draw = () => {
    frame = 0;
    const container = map.getContainer();
    const { lng, lat } = map.getCenter();
    const camera = { lng, lat, bearing: map.getBearing(), pitch: map.getPitch() };
    const view = { width: container.clientWidth, height: container.clientHeight, fov: map.getVerticalFieldOfView() };
    if (map.getZoom() > MAX_ZOOM || globeCoversView(camera, map.getZoom(), view)) {
      glowLayer.fit(0, 0, 1);
      starLayer.fit(0, 0, 1);
      return;
    }
    const time = now();
    glowLayer.fit(view.width, view.height, GLOW_SCALE);
    drawSky(glowLayer.context, glow, camera, time, view);
    starLayer.fit(view.width, view.height, Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    drawSky(starLayer.context, stars, camera, time, view);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  map.on('move', schedule);
  map.on('resize', schedule);
  schedule();
  void import('./stars.json').then(({ default: catalog }) => {
    stars = [...stars, ...starGroups(catalog as number[])];
    schedule();
  });
}
