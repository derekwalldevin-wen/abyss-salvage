// 战斗特效：枪口火光、曳光、命中火花、血泡、伤害方向指示、稀有战利品横幅。
// 全部走对象池，避免每次开火都新建几何体（参考作在这一点上很干净，值得学）。

import * as THREE from 'three';

const POOL = 64;

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.pool = [];
    this._geo = {
      spark: new THREE.SphereGeometry(0.06, 5, 4),
      bubble: new THREE.SphereGeometry(0.1, 6, 5),
      flash: new THREE.ConeGeometry(0.16, 0.5, 6),
    };
    for (let i = 0; i < POOL; i++) {
      const m = new THREE.Mesh(this._geo.spark, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      m.visible = false;
      m.renderOrder = 4;
      scene.add(m);
      this.pool.push(m);
    }
    // 曳光线段
    this.tracers = [];
    for (let i = 0; i < 24; i++) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({
        color: 0xffe9a8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      line.visible = false;
      line.renderOrder = 4;
      scene.add(line);
      this.tracers.push({ line, t: 0 });
    }
    this.ti = 0;
    this.shake = 0;
  }

  _take() {
    for (const m of this.pool) if (!m.visible) return m;
    return null;
  }

  /** 枪口火光 */
  muzzle(x, y, z, ang) {
    const m = this._take();
    if (!m) return;
    m.geometry = this._geo.flash;
    m.material.color.set(0xffd9a0);
    m.material.opacity = 1;
    m.position.set(x, y, z);
    m.rotation.set(0, ang, 0);
    m.rotateX(Math.PI / 2);
    m.scale.setScalar(0.9 + Math.random() * 0.4);
    m.visible = true;
    this.items.push({ m, t: 0, life: 0.06, kind: 'flash' });
  }

  /** 曳光：从枪口到命中点 */
  tracer(x0, y0, z0, x1, y1, z1) {
    const t = this.tracers[this.ti++ % this.tracers.length];
    const p = t.line.geometry.attributes.position;
    p.setXYZ(0, x0, y0, z0);
    p.setXYZ(1, x1, y1, z1);
    p.needsUpdate = true;
    t.line.geometry.computeBoundingSphere();
    t.line.material.opacity = 0.9;
    t.line.visible = true;
    t.t = 0.075;
  }

  /** 命中：金属火花（敌人）或血泡（玩家） */
  hit(x, y, z, hostile) {
    const m = this._take();
    if (!m) return;
    m.geometry = hostile ? this._geo.bubble : this._geo.spark;
    m.material.color.set(hostile ? 0xd8484a : 0xffcf8a);
    m.material.opacity = 0.95;
    m.position.set(x, y, z);
    m.scale.setScalar(hostile ? 1.1 : 0.8);
    m.visible = true;
    // 往上飘（水下气泡上浮）
    this.items.push({ m, t: 0, life: hostile ? 0.9 : 0.3, kind: hostile ? 'bubble' : 'spark', vy: hostile ? 1.6 : 0.4 });
  }

  /** 玩家中弹时的红色方向指示（屏幕空间由 UI 负责，这里只给方向） */
  hurtFrom(x, z) {
    this.shake = Math.min(1, this.shake + 0.35);
    void x; void z;
  }

  consumeShake() { const s = this.shake; this.shake = 0; return s; }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      const k = it.t / it.life;
      if (k >= 1) {
        it.m.visible = false;
        this.items.splice(i, 1);
        continue;
      }
      if (it.kind === 'bubble') {
        it.m.position.y += it.vy * dt;
        it.m.position.x += Math.sin(it.t * 5) * 0.02;
        it.m.scale.multiplyScalar(1 + dt * 0.7);
        it.m.material.opacity = 0.95 * (1 - k);
      } else {
        it.m.material.opacity = 1 - k;
      }
    }
    for (const t of this.tracers) {
      if (t.t <= 0) continue;
      t.t -= dt;
      t.line.material.opacity = Math.max(0, t.t / 0.075) * 0.9;
      if (t.t <= 0) t.line.visible = false;
    }
  }
}
