# 以后怎么加新端点（bridge.js）

> 结论先说：`src/bridge.js` 看着大（约 1.8 万行），但它是一条**顺序 if 链**，每个端点自包含、
> 以 `url.pathname === '…'` 开头、`return;` 结尾，互相零耦合。**加新接口和现在一样方便，不需要拆文件。**

## 结构速览

- **中间件区**（`const server = http.createServer(...)` 回调开头约 200 行）：安全头、令牌校验、
  Host 校验、CSRF、agent 白名单。**几乎不用碰**。
- **端点链**（`dispatchEndpoints(mw, req, res)` 函数体，约 6000 行）：146 个端点按顺序排成 if 链。

```js
if (req.method === 'POST' && url.pathname === '/api/xxx') {
  // 这个端点的逻辑
  return;
}
```

每个块开头是 `req.method === '…' && url.pathname === '…'`，结尾是 `return;`（或 `sendJson(...); return;`）。

## 三步加一个新端点

1. **找位置**：`grep -n "url.pathname === '/api"` 找到相近的端点区域。
2. **插块**：在合适位置插一个 `if (...) { ... return; }` 块。可用变量：
   - `url`（解析好的 `URL`）、`req` / `res`（原生请求/响应）
   - `sendJson(obj, status)`（写 JSON 响应，自动带安全头）
   - `readBody()`（读并解析 JSON body，超长/坏 JSON 会自动 400）
   - `cfg`（配置）、`socialV2`（会话状态）、`v2ToolEnabled(flag)`、`agentTokenOk(key, token)` 等
3. **验证**：跑回归，确认没改坏别的端点。

## 注意事项

- **守卫要过三关**：新端点如果要给 QQ agent 用，得在 `plugins/qq-agent-presets/qq-tool-restrict.mjs`
  里放行（否则守卫会兜底拒绝「工具不在白名单」）；如果是管理员控制台专用，加进 `agentAllowed` 白名单即可。
- **每个块必须 `return;`**：这条链靠顺序 fall-through，漏了 `return` 会掉进下一个端点的判断里。
- **别碰中间件区**：那里的安全逻辑（Host 校验、CSRF、令牌）一旦动坏，所有端点一起崩。

## 回归命令

```bash
node scripts/test-console.mjs          # 控制台端点行为
node scripts/test-audit-bridge.mjs     # 安全/恶意请求审计
npm run test-smoke                     # extra-console + proactive-time
```

改完跑这三条，全绿再提交。每个改动单独 `git commit`，基线干净、随时 `git revert` 回退。
