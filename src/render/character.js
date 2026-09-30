// 程序化潜水员：不用任何外部模型，靠基础几何体拼出来。
// 好处是零资产依赖，而且能和 gameplay 的胶囊/头球碰撞体严格对应 ——
// 玩家看到的头就在 rules.js rayActor 判定的那个位置上。

import * as THREE from 'three';
import { BODY } from '../core/rules.js';

const TINT = {
  player: 0x2e6f7a,      // 潜水服主色：青蓝
  suit: 0x1f4f5c,
  trim: 0xd8a24a,       // 金属配件：金
  tank: 0xc8b46a,       // 气瓶：浅黄铜
  enemy: 0x6b4a3a,      // 敌方：暗褐红
  enemyTrim: 0xb03a2e,
};

function mat(color, rough = 0.7, metal = 0.15) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

export class Diver {
  /** @param {boolean} hostile 是否敌方（换配色） */
  constructor(hostile = false) {
    this.hostile = hostile;
    this.root = new THREE.Group();
    const suit = mat(hostile ? TINT.enemy : TINT.suit, 0.72, 0.1);
    const trim = mat(hostile ? TINT.enemyTrim : TINT.trim, 0.45, 0.6);
    const tank = mat(TINT.tank, 0.35, 0.7);
    const dark = mat(0x1a1f22, 0.6, 0.3);

    // 躯干：高度对齐 BODY.y0..BODY.y1
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(BODY.r * 0.92, BODY.y1 - BODY.y0 - BODY.r * 0.9, 4, 10), suit);
    torso.position.y = (BODY.y0 + BODY.y1) / 2;
    torso.castShadow = true;
    this.torso = torso;
    this.root.add(torso);

    // 头：球，位置严格等于 BODY.headY
    const head = new THREE.Mesh(new THREE.SphereGeometry(BODY.headR * 1.05, 12, 10), suit);
    head.position.y = BODY.headY;
    head.castShadow = true;
    this.head = head;
    this.root.add(head);

    // 面罩
    const mask = new THREE.Mesh(new THREE.SphereGeometry(BODY.headR * 0.92, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), dark);
    mask.position.set(0, BODY.headY + 0.01, BODY.headR * 0.42);
    mask.rotation.x = Math.PI / 2.1;
    this.root.add(mask);
    this.mask = mask;

    // 头灯
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.1, 8), trim);
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(0, BODY.headY + 0.06, BODY.headR * 0.95);
    this.root.add(lamp);
    const beam = new THREE.SpotLight(0xfff0c0, 0, 9, 0.5, 0.5, 1.2);
    beam.position.set(0, BODY.headY + 0.06, BODY.headR);
    beam.target.position.set(0, BODY.headY - 0.6, 6);
    this.root.add(beam, beam.target);
    this.beam = beam;

    // 气瓶（背部）
    for (const ox of [-0.13, 0.13]) {
      const t = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.5, 4, 8), tank);
      t.position.set(ox, BODY.y1 - 0.28, -BODY.r * 0.85);
      t.castShadow = true;
      this.root.add(t);
    }

    // 配重带
    const belt = new THREE.Mesh(new THREE.TorusGeometry(BODY.r * 0.98, 0.055, 6, 14), trim);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.86;
    this.root.add(belt);

    // 手臂（跟着朝向前后摆）
    this.arms = [];
    for (const ox of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.44, 3, 6), suit);
      arm.position.set(ox * (BODY.r * 0.95), BODY.y1 - 0.42, 0.1);
      arm.castShadow = true;
      this.root.add(arm);
      this.arms.push(arm);
    }

    // 腿
    this.legs = [];
    for (const ox of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.5, 3, 6), suit);
      leg.position.set(ox * 0.13, 0.42, 0);
      leg.castShadow = true;
      this.root.add(leg);
      this.legs.push(leg);
    }
    // 脚蹼
    for (const ox of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.42), trim);
      fin.position.set(ox * 0.13, 0.06, 0.08);
      this.root.add(fin);
    }

    // 武器
    this.gun = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.72), dark);
    barrel.position.z = 0.3;
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.15, 0.22), suit);
    stock.position.z = -0.14;
    this.gun.add(barrel, stock);
    this.gun.position.set(BODY.r * 0.75, BODY.y1 - 0.5, 0.34);
    this.root.add(this.gun);

    this.recoil = 0;
    this.phase = Math.random() * 6.28;
    this.visible = true;
  }

  /**
   * @param {number} dt
   * @param {number} speed 水平速度
   * @param {number} moveDot 速度与朝向的点积（-1 倒退 ~ 1 前进）
   * @param {number} aimAngle 世界朝向角
   */
  update(dt, speed, moveDot, aimAngle) {
    this.phase += dt * (2.2 + speed * 1.5);
    this.root.rotation.y = aimAngle;

    // 水下没有跑动，走路是"蹬腿漂移"，所以摆动幅度比陆地小、频率低
    const gait = Math.min(1, speed / 5);
    const sw = Math.sin(this.phase * 2.4) * gait;
    this.legs[0].rotation.x = sw * 0.7;
    this.legs[1].rotation.x = -sw * 0.7;
    this.arms[0].rotation.x = -sw * 0.45;
    this.arms[1].rotation.x = sw * 0.45;
    // 躯干随步伐轻微起伏
    this.torso.position.y = (BODY.y0 + BODY.y1) / 2 + Math.sin(this.phase * 4.8) * 0.03 * gait;
    this.head.position.y = BODY.headY + Math.sin(this.phase * 4.8) * 0.03 * gait;

    // 后坐：枪往回顶再弹回
    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - dt * 5);
      this.gun.position.z = 0.34 - this.recoil * 0.16;
    }
    // 灯光只朝瞄准方向
    this.beam.target.position.set(0, BODY.headY - 0.8, 7);
  }

  fire() { this.recoil = 1; }

  setVisible(v) {
    if (this.visible === v) return;
    this.visible = v;
    this.root.visible = v;
  }

  setOpacity(o) {
    this.root.traverse(n => {
      if (!n.isMesh) return;
      if (!n.material) return;
      const list = Array.isArray(n.material) ? n.material : [n.material];
      for (const m of list) { m.transparent = o < 0.999; m.opacity = o; }
    });
  }
}
