// 「只在必要时重连」的离线回归（2026-10-22）。
//
// 主人原话：「怎么需要使用手的时候，我每次都要点这个浏览器的允许？我不是在一键启动
// 里面就打开过一次了吗」。
//
// 实测出来的规则（见 LOCAL-PATCH.md）：Edge 的「允许远程调试」是**按 CDP 连接**确认的，
// 不是按浏览器实例。所以真正要保证的是三件事，全部在这里钉住：
//
//   ① 握手超时：socket 连上了但浏览器一直不回话（= 弹窗在等主人点），
//      **必须**在超时后 reject 并带 code='CDP_HANDSHAKE_TIMEOUT'，绝不能永久挂住。
//      （旧实现没有这条 ⇒ flight Promise 永不结算，/health 永远 connected:false，
//       每个请求都吊死在那儿，还一句话都不报。）
//   ② 连接活着时 connect() 直接返回，**不会**再建新 socket（= 不会再弹授权）。
//   ③ 断开后能重新连上（退避只是把重试拖慢，不能把能力弄丢）。
//
// 全程用假 WebSocket，不碰真实浏览器、不需要任何授权。
//
// 跑：node --test scripts/test-cdp-reconnect.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCdpConnection } from '../tools/web-access/scripts/cdp-connection.mjs';

// 一个可编程的假 WebSocket，覆盖真实世界里两种失败形态：
//   'hang'  —— **真实遇到的那种**：HTTP upgrade 被浏览器吊住（在等主人点「允许」），
//              既不触发 open 也不触发 error，`readyState` 一直是 0；
//   'refuse'—— 浏览器直接拒绝（调试口没开、端口关了）：触发 error；
//   'open'  —— 正常连上。
class FakeSocket {
  constructor(url, { mode = 'hang' } = {}) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
    this._mode = mode;
    if (mode === 'refuse') {
      setImmediate(() => this._emit('error', new Error('connection refused')));
    } else if (mode === 'open') {
      setImmediate(() => {
        this.readyState = 1;
        this._emit('open');
      });
    }
    // 'hang'：什么都不做 —— 这就是"等主人点允许"的样子，靠外部超时才能脱身。
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  _emit(type, arg) {
    for (const fn of this.listeners.get(type) ?? []) fn(arg ?? {});
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
  /** 模拟浏览器回一条 CDP 响应 */
  reply(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
}
FakeSocket.instances = [];

// 默认用 'open'（正常连上）；需要模拟异常的测试自己传 hang / refuse。
const makeWs = (mode) => class extends FakeSocket {
  constructor(url) { super(url, { mode }); }
};

const reset = () => { FakeSocket.instances = []; };

console.log('— 1. 握手超时：弹窗没人点，必须报错而不是永久挂住 —');
test('socket 被吊住（真实形态：既无 open 也无 error）⇒ 超时 reject，带 CDP_HANDSHAKE_TIMEOUT', async () => {
  reset();
  const disconnects = [];
  const conn = createCdpConnection({
    WebSocketImpl: makeWs('hang'),
    discoverUrl: async () => 'ws://127.0.0.1:1/devtools/browser/fake',
    commandTimeoutMs: 2000,
    handshakeTimeoutMs: 120,          // 测试里压到 120ms
    onDisconnect: (e) => disconnects.push(e),
  });

  const t0 = Date.now();
  await assert.rejects(
    conn.connect(),
    (error) => {
      assert.equal(error.code, 'CDP_HANDSHAKE_TIMEOUT', `错误要带 code，实际：${error?.code} / ${error?.message}`);
      assert.match(error.message, /允许远程调试/, '文案要点明是等授权，不是"网络错误"');
      return true;
    },
    '握手超时必须 reject —— 旧实现会永远挂着',
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 100 && elapsed < 3000, `超时时间应在 120ms 附近生效，实际 ${elapsed}ms`);
  assert.equal(conn.connected, false, '超时后不能还声称 connected');
  assert.equal(conn.state, 'disconnected', '超时后状态要回到 disconnected');
  assert.ok(disconnects.length >= 1, '必须触发 onDisconnect（上层靠它安排退避）');
});

test('超时之后 socket 要被真的关掉（别把授权弹窗吊在那儿）', async () => {
  reset();
  const conn = createCdpConnection({
    WebSocketImpl: makeWs('hang'),
    discoverUrl: async () => 'ws://127.0.0.1:1/devtools/browser/fake',
    commandTimeoutMs: 2000,
    handshakeTimeoutMs: 80,
  });
  await conn.connect().catch(() => {});
  const sock = FakeSocket.instances[0];
  assert.ok(sock, '应该建过一个 socket');
  assert.equal(sock.readyState, 3, '超时后必须 close() —— 否则浏览器那边的"等待确认"会一直挂着');
});

console.log('— 2. 连接活着时绝不再建新连接（= 不会再弹授权）—');
test('已连接状态下反复 connect() 不会新建 socket', async () => {
  reset();
  let discovered = 0;
  const conn = createCdpConnection({
    WebSocketImpl: makeWs('open'),
    discoverUrl: async () => { discovered += 1; return 'ws://127.0.0.1:1/devtools/browser/fake'; },
    commandTimeoutMs: 2000,
    handshakeTimeoutMs: 2000,
  });
  await conn.connect();
  assert.equal(conn.connected, true);

  // 模拟"她连着调了 20 次工具"：每次入口都会 ensureProxy → connect()
  for (let i = 0; i < 20; i += 1) await conn.connect();
  assert.equal(FakeSocket.instances.length, 1, `只能有一个 socket，实际 ${FakeSocket.instances.length} 个（每多一个就可能多一次授权弹窗）`);
  assert.equal(discovered, 1, '已连接时不该重新发现/重连');
});

test('并发调用共用同一次握手（不会同时开一堆 socket 各弹一次）', async () => {
  reset();
  const conn = createCdpConnection({
    WebSocketImpl: makeWs('open'),
    discoverUrl: async () => 'ws://127.0.0.1:1/devtools/browser/fake',
    commandTimeoutMs: 2000,
    handshakeTimeoutMs: 2000,
  });
  await Promise.all(Array.from({ length: 10 }, () => conn.connect()));
  assert.equal(FakeSocket.instances.length, 1, `10 个并发只能开 1 个 socket，实际 ${FakeSocket.instances.length}`);
  assert.equal(conn.connected, true);
});

console.log('— 3. 真断了还能连回来（退避不能把能力弄丢）—');
test('断开后 connect() 能建立新连接并重新可用', async () => {
  reset();
  const conn = createCdpConnection({
    WebSocketImpl: makeWs('open'),
    discoverUrl: async () => 'ws://127.0.0.1:1/devtools/browser/fake',
    commandTimeoutMs: 2000,
    handshakeTimeoutMs: 2000,
  });
  await conn.connect();
  const first = FakeSocket.instances[0];
  assert.equal(conn.connected, true);

  // 模拟浏览器退出：socket close
  first.readyState = 3;
  first._emit('close', {});
  assert.equal(conn.connected, false, '断开后必须立刻反映出来');

  await conn.connect();
  assert.equal(conn.connected, true, '断开后必须能重连');
  assert.equal(FakeSocket.instances.length, 2, '应该是新建了一条连接');
});

test('浏览器直接拒绝连接（不是等授权）⇒ 立刻失败，且不误标成"等授权"', async () => {
  reset();
  const conn = createCdpConnection({
    WebSocketImpl: makeWs('refuse'),
    discoverUrl: async () => 'ws://127.0.0.1:1/devtools/browser/fake',
    commandTimeoutMs: 2000,
    handshakeTimeoutMs: 5000,
  });
  await assert.rejects(conn.connect(), (e) => {
    assert.notEqual(e.code, 'CDP_HANDSHAKE_TIMEOUT', '被拒 ≠ 等授权：这两个要分开，否则会误报"请点允许"');
    return true;
  });
  assert.equal(conn.connected, false);
});

console.log('— 4. 命令超时仍然独立生效（别被握手超时带偏）—');
test('已连接后某个命令不回话 ⇒ 报 CDP 命令超时，连接本身不受影响', async () => {
  reset();
  const conn = createCdpConnection({
    WebSocketImpl: makeWs('open'),
    discoverUrl: async () => 'ws://127.0.0.1:1/devtools/browser/fake',
    commandTimeoutMs: 120,
    handshakeTimeoutMs: 5000,
  });
  await conn.connect();
  await assert.rejects(conn.send('Target.getTargets'), /CDP 命令超时/);
  assert.equal(conn.connected, true, '一条命令超时不该把整条连接判死');
});

test('正常命令能拿到响应（改完之后基本功能没坏）', async () => {
  reset();
  const conn = createCdpConnection({
    WebSocketImpl: makeWs('open'),
    discoverUrl: async () => 'ws://127.0.0.1:1/devtools/browser/fake',
    commandTimeoutMs: 2000,
    handshakeTimeoutMs: 2000,
  });
  await conn.connect();
  const sock = FakeSocket.instances[0];
  const pending = conn.send('Target.getTargets');
  const msg = JSON.parse(sock.sent.at(-1));
  sock.reply({ id: msg.id, result: { targetInfos: [{ targetId: 'a' }, { targetId: 'b' }] } });
  const res = await pending;
  assert.equal(res.result.targetInfos.length, 2);
});

