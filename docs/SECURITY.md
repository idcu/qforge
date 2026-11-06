# 安全与隐私（SECURITY）

> **这份文件是什么**：安全边界与威胁模型的**诚实声明**，不是安全认证或合规承诺。
> 适用对象：本地优先部署（双击 `file://` 或 `node scripts/serve.mjs` 自建静态站 + 可选参考后端）。
> 相关：[ARCHITECTURE.md](ARCHITECTURE.md)（CSP/存储底座）、[BACKUP.md](BACKUP.md)、[DATABASE.md](DATABASE.md)。

## 1. 数据位置与默认姿态

- 题库、成绩、复习计划、图片资产默认**只在本机**：IndexedDB `qforge-kv` / `qforge-assets`，引导标记在 LocalStorage。
- 无账号、无遥测；除用户主动触发的 WebDAV 上传/URL 导入与可选的 `DATA_BACKEND=api` 外，不发起网络请求。
- 页面默认启用 CSP：`script-src 'self'`（禁内联脚本/eval），`connect-src` 默认仅 `'self'`；跨源后端/WebDAV 必须显式白名单（见 [DEVELOPMENT.md](DEVELOPMENT.md)）。
- 参考后端默认**无鉴权**；设置 `API_TOKEN` 后为共享 Bearer 密钥，**不是账号体系**，公网暴露前必须启用并配合 TLS/反代。

## 9. WebDAV 密码加密（C027）

### 9.1 存储布局

| 项 | 位置 | 内容 |
| --- | --- | --- |
| 配置元数据 | LocalStorage `qb:meta:dav` | `{v:2, baseUrl, user, passEnc, lastAt, lastName, lastSize}`；**没有 `pass` 明文字段** |
| 密文 | 同上的 `passEnc` | `{alg:'AES-GCM', iv:<base64 12B 随机>, data:<base64 密文>}`（AES-GCM 256） |
| 密钥 | IndexedDB `qforge-secrets/keys`（键 `dav`） | `crypto.subtle.generateKey({name:'AES-GCM',length:256}, false, ['encrypt','decrypt'])` 生成的 **non-extractable CryptoKey**，无法被 `exportKey` 导出 |
| 备份/诊断 | 备份包与诊断快照 | 同时剔除 `pass` 与 `passEnc`（密文也不带走） |

### 9.2 旧明文迁移路径

1. 首次 `loadConfig()` 检测到旧字段 `pass`（明文）→ 用当前密钥加密 → **立即解密回读**。
2. 回读与原文逐字符一致才覆盖为 `v2` 密文并删除 `pass`；不一致或加密失败则**保留旧明文不动**，返回可见错误提示用户重输密码后保存。
3. Web Crypto 不可用或密钥无法创建时，**不会把明文重新写回**：移除旧 `pass`、保留地址/账号元数据，密码仅本次会话可用，UI 给出可见提示（刷新后需重新输入）。
4. IndexedDB 不可用时：密钥仅存内存（会话级），`passEnc` 不落盘（因为刷新后必然无法解密）；同样给出可见提示。
5. 迁移幂等：已是 `v2` 的配置再次读取不会重写密文。

### 9.3 能挡什么 / 挡不住什么（不夸大）

| 场景 | 是否有效 | 说明 |
| --- | --- | --- |
| 只拿到 LocalStorage 的拷贝/导出/截图/浏览器同步 | **有效** | 看到的是 AES-GCM 密文；没有 IndexedDB 里的不可导出密钥无法还原密码 |
| 备份文件/诊断包外泄 | **有效** | `pass` 与 `passEnc` 都不写入 |
| 浏览器正常清理站点数据 | 有效（密钥一并清除） | 代价是密码丢失，需要重新输入 |
| **同源 XSS** | **无效** | 注入脚本可调用 `crypto.subtle.decrypt`，也能直接读内存中的明文密码 |
| **恶意浏览器扩展 / 调试器 / 同机读盘** | **无效** | 扩展可读取页面存储并调用 Web Crypto；同机攻击者可拷贝整个 profile（LS + IDB）后在受控环境解密 |
| 整浏览器 profile 拷贝 | **无效** | 密钥与密文都在 profile 内 |
| 运行期内存转储 / 崩溃转储 | **无效** | 解密后的密码在 JS 内存中 |
| 忘记密码后的离线暴力破解 | 未设计 | 无用户输入口令/KDF；密钥由浏览器生成并保存，安全强度取决于操作系统与浏览器隔离 |

**结论**：该方案的目标是「密码不以明文静态落盘」，降低备份、同步、随手拷贝类泄露；**不能**抵御能执行同源代码或读取本机文件的攻击者，也**不能替代**应用专用密码与最小权限原则。

### 9.4 建议

- WebDAV 一律使用**应用专用密码/受限令牌**，并定期轮换。
- 公共/共享设备用完点「清除配置」；更高安全需求应使用独立操作系统账户或专用浏览器 profile。
- 不把浏览器 profile 目录纳入云同步/共享。

### 9.5 未验证 / 残余风险（如实标注）

- Node 套件覆盖了「加密落盘、解密读取、迁移、篡改拒绝、上传使用解密密码」的纯逻辑路径；**真实浏览器 IndexedDB 中 CryptoKey 的跨会话持久性未做真机自动化验收**（Node 环境无 IDB，走的是内存会话密钥回退路径）。
- 未验证浏览器在隐私模式/存储清理策略下对 `qforge-secrets` 的具体行为；失败时按上述回退给出「重新输入密码」提示，但**未做真机截图证据**。
- 未做密码强度、KDF、密钥轮换与多设备密钥同步；这些不在本方案范围。
