import { Input } from './js/input.js';
import { Net } from './js/net.js';
import { World } from './js/world.js';
import { Renderer } from './js/renderer.js';

import { canvas, showHint, isDlgOpen } from './js/dialogue.js';


// ---------- 초기화 ----------
// main.js
const net = new Net();
if (!window.isTempChar) net.connect();
await net.init();

const world = new World(net);
const renderer = new Renderer(canvas, net, world);
const input = new Input({ ui, renderer });
input.allow = false;

window.ignoreColliosion = false;

// 최초 map:init까지 기다렸다가 세팅
await new Promise((resolve) => {
    const onInit = async (payload) => {
        await world.setMap(payload.maps);
        await renderer.preload(world.map);
        input.allow = true;

        net.off?.('map:init', onInit);
        resolve();
    };

    if (net.on) {
        net.on('map:init', onInit);
    } else if (net._call) {
        net._call('on', 'map:init', onInit);
    }
});

function getNearbyObject(map, x, y, radius = 36) {
    if (!map || !Array.isArray(map.objects)) return null;
    const r2 = radius * radius;
    for (const o of map.objects) {
        const dx = x - o.x, dy = y - o.y;
        if (dx * dx + dy * dy <= r2) return o;
    }
    return null;
}

// ---------- 업데이트 루프 ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let prev = performance.now();
let acc = 0;
const FIXED_DT = 50; // 20fps

function update(dt) {
    if (!net.me || !world.map) return;

    const me = net.me;
    const d = input.dir;
    const speed = 1.6 * (dt / 50) * 3;

    // 대화 중엔 이동/상호작용 금지
    if (isDlgOpen()) return;

    // 상호작용
    if (input.consumeInteract()) {
        const obj = (typeof world.tryInteract === 'function')
            ? world.tryInteract(me)
            : getNearbyObject(world.map, me.x, me.y, 36);

        if (obj) {
            net.interact(obj);
        } else {
            showHint('상호작용 대상 없음', 600);
        }
    }

    // 이동
    if (d.x || d.y) {
        const len = Math.hypot(d.x, d.y) || 1;
        const stepX = (d.x / len) * speed;
        const stepY = (d.y / len) * speed;

        const prevX = me.x, prevY = me.y;
        let nx = me.x + stepX, ny = me.y + stepY;

        if (typeof world.blockedRect === 'function') {
            if (!world.blockedRect(nx, me.y)) me.x = clamp(nx, 16, world.map.w - 16);
            if (!world.blockedRect(me.x, ny)) me.y = clamp(ny, 16, world.map.h - 16);
        } else {
            me.x = clamp(nx, 16, world.map.w - 16);
            me.y = clamp(ny, 16, world.map.h - 16);
        }

        const moved = (me.x !== prevX) || (me.y !== prevY);
        me.moving = moved;

        if (moved) {
            const dx = me.x - prevX, dy = me.y - prevY;
            if (dx !== 0 || dy !== 0) {
                if (Math.abs(dx) > 0 && Math.abs(dy) > 0) {
                    if (dx > 0 && dy > 0) me.dir = 'down-right';
                    else if (dx < 0 && dy > 0) me.dir = 'down-left';
                    else if (dx > 0 && dy < 0) me.dir = 'up-right';
                    else if (dx < 0 && dy < 0) me.dir = 'up-left';
                } else if (Math.abs(dx) > Math.abs(dy)) {
                    me.dir = dx > 0 ? 'right' : 'left';
                } else {
                    me.dir = dy > 0 ? 'down' : 'up';
                }
            }
            if (!window.isTempChar) net.move(me.x, me.y, me.dir);
        }
    } else {
        me.moving = false;
    }
}

function loop(now) {
    let frameDt = now - prev;
    prev = now;
    frameDt = Math.min(frameDt, 100);
    acc += frameDt;

    while (acc >= FIXED_DT) {
        update(FIXED_DT);
        renderer.draw(now);
        acc -= FIXED_DT;
    }

    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
