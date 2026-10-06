// Tiny perf overlay (?debug=1 or the ` key): fps, frame time, draw calls, triangles, etc.
export class DebugOverlay {
  constructor(container = document.body) {
    const el = document.createElement('pre');
    el.className = 'core-debug';
    el.style.display = 'none';
    container.appendChild(el);
    this.el = el;
    this.visible = false;
    this.acc = 0;
    this.frames = 0;
    this.worst = 0;
  }

  toggle(v = !this.visible) {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  update(realDt, info) {
    this.frames++;
    this.acc += realDt;
    if (realDt > this.worst) this.worst = realDt;
    if (!this.visible || this.acc < 0.25) return;
    const fps = this.frames / this.acc;
    const r = info.renderer.info;
    this.el.textContent =
      `${fps.toFixed(0).padStart(3)} fps  ${(1000 / fps).toFixed(1)} ms  worst ${(this.worst * 1000).toFixed(1)} ms\n` +
      `calls ${r.render.calls}  tris ${(r.render.triangles / 1000).toFixed(0)}k  pts ${r.render.points}  lines ${r.render.lines}\n` +
      `geo ${r.memory.geometries}  tex ${r.memory.textures}  prog ${r.programs ? r.programs.length : '-'}\n` +
      `pr ${info.pixelRatio.toFixed(2)}  ${info.width}x${info.height}  cam ${info.camMode}\n` +
      `${info.state}  ${info.speed.toFixed(0)} km/h  s ${info.s.toFixed(0)}  lat ${info.lateral.toFixed(1)}` +
      (info.prof
        ? `\ncpu ms  sim ${info.prof.sim.toFixed(2)}  fx ${info.prof.fx.toFixed(2)}  world ${info.prof.world.toFixed(2)}  ui ${info.prof.ui.toFixed(2)}  render ${info.prof.render.toFixed(2)}`
        : '');
    this.acc = 0;
    this.frames = 0;
    this.worst = 0;
  }
}
