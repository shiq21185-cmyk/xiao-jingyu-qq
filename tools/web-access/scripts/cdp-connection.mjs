// CDP 连接的唯一所有者：发现、握手、socket 生命周期与命令响应。
// connect 覆盖完整 singleflight；send 不隐式连接；close 同步结算所有等待者。
//
// ★握手超时（2026-10-22 qq-bridge 加的）★
// 为什么必须有：Chromium 136+ 的「Allow remote debugging for this browser instance」
// 是**按连接**确认的 —— 新的 WebSocket 连上去之后，浏览器要先弹一次确认框，
// 主人点了「允许」它才真正开始说话。在这之前 socket 处于"开着但没消息"的状态。
// 原来的实现没有握手超时 ⇒ 那个 `flight` Promise 永远不结算：
//   · 代理的 /health 一直是 connected:false，看着像"正在连"；
//   · 每一个请求都挂在同一个 flight 上，全都在等一个可能永远不会来的点击；
//   · 而且**不会报错**，用户只看到"卡住"。
// 现在：超过 handshakeTimeoutMs 就关掉 socket 并 reject 一个带 code 的错误，
// 让上层能说清"在等你点允许"，也能按退避策略控制重试频率。
export function createCdpConnection({
  WebSocketImpl,
  discoverUrl,
  onConnect = () => {},
  onDisconnect = () => {},
  onEvent = () => {},
  onDiagnostic = () => {},
  commandTimeoutMs = 30000,
  handshakeTimeoutMs = 60000,
}) {
  if (typeof WebSocketImpl !== 'function' || typeof discoverUrl !== 'function') {
    throw new TypeError('CDP 连接需要 WebSocketImpl 与 discoverUrl');
  }
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs < 0) {
    throw new TypeError('CDP 命令超时必须是非负有限数字');
  }

  let state = 'disconnected';
  let current = null;
  let flight = null;
  let attemptCount = 0;
  let commandId = 0;
  const pending = new Map();

  function asError(value, fallback) {
    if (value instanceof Error) return value;
    if (value?.error instanceof Error) return value.error;
    return new Error(value?.message || fallback);
  }

  function diagnostic(error) {
    try { onDiagnostic(error); }
    catch (reportingError) {
      // 诊断回调自身失败不能让 socket 回调跳过生命周期清理。
      console.error('[CDP connection] 诊断回调失败:', reportingError, '原始错误:', error);
    }
  }

  function settleCommand(id, { response, error }) {
    const command = pending.get(id);
    if (!command) return;
    pending.delete(id);
    clearTimeout(command.timer);
    if (error) command.reject(error);
    else command.resolve(response);
  }

  function closeSocket(socket) {
    if (!socket) return;
    try { socket.close(); }
    catch (error) { diagnostic(asError(error, 'WebSocket 关闭失败')); }
  }

  function clearHandshakeTimer(context) {
    if (!context?.handshakeTimer) return;
    clearTimeout(context.handshakeTimer);
    context.handshakeTimer = null;
  }

  // 握手超时：socket 开着却一直没人说话 = 浏览器在等主人点「允许」。
  // 抛 ERROR code 让上层能区分"浏览器没开"和"在等授权"，文案也说得清。
  function handshakeTimedOut(context) {
    if (current !== context || context.settled) return;
    const error = new Error(
      `握手超时：浏览器 ${Math.round(handshakeTimeoutMs / 1000)} 秒内没有回应 —— `
      + '多半是在等你在 Edge 里点「允许远程调试」',
    );
    error.code = 'CDP_HANDSHAKE_TIMEOUT';
    disconnect(context, error);
  }

  function disconnect(context, error, shouldClose = true) {
    if (current !== context) return;
    // 先撤销本次 socket 的写入资格，再关闭，防止 close/error 重入清理新连接。
    clearHandshakeTimer(context);
    current = null;
    flight = null;
    state = 'disconnected';
    if (!context.settled) {
      context.settled = true;
      context.reject(error);
    }
    for (const [id, command] of pending) {
      if (command.context === context) settleCommand(id, { error });
    }
    try { onDisconnect(error); }
    catch (hookError) { diagnostic(asError(hookError, 'CDP 断开回调失败')); }
    if (shouldClose) closeSocket(context.socket);
  }

  function bindSocket(context) {
    const socket = context.socket;
    const active = () => current === context;
    const handlers = {
      open() {
        if (!active() || state !== 'connecting') return;
        state = 'connected';
        clearHandshakeTimer(context);
        try { onConnect(); }
        catch (error) { disconnect(context, asError(error, 'CDP 连接回调失败')); return; }
        if (!active()) return;
        context.settled = true;
        flight = null;
        context.resolve();
      },
      error(event) {
        if (!active()) return;
        disconnect(context, asError(event, 'WebSocket 连接失败'));
      },
      close(event, reason) {
        if (!active()) return;
        const detail = typeof event === 'number' ? `${event}${reason ? `, ${reason}` : ''}` : event?.reason;
        const phase = state === 'connected' ? '连接断开' : '建立连接前关闭';
        disconnect(context, new Error(`WebSocket ${phase}${detail ? ` (${detail})` : ''}`), false);
      },
      message(event) {
        if (!active() || state !== 'connected') return;
        let message;
        try {
          // MessageEvent.data 是原型 getter；不能靠 Object.keys 或自身属性判断。
          const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
          message = JSON.parse(typeof data === 'string' ? data : data.toString());
          if (!message || typeof message !== 'object' || Array.isArray(message)) {
            throw new Error('CDP 响应不是 JSON 对象');
          }
        } catch (error) {
          diagnostic(asError(error, 'CDP 响应解析失败'));
          return;
        }
        if (message.id !== undefined && pending.get(message.id)?.context === context) {
          settleCommand(message.id, { response: message });
        }
        if (message.method) {
          try { onEvent(message); }
          catch (error) { diagnostic(asError(error, 'CDP 事件回调失败')); }
        }
      },
    };

    // 已退役 socket 保留局部监听器吸收其迟到事件，事件只能通过 identity 闸门。
    // 尤其 ws EventEmitter 的迟到 error 必须有监听器，否则会被 Node 当作未处理异常。
    if (typeof socket.addEventListener === 'function') {
      for (const [type, handler] of Object.entries(handlers)) socket.addEventListener(type, handler);
    } else if (typeof socket.on === 'function') {
      for (const [type, handler] of Object.entries(handlers)) socket.on(type, handler);
    } else {
      throw new TypeError('WebSocket 未提供 EventTarget 或 EventEmitter 事件 API');
    }
    if (socket.readyState === 1) handlers.open();
  }

  function connect() {
    if (state === 'connected') return Promise.resolve();
    if (flight) return flight;
    const context = { socket: null, settled: false, resolve: null, reject: null };
    // 发现可能异步或同步重入，因此在调用 discoverUrl 前发布同一个 Promise。
    flight = new Promise((resolve, reject) => { context.resolve = resolve; context.reject = reject; });
    const result = flight;
    current = context;
    state = 'discovering';
    attemptCount++;
    Promise.resolve().then(() => {
      if (current !== context) return;
      return discoverUrl();
    }).then(url => {
      if (current !== context) return;
      if (!url) throw new Error('无法发现 CDP WebSocket URL');
      state = 'connecting';
      context.socket = new WebSocketImpl(url);
      bindSocket(context);
      // ★握手计时（2026-10-22）★
      // 真实形态是：WebSocket 的 HTTP upgrade **挂在浏览器那边不返回**，
      // 因为 Edge 先弹确认框等主人点「允许」，open 事件根本不触发。
      // 它不会报错、不会超时，就是静静地挂着 —— 旧实现因此永久卡死。
      // 这里在"建完 socket 但还没 open"的窗口里计时。
      if (current === context && !context.settled && state === 'connecting') {
        context.handshakeTimer = setTimeout(() => handshakeTimedOut(context), handshakeTimeoutMs);
        // bindSocket 里如果同步 open 过（readyState 已经是 1 / 已 settle），上面那个 if 会挡掉；
        // 万一在这一拍之内 settle 了，也要把 timer 清掉，别留个幽灵定时器。
        if (current !== context || context.settled) clearHandshakeTimer(context);
      }
    }).catch(error => {
      clearHandshakeTimer(context);
      if (current === context) disconnect(context, asError(error, 'CDP 连接失败'));
    });
    return result;
  }

  function send(method, params = {}, sessionId = null) {
    if (state !== 'connected' || !current || current.socket.readyState !== 1) {
      return Promise.reject(new Error('WebSocket 未连接'));
    }
    const context = current;
    return new Promise((resolve, reject) => {
      const id = ++commandId;
      const message = { id, method, params };
      if (sessionId !== null) message.sessionId = sessionId;
      let serialized;
      try { serialized = JSON.stringify(message); }
      catch (error) { reject(asError(error, 'CDP 命令编码失败')); return; }
      const timer = setTimeout(() => {
        settleCommand(id, { error: new Error(`CDP 命令超时: ${method}`) });
      }, commandTimeoutMs);
      pending.set(id, { context, resolve, reject, timer });
      try { context.socket.send(serialized); }
      catch (error) { settleCommand(id, { error: asError(error, 'CDP 命令发送失败') }); }
    });
  }

  function close() {
    if (current) disconnect(current, new Error('CDP 连接已主动关闭'));
  }

  return {
    connect,
    send,
    close,
    get connected() { return state === 'connected'; },
    get state() { return state; },
    get attemptCount() { return attemptCount; },
    get pendingCount() { return pending.size; },
  };
}
